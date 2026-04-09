import React, { useEffect, useRef, useState } from 'react'
import { useHermesConfig, CredentialView, OAuthStartResponse } from '../../hooks/useHermesConfig'

// Critic M-4: Only this origin is allowed for shell.openExternal in OAuth flow
const ALLOWED_OAUTH_ORIGIN = 'https://auth.openai.com'

const SECTION_STYLE: React.CSSProperties = { padding: '16px 0', borderBottom: '1px solid #fce4ec' }
const LABEL_STYLE: React.CSSProperties = { fontSize: 12, color: '#555', display: 'block', marginBottom: 4 }
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12,
  border: '1px solid #fce4ec', borderRadius: 6, outline: 'none', boxSizing: 'border-box',
}
const SELECT_STYLE: React.CSSProperties = { ...INPUT_STYLE, background: '#fff' }
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

const PROVIDERS = ['openai', 'anthropic', 'openrouter', 'openai-codex', 'nous', 'custom']

function openVerificationUrl(url: string): void {
  try {
    if (new URL(url).origin !== ALLOWED_OAUTH_ORIGIN) {
      console.error('invalid verification URL, aborted:', url)
      return
    }
  } catch {
    console.error('invalid URL, aborted:', url)
    return
  }
  window.electron.openExternal(url)
}

// ── OAuth countdown modal ────────────────────────────────────────────────────

interface OAuthModalProps {
  flow: OAuthStartResponse
  onSuccess: (cred: CredentialView) => void
  onClose: () => void
}

function OAuthModal({ flow, onSuccess, onClose }: OAuthModalProps): React.ReactElement {
  const { pollCodexOAuth, cancelCodexOAuth } = useHermesConfig()
  const [status, setStatus] = useState<'pending' | 'success' | 'error' | 'timeout'>('pending')
  const [errorMsg, setErrorMsg] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(flow.expires_in_seconds)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Countdown timer
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)

    // Polling
    const doPoll = async () => {
      try {
        const res = await pollCodexOAuth(flow.flow_id)
        if (res.status === 'success' && res.credential) {
          setStatus('success')
          onSuccess(res.credential)
          return
        }
        if (res.status === 'error') {
          setStatus('error')
          setErrorMsg(res.error ?? '认证失败')
          return
        }
        if (res.status === 'timeout') {
          setStatus('timeout')
          return
        }
        // pending — schedule next poll
        pollRef.current = setTimeout(doPoll, flow.interval * 1000)
      } catch (e: any) {
        setStatus('error')
        setErrorMsg(e.message)
      }
    }
    pollRef.current = setTimeout(doPoll, flow.interval * 1000)

    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const handleClose = () => {
    if (pollRef.current) clearTimeout(pollRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    cancelCodexOAuth(flow.flow_id).catch(() => {})
    onClose()
  }

  const mins = Math.floor(secondsLeft / 60)
  const secs = secondsLeft % 60

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: 24, width: 340,
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h4 style={{ fontSize: 14, fontWeight: 700, color: '#333', marginBottom: 16 }}>
          ChatGPT OAuth 登录
        </h4>

        {(status === 'pending') && (
          <>
            <p style={{ fontSize: 12, color: '#555', marginBottom: 12 }}>
              在浏览器中访问以下链接并输入验证码：
            </p>
            <div style={{
              background: '#f9f9f9', border: '1px solid #eee', borderRadius: 8,
              padding: '12px 16px', marginBottom: 12, textAlign: 'center',
            }}>
              <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 4, color: '#333', marginBottom: 8 }}>
                {flow.user_code}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(flow.user_code)}
                style={{ ...BTN_GHOST, fontSize: 11, padding: '2px 10px' }}
              >
                复制验证码
              </button>
            </div>
            <button
              onClick={() => openVerificationUrl(flow.verification_url)}
              style={{ ...BTN_PRIMARY, width: '100%', marginBottom: 12 }}
            >
              在浏览器中打开
            </button>
            <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', marginBottom: 16 }}>
              等待授权中… 剩余 {mins}:{String(secs).padStart(2, '0')}
            </div>
          </>
        )}

        {status === 'success' && (
          <div style={{ fontSize: 13, color: '#4caf50', textAlign: 'center', padding: '16px 0' }}>
            ✓ 登录成功！
          </div>
        )}

        {(status === 'error' || status === 'timeout') && (
          <div style={{ fontSize: 12, color: '#e53935', marginBottom: 16 }}>
            {status === 'timeout' ? '验证码已过期，请重新开始' : errorMsg}
          </div>
        )}

        <button onClick={handleClose} style={{ ...BTN_GHOST, width: '100%' }}>
          {status === 'success' ? '关闭' : '取消'}
        </button>
      </div>
    </div>
  )
}

// ── Add credential drawer ────────────────────────────────────────────────────

interface AddDrawerProps {
  onAdded: (cred: CredentialView) => void
  onClose: () => void
}

function AddDrawer({ onAdded, onClose }: AddDrawerProps): React.ReactElement {
  const { addApiKey, startCodexOAuth } = useHermesConfig()
  const [provider, setProvider] = useState('openai')
  const [authType, setAuthType] = useState<'api_key' | 'oauth'>('api_key')
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [oauthFlow, setOauthFlow] = useState<OAuthStartResponse | null>(null)

  const handleAddApiKey = async () => {
    if (!apiKey.trim()) return
    setAdding(true)
    setError('')
    try {
      const cred = await addApiKey({
        provider, api_key: apiKey.trim(),
        label: label.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
      })
      // Clear sensitive field immediately after submit
      setApiKey('')
      onAdded(cred)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  const handleStartOAuth = async () => {
    setAdding(true)
    setError('')
    try {
      const flow = await startCodexOAuth()
      setOauthFlow(flow)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  if (oauthFlow) {
    return (
      <OAuthModal
        flow={oauthFlow}
        onSuccess={(cred) => { setOauthFlow(null); onAdded(cred) }}
        onClose={() => setOauthFlow(null)}
      />
    )
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
        <h4 style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 16 }}>添加凭据</h4>

        <div style={{ marginBottom: 10 }}>
          <label style={LABEL_STYLE}>Provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={SELECT_STYLE}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {(['api_key', 'oauth'] as const).map((t) => (
            <button key={t} onClick={() => setAuthType(t)} style={{
              ...BTN_GHOST,
              background: authType === t ? '#FF69B4' : '#fff',
              color: authType === t ? '#fff' : '#FF69B4',
            }}>
              {t === 'api_key' ? 'API Key' : 'OAuth (ChatGPT)'}
            </button>
          ))}
        </div>

        {authType === 'api_key' && (
          <>
            <div style={{ marginBottom: 10 }}>
              <label style={LABEL_STYLE}>API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                style={INPUT_STYLE}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={LABEL_STYLE}>标签（可选）</label>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="work" style={INPUT_STYLE} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={LABEL_STYLE}>Base URL（可选）</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." style={INPUT_STYLE} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleAddApiKey} disabled={adding || !apiKey.trim()} style={{
                ...BTN_PRIMARY, opacity: (adding || !apiKey.trim()) ? 0.6 : 1,
              }}>
                {adding ? '添加中…' : '添加'}
              </button>
              <button onClick={onClose} style={BTN_GHOST}>取消</button>
            </div>
          </>
        )}

        {authType === 'oauth' && (
          <>
            <p style={{ fontSize: 12, color: '#777', marginBottom: 14 }}>
              仅支持 openai-codex。点击下方按钮开始设备码登录流程。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleStartOAuth} disabled={adding} style={{
                ...BTN_PRIMARY, opacity: adding ? 0.6 : 1,
              }}>
                {adding ? '准备中…' : '开始 ChatGPT 登录'}
              </button>
              <button onClick={onClose} style={BTN_GHOST}>取消</button>
            </div>
          </>
        )}

        {error && <div style={{ marginTop: 10, fontSize: 12, color: '#e53935' }}>{error}</div>}
      </div>
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function HermesAuthPanel(): React.ReactElement {
  const { listCredentials, removeCredential } = useHermesConfig()
  const [creds, setCreds] = useState<CredentialView[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState('')

  const refresh = () => {
    listCredentials()
      .then(setCreds)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const handleRemove = async (provider: string, id: string) => {
    try {
      await removeCredential(provider, id)
      setCreds((prev) => prev.filter((c) => !(c.provider === provider && c.id === id)))
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div style={SECTION_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#d81b60' }}>Hermes 认证</h3>
        <button onClick={() => setShowAdd(true)} style={BTN_PRIMARY}>+ 添加</button>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: '#aaa' }}>加载中…</div>
      ) : creds.length === 0 ? (
        <div style={{ fontSize: 12, color: '#aaa' }}>暂无凭据，点击"添加"配置</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {creds.map((c) => (
            <div key={`${c.provider}-${c.id}`} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 6,
              background: c.is_current ? 'rgba(255,105,180,0.06)' : '#fafafa',
              border: `1px solid ${c.is_current ? '#fce4ec' : '#eee'}`,
            }}>
              <span style={{ fontSize: 11, color: '#888', minWidth: 80 }}>{c.provider}</span>
              <span style={{ fontSize: 12, color: '#333', flex: 1 }}>
                {c.label} <span style={{ color: '#aaa' }}>…{c.last4}</span>
                {c.auth_type === 'oauth' && <span style={{ marginLeft: 4, fontSize: 10, color: '#FF69B4' }}>OAuth</span>}
              </span>
              {c.status && (
                <span style={{ fontSize: 10, color: c.status === 'ok' ? '#4caf50' : '#e53935' }}>
                  {c.status}
                </span>
              )}
              {c.is_current && <span style={{ fontSize: 10, color: '#FF69B4' }}>当前</span>}
              <button
                onClick={() => handleRemove(c.provider, c.id)}
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
          onAdded={(cred) => { setCreds((prev) => [...prev, cred]); setShowAdd(false) }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  )
}
