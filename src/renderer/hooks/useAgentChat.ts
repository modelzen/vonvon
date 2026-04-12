import { useState, useCallback, useRef, useEffect } from 'react'
import { useBackend } from './useBackend'
import {
  getSessionAttachments,
  putAttachments,
  type CachedAttachment
} from '../lib/attachmentCache'

export interface AgentAttachment {
  type: 'image'
  dataUrl: string
  name?: string
}

// Backend chat.py persists a tail like "[图片:image.png]" or "[图片]" into
// SessionDB because the TEXT column can't hold multimodal data. When we
// successfully rehydrate the image from the local cache we should also
// strip that placeholder tail from the visible text — otherwise the user
// sees both the real image AND "[图片:image.png]" in the bubble.
const IMAGE_PLACEHOLDER_TAIL_RE = /(\s*\[图片(?::[^\]]*)?\])+\s*$/

function stripImagePlaceholderTail(text: string): string {
  return text.replace(IMAGE_PLACEHOLDER_TAIL_RE, '').trim()
}

// Per-session usage cache stored in localStorage. The backend's
// /api/sessions/:id/usage endpoint uses a rough character-based token
// estimate that rounds to 0% on wide-context models, so we can't trust
// it as the authoritative number on session switch. Instead we snapshot
// the real value reported in run.completed (derived from hermes's actual
// last_prompt_tokens) and replay it on rehydration.
const USAGE_CACHE_PREFIX = 'vonvon:usage:'

function readCachedUsage(sessionId: string): number | null {
  try {
    const raw = localStorage.getItem(USAGE_CACHE_PREFIX + sessionId)
    if (raw == null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeCachedUsage(sessionId: string, percent: number): void {
  try {
    localStorage.setItem(USAGE_CACHE_PREFIX + sessionId, String(percent))
  } catch {
    // Quota/disabled — silently ignore; usage ring will re-learn on next run.
  }
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
  toolName?: string
  toolStatus?: 'running' | 'completed' | 'failed'
  toolDuration?: number
  toolPreview?: string
  attachments?: AgentAttachment[]
}

const DEFAULT_SESSION_NAME_RE = /^会话 \d{2}:\d{2}:\d{2}$/

interface UseAgentChatOpts {
  sessionName?: string
  onTitleUpdate?: (title: string) => void
  onRunCompleted?: () => void
}

export function useAgentChat(sessionId: string | null | undefined, opts?: UseAgentChatOpts) {
  const { apiFetch } = useBackend()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [usagePercent, setUsagePercent] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(false)
  // Transient thinking indicator text. Kept out of the messages list so it
  // vanishes the moment a run finishes and never gets persisted/scrolled
  // into chat history. Hermes emits a fresh "cogitating..."-style phrase
  // (see hermes-agent/agent/display.py) on every reasoning tick — we just
  // append deltas here for the current in-flight run.
  const [thinking, setThinking] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  // Avoid stale closure: always read the latest opts inside callbacks.
  const optsRef = useRef(opts)
  optsRef.current = opts
  // Fire auto-title once per session (reset when sessionId changes).
  const hasSummarizedRef = useRef(false)

  // Reset + load history whenever the active session changes.
  useEffect(() => {
    // Abort any in-flight streaming request from the previous session.
    abortRef.current?.abort()
    abortRef.current = null
    hasSummarizedRef.current = false
    setMessages([])
    setIsLoading(false)
    setThinking('')
    // Seed usage from cache if we have a prior authoritative number for
    // this session (written by run.completed in a past turn). Otherwise
    // start at 0 and let the fire-and-forget /usage fetch below paint it.
    setUsagePercent(sessionId ? readCachedUsage(sessionId) ?? 0 : 0)

    if (!sessionId) {
      setLoadingHistory(false)
      return
    }

    let cancelled = false
    setLoadingHistory(true)

    // Fallback usage fetch: only trusted when we have no cached authoritative
    // value. /api/sessions/:id/usage uses a rough character-based estimate
    // in session_service.get_usage, which rounds to 0% on wide-context
    // models. Treat it as a best-effort seed for brand-new sessions only.
    ;(async () => {
      if (readCachedUsage(sessionId) != null) return
      try {
        const r = await apiFetch(`/api/sessions/${sessionId}/usage`)
        if (cancelled || !r.ok) return
        const u = (await r.json()) as { usage_percent?: number }
        if (cancelled) return
        if (
          typeof u?.usage_percent === 'number' &&
          readCachedUsage(sessionId) == null
        ) {
          setUsagePercent(u.usage_percent)
        }
      } catch {
        // Silent: leave whatever the effect already seeded.
      }
    })()

    ;(async () => {
      try {
        // Pull history and local attachment cache in parallel: the backend
        // never persists image data (it stores only a "[图片:name]"
        // placeholder in SessionDB), so we rehydrate images from IndexedDB
        // keyed by (sessionId, userMessageOrdinal).
        const [res, cacheMap] = await Promise.all([
          apiFetch(`/api/sessions/${sessionId}/messages`),
          getSessionAttachments(sessionId)
        ])
        if (cancelled) return
        if (!res.ok) {
          setLoadingHistory(false)
          return
        }
        const raw = (await res.json()) as Array<Record<string, unknown>>
        if (cancelled) return
        if (!Array.isArray(raw)) {
          setLoadingHistory(false)
          return
        }
        const now = Date.now()

        // First pass: build a tool_call_id → tool-result map so we can attach
        // tool outputs to their originating assistant tool_calls when we
        // rebuild the timeline. Without this we'd either show the
        // tool_calls-only assistant message as an empty bubble (the bug)
        // or lose the tool's output entirely.
        type RawTc = { id?: string; function?: { name?: string } }
        interface ToolResult { content: string; name?: string }
        const toolResultMap = new Map<string, ToolResult>()
        for (const m of raw) {
          if (
            m.role === 'tool' &&
            typeof (m as Record<string, unknown>).tool_call_id === 'string'
          ) {
            const tcId = (m as Record<string, unknown>).tool_call_id as string
            toolResultMap.set(tcId, {
              content: typeof m.content === 'string' ? m.content : '',
              name:
                typeof (m as Record<string, unknown>).tool_name === 'string'
                  ? ((m as Record<string, unknown>).tool_name as string)
                  : undefined
            })
          }
        }

        const history: AgentMessage[] = []
        let userOrdinal = 0
        for (let i = 0; i < raw.length; i++) {
          const m = raw[i]
          const rawRole = m.role
          // tool role messages are folded into their originating assistant
          // tool_calls above; skip them as standalone entries.
          if (rawRole === 'tool') continue
          if (rawRole !== 'user' && rawRole !== 'assistant') continue
          const role = rawRole as 'user' | 'assistant'
          const content = typeof m.content === 'string' ? m.content : ''
          const baseTs = now - (raw.length - i)

          if (role === 'user') {
            const msg: AgentMessage = {
              id: `hist-${i}-${now}`,
              role,
              content,
              timestamp: baseTs
            }
            const cached = cacheMap.get(userOrdinal)
            if (cached && cached.attachments.length > 0) {
              // Guard against compress drift: if the cached record carries a
              // contentHint (e.g. "[图片:image.png]"), only rehydrate when
              // the current message still contains that hint. Otherwise we
              // risk pinning old images to a different, unrelated message
              // after the session was compressed.
              const okByHint =
                !cached.contentHint || content.includes(cached.contentHint)
              if (okByHint) {
                msg.attachments = cached.attachments.map((a) => ({
                  type: 'image' as const,
                  dataUrl: a.dataUrl,
                  name: a.name
                }))
                // Only strip the "[图片:xxx]" tail when we actually showed
                // the picture back. If rehydration failed, keep the tail so
                // the user at least sees that an image used to be here.
                msg.content = stripImagePlaceholderTail(content)
              }
            }
            userOrdinal++
            history.push(msg)
            continue
          }

          // role === 'assistant' —— may be:
          //   (a) a "tool_calls" wrapper (content empty, tool_calls set) →
          //       expand into one tool card per call
          //   (b) a final answer with text content
          //   (c) both in one message (rare but possible)
          //   (d) completely empty → skip (no empty bubble)
          const rawToolCalls = (m as Record<string, unknown>).tool_calls
          if (Array.isArray(rawToolCalls)) {
            for (let j = 0; j < rawToolCalls.length; j++) {
              const tc = rawToolCalls[j] as RawTc | null
              if (!tc || typeof tc !== 'object') continue
              const toolName = tc.function?.name || 'tool'
              const tcId = typeof tc.id === 'string' ? tc.id : ''
              const result = tcId ? toolResultMap.get(tcId) : undefined
              history.push({
                id: `hist-${i}-tc${j}-${now}`,
                role: 'tool',
                content: '',
                timestamp: baseTs,
                toolName,
                toolStatus: 'completed',
                toolPreview: result?.content || ''
              })
            }
          }
          if (content.trim()) {
            history.push({
              id: `hist-${i}-${now}`,
              role,
              content,
              timestamp: baseTs
            })
          }
        }
        setMessages(history)
      } catch {
        // Silent: keep the list empty on any failure.
      } finally {
        if (!cancelled) setLoadingHistory(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId, apiFetch])

  const sendMessage = useCallback(
    async (content: string, sessionId: string, attachments?: AgentAttachment[]) => {
      const hasAttachments = !!(attachments && attachments.length > 0)
      if ((!content.trim() && !hasAttachments) || isLoading) return

      const userMsg: AgentMessage = {
        id: Date.now().toString(),
        role: 'user',
        content,
        timestamp: Date.now(),
        ...(hasAttachments ? { attachments } : {})
      }
      setMessages((prev) => {
        if (hasAttachments && attachments) {
          // Ordinal = count of existing user messages (0-based index of
          // the one we are about to append). On reload, raw history is
          // filtered down to user/assistant and this same counter is
          // walked — the two must match.
          const ordinal = prev.filter((m) => m.role === 'user').length
          const names = attachments.filter((a) => a.name).map((a) => a.name as string)
          const contentHint =
            names.length > 0
              ? `[图片:${names[0]}]` // first filename is enough to disambiguate
              : '[图片]'
          const cached: CachedAttachment[] = attachments.map((a) => ({
            dataUrl: a.dataUrl,
            name: a.name
          }))
          void putAttachments(sessionId, ordinal, cached, contentHint)
        }
        return [...prev, userMsg]
      })
      setIsLoading(true)
      // Clear any leftover thinking text from a previous run before the
      // new indicator stream starts.
      setThinking('')

      const ctrl = new AbortController()
      abortRef.current = ctrl

      const assistantId = `assistant-${Date.now()}`
      // Add placeholder assistant message
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', timestamp: Date.now() }
      ])

      try {
        const res = await apiFetch('/api/chat/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            message: content,
            attachments: (attachments || []).map((a) => ({
              type: a.type,
              data_url: a.dataUrl,
              name: a.name
            }))
          }),
          signal: ctrl.signal
        })

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          let currentEvent = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              const raw = line.slice(6).trim()
              if (!raw) continue
              let data: Record<string, unknown>
              try {
                data = JSON.parse(raw)
              } catch {
                continue
              }

              if (currentEvent === 'tool.started') {
                const toolId = `tool-${Date.now()}-${Math.random()}`
                const toolMsg: AgentMessage = {
                  id: toolId,
                  role: 'tool',
                  content: '',
                  timestamp: Date.now(),
                  toolName: data.tool as string,
                  toolStatus: 'running',
                  toolPreview: data.preview as string | undefined
                }
                setMessages((prev) => {
                  // Float the assistant placeholder to the tail on every new
                  // tool card so the final answer always ends up *after* all
                  // the tool executions in this turn. The placeholder is
                  // created at sendMessage time (before any tool runs), so
                  // a naive push leaves it sitting above the tool cards and
                  // makes the conversation read upside-down once streaming
                  // fills it with the answer.
                  const pIdx = prev.findIndex((m) => m.id === assistantId)
                  if (pIdx === -1) return [...prev, toolMsg]
                  const next = prev.slice()
                  const [placeholder] = next.splice(pIdx, 1)
                  return [...next, toolMsg, placeholder]
                })
              } else if (currentEvent === 'tool.completed') {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.role === 'tool' &&
                    m.toolName === (data.tool as string) &&
                    m.toolStatus === 'running'
                      ? {
                          ...m,
                          toolStatus: (data.error ? 'failed' : 'completed') as 'completed' | 'failed',
                          toolDuration: data.duration as number | undefined
                        }
                      : m
                  )
                )
              } else if (currentEvent === 'message.delta') {
                const delta = data.delta as string
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: m.content + delta } : m
                  )
                )
              } else if (currentEvent === 'reasoning') {
                const text = (data.text as string) || ''
                if (!text) continue
                // Replace, don't append. hermes/agent/display.py emits a
                // fresh complete indicator phrase each tick (pondering…,
                // musing…, analyzing…), not incremental tokens — appending
                // would run them together into a single garbled string.
                setThinking(text)
              } else if (currentEvent === 'run.completed') {
                const output = (data.output as string) || ''
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId && !m.content ? { ...m, content: output } : m
                  )
                )
                const pct = (data.usage_percent as number) ?? 0
                setUsagePercent(pct)
                // Snapshot the authoritative value so future session switches
                // can rehydrate without trusting the rough-estimate endpoint.
                writeCachedUsage(sessionId, pct)
                setIsLoading(false)
                setThinking('')
                optsRef.current?.onRunCompleted?.()
                // Auto-title: fire once for default-named sessions after first run.
                if (
                  !hasSummarizedRef.current &&
                  optsRef.current?.sessionName &&
                  DEFAULT_SESSION_NAME_RE.test(optsRef.current.sessionName)
                ) {
                  hasSummarizedRef.current = true
                  void (async () => {
                    const autoTitle = await window.electron?.storeGet?.('autoTitleEnabled')
                    if (autoTitle === false) return
                    const titleModel = await window.electron?.storeGet?.('titleSummaryModel') as
                      { model: string; provider: string } | null | undefined
                    try {
                      const r = await apiFetch(`/api/sessions/${sessionId}/summarize`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(titleModel ?? {}),
                      })
                      if (!r.ok) return
                      const result = (await r.json()) as { name?: string }
                      if (result.name) optsRef.current?.onTitleUpdate?.(result.name)
                    } catch { /* silent */ }
                  })()
                }
              } else if (currentEvent === 'run.failed') {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: `Error: ${data.error}` }
                      : m
                  )
                )
                setThinking('')
                setIsLoading(false)
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${(err as Error).message}` }
                : m
            )
          )
        }
        setIsLoading(false)
        setThinking('')
      }
    },
    [apiFetch, isLoading]
  )

  const clearMessages = useCallback(() => {
    abortRef.current?.abort()
    setMessages([])
    setUsagePercent(0)
    setIsLoading(false)
    setThinking('')
  }, [])

  // Abort the in-flight streaming request without wiping history. Used by
  // the input area's "stop" button so the user can interrupt a long-running
  // tool chain or runaway generation, then keep the conversation. Anything
  // already streamed into the assistant placeholder stays in the bubble.
  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsLoading(false)
    setThinking('')
  }, [])

  return {
    messages,
    isLoading,
    usagePercent,
    sendMessage,
    clearMessages,
    loadingHistory,
    thinking,
    stop
  }
}
