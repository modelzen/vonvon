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
  const { sessions, openTabs, openTab, switchSession } = useSession()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(s => (s.title || s.name).toLowerCase().includes(q))
  }, [sessions, query])

  const groups = useMemo(() => groupByBucket(filtered), [filtered])

  const handlePick = (s: Session) => {
    if (openTabs.includes(s.id)) {
      switchSession(s)
    } else {
      openTab(s.id)
    }
    setOpen(false)
    setQuery('')
  }

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
            {groups.length === 0 ? (
              <div style={{ padding: '12px', fontSize: 12, color: '#aaa', textAlign: 'center' }}>无匹配会话</div>
            ) : (
              groups.map(g => (
                <div key={g.label} style={{ marginBottom: 4 }}>
                  <div style={{
                    padding: '6px 12px 4px',
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#FF69B4',
                    letterSpacing: '0.5px',
                    textTransform: 'uppercase',
                  }}>{g.label}</div>
                  {g.items.map(s => (
                    <div
                      key={s.id}
                      onClick={() => handlePick(s)}
                      style={{
                        padding: '6px 12px',
                        fontSize: 12,
                        color: '#333',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(252,228,236,0.4)' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                    >
                      {s.title || s.name}
                      {openTabs.includes(s.id) && (
                        <span style={{ marginLeft: 6, fontSize: 9, color: '#FF69B4' }}>● 已打开</span>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
