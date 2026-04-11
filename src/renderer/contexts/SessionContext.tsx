import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useBackend } from '../hooks/useBackend'

export interface Session {
  id: string
  name: string
  title?: string
  last_active?: number
}

interface SessionContextValue {
  sessions: Session[]
  activeSession: Session | null
  loadSessions: () => Promise<void>
  createSession: (name: string) => Promise<Session | null>
  switchSession: (session: Session) => void
  deleteSession: (id: string) => Promise<void>
  resetSession: (id: string) => Promise<void>
  // Tab bar state
  openTabs: string[]
  activeTabId: string | null
  openTab: (sessionId: string) => void
  closeTab: (sessionId: string) => void
  newTab: () => Promise<void>
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
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)

  const loadSessions = useCallback(async () => {
    try {
      const res = await apiFetch('/api/sessions')
      if (!res.ok) return
      const data = (await res.json()) as Session[]
      setSessions(data)
    } catch {
      // backend not reachable
    }
  }, [apiFetch])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // Hydration: runs once after sessions load
  useEffect(() => {
    if (hydrated || sessions.length === 0) return
    ;(async () => {
      let stored = (await window.electron?.storeGet?.('openTabs')) as string[] | null
      let storedActive = (await window.electron?.storeGet?.('activeTabId')) as string | null
      const validIds = new Set(sessions.map(s => s.id))
      let tabs = Array.isArray(stored) ? stored.filter(id => validIds.has(id)) : []
      if (tabs.length === 0) {
        const sorted = [...sessions].sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0))
        tabs = sorted[0] ? [sorted[0].id] : []
      }
      let active = storedActive && tabs.includes(storedActive) ? storedActive : tabs[0] ?? null
      setOpenTabs(tabs)
      setActiveTabIdState(active)
      if (active) {
        const s = sessions.find(x => x.id === active)
        if (s) setActiveSession(s)
      }
      setHydrated(true)
    })()
  }, [sessions, hydrated])

  // Debounced write-back to electron-store
  useEffect(() => {
    if (!hydrated) return
    const t = setTimeout(() => {
      void window.electron?.storeSet?.('openTabs', openTabs)
      void window.electron?.storeSet?.('activeTabId', activeTabId)
    }, 300)
    return () => clearTimeout(t)
  }, [openTabs, activeTabId, hydrated])

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
    setActiveTabIdState(session.id)
    setOpenTabs(prev => prev.includes(session.id) ? prev : [...prev, session.id])
  }, [])

  const openTab = useCallback((sessionId: string) => {
    setOpenTabs(prev => prev.includes(sessionId) ? prev : [...prev, sessionId])
    setActiveTabIdState(sessionId)
    const s = sessions.find(x => x.id === sessionId)
    if (s) setActiveSession(s)
  }, [sessions])

  const closeTab = useCallback((sessionId: string) => {
    setOpenTabs(prev => {
      const idx = prev.indexOf(sessionId)
      if (idx === -1) return prev
      const next = prev.filter(id => id !== sessionId)
      if (activeTabId === sessionId) {
        let fallback: string | null = null
        if (next.length > 0) {
          fallback = next[idx] ?? next[idx - 1] ?? next[0]
        } else {
          const sorted = [...sessions].sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0))
          if (sorted[0]) {
            fallback = sorted[0].id
            return [sorted[0].id]
          }
        }
        setActiveTabIdState(fallback)
        const s = fallback ? sessions.find(x => x.id === fallback) : null
        setActiveSession(s ?? null)
      }
      return next
    })
  }, [activeTabId, sessions])

  const newTab = useCallback(async () => {
    // Backend enforces unique session titles (session_service.py raises
    // ValueError on collision). HH:MM alone produces duplicates when the
    // user clicks + twice in the same minute; HH:MM:SS makes collisions
    // basically unreachable at human click speed.
    const name = `会话 ${new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })}`
    const s = await createSession(name)
    if (s) {
      setOpenTabs(prev => prev.includes(s.id) ? prev : [...prev, s.id])
      setActiveTabIdState(s.id)
    }
  }, [createSession])

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
    resetSession,
    openTabs,
    activeTabId,
    openTab,
    closeTab,
    newTab
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
