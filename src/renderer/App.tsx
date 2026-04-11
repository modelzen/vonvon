import React, { useState, useEffect } from 'react'
import { TabBar } from './components/Session/TabBar'
import { SessionHistoryDropdown } from './components/Session/SessionHistoryDropdown'
import { useAgentChat } from './hooks/useAgentChat'
import { useSession } from './hooks/useSession'
import { CompressHint } from './components/Chat/CompressHint'
import { InputArea } from './components/Chat/InputArea'
import { AgentMessageList } from './components/Chat/AgentMessageList'
import { UsageRing } from './components/Chat/UsageRing'
import { AgentModelSelector } from './components/Chat/AgentModelSelector'

// `#floating` is set by windows.ts when opening the standalone chat window;
// we use it to (a) leave room for macOS traffic lights in the header and
// (b) hide the ✕ detach button, which is meaningless in standalone mode.
const isFloatingWindow = window.location.hash === '#floating'

function App(): React.ReactElement {
  const { activeSession, newTab } = useSession()
  const { messages: agentMessages, isLoading, usagePercent, sendMessage, thinking } =
    useAgentChat(activeSession?.id)
  const [displayPercent, setDisplayPercent] = useState(0)

  useEffect(() => { setDisplayPercent(usagePercent) }, [usagePercent])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 6,
        // Floating (standalone) window uses titleBarStyle: 'hiddenInset', so
        // we need ~86px left padding to clear the macOS traffic lights.
        // The Feishu-snapped sidebar is frameless and needs no padding.
        padding: isFloatingWindow ? '10px 10px 0 86px' : '10px 10px 0',
        borderBottom: '1px solid #fce4ec',
        background: 'rgba(255,255,255,0.92)', flexShrink: 0,
        WebkitAppRegion: isFloatingWindow ? 'drag' : 'no-drag',
      } as React.CSSProperties}>
        {/* Scrollable tab strip — individual tabs use margin-bottom: -1 to
            sit flush with the header's border-bottom. */}
        <TabBar />
        {/* Right-aligned icon group — fixed so it's always visible even
            when the tab strip overflows horizontally. paddingBottom keeps
            it aligned with the tab baseline. */}
        <div style={{
          display: 'flex', gap: 2, alignItems: 'center',
          paddingBottom: 4,
          flexShrink: 0,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}>
          <button
            onClick={() => { void newTab() }}
            title="新建会话"
            style={{
              width: 26, height: 26,
              border: 'none',
              background: 'transparent',
              color: '#FF69B4',
              cursor: 'pointer',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(252,228,236,0.6)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <SessionHistoryDropdown />
          {!isFloatingWindow && (
            <button
              onClick={() => { try { (window as any).electron?.detachKirby?.() } catch {} }}
              title="脱离"
              style={{
                width: 26, height: 26,
                border: 'none',
                background: 'transparent',
                color: '#9e9e9e',
                cursor: 'pointer',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                fontSize: 12,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#FF69B4'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(252,228,236,0.6)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#9e9e9e'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', minHeight: 0, position: 'relative'
        }}>
          <AgentMessageList messages={agentMessages} isLoading={isLoading} thinking={thinking} />
          {activeSession && (
            <CompressHint percent={displayPercent} sessionId={activeSession.id} onCompressed={setDisplayPercent} />
          )}
          <InputArea
            onSend={(msg) => { if (activeSession) sendMessage(msg, activeSession.id) }}
            onSendWithAttachments={(msg, atts) => { if (activeSession) sendMessage(msg, activeSession.id, atts) }}
            isLoading={isLoading}
            toolbarLeft={<AgentModelSelector />}
            toolbarRight={<UsageRing percent={displayPercent} />}
          />
        </div>
      </div>
    </div>
  )
}

export default App
