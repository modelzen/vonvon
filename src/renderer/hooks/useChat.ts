import { useState, useEffect, useCallback } from 'react'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  isStreaming?: boolean
}

export function useChat(initialModel: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState(initialModel)

  // Load persisted messages on mount
  useEffect(() => {
    window.electron.storeGet('messages').then((stored) => {
      if (Array.isArray(stored)) {
        setMessages(stored as ChatMessage[])
      }
    })
  }, [])

  // Listen for streaming events from main process
  useEffect(() => {
    const handleChunk = (data: unknown) => {
      const { messageId, chunk } = data as { messageId: string; chunk: string }
      setMessages((prev) => {
        const exists = prev.find((m) => m.id === messageId)
        if (exists) {
          return prev.map((m) =>
            m.id === messageId ? { ...m, content: m.content + chunk } : m
          )
        }
        return [
          ...prev,
          {
            id: messageId,
            role: 'assistant',
            content: chunk,
            timestamp: Date.now(),
            isStreaming: true
          }
        ]
      })
    }

    const handleDone = (data: unknown) => {
      const { messageId } = data as { messageId: string }
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, isStreaming: false } : m))
      )
      setIsLoading(false)
    }

    const handleError = (data: unknown) => {
      const { error } = (data as { error: string }) || {}
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: `Error: ${error || 'Unknown error'}`,
          timestamp: Date.now()
        }
      ])
      setIsLoading(false)
    }

    window.electron.on('chat:chunk', handleChunk)
    window.electron.on('chat:done', handleDone)
    window.electron.on('chat:error', handleError)

    return () => {
      window.electron.off('chat:chunk', handleChunk)
      window.electron.off('chat:done', handleDone)
      window.electron.off('chat:error', handleError)
    }
  }, [])

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        content,
        timestamp: Date.now()
      }
      setMessages((prev) => [...prev, userMsg])
      setIsLoading(true)

      const result = await window.electron.sendMessage(content, selectedModel)
      if (result.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: `Error: ${result.error}`,
            timestamp: Date.now()
          }
        ])
        setIsLoading(false)
      }
    },
    [isLoading, selectedModel]
  )

  const clearMessages = useCallback(async () => {
    await window.electron.storeSet('messages', null)
    setMessages([])
  }, [])

  return { messages, isLoading, selectedModel, setSelectedModel, sendMessage, clearMessages }
}
