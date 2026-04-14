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
import { clearStoredModelCatalog } from '../../lib/modelCatalogCache'

// Critic M-4: Only this origin is allowed for shell.openExternal in OAuth flow
const ALLOWED_OAUTH_ORIGIN = 'https://auth.openai.com'

type ProviderOption = {
  id: string
  name: string
  authType: 'api_key' | 'oauth'
  requiresBaseUrl?: boolean
  apiKeyPlaceholder?: string
  baseUrlPlaceholder?: string
  hint: string
}

const PROVIDERS: ProviderOption[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    authType: 'api_key',
    apiKeyPlaceholder: 'sk-...',
    hint: '官方 OpenAI 接口，仅需配置 API Key。',
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    authType: 'oauth',
    hint: '使用 ChatGPT 订阅账号完成 OAuth 认证。',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    authType: 'api_key',
    apiKeyPlaceholder: 'sk-ant-...',
    hint: '官方 Anthropic 接口，仅需配置 API Key。',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容接口',
    authType: 'api_key',
    requiresBaseUrl: true,
    apiKeyPlaceholder: 'sk-...',
    baseUrlPlaceholder: 'https://your-openai-compatible-endpoint/v1',
    hint: '适用于兼容 OpenAI 协议的代理或自建接口，需要 Base URL 和 API Key。',
  },
  {
    id: 'anthropic-compatible',
    name: 'Anthropic 兼容接口',
    authType: 'api_key',
    requiresBaseUrl: true,
    apiKeyPlaceholder: 'sk-ant-...',
    baseUrlPlaceholder: 'https://your-anthropic-compatible-endpoint',
    hint: '适用于兼容 Anthropic 协议的代理接口，需要 Base URL 和 API Key。',
  },
]

const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider])) as Record<
  string,
  ProviderOption
>

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

interface DeleteConfirmModalProps {
  credential: CredentialView
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}

function DeleteConfirmModal({
  credential,
  busy,
  onConfirm,
  onClose,
}: DeleteConfirmModalProps): React.ReactElement {
  const providerName = PROVIDER_BY_ID[credential.provider]?.name ?? credential.provider

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
          width: 360,
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
            marginBottom: 10,
          }}
        >
          删除凭据
        </h4>
        <p
          style={{
            fontSize: 12,
            color: tokens.inkSoft,
            lineHeight: 1.6,
            margin: '0 0 14px',
          }}
        >
          确认删除 <strong style={{ color: tokens.ink }}>{providerName}</strong> 的凭据
          <strong style={{ color: tokens.ink }}> “{credential.label}” </strong>
          吗？删除后需要重新添加才能继续使用。
        </p>

        <div
          style={{
            padding: '10px 12px',
            borderRadius: tokens.radiusControl,
            background: tokens.petal,
            border: `1px solid ${tokens.border}`,
            fontSize: 11,
            color: tokens.inkMuted,
            marginBottom: 16,
            fontFamily: tokens.monoFont,
          }}
        >
          {credential.label} · …{credential.last4}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              ...btnGhostStyle,
              opacity: busy ? 0.55 : 1,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{
              ...btnPrimaryStyle,
              background: `linear-gradient(135deg, ${tokens.danger}, #ff6b6b)`,
              boxShadow: '0 2px 8px -2px rgba(229, 57, 53, 0.35)',
              opacity: busy ? 0.55 : 1,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
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
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [oauthFlow, setOauthFlow] = useState<OAuthStartResponse | null>(null)
  const providerOption = PROVIDER_BY_ID[provider]
  const isOAuthProvider = providerOption.authType === 'oauth'

  const handleAddApiKey = async () => {
    if (!apiKey.trim()) return
    setAdding(true)
    setError('')
    try {
      const cred = await addApiKey({
        provider,
        api_key: apiKey.trim(),
        label: label.trim() || undefined,
        base_url: providerOption.requiresBaseUrl ? baseUrl.trim() || undefined : undefined,
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
      const flow = await startCodexOAuth(label)
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
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div
          style={{
            marginBottom: 14,
            fontSize: 12,
            color: tokens.inkSoft,
            lineHeight: 1.6,
          }}
        >
          {providerOption.hint}
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

        {!isOAuthProvider && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={providerOption.apiKeyPlaceholder ?? 'sk-...'}
                style={inputStyle}
                onFocus={(e) => applyFocusRing(e, true)}
                onBlur={(e) => applyFocusRing(e, false)}
              />
            </div>
            {providerOption.requiresBaseUrl && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Base URL</label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={providerOption.baseUrlPlaceholder ?? 'https://...'}
                  style={inputStyle}
                  onFocus={(e) => applyFocusRing(e, true)}
                  onBlur={(e) => applyFocusRing(e, false)}
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleAddApiKey}
                disabled={
                  adding ||
                  !apiKey.trim() ||
                  (providerOption.requiresBaseUrl && !baseUrl.trim())
                }
                style={{
                  ...btnPrimaryStyle,
                  opacity:
                    adding ||
                    !apiKey.trim() ||
                    (providerOption.requiresBaseUrl && !baseUrl.trim())
                      ? 0.55
                      : 1,
                  cursor:
                    adding ||
                    !apiKey.trim() ||
                    (providerOption.requiresBaseUrl && !baseUrl.trim())
                      ? 'not-allowed'
                      : 'pointer',
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

        {isOAuthProvider && (
          <>
            <p style={{ fontSize: 12, color: tokens.inkSoft, marginBottom: 14, lineHeight: 1.5 }}>
              点击下方按钮开始设备码登录流程，完成后会保存到 OpenAI Codex 订阅账号。
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

export function HermesAuthPanel({
  onCredentialsChanged,
}: {
  onCredentialsChanged?: () => void
} = {}): React.ReactElement {
  const { listCredentials, removeCredential, setCurrentCredential } = useHermesConfig()
  const [creds, setCreds] = useState<CredentialView[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState('')
  const [busyCredentialKey, setBusyCredentialKey] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CredentialView | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      setCreds(await listCredentials())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const credentialKey = (provider: string, id: string) => `${provider}:${id}`

  const handleRemove = async (credential: CredentialView) => {
    setBusyCredentialKey(credentialKey(credential.provider, credential.id))
    try {
      await removeCredential(credential.provider, credential.id)
      await clearStoredModelCatalog()
      await refresh()
      setPendingDelete(null)
      onCredentialsChanged?.()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusyCredentialKey(null)
    }
  }

  const handleSetCurrent = async (credential: CredentialView) => {
    setBusyCredentialKey(credentialKey(credential.provider, credential.id))
    try {
      await setCurrentCredential(credential.provider, credential.id)
      await clearStoredModelCatalog()
      await refresh()
      onCredentialsChanged?.()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusyCredentialKey(null)
    }
  }

  const providerGroups = PROVIDERS.map((provider) => ({
    provider,
    credentials: creds.filter((cred) => cred.provider === provider.id),
  })).filter((group) => group.credentials.length > 0)

  return (
    <SectionCard
      title="模型 Provider"
      subtitle={
        creds.length > 0
          ? `已配置 ${creds.length} 个账号`
          : '支持 OpenAI、OpenAI Codex、Anthropic 以及兼容接口'
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
          {providerGroups.map(({ provider, credentials }) => (
            <div
              key={provider.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: 12,
                borderRadius: tokens.radiusControl,
                border: `1px solid ${tokens.border}`,
                background: '#fff',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '2px 2px 6px',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: tokens.ink,
                  }}
                >
                  {provider.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: tokens.inkMuted,
                  }}
                >
                  {credentials.length} 个凭据
                </span>
              </div>

              {credentials.map((credential) => {
                const isCurrent = credentials.length > 1 && credential.is_current
                const canSetCurrent = credentials.length > 1 && !credential.is_current
                const isBusy = busyCredentialKey === credentialKey(credential.provider, credential.id)

                return (
                  <div
                    key={`${credential.provider}-${credential.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: tokens.radiusControl,
                      background: isCurrent ? tokens.petal : '#fafafa',
                      border: `1px solid ${isCurrent ? tokens.border : '#eee'}`,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: tokens.ink,
                        flex: 1,
                        minWidth: 140,
                        fontWeight: 500,
                      }}
                    >
                      {credential.label}
                      <span
                        style={{
                          color: tokens.inkMuted,
                          marginLeft: 6,
                          fontFamily: tokens.monoFont,
                          fontWeight: 400,
                        }}
                      >
                        …{credential.last4}
                      </span>
                      {credential.auth_type === 'oauth' && (
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

                    {credential.status && (
                      <span
                        style={{
                          fontSize: 10,
                          color: credential.status === 'ok' ? tokens.success : tokens.danger,
                          fontWeight: 500,
                        }}
                      >
                        {credential.status}
                      </span>
                    )}

                    {isCurrent && (
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
                        当前使用
                      </span>
                    )}

                    {canSetCurrent && (
                      <button
                        onClick={() => void handleSetCurrent(credential)}
                        disabled={busyCredentialKey !== null}
                        style={{
                          ...btnGhostStyle,
                          fontSize: 11,
                          padding: '5px 10px',
                          color: tokens.brand,
                          borderColor: tokens.border,
                          opacity: busyCredentialKey !== null ? 0.55 : 1,
                          cursor: busyCredentialKey !== null ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isBusy ? '设置中…' : '设为当前'}
                      </button>
                    )}

                    <button
                      onClick={() => setPendingDelete(credential)}
                      disabled={busyCredentialKey !== null}
                      style={{
                        fontSize: 11,
                        color: tokens.danger,
                        background: 'none',
                        border: 'none',
                        cursor: busyCredentialKey !== null ? 'not-allowed' : 'pointer',
                        padding: '2px 4px',
                        fontWeight: 500,
                        opacity: busyCredentialKey !== null ? 0.55 : 1,
                      }}
                    >
                      {isBusy && !canSetCurrent ? '删除中…' : '删除'}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.danger }}>{error}</div>
      )}

      {showAdd && (
        <AddDrawer
          onAdded={(_cred) => {
            setShowAdd(false)
            void (async () => {
              await clearStoredModelCatalog()
              await refresh()
              onCredentialsChanged?.()
            })()
          }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {pendingDelete && (
        <DeleteConfirmModal
          credential={pendingDelete}
          busy={busyCredentialKey === credentialKey(pendingDelete.provider, pendingDelete.id)}
          onConfirm={() => void handleRemove(pendingDelete)}
          onClose={() => {
            if (busyCredentialKey === null) setPendingDelete(null)
          }}
        />
      )}
    </SectionCard>
  )
}
