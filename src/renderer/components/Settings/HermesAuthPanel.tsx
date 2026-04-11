import React, { useEffect, useRef, useState } from 'react'
import { useHermesConfig, CredentialView, OAuthStartResponse } from '../../hooks/useHermesConfig'
import { SectionCard } from './SectionCard'
import {
  tokens,
  inputStyle,
  selectStyle,
  btnPrimaryStyle,
  btnGhostStyle,
  labelStyle,
  applyFocusRing,
} from './settingsStyles'

// Critic M-4: Only this origin is allowed for shell.openExternal in OAuth flow
const ALLOWED_OAUTH_ORIGIN = 'https://auth.openai.com'

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
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)

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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: tokens.card,
          borderRadius: tokens.radiusCard,
          padding: 22,
          width: 340,
          boxShadow: '0 12px 36px rgba(0, 0, 0, 0.18)',
          border: `1px solid ${tokens.border}`,
        }}
      >
        <h4
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: tokens.ink,
            marginBottom: 14,
          }}
        >
          ChatGPT 登录
        </h4>

        {status === 'pending' && (
          <>
            <p style={{ fontSize: 12, color: tokens.inkSoft, marginBottom: 12, lineHeight: 1.5 }}>
              在浏览器中访问以下链接并输入验证码:
            </p>
            <div
              style={{
                background: tokens.petal,
                border: `1px solid ${tokens.border}`,
                borderRadius: tokens.radiusControl,
                padding: '14px 16px',
                marginBottom: 12,
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 4,
                  color: tokens.ink,
                  marginBottom: 8,
                  fontFamily: tokens.monoFont,
                }}
              >
                {flow.user_code}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(flow.user_code)}
                style={{ ...btnGhostStyle, fontSize: 11, padding: '3px 10px' }}
              >
                复制验证码
              </button>
            </div>
            <button
              onClick={() => openVerificationUrl(flow.verification_url)}
              style={{ ...btnPrimaryStyle, width: '100%', marginBottom: 10 }}
            >
              在浏览器中打开
            </button>
            <div
              style={{
                fontSize: 11,
                color: tokens.inkMuted,
                textAlign: 'center',
                marginBottom: 14,
              }}
            >
              等待授权中 · 剩余 {mins}:{String(secs).padStart(2, '0')}
            </div>
          </>
        )}

        {status === 'success' && (
          <div
            style={{
              fontSize: 13,
              color: tokens.success,
              textAlign: 'center',
              padding: '14px 0',
            }}
          >
            ✓ 登录成功
          </div>
        )}

        {(status === 'error' || status === 'timeout') && (
          <div style={{ fontSize: 12, color: tokens.danger, marginBottom: 14 }}>
            {status === 'timeout' ? '验证码已过期，请重新开始' : errorMsg}
          </div>
        )}

        <button onClick={handleClose} style={{ ...btnGhostStyle, width: '100%' }}>
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
        provider,
        api_key: apiKey.trim(),
        label: label.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
      })
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
        onSuccess={(cred) => {
          setOauthFlow(null)
          onAdded(cred)
        }}
        onClose={() => setOauthFlow(null)}
      />
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 900,
      }}
    >
      <div
        style={{
          background: tokens.card,
          borderRadius: tokens.radiusCard,
          padding: 20,
          width: 420,
          maxWidth: '92vw',
          boxShadow: '0 12px 36px rgba(0, 0, 0, 0.18)',
          border: `1px solid ${tokens.border}`,
        }}
      >
        <h4
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: tokens.ink,
            marginBottom: 14,
          }}
        >
          添加凭据
        </h4>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={selectStyle}
            onFocus={(e) => applyFocusRing(e, true)}
            onBlur={(e) => applyFocusRing(e, false)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {(['api_key', 'oauth'] as const).map((t) => {
            const active = authType === t
            return (
              <button
                key={t}
                onClick={() => setAuthType(t)}
                style={{
                  ...btnGhostStyle,
                  background: active ? tokens.brand : '#fff',
                  color: active ? '#fff' : tokens.brand,
                }}
              >
                {t === 'api_key' ? 'API Key' : 'OAuth (ChatGPT)'}
              </button>
            )
          })}
        </div>

        {authType === 'api_key' && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                style={inputStyle}
                onFocus={(e) => applyFocusRing(e, true)}
                onBlur={(e) => applyFocusRing(e, false)}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>标签(可选)</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="work"
                style={inputStyle}
                onFocus={(e) => applyFocusRing(e, true)}
                onBlur={(e) => applyFocusRing(e, false)}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Base URL(可选)</label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://..."
                style={inputStyle}
                onFocus={(e) => applyFocusRing(e, true)}
                onBlur={(e) => applyFocusRing(e, false)}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleAddApiKey}
                disabled={adding || !apiKey.trim()}
                style={{
                  ...btnPrimaryStyle,
                  opacity: adding || !apiKey.trim() ? 0.55 : 1,
                  cursor: adding || !apiKey.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {adding ? '添加中…' : '添加'}
              </button>
              <button onClick={onClose} style={btnGhostStyle}>
                取消
              </button>
            </div>
          </>
        )}

        {authType === 'oauth' && (
          <>
            <p style={{ fontSize: 12, color: tokens.inkSoft, marginBottom: 14, lineHeight: 1.5 }}>
              仅支持 openai-codex。点击下方按钮开始设备码登录流程。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleStartOAuth}
                disabled={adding}
                style={{ ...btnPrimaryStyle, opacity: adding ? 0.55 : 1 }}
              >
                {adding ? '准备中…' : '开始 ChatGPT 登录'}
              </button>
              <button onClick={onClose} style={btnGhostStyle}>
                取消
              </button>
            </div>
          </>
        )}

        {error && (
          <div style={{ marginTop: 10, fontSize: 12, color: tokens.danger }}>{error}</div>
        )}
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

  useEffect(() => {
    refresh()
  }, [])

  const handleRemove = async (provider: string, id: string) => {
    try {
      await removeCredential(provider, id)
      setCreds((prev) => prev.filter((c) => !(c.provider === provider && c.id === id)))
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <SectionCard
      title="模型 Provider"
      subtitle={
        creds.length > 0
          ? `已配置 ${creds.length} 个账号`
          : '添加 API Key 或使用 ChatGPT 登录'
      }
      action={
        <button onClick={() => setShowAdd(true)} style={btnPrimaryStyle}>
          + 添加
        </button>
      }
    >
      {loading ? (
        <div style={{ fontSize: 12, color: tokens.inkMuted }}>加载中…</div>
      ) : creds.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: tokens.inkMuted,
            padding: '14px',
            borderRadius: tokens.radiusControl,
            background: tokens.petal,
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          还没有凭据。点击右上角 <strong style={{ color: tokens.brandHeader }}>+ 添加</strong> 开始配置。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {creds.map((c) => (
            <div
              key={`${c.provider}-${c.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: tokens.radiusControl,
                background: c.is_current ? tokens.petal : '#fafafa',
                border: `1px solid ${c.is_current ? tokens.border : '#eee'}`,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: tokens.inkSoft,
                  fontFamily: tokens.monoFont,
                  minWidth: 90,
                }}
              >
                {c.provider}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: tokens.ink,
                  flex: 1,
                  minWidth: 100,
                  fontWeight: 500,
                }}
              >
                {c.label}
                <span
                  style={{
                    color: tokens.inkMuted,
                    marginLeft: 6,
                    fontFamily: tokens.monoFont,
                    fontWeight: 400,
                  }}
                >
                  …{c.last4}
                </span>
                {c.auth_type === 'oauth' && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 9,
                      fontWeight: 600,
                      padding: '1px 6px',
                      borderRadius: tokens.radiusPill,
                      background: '#fff',
                      color: tokens.brand,
                      border: `1px solid ${tokens.border}`,
                      letterSpacing: 0.3,
                      textTransform: 'uppercase',
                    }}
                  >
                    OAuth
                  </span>
                )}
              </span>
              {c.status && (
                <span
                  style={{
                    fontSize: 10,
                    color: c.status === 'ok' ? tokens.success : tokens.danger,
                    fontWeight: 500,
                  }}
                >
                  {c.status}
                </span>
              )}
              {c.is_current && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    padding: '2px 7px',
                    borderRadius: tokens.radiusPill,
                    background: `linear-gradient(135deg, ${tokens.brand}, ${tokens.brandStrong})`,
                    color: '#fff',
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                  }}
                >
                  当前
                </span>
              )}
              <button
                onClick={() => handleRemove(c.provider, c.id)}
                style={{
                  fontSize: 11,
                  color: tokens.danger,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  fontWeight: 500,
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.danger }}>{error}</div>
      )}

      {showAdd && (
        <AddDrawer
          onAdded={(cred) => {
            setCreds((prev) => [...prev, cred])
            setShowAdd(false)
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </SectionCard>
  )
}
