import React, { useState, useRef, useEffect } from 'react'
import { useSession } from '../../hooks/useSession'
import type { Session } from '../../hooks/useSession'

export function SessionSwitcher(): React.ReactElement {
  const { sessions, activeSession, createSession, switchSession, deleteSession } = useSession()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setNewName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleStartNew = () => {
    setCreating(true)
    setNewName(`会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`)
  }

  const handleConfirmNew = async () => {
    const name = newName.trim()
    if (!name) return
    await createSession(name)
    setCreating(false)
    setNewName('')
    setOpen(false)
  }

  const handleCancelNew = () => {
    setCreating(false)
    setNewName('')
  }

  const handleSwitch = (session: Session) => {
    switchSession(session)
    setOpen(false)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await deleteSession(id)
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          fontSize: 13,
          fontWeight: 600,
          border: '1px solid #fce4ec',
          borderRadius: 8,
          background: 'rgba(252,228,236,0.5)',
          color: '#d81b60',
          cursor: 'pointer',
          minWidth: 120,
          justifyContent: 'space-between'
        }}
      >
        <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeSession?.title || activeSession?.name || '选择会话'}
        </span>
        <span style={{ fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 200,
            background: '#fff',
            border: '1px solid #fce4ec',
            borderRadius: 10,
            boxShadow: '0 4px 16px rgba(255,105,180,0.15)',
            zIndex: 1000,
            overflow: 'hidden'
          }}
        >
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => handleSwitch(session)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                fontSize: 13,
                cursor: 'pointer',
                background: activeSession?.id === session.id ? 'rgba(252,228,236,0.6)' : 'transparent',
                color: '#333'
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(252,228,236,0.4)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = activeSession?.id === session.id ? 'rgba(252,228,236,0.6)' : 'transparent' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {activeSession?.id === session.id && (
                  <span style={{ color: '#FF69B4', fontSize: 12 }}>✓</span>
                )}
                <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.title || session.name}
                </span>
              </span>
              <button
                onClick={(e) => handleDelete(e, session.id)}
                title="删除会话"
                style={{
                  padding: '1px 6px',
                  fontSize: 11,
                  border: 'none',
                  background: 'transparent',
                  color: '#bbb',
                  cursor: 'pointer',
                  borderRadius: 4
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f44336' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#bbb' }}
              >
                🗑
              </button>
            </div>
          ))}

          {sessions.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12, color: '#aaa' }}>
              暂无会话
            </div>
          )}

          {/* New session: inline input (window.prompt is blocked in Electron renderer) */}
          {creating ? (
            <div
              style={{
                padding: '8px 10px',
                borderTop: '1px solid #fce4ec',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(252,228,236,0.25)'
              }}
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void handleConfirmNew() }
                  else if (e.key === 'Escape') { handleCancelNew() }
                }}
                placeholder="会话名称"
                style={{
                  flex: 1,
                  padding: '4px 8px',
                  fontSize: 12,
                  border: '1px solid #fce4ec',
                  borderRadius: 6,
                  outline: 'none',
                  color: '#333',
                  background: '#fff',
                  minWidth: 0
                }}
              />
              <button
                onClick={() => { void handleConfirmNew() }}
                disabled={!newName.trim()}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  border: 'none',
                  borderRadius: 6,
                  background: 'linear-gradient(135deg, #FF69B4, #FF1493)',
                  color: '#fff',
                  cursor: newName.trim() ? 'pointer' : 'default',
                  fontWeight: 600,
                  opacity: newName.trim() ? 1 : 0.5,
                  flexShrink: 0
                }}
              >确定</button>
              <button
                onClick={handleCancelNew}
                style={{
                  padding: '4px 8px',
                  fontSize: 12,
                  border: '1px solid #fce4ec',
                  borderRadius: 6,
                  background: '#fff',
                  color: '#777',
                  cursor: 'pointer',
                  flexShrink: 0
                }}
              >取消</button>
            </div>
          ) : (
            <div
              onClick={handleStartNew}
              style={{
                padding: '8px 12px',
                fontSize: 13,
                color: '#FF69B4',
                cursor: 'pointer',
                borderTop: '1px solid #fce4ec',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(252,228,236,0.3)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              <span>+</span>
              <span>新建会话</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
