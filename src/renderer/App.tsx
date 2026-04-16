import React, { useState, useEffect, useRef } from 'react'
import { TabBar } from './components/Session/TabBar'
import { SessionHistoryDropdown } from './components/Session/SessionHistoryDropdown'
import { useAgentChat } from './hooks/useAgentChat'
import { useSession } from './hooks/useSession'
import { CompressHint } from './components/Chat/CompressHint'
import { InputArea } from './components/Chat/InputArea'
import {
  AgentMessageList,
  getLatestTodoMessage,
  TodoPanel
} from './components/Chat/AgentMessageList'
import { UsageRing } from './components/Chat/UsageRing'
import { AgentModelSelector } from './components/Chat/AgentModelSelector'
import { VONVON_INSPECT_MESSAGE } from './lib/vonvonInspect'

// `#floating` is set by windows.ts when opening the standalone chat window;
// we use it to (a) leave room for macOS traffic lights in the header and
// (b) hide the ✕ detach button, which is meaningless in standalone mode.
const isFloatingWindow = window.location.hash === '#floating'
const TODO_COLLAPSED_OVERLAP_PX = 32
const TODO_EXPANDED_OVERLAP_PX = 12
const TODO_VISIBLE_GAP_PX = 14
const TODO_SIDE_INSET_PX = 28

interface LarkInspectWindow {
  x: number
  y: number
  width: number
  height: number
  windowId: number
  windowTitle?: string
}

type InspectBannerTone = 'loading' | 'success' | 'warning' | 'error'

interface InspectBannerState {
  tone: InspectBannerTone
  message: string
}

function App(): React.ReactElement {
  const { activeSession, newTab, updateSessionName, touchSession } = useSession()
  const { messages: agentMessages, isLoading, usagePercent, sendMessage, thinking, stop } =
    useAgentChat(activeSession?.id, {
      sessionName: activeSession?.name,
      onTitleUpdate: (title) => {
        if (activeSession) updateSessionName(activeSession.id, title)
      },
      onRunCompleted: () => {
        if (activeSession) touchSession(activeSession.id)
      },
    })
  const [displayPercent, setDisplayPercent] = useState(0)
  // Bumps each time the main process tells us the sidebar was (re)shown,
  // so we can replay the entry animation even though the React tree doesn't
  // unmount when the BrowserWindow is hide/show'd.
  const [sidebarShowTick, setSidebarShowTick] = useState(0)
  // Same idea but for the exit animation: main sends 'kirby:sidebar-hide'
  // ~240ms before actually hiding the BrowserWindow, giving us time to play
  // a scaleX(1→0) collapse anchored at top-left.
  const [sidebarHideTick, setSidebarHideTick] = useState(0)
  const [todoBottomInset, setTodoBottomInset] = useState(0)
  const [todoCollapsed, setTodoCollapsed] = useState(false)
  const [inspectBanner, setInspectBanner] = useState<InspectBannerState | null>(null)
  const todoOverlayRef = useRef<HTMLDivElement>(null)
  const activeSessionIdRef = useRef<string | null>(activeSession?.id ?? null)
  const inspectInFlightRef = useRef(false)
  const latestTodoMessage = getLatestTodoMessage(agentMessages)
  const todoOverlapPx = todoCollapsed ? TODO_COLLAPSED_OVERLAP_PX : TODO_EXPANDED_OVERLAP_PX

  useEffect(() => { setDisplayPercent(usagePercent) }, [usagePercent])
  useEffect(() => {
    activeSessionIdRef.current = activeSession?.id ?? null
  }, [activeSession?.id])

  useEffect(() => {
    setInspectBanner(null)
  }, [activeSession?.id])

  useEffect(() => {
    if (!inspectBanner || inspectBanner.tone === 'loading') return
    const timeoutMs = inspectBanner.tone === 'error' ? 5000 : 3200
    const timer = window.setTimeout(() => {
      setInspectBanner((current) => (current === inspectBanner ? null : current))
    }, timeoutMs)
    return () => window.clearTimeout(timer)
  }, [inspectBanner])

  useEffect(() => {
    if (isFloatingWindow) return

    const dockedClickHandler = (payload?: unknown): void => {
      const sessionId = activeSessionIdRef.current
      if (!sessionId || !payload || typeof payload !== 'object') return
      if (inspectInFlightRef.current) return
      if (isLoading) {
        setInspectBanner({
          tone: 'warning',
          message: '上一条消息还在处理中，等我先回复完再看新的协同上下文。',
        })
        return
      }

      const windowInfo = payload as LarkInspectWindow
      inspectInFlightRef.current = true
      setInspectBanner({ tone: 'loading', message: '正在发送当前 Lark 窗口截图…' })

      void (async () => {
        try {
          const screenshotDataUrl = await window.electron.captureLarkWindow(windowInfo.windowId)
          if (!screenshotDataUrl) {
            throw new Error('还没有拿到 Lark 窗口截图，请先确认录屏权限已经授予')
          }
          if (activeSessionIdRef.current !== sessionId) return
          sendMessage(
            VONVON_INSPECT_MESSAGE,
            sessionId,
            [{ type: 'image', dataUrl: screenshotDataUrl, name: 'vonvon-inspect-lark.png' }],
            ['vonvon-inspect']
          )
          setInspectBanner({
            tone: 'success',
            message: '已发送当前截图，我先结合相关 skills 主动帮你看一眼。',
          })
        } catch (error) {
          if (activeSessionIdRef.current !== sessionId) return
          setInspectBanner({
            tone: 'error',
            message: `发送协同上下文失败：${(error as Error).message}`,
          })
        } finally {
          inspectInFlightRef.current = false
        }
      })()
    }

    try {
      ;(window as any).electron?.on?.('kirby:docked-click', dockedClickHandler)
    } catch {}
    return () => {
      try {
        ;(window as any).electron?.off?.('kirby:docked-click', dockedClickHandler)
      } catch {}
    }
  }, [isLoading, sendMessage])

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

  useEffect(() => {
    setTodoCollapsed(false)
  }, [latestTodoMessage?.id, activeSession?.id])

  useEffect(() => {
    if (!latestTodoMessage) {
      setTodoBottomInset(0)
      return
    }

    const el = todoOverlayRef.current
    if (!el) return

    const updateInset = () => {
      const height = Math.ceil(el.getBoundingClientRect().height)
      const visibleHeight = Math.max(0, height - todoOverlapPx)
      setTodoBottomInset(visibleHeight + TODO_VISIBLE_GAP_PX)
    }

    updateInset()
    const observer = new ResizeObserver(() => {
      updateInset()
    })
    observer.observe(el)
    window.addEventListener('resize', updateInset)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateInset)
    }
  }, [
    latestTodoMessage?.id,
    latestTodoMessage?.toolPreview,
    latestTodoMessage?.toolStatus,
    latestTodoMessage?.toolDuration,
    todoOverlapPx
  ])

  return (
    <div
      ref={rootRef}
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background:
          'linear-gradient(180deg, #fffdfd 0%, #fff8fb 44%, #f8f5fb 100%)'
      }}
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
          <AgentMessageList
            messages={agentMessages}
            isLoading={isLoading}
            thinking={thinking}
            bottomInset={todoBottomInset}
          />
          {activeSession && (
            <CompressHint percent={displayPercent} sessionId={activeSession.id} onCompressed={setDisplayPercent} />
          )}
          <div style={{ position: 'relative', zIndex: 2, flexShrink: 0 }}>
            {latestTodoMessage && (
              <div
                style={{
                  position: 'absolute',
                  left: TODO_SIDE_INSET_PX,
                  right: TODO_SIDE_INSET_PX,
                  bottom: `calc(100% - ${todoOverlapPx}px)`,
                  zIndex: 0,
                  pointerEvents: 'none'
                }}
              >
                <div ref={todoOverlayRef} style={{ pointerEvents: 'auto' }}>
                  <TodoPanel
                    msg={latestTodoMessage}
                    floating
                    collapsed={todoCollapsed}
                    onToggleCollapse={() => setTodoCollapsed((prev) => !prev)}
                  />
                </div>
              </div>
            )}
            <div style={{ position: 'relative', zIndex: 1 }}>
              {inspectBanner && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: '0 12px 8px',
                  }}
                >
                  {inspectBanner && (
                    <div
                      style={{
                        padding: '10px 12px',
                        borderRadius: 14,
                        border: `1px solid ${
                          inspectBanner.tone === 'error'
                            ? '#f4b4c0'
                            : inspectBanner.tone === 'warning'
                              ? '#f3d4a4'
                              : '#f5d5e7'
                        }`,
                        background:
                          inspectBanner.tone === 'error'
                            ? 'rgba(255, 240, 244, 0.96)'
                            : inspectBanner.tone === 'warning'
                              ? 'rgba(255, 249, 236, 0.96)'
                              : 'rgba(255, 248, 252, 0.96)',
                        color:
                          inspectBanner.tone === 'error'
                            ? '#9f3e58'
                            : inspectBanner.tone === 'warning'
                              ? '#8d6221'
                              : '#6f4d60',
                        fontSize: 13,
                        lineHeight: 1.4,
                      }}
                    >
                      {inspectBanner.message}
                    </div>
                  )}
                </div>
              )}
              <InputArea
                onSend={(msg, skills) => { if (activeSession) sendMessage(msg, activeSession.id, undefined, skills) }}
                onSendWithAttachments={(msg, atts, skills) => { if (activeSession) sendMessage(msg, activeSession.id, atts, skills) }}
                isLoading={isLoading}
                onStop={stop}
                toolbarLeft={<AgentModelSelector />}
                toolbarRight={<UsageRing percent={displayPercent} />}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
