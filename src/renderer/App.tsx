import React, { useState, useEffect } from 'react'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { ChatContainer } from './components/Chat/ChatContainer'
import { SessionSwitcher } from './components/Session/SessionSwitcher'
import { useAgentChat } from './hooks/useAgentChat'
import { useSession } from './hooks/useSession'
import { UsageBar } from './components/Chat/UsageBar'
import { CompressHint } from './components/Chat/CompressHint'
import { InputArea } from './components/Chat/InputArea'

function App(): React.ReactElement {
  const [showSettings, setShowSettings] = useState(false)
  const [backendEnabled, setBackendEnabled] = useState(false)
  const { messages: agentMessages, isLoading, usagePercent, sendMessage } = useAgentChat()
  const { activeSession } = useSession()
  const [displayPercent, setDisplayPercent] = useState(0)

  useEffect(() => { setDisplayPercent(usagePercent) }, [usagePercent])

  const refreshBackendConfig = () => {
    window.electron.getBackendConfig().then((cfg) => setBackendEnabled(cfg.enabled))
  }

  useEffect(() => {
    refreshBackendConfig()
  }, [])

  if (showSettings) {
    // Re-read backend config on close so toggling "启用 Agent 模式" in
    // Settings takes effect immediately instead of requiring an app restart.
    return <SettingsPanel onBack={() => { refreshBackendConfig(); setShowSettings(false) }} />
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid #fce4ec',
        background: 'rgba(255,255,255,0.92)', flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px',
            background: 'linear-gradient(135deg, #FF69B4, #FF1493)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
          }}>Vonvon</span>
          {backendEnabled && <SessionSwitcher />}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button onClick={() => setShowSettings(true)} title="设置"
            style={{ width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'rgba(255,105,180,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FF69B4', fontSize: 14 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          </button>
          <button onClick={() => { try { (window as any).electron?.detachKirby?.() } catch {} }} title="脱离"
            style={{ width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'rgba(255,105,180,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FF69B4', fontSize: 12 }}>
            ✕
          </button>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        {backendEnabled ? (
          <>
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', minHeight: 0 }}>
              {agentMessages.map((msg) => (
                <div key={msg.id} style={{
                  marginBottom: 10, display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start'
                }}>
                  <div style={{
                    maxWidth: '80%', padding: '8px 12px', borderRadius: 12, fontSize: 13,
                    background: msg.role === 'user'
                      ? 'linear-gradient(135deg, #FF69B4, #FF1493)'
                      : msg.role === 'tool' ? 'rgba(100,100,100,0.06)' : '#fff',
                    color: msg.role === 'user' ? '#fff' : '#333',
                    border: msg.role !== 'user' ? '1px solid #fce4ec' : 'none'
                  }}>
                    {msg.role === 'tool' && (
                      <span style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 2 }}>
                        🔧 {msg.toolName} {msg.toolStatus === 'running' ? '⟳' : msg.toolStatus === 'completed' ? '✓' : '✗'}
                      </span>
                    )}
                    {msg.content || (msg.role === 'assistant' && isLoading ? '…' : '')}
                  </div>
                </div>
              ))}
            </div>
            {activeSession && (
              <CompressHint percent={displayPercent} sessionId={activeSession.id} onCompressed={setDisplayPercent} />
            )}
            <UsageBar percent={displayPercent} />
            <InputArea
              onSend={(msg) => { if (activeSession) sendMessage(msg, activeSession.id) }}
              isLoading={isLoading}
            />
          </>
        ) : (
          <ChatContainer />
        )}
      </div>
    </div>
  )
}

export default App
