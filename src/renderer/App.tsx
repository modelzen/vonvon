import React, { useState, useEffect, useRef } from 'react'
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
  const { messages: agentMessages, isLoading, usagePercent, sendMessage, thinking, stop } =
    useAgentChat(activeSession?.id)
  const [displayPercent, setDisplayPercent] = useState(0)
  // Bumps each time the main process tells us the sidebar was (re)shown,
  // so we can replay the entry animation even though the React tree doesn't
  // unmount when the BrowserWindow is hide/show'd.
  const [sidebarShowTick, setSidebarShowTick] = useState(0)
  // Same idea but for the exit animation: main sends 'kirby:sidebar-hide'
  // ~240ms before actually hiding the BrowserWindow, giving us time to play
  // a scaleX(1→0) collapse anchored at top-left.
  const [sidebarHideTick, setSidebarHideTick] = useState(0)

  useEffect(() => { setDisplayPercent(usagePercent) }, [usagePercent])

  // Listen for sidebar show/hide events from main so we can replay the CSS
  // entry/exit animations on the still-mounted React tree.
  useEffect(() => {
    if (isFloatingWindow) return
    const showHandler = (): void => setSidebarShowTick((t) => t + 1)
    const hideHandler = (): void => setSidebarHideTick((t) => t + 1)
    try {
      ;(window as any).electron?.on?.('kirby:sidebar-show', showHandler)
      ;(window as any).electron?.on?.('kirby:sidebar-hide', hideHandler)
    } catch {}
    return () => {
      try {
        ;(window as any).electron?.off?.('kirby:sidebar-show', showHandler)
        ;(window as any).electron?.off?.('kirby:sidebar-hide', hideHandler)
      } catch {}
    }
  }, [])

  // Replay the entry animation on each show-tick. CSS animations don't
  // replay on their own when the same class is already applied, so we
  // toggle it off, force reflow, then toggle back on. Also strip the
  // exit class so we don't end up with both at once.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (sidebarShowTick === 0 || isFloatingWindow) return
    const el = rootRef.current
    if (!el) return
    el.classList.remove('kirby-sidebar-exit')
    el.classList.remove('kirby-sidebar-entry')
    void el.offsetWidth
    el.classList.add('kirby-sidebar-entry')
  }, [sidebarShowTick])

  // Same dance for the exit animation. Main hides the BrowserWindow 240ms
  // after sending sidebar-hide, so by then the animation has played out
  // and the window simply disappears.
  useEffect(() => {
    if (sidebarHideTick === 0 || isFloatingWindow) return
    const el = rootRef.current
    if (!el) return
    el.classList.remove('kirby-sidebar-entry')
    el.classList.remove('kirby-sidebar-exit')
    void el.offsetWidth
    el.classList.add('kirby-sidebar-exit')
  }, [sidebarHideTick])

  return (
    <div
      ref={rootRef}
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {/* Sidebar entry animation (replayed on kirby:sidebar-show events).
          Anchored to top-LEFT so scaleX(0→1) makes the sidebar appear to
          grow rightward out of the docked vonvon ball. The ball sits at
          Feishu's top-right corner = sidebar's top-left corner, so the
          left edge stays pinned to the ball while the right edge sweeps
          out. transform-origin: top right would have made it pop from
          the wrong side. */}
      <style>{`
        @keyframes kirby-sidebar-entry {
          from { opacity: 0; transform: scaleX(0); }
          to   { opacity: 1; transform: scaleX(1); }
        }
        .kirby-sidebar-entry {
          animation: kirby-sidebar-entry 240ms cubic-bezier(0.2, 0.8, 0.3, 1);
          transform-origin: top left;
        }
        @keyframes kirby-sidebar-exit {
          from { opacity: 1; transform: scaleX(1); }
          to   { opacity: 0; transform: scaleX(0); }
        }
        .kirby-sidebar-exit {
          animation: kirby-sidebar-exit 240ms cubic-bezier(0.4, 0, 0.8, 0.2);
          transform-origin: top left;
        }
      `}</style>
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
              onClick={() => { try { (window as any).electron?.closeKirbySidebar?.() } catch {} }}
              title="收起"
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
            onStop={stop}
            toolbarLeft={<AgentModelSelector />}
            toolbarRight={<UsageRing percent={displayPercent} />}
          />
        </div>
      </div>
    </div>
  )
}

export default App
