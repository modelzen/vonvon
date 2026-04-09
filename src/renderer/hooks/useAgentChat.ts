import { useState, useCallback, useRef } from 'react'
import { useBackend } from './useBackend'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
  toolName?: string
  toolStatus?: 'running' | 'completed' | 'failed'
  toolDuration?: number
  toolPreview?: string
}

export function useAgentChat() {
  const { apiFetch } = useBackend()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [usagePercent, setUsagePercent] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(
    async (content: string, sessionId: string) => {
      if (!content.trim() || isLoading) return

      const userMsg: AgentMessage = {
        id: Date.now().toString(),
        role: 'user',
        content,
        timestamp: Date.now()
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
          body: JSON.stringify({ session_id: sessionId, message: content }),
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
              } else if (currentEvent === 'run.completed') {
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

  return { messages, isLoading, usagePercent, sendMessage, clearMessages }
}
