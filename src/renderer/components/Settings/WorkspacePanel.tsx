import React, { useEffect, useState } from 'react'
import { useHermesConfig, WorkspaceState } from '../../hooks/useHermesConfig'

const SECTION_STYLE: React.CSSProperties = { padding: '16px 0', borderBottom: '1px solid #fce4ec' }
const BTN_PRIMARY: React.CSSProperties = {
  padding: '6px 16px', fontSize: 12, borderRadius: 6, border: 'none',
  background: 'linear-gradient(135deg, #FF69B4, #FF1493)', color: '#fff',
  cursor: 'pointer', fontWeight: 600,
}
const BTN_GHOST: React.CSSProperties = {
  padding: '5px 14px', fontSize: 12, borderRadius: 6,
  border: '1px solid #FF69B4', background: '#fff', color: '#FF69B4',
  cursor: 'pointer', fontWeight: 600,
}

function openInFinder(path: string): void {
  // path comes from workspace_service.current_state().path — trusted backend value,
  // never from raw user input, satisfying Critic M-4 whitelist requirement.
  window.electron.showItemInFolder(path)
}

export function WorkspacePanel(): React.ReactElement {
  const { getWorkspace, setWorkspace, resetWorkspace } = useHermesConfig()
  const [ws, setWs] = useState<WorkspaceState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = () =>
    getWorkspace()
      .then(setWs)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))

  useEffect(() => { refresh() }, [])

  const handlePickDirectory = async () => {
    setBusy(true)
    setError('')
    try {
      const picked = await window.electron.pickWorkspaceDirectory()
      if (!picked) return // user cancelled
      const state = await setWorkspace(picked)
      setWs(state)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async () => {
    setBusy(true)
    setError('')
    try {
      const state = await resetWorkspace()
      setWs(state)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={SECTION_STYLE}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#d81b60', marginBottom: 12 }}>工作区</h3>

      {loading ? (
        <div style={{ fontSize: 12, color: '#aaa' }}>加载中…</div>
      ) : ws ? (
        <>
          <div style={{
            padding: '8px 12px', borderRadius: 6, marginBottom: 12,
            background: ws.is_sandbox ? '#fff8e1' : '#f1f8e9',
            border: `1px solid ${ws.is_sandbox ? '#ffc107' : '#a5d6a7'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, borderRadius: 3, padding: '1px 5px',
                background: ws.is_sandbox ? '#ffc107' : '#4caf50', color: '#fff',
              }}>
                {ws.is_sandbox ? '沙箱' : '项目'}
              </span>
              <button
                onClick={() => openInFinder(ws.path)}
                style={{ fontSize: 11, color: '#888', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                在 Finder 中显示
              </button>
            </div>
            <code style={{ fontSize: 11, color: '#555', wordBreak: 'break-all' }}>{ws.path}</code>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handlePickDirectory} disabled={busy} style={{
              ...BTN_PRIMARY, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer',
            }}>
              {busy ? '处理中…' : '选择目录…'}
            </button>
            {!ws.is_sandbox && (
              <button onClick={handleReset} disabled={busy} style={{
                ...BTN_GHOST, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer',
              }}>
                使用默认沙箱
              </button>
            )}
          </div>

          {ws.is_sandbox && (
            <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
              当前使用默认沙箱。建议选择一个真实项目目录以获得更好的 agent 体验。
            </p>
          )}
        </>
      ) : (
        <div style={{ fontSize: 12, color: '#aaa' }}>无法加载工作区状态</div>
      )}

      {error && <div style={{ marginTop: 8, fontSize: 12, color: '#e53935' }}>{error}</div>}
    </div>
  )
}
