import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useBackend } from '../hooks/useBackend'

const INITIAL_LOAD_RETRY_BASE_MS = 300
const INITIAL_LOAD_RETRY_MAX_MS = 5000

export interface Session {
  id: string
  name: string
  title?: string
  last_active?: number
  archived_at?: number | null
}

interface SessionContextValue {
  sessions: Session[]
  archivedSessions: Session[]
  activeSession: Session | null
  loadSessions: () => Promise<void>
  createSession: (name: string) => Promise<Session | null>
  switchSession: (session: Session) => void
  deleteSession: (id: string) => Promise<void>
  archiveSession: (id: string) => Promise<void>
  restoreSession: (id: string) => Promise<void>
  resetSession: (id: string) => Promise<void>
  updateSessionName: (id: string, name: string) => void
  touchSession: (id: string) => void
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
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)

  const notifySessionsChanged = useCallback(() => {
    try {
      window.electron?.notifySessionsChanged?.()
    } catch {
      // Best-effort cross-window sync only.
    }
  }, [])

  const fetchSessions = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/sessions?include_archived=true')
      if (!res.ok) return false
      const data = ((await res.json()) as Session[]).map((session) => ({
        ...session,
        name: session.name || session.title || '未命名会话',
      }))
      setSessions(data.filter((session) => !session.archived_at))
      setArchivedSessions(data.filter((session) => !!session.archived_at))
      return true
    } catch {
      return false
    }
  }, [apiFetch])

  const loadSessions = useCallback(async () => {
    const ok = await fetchSessions()
    if (ok) {
      setSessionsLoaded(true)
    }
  }, [fetchSessions])

  useEffect(() => {
    if (sessionsLoaded) return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    // Electron shows the renderer before uvicorn is always ready, so an
    // initial connection-refused here should retry instead of freezing the
    // session list into an empty state for the whole app lifetime.
    const attemptLoad = async (attempt: number) => {
      const ok = await fetchSessions()
      if (cancelled) return
      if (ok) {
        setSessionsLoaded(true)
        return
      }

      const delay = Math.min(
        INITIAL_LOAD_RETRY_BASE_MS * 2 ** attempt,
        INITIAL_LOAD_RETRY_MAX_MS
      )
      retryTimer = setTimeout(() => {
        void attemptLoad(attempt + 1)
      }, delay)
    }

    void attemptLoad(0)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [fetchSessions, sessionsLoaded])

  useEffect(() => {
    const handleSessionsChanged = () => {
      void fetchSessions()
    }
    try {
      window.electron?.on?.('sessions:changed', handleSessionsChanged)
    } catch {
      return
    }
    return () => {
      try {
        window.electron?.off?.('sessions:changed', handleSessionsChanged)
      } catch {
        // ignore
      }
    }
  }, [fetchSessions])

  // Hydration: runs once after sessions load
  useEffect(() => {
    if (hydrated || !sessionsLoaded) return
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
  }, [sessions, hydrated, sessionsLoaded])

  useEffect(() => {
    const validIds = new Set(sessions.map((session) => session.id))
    const cleanedTabs = openTabs.filter((id) => validIds.has(id))

    if (cleanedTabs.length !== openTabs.length) {
      setOpenTabs(cleanedTabs)
    }

    const nextActiveTabId =
      activeTabId && validIds.has(activeTabId)
        ? activeTabId
        : cleanedTabs[0] ?? null

    if (nextActiveTabId !== activeTabId) {
      setActiveTabIdState(nextActiveTabId)
    }

    if (!nextActiveTabId) {
      if (activeSession !== null) setActiveSession(null)
      return
    }

    const nextActiveSession = sessions.find((session) => session.id === nextActiveTabId) ?? null
    if (!nextActiveSession) {
      if (activeSession !== null) setActiveSession(null)
      return
    }

    if (
      !activeSession ||
      activeSession.id !== nextActiveSession.id ||
      activeSession.name !== nextActiveSession.name ||
      activeSession.title !== nextActiveSession.title ||
      activeSession.last_active !== nextActiveSession.last_active ||
      activeSession.archived_at !== nextActiveSession.archived_at
    ) {
      setActiveSession(nextActiveSession)
    }
  }, [sessions, openTabs, activeTabId, activeSession])

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
        notifySessionsChanged()
        return session
      } catch {
        return null
      }
    },
    [apiFetch, notifySessionsChanged]
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
          const sorted = sessions
            .filter((session) => session.id !== sessionId)
            .sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0))
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

  const removeSessionFromActiveView = useCallback((id: string) => {
    const remaining = sessions.filter((session) => session.id !== id)
    const nextTabsWithoutRemoved = openTabs.filter((tabId) => tabId !== id)

    let nextTabs = nextTabsWithoutRemoved
    let nextActiveTabId = activeTabId
    let nextActiveSession = activeSession

    if (activeSession?.id === id || activeTabId === id) {
      const fallbackFromOpenTabs = nextTabsWithoutRemoved[0]
      const fallbackFromRecent = [...remaining].sort(
        (a, b) => (b.last_active ?? 0) - (a.last_active ?? 0)
      )[0]?.id ?? null
      const fallbackId = fallbackFromOpenTabs ?? fallbackFromRecent ?? null
      if (fallbackId && !nextTabsWithoutRemoved.includes(fallbackId)) {
        nextTabs = [...nextTabsWithoutRemoved, fallbackId]
      }
      nextActiveTabId = fallbackId
      nextActiveSession = fallbackId
        ? remaining.find((session) => session.id === fallbackId) ?? null
        : null
    }

    setSessions(remaining)
    setOpenTabs(nextTabs)
    setActiveTabIdState(nextActiveTabId)
    setActiveSession(nextActiveSession)
  }, [sessions, openTabs, activeTabId, activeSession])

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' })
        removeSessionFromActiveView(id)
        setArchivedSessions((prev) => prev.filter((session) => session.id !== id))
        notifySessionsChanged()
      } catch {
        // ignore
      }
    },
    [apiFetch, notifySessionsChanged, removeSessionFromActiveView]
  )

  const archiveSession = useCallback(
    async (id: string) => {
      try {
        const res = await apiFetch(`/api/sessions/${id}/archive`, { method: 'POST' })
        if (!res.ok) return
        const payload = (await res.json()) as { archived_at?: number }
        const target = sessions.find((session) => session.id === id)
        removeSessionFromActiveView(id)
        if (target) {
          setArchivedSessions((prev) => [
            { ...target, archived_at: payload.archived_at ?? Date.now() / 1000 },
            ...prev.filter((session) => session.id !== id),
          ])
        } else {
          await loadSessions()
        }
        notifySessionsChanged()
      } catch {
        // ignore
      }
    },
    [apiFetch, sessions, notifySessionsChanged, removeSessionFromActiveView, loadSessions]
  )

  const restoreSession = useCallback(
    async (id: string) => {
      try {
        const res = await apiFetch(`/api/sessions/${id}/restore`, { method: 'POST' })
        if (!res.ok) return
        const target = archivedSessions.find((session) => session.id === id)
        setArchivedSessions((prev) => prev.filter((session) => session.id !== id))
        if (target) {
          setSessions((prev) => [{ ...target, archived_at: null }, ...prev.filter((session) => session.id !== id)])
        } else {
          await loadSessions()
        }
        notifySessionsChanged()
      } catch {
        // ignore
      }
    },
    [apiFetch, archivedSessions, notifySessionsChanged, loadSessions]
  )

  const updateSessionName = useCallback((id: string, name: string) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, name } : s))
    setArchivedSessions(prev => prev.map(s => s.id === id ? { ...s, name } : s))
    setActiveSession(prev => prev?.id === id ? { ...prev, name } : prev)
    notifySessionsChanged()
  }, [notifySessionsChanged])

  const touchSession = useCallback((id: string) => {
    const now = Date.now() / 1000
    setSessions(prev => prev.map(s => s.id === id ? { ...s, last_active: now } : s))
    setArchivedSessions(prev => prev.map(s => s.id === id ? { ...s, last_active: now } : s))
    notifySessionsChanged()
  }, [notifySessionsChanged])

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
    archivedSessions,
    activeSession,
    loadSessions,
    createSession,
    switchSession,
    deleteSession,
    archiveSession,
    restoreSession,
    resetSession,
    updateSessionName,
    touchSession,
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
