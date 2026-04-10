import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useBackend } from '../hooks/useBackend'

export interface Session {
  id: string
  name: string
  title?: string
  last_active?: string
}

interface SessionContextValue {
  sessions: Session[]
  activeSession: Session | null
  loadSessions: () => Promise<void>
  createSession: (name: string) => Promise<Session | null>
  switchSession: (session: Session) => void
  deleteSession: (id: string) => Promise<void>
  resetSession: (id: string) => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

/**
 * Provider owns the one-and-only session state for the entire renderer.
 *
 * WHY this exists: before this provider existed, `useSession()` was a plain
 * hook called independently from both `App.tsx` and `SessionSwitcher.tsx`.
 * Each call created its own state instance, so clicking a session in the
 * switcher never propagated to App's `activeSession`. `<InputArea>`'s
 * `onSend` callback then silently no-oped (`if (activeSession) ...`) and
 * the backend never saw `POST /api/chat/send`. Sharing via Context fixes
 * that by making every consumer read the same state.
 */
export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { apiFetch } = useBackend()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      const res = await apiFetch('/api/sessions')
      if (!res.ok) return
      const data = (await res.json()) as Session[]
      setSessions(data)
      if (data.length > 0 && !activeSession) {
        setActiveSession(data[0])
      } else if (data.length === 0 && !activeSession) {
        // Auto-create a default session so InputArea can send immediately.
        try {
          const created = await apiFetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '默认会话' })
          })
          if (created.ok) {
            const session = (await created.json()) as Session
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
        const session = (await res.json()) as Session
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
        setSessions((prev) => {
          const remaining = prev.filter((s) => s.id !== id)
          if (activeSession?.id === id) {
            setActiveSession(remaining.length > 0 ? remaining[0] : null)
          }
          return remaining
        })
      } catch {
        // ignore
      }
    },
    [apiFetch, activeSession]
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

  const value: SessionContextValue = {
    sessions,
    activeSession,
    loadSessions,
    createSession,
    switchSession,
    deleteSession,
    resetSession
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/**
 * Consumer hook — MUST be used inside a <SessionProvider>.
 *
 * All components that care about the active session (App, SessionSwitcher,
 * future usage hooks, etc.) read through this so they always see the same
 * state instance.
 */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error('useSession() must be used inside <SessionProvider>')
  }
  return ctx
}
