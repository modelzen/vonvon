import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useSession } from '../../hooks/useSession'
import type { Session } from '../../hooks/useSession'

function groupByBucket(sessions: Session[]): Array<{ label: string; items: Session[] }> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayTs = todayStart.getTime() / 1000
  const yesterdayTs = todayTs - 86400
  const weekTs = todayTs - 7 * 86400

  const today: Session[] = []
  const yesterday: Session[] = []
  const week: Session[] = []
  const older: Session[] = []
  for (const s of sessions) {
    const t = s.last_active ?? 0
    if (t >= todayTs) today.push(s)
    else if (t >= yesterdayTs) yesterday.push(s)
    else if (t >= weekTs) week.push(s)
    else older.push(s)
  }
  const sortDesc = (a: Session, b: Session) => (b.last_active ?? 0) - (a.last_active ?? 0)
  return [
    { label: '今天', items: today.sort(sortDesc) },
    { label: '昨天', items: yesterday.sort(sortDesc) },
    { label: '本周', items: week.sort(sortDesc) },
    { label: '更早', items: older.sort(sortDesc) },
  ].filter(g => g.items.length > 0)
}

export function SessionHistoryDropdown(): React.ReactElement {
  const {
    sessions,
    archivedSessions,
    openTabs,
    openTab,
    switchSession,
    archiveSession,
    restoreSession,
  } = useSession()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
        setShowArchived(false)
        setHoveredSessionId(null)
        setConfirmArchiveId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open) return
    setQuery('')
    setShowArchived(false)
    setHoveredSessionId(null)
    setConfirmArchiveId(null)
  }, [open])

  const activeFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(s => (s.title || s.name).toLowerCase().includes(q))
  }, [sessions, query])

  const archivedFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return archivedSessions
    return archivedSessions.filter(s => (s.title || s.name).toLowerCase().includes(q))
  }, [archivedSessions, query])

  const groups = useMemo(() => groupByBucket(activeFiltered), [activeFiltered])
  const archivedGroups = useMemo(() => groupByBucket(archivedFiltered), [archivedFiltered])
  const autoExpandedArchived = query.trim().length > 0 && archivedGroups.length > 0
  const archivedExpanded = showArchived || autoExpandedArchived
  const hasVisibleResults = groups.length > 0 || (archivedExpanded && archivedGroups.length > 0)

  const handlePick = (s: Session) => {
    if (openTabs.includes(s.id)) {
      switchSession(s)
    } else {
      openTab(s.id)
    }
    setOpen(false)
    setQuery('')
    setShowArchived(false)
    setHoveredSessionId(null)
    setConfirmArchiveId(null)
  }

  const handleArchiveClick = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    if (confirmArchiveId !== sessionId) {
      setConfirmArchiveId(sessionId)
      return
    }
    await archiveSession(sessionId)
    setConfirmArchiveId(null)
    setHoveredSessionId(null)
  }

  const handleRestoreClick = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    await restoreSession(sessionId)
    setHoveredSessionId(null)
  }

  const renderSessionGroup = (
    group: { label: string; items: Session[] },
    mode: 'active' | 'archived'
  ) => (
    <div key={`${mode}-${group.label}`} style={{ marginBottom: 4 }}>
      <div style={{
        padding: '6px 12px 4px',
        fontSize: 10,
        fontWeight: 700,
        color: mode === 'active' ? '#FF69B4' : '#d38aa5',
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
      }}>{group.label}</div>
      {group.items.map((session) => {
        const isHovered = hoveredSessionId === session.id
        const isConfirming = confirmArchiveId === session.id
        const showAction = mode === 'archived' ? isHovered : isHovered || isConfirming
        return (
          <div
            key={session.id}
            onMouseEnter={() => setHoveredSessionId(session.id)}
            onMouseLeave={() => {
              setHoveredSessionId((current) => current === session.id ? null : current)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 8px',
            }}
          >
            <div
              onClick={() => mode === 'active' && handlePick(session)}
              style={{
                flex: 1,
                padding: '6px 8px',
                fontSize: 12,
                color: mode === 'active' ? '#333' : '#777',
                cursor: mode === 'active' ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                borderRadius: 10,
                background: isHovered ? 'rgba(252,228,236,0.45)' : 'transparent',
                transition: 'background 120ms ease',
              }}
            >
              {session.title || session.name}
              {mode === 'active' && openTabs.includes(session.id) && (
                <span style={{ marginLeft: 6, fontSize: 9, color: '#FF69B4' }}>● 已打开</span>
              )}
            </div>
            <button
              onClick={(e) => {
                if (mode === 'active') {
                  void handleArchiveClick(e, session.id)
                  return
                }
                void handleRestoreClick(e, session.id)
              }}
              style={{
                border: '1px solid',
                borderColor: mode === 'active' && isConfirming ? '#ffd7dd' : '#f3d6e2',
                background: mode === 'active' && isConfirming ? '#ffecef' : '#fff',
                color: mode === 'active' && isConfirming ? '#ff4d4f' : '#5a4b52',
                borderRadius: 999,
                padding: '6px 12px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                flexShrink: 0,
                opacity: showAction ? 1 : 0,
                pointerEvents: showAction ? 'auto' : 'none',
                transform: showAction ? 'translateX(0)' : 'translateX(6px)',
                transition: 'opacity 120ms ease, transform 120ms ease',
              }}
            >
              {mode === 'active' ? (isConfirming ? '确认' : '归档线程') : '恢复'}
            </button>
          </div>
        )
      })}
    </div>
  )

  return (
    <div ref={ref} style={{ position: 'relative', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        onClick={() => setOpen(v => !v)}
        title="历史会话"
        style={{
          width: 26,
          height: 26,
          border: 'none',
          background: 'transparent',
          color: open ? '#FF69B4' : '#9e9e9e',
          cursor: 'pointer',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.color = '#FF69B4' }}
        onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.color = '#9e9e9e' }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 260,
            maxHeight: 360,
            background: '#fff',
            border: '1px solid #fce4ec',
            borderRadius: 12,
            boxShadow: '0 8px 28px -10px rgba(255,20,147,0.25)',
            zIndex: 1000,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid #fce4ec' }}>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索会话..."
              style={{
                width: '100%',
                padding: '6px 10px',
                fontSize: 12,
                border: '1px solid #fce4ec',
                borderRadius: 8,
                outline: 'none',
                color: '#333',
                background: '#fff5f9',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ overflowY: 'auto', flex: 1, padding: '6px 0' }}>
            {groups.map((group) => renderSessionGroup(group, 'active'))}

            {archivedSessions.length > 0 && (
              <div style={{ marginTop: groups.length > 0 ? 6 : 0, paddingTop: groups.length > 0 ? 4 : 0, borderTop: groups.length > 0 ? '1px solid #fdf1f5' : 'none' }}>
                <button
                  onClick={() => setShowArchived((value) => !value)}
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    color: '#9b6b7f',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  <span>已归档</span>
                  <span>
                    {autoExpandedArchived ? `匹配 ${archivedFiltered.length}` : archivedExpanded ? '收起' : `查看 ${archivedSessions.length}`}
                  </span>
                </button>
                {archivedExpanded && archivedGroups.map((group) => renderSessionGroup(group, 'archived'))}
              </div>
            )}

            {!hasVisibleResults && (
              <div style={{ padding: '12px', fontSize: 12, color: '#aaa', textAlign: 'center' }}>
                {query.trim() ? '无匹配会话' : archivedSessions.length > 0 ? '暂无未归档会话' : '暂无会话'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
