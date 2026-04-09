import React, { useEffect, useState } from 'react'
import { useHermesConfig, McpServerConfig, McpServerView, McpProbeResult } from '../../hooks/useHermesConfig'

const SECTION_STYLE: React.CSSProperties = { padding: '16px 0', borderBottom: '1px solid #fce4ec' }
const LABEL_STYLE: React.CSSProperties = { fontSize: 12, color: '#555', display: 'block', marginBottom: 4 }
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12,
  border: '1px solid #fce4ec', borderRadius: 6, outline: 'none', boxSizing: 'border-box',
}
const BTN_PRIMARY: React.CSSProperties = {
  padding: '6px 16px', fontSize: 12, borderRadius: 6, border: 'none',
  background: 'linear-gradient(135deg, #FF69B4, #FF1493)', color: '#fff',
  cursor: 'pointer', fontWeight: 600,
}
const BTN_GHOST: React.CSSProperties = {
  padding: '5px 12px', fontSize: 12, borderRadius: 6,
  border: '1px solid #FF69B4', background: '#fff', color: '#FF69B4',
  cursor: 'pointer', fontWeight: 600,
}

// ── Probe result modal ───────────────────────────────────────────────────────

function ProbeModal({ result, name, onClose }: { result: McpProbeResult; name: string; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: 20, width: 340, maxHeight: '70vh',
        overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h4 style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 12 }}>
          {name} — {result.ok ? `✓ 连接成功 (${result.latency_ms}ms)` : '✗ 连接失败'}
        </h4>
        {result.error && (
          <div style={{ fontSize: 12, color: '#e53935', marginBottom: 10 }}>{result.error}</div>
        )}
        {result.tools.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
              工具列表 ({result.tools.length}):
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.tools.map((t) => (
                <div key={t.name} style={{ fontSize: 11, padding: '4px 8px', background: '#f9f9f9', borderRadius: 4 }}>
                  <strong>{t.name}</strong>
                  {t.description && <span style={{ color: '#777', marginLeft: 4 }}>{t.description}</span>}
                </div>
              ))}
            </div>
          </>
        )}
        <button onClick={onClose} style={{ ...BTN_GHOST, width: '100%', marginTop: 16 }}>关闭</button>
      </div>
    </div>
  )
}

// ── Add server drawer ────────────────────────────────────────────────────────

function AddDrawer({ onAdded, onClose }: { onAdded: (s: McpServerView) => void; onClose: () => void }) {
  const { addMcpServer } = useHermesConfig()
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [argsRaw, setArgsRaw] = useState('')
  const [probe, setProbe] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const handleAdd = async () => {
    if (!name.trim()) { setError('服务器名称不能为空'); return }
    setAdding(true)
    setError('')
    try {
      const cfg: McpServerConfig = { name: name.trim() }
      if (transport === 'http') {
        cfg.url = url.trim()
      } else {
        cfg.command = command.trim()
        if (argsRaw.trim()) cfg.args = argsRaw.trim().split(/\s+/)
      }
      const server = await addMcpServer(cfg, probe)
      onAdded(server)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 900,
    }}>
      <div style={{
        background: '#fff', borderRadius: '12px 12px 0 0', padding: 20,
        width: '100%', maxWidth: 480, boxShadow: '0 -4px 20px rgba(0,0,0,0.12)',
      }}>
        <h4 style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 14 }}>添加 MCP 服务器</h4>

        <div style={{ marginBottom: 10 }}>
          <label style={LABEL_STYLE}>名称（字母/数字/-/_，最多32位）</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" style={INPUT_STYLE} />
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {(['http', 'stdio'] as const).map((t) => (
            <button key={t} onClick={() => setTransport(t)} style={{
              ...BTN_GHOST,
              background: transport === t ? '#FF69B4' : '#fff',
              color: transport === t ? '#fff' : '#FF69B4',
            }}>
              {t === 'http' ? 'HTTP' : 'Stdio'}
            </button>
          ))}
        </div>

        {transport === 'http' ? (
          <div style={{ marginBottom: 10 }}>
            <label style={LABEL_STYLE}>URL</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000" style={INPUT_STYLE} />
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 10 }}>
              <label style={LABEL_STYLE}>命令</label>
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" style={INPUT_STYLE} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={LABEL_STYLE}>参数（空格分隔）</label>
              <input value={argsRaw} onChange={(e) => setArgsRaw(e.target.value)}
                placeholder="@modelcontextprotocol/server-filesystem /tmp" style={INPUT_STYLE} />
            </div>
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <input type="checkbox" id="mcp-probe" checked={probe} onChange={(e) => setProbe(e.target.checked)} />
          <label htmlFor="mcp-probe" style={{ fontSize: 12, color: '#555', cursor: 'pointer' }}>
            保存时测试连接
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleAdd} disabled={adding} style={{ ...BTN_PRIMARY, opacity: adding ? 0.6 : 1 }}>
            {adding ? '连接测试中…' : '保存'}
          </button>
          <button onClick={onClose} style={BTN_GHOST}>取消</button>
        </div>

        {error && <div style={{ marginTop: 10, fontSize: 12, color: '#e53935' }}>{error}</div>}
      </div>
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function McpServerPanel(): React.ReactElement {
  const { listMcpServers, removeMcpServer, testMcpServer } = useHermesConfig()
  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [probeResult, setProbeResult] = useState<{ name: string; result: McpProbeResult } | null>(null)
  const [testingName, setTestingName] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = () => {
    listMcpServers()
      .then(setServers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const handleRemove = async (name: string) => {
    try {
      await removeMcpServer(name)
      setServers((prev) => prev.filter((s) => s.name !== name))
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleTest = async (name: string) => {
    setTestingName(name)
    try {
      const result = await testMcpServer(name)
      setProbeResult({ name, result })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setTestingName(null)
    }
  }

  return (
    <div style={SECTION_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#d81b60' }}>MCP 服务器</h3>
        <button onClick={() => setShowAdd(true)} style={BTN_PRIMARY}>+ 添加</button>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: '#aaa' }}>加载中…</div>
      ) : servers.length === 0 ? (
        <div style={{ fontSize: 12, color: '#aaa' }}>暂无 MCP 服务器</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {servers.map((s) => (
            <div key={s.name} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
              borderRadius: 6, background: '#fafafa', border: '1px solid #eee',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#333', minWidth: 80 }}>{s.name}</span>
              <span style={{ fontSize: 11, color: '#888', flex: 1 }}>
                {s.url ?? s.command}
                {s.tools_count !== undefined && ` · ${s.tools_count} tools`}
              </span>
              <span style={{
                fontSize: 10,
                color: s.enabled ? '#4caf50' : '#e53935',
              }}>
                {s.enabled ? '启用' : '禁用'}
              </span>
              <button
                onClick={() => handleTest(s.name)}
                disabled={testingName === s.name}
                style={{ fontSize: 11, color: '#FF69B4', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {testingName === s.name ? '测试中…' : '测试'}
              </button>
              <button
                onClick={() => handleRemove(s.name)}
                style={{ fontSize: 11, color: '#e53935', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div style={{ marginTop: 8, fontSize: 12, color: '#e53935' }}>{error}</div>}

      {showAdd && (
        <AddDrawer
          onAdded={(s) => { setServers((prev) => [...prev, s]); setShowAdd(false) }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {probeResult && (
        <ProbeModal
          name={probeResult.name}
          result={probeResult.result}
          onClose={() => setProbeResult(null)}
        />
      )}
    </div>
  )
}
