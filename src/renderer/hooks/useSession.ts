import { useState, useCallback, useEffect } from 'react'
import { useBackend } from './useBackend'

export interface Session {
  id: string
  name: string
  title?: string
  last_active?: string
}

export function useSession() {
  const { apiFetch } = useBackend()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      const res = await apiFetch('/api/sessions')
      if (!res.ok) return
      const data = await res.json() as Session[]
      setSessions(data)
      if (data.length > 0 && !activeSession) {
        setActiveSession(data[0])
      } else if (data.length === 0 && !activeSession) {
        // Auto-create a default session so InputArea can send immediately.
        // Otherwise the user has to manually click "+ 新建会话" before any
        // message will be delivered (InputArea silently no-ops without
        // activeSession).
        try {
          const created = await apiFetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '默认会话' })
          })
          if (created.ok) {
            const session = await created.json() as Session
            setSessions([session])
            setActiveSession(session)
          }
        } catch {
          // backend may be mid-startup or disabled
        }
      }
    } catch {
      // backend not reachable
    }
  }, [apiFetch, activeSession])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const createSession = useCallback(
    async (name: string): Promise<Session | null> => {
      try {
        const res = await apiFetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        })
        if (!res.ok) return null
        const session = await res.json() as Session
        setSessions((prev) => [...prev, session])
        setActiveSession(session)
        return session
      } catch {
        return null
      }
    },
    [apiFetch]
  )

  const switchSession = useCallback((session: Session) => {
    setActiveSession(session)
  }, [])

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' })
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (activeSession?.id === id) {
          setActiveSession((prev) => {
            const remaining = sessions.filter((s) => s.id !== id)
            return remaining.length > 0 ? remaining[0] : null
          })
        }
      } catch {
        // ignore
      }
    },
    [apiFetch, activeSession, sessions]
  )

  const resetSession = useCallback(
    async (id: string) => {
      try {
        await apiFetch(`/api/sessions/${id}/reset`, { method: 'POST' })
      } catch {
        // ignore
      }
    },
    [apiFetch]
  )

  return { sessions, activeSession, loadSessions, createSession, switchSession, deleteSession, resetSession }
}
