import { useState, useCallback, useRef, useEffect } from 'react'
import { useBackend } from './useBackend'

export interface AgentAttachment {
  type: 'image'
  dataUrl: string
  name?: string
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'thinking'
  content: string
  timestamp: number
  toolName?: string
  toolStatus?: 'running' | 'completed' | 'failed'
  toolDuration?: number
  toolPreview?: string
  attachments?: AgentAttachment[]
}

export function useAgentChat(sessionId: string | null | undefined) {
  const { apiFetch } = useBackend()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [usagePercent, setUsagePercent] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Reset + load history whenever the active session changes.
  useEffect(() => {
    // Abort any in-flight streaming request from the previous session.
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setIsLoading(false)
    setUsagePercent(0)

    if (!sessionId) {
      setLoadingHistory(false)
      return
    }

    let cancelled = false
    setLoadingHistory(true)

    ;(async () => {
      try {
        const res = await apiFetch(`/api/sessions/${sessionId}/messages`)
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
        const history: AgentMessage[] = raw
          .map((m, i) => {
            const rawRole = m.role
            const role: AgentMessage['role'] =
              rawRole === 'assistant' || rawRole === 'user'
                ? (rawRole as 'assistant' | 'user')
                : 'tool'
            const content = typeof m.content === 'string' ? m.content : ''
            return {
              id: `hist-${i}-${now}`,
              role,
              content,
              timestamp: now - (raw.length - i)
            } as AgentMessage
          })
          .filter((m) => m.role === 'user' || m.role === 'assistant')
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
      setMessages((prev) => [...prev, userMsg])
      setIsLoading(true)

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
                setMessages((prev) => [
                  ...prev,
                  {
                    id: toolId,
                    role: 'tool',
                    content: '',
                    timestamp: Date.now(),
                    toolName: data.tool as string,
                    toolStatus: 'running',
                    toolPreview: data.preview as string | undefined
                  }
                ])
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
                setMessages((prev) => {
                  const last = prev[prev.length - 1]
                  if (last && last.role === 'thinking') {
                    return prev.map((m, i) =>
                      i === prev.length - 1 ? { ...m, content: m.content + text } : m
                    )
                  }
                  return [
                    ...prev,
                    {
                      id: `thinking-${Date.now()}`,
                      role: 'thinking',
                      content: text,
                      timestamp: Date.now()
                    }
                  ]
                })
              } else if (currentEvent === 'run.completed') {
                const output = (data.output as string) || ''
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId && !m.content ? { ...m, content: output } : m
                  )
                )
                setUsagePercent((data.usage_percent as number) ?? 0)
                setIsLoading(false)
              } else if (currentEvent === 'run.failed') {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: `Error: ${data.error}` }
                      : m
                  )
                )
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
      }
    },
    [apiFetch, isLoading]
  )

  const clearMessages = useCallback(() => {
    abortRef.current?.abort()
    setMessages([])
    setUsagePercent(0)
    setIsLoading(false)
  }, [])

  return { messages, isLoading, usagePercent, sendMessage, clearMessages, loadingHistory }
}
