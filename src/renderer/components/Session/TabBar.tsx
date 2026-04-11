import React from 'react'
import { useSession } from '../../hooks/useSession'

export function TabBar(): React.ReactElement {
  const { sessions, openTabs, activeTabId, switchSession, closeTab } = useSession()

  const tabs = openTabs
    .map(id => sessions.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flex: 1,
        minWidth: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
      }}
      className="vonvon-tab-bar-scroll"
    >
      {tabs.map(s => {
        const active = s.id === activeTabId
        return (
          <div
            key={s.id}
            onClick={() => switchSession(s)}
            title={s.title || s.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 11px 9px 11px',
              background: active ? '#fff' : 'transparent',
              border: active ? '1px solid #fce4ec' : '1px solid transparent',
              borderRadius: '10px 10px 0 0',
              borderBottom: '1px solid transparent',
              marginBottom: -1,
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              color: active ? '#d81b60' : '#9e9e9e',
              cursor: 'pointer',
              maxWidth: 130,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flexShrink: 0,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.title || s.name}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(s.id) }}
              title="关闭标签"
              style={{
                marginLeft: 2,
                width: 14,
                height: 14,
                borderRadius: 3,
                border: 'none',
                background: 'transparent',
                color: '#bbb',
                fontSize: 11,
                lineHeight: 1,
                cursor: 'pointer',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#FF1493' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#bbb' }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
