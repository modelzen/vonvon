import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FeishuFlowStatus,
  FeishuIntegrationState,
  useHermesConfig,
} from '../../hooks/useHermesConfig'
import { SectionCard } from './SectionCard'
import { btnGhostStyle, btnPrimaryStyle, tokens } from './settingsStyles'

const SPINNER_KEYFRAMES = `
@keyframes larkSpinnerRotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`

const RUNTIME_STATUS_LABELS: Record<string, string> = {
  not_installed: '未初始化',
  installed_needs_config: '待配置应用',
  configured_needs_auth: '待登录账号',
  ready: '已就绪',
  error: '异常',
}

const FLOW_STATUS_LABELS: Record<string, string> = {
  starting: '启动中',
  running: '进行中',
  waiting_user: '等待浏览器完成',
  success: '已完成',
  error: '失败',
}

function Spinner(): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.45)',
        borderTopColor: '#fff',
        animation: 'larkSpinnerRotate 0.8s linear infinite',
        flexShrink: 0,
      }}
    />
  )
}

function SecondarySpinner(): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: `2px solid ${tokens.border}`,
        borderTopColor: tokens.brandStrong,
        animation: 'larkSpinnerRotate 0.8s linear infinite',
        flexShrink: 0,
      }}
    />
  )
}

function ButtonLabel({
  busy,
  idleLabel,
  busyLabel,
  primary = false,
}: {
  busy: boolean
  idleLabel: string
  busyLabel: string
  primary?: boolean
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {busy ? (primary ? <Spinner /> : <SecondarySpinner />) : null}
      <span>{busy ? busyLabel : idleLabel}</span>
    </span>
  )
}

function formatTime(ts?: number | null): string {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN')
  } catch {
    return '—'
  }
}

function runtimeBadge(state: FeishuIntegrationState): React.ReactElement {
  const tone =
    state.runtime_status === 'ready'
      ? { background: '#e8f5e9', color: '#2e7d32' }
      : state.runtime_status === 'error'
        ? { background: '#fdecea', color: '#d32f2f' }
        : { background: '#fff4e5', color: '#b26a00' }

  return (
    <span
      style={{
        ...tone,
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {RUNTIME_STATUS_LABELS[state.runtime_status] ?? state.runtime_status}
    </span>
  )
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 12,
        border: `1px solid ${tokens.border}`,
        background: '#fff',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: tokens.ink }}>{title}</div>
        <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.55, color: tokens.inkSoft }}>
          {description}
        </div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        style={{ marginTop: 2 }}
      />
    </label>
  )
}

export function FeishuIntegrationPanel(): React.ReactElement {
  const api = useHermesConfig()
  const apiRef = useRef(api)
  apiRef.current = api

  const [state, setState] = useState<FeishuIntegrationState | null>(null)
  const [activeFlow, setActiveFlow] = useState<FeishuFlowStatus | null>(null)
  const [browserLink, setBrowserLink] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const openedBrowserLinks = useRef(new Set<string>())
  const autoResumedAuthFlows = useRef(new Set<string>())
  const autoAdvancedConfigFlows = useRef(new Set<string>())

  const safeSetState = useCallback((next: FeishuIntegrationState | null) => {
    if (next) setState(next)
  }, [])

  const loadState = useCallback(async () => {
    try {
      const next = await apiRef.current.getFeishuIntegrationState()
      setState(next)
      return next
    } catch (err: any) {
      setError(err?.message ?? '读取飞书状态失败')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadState()
  }, [loadState])

  const runStateAction = useCallback(
    async (
      key: string,
      action: () => Promise<FeishuIntegrationState>,
      successHint?: string
    ): Promise<FeishuIntegrationState | null> => {
      setBusyAction(key)
      setError(null)
      if (successHint) setHint(null)
      try {
        const next = await action()
        safeSetState(next)
        if (successHint) setHint(successHint)
        return next
      } catch (err: any) {
        setError(err?.message ?? '请求失败')
        return null
      } finally {
        setBusyAction((current) => (current === key ? null : current))
      }
    },
    [safeSetState]
  )

  const runFlowAction = useCallback(
    async (
      key: string,
      action: () => Promise<FeishuFlowStatus>,
      flowHint: string
    ): Promise<FeishuFlowStatus | null> => {
      setBusyAction(key)
      setError(null)
      setHint(flowHint)
      try {
        const flow = await action()
        setBrowserLink(flow.verification_url ?? null)
        setActiveFlow(flow)
        return flow
      } catch (err: any) {
        setError(err?.message ?? '流程启动失败')
        return null
      } finally {
        setBusyAction((current) => (current === key ? null : current))
      }
    },
    []
  )

  const openLink = useCallback(async (url?: string | null) => {
    if (!url) return
    try {
      await window.electron.openExternal(url)
    } catch (err: any) {
      setError(err?.message ?? '打开浏览器失败')
    }
  }, [])

  const startConfigFlow = useCallback(
    async (auto = false): Promise<FeishuFlowStatus | null> => {
      return runFlowAction(
        auto ? 'auto-config' : 'primary',
        () => apiRef.current.startFeishuConfigFlow(),
        '已拉起飞书应用配置，完成后会自动继续。'
      )
    },
    [runFlowAction]
  )

  const startAuthFlow = useCallback(
    async (auto = false): Promise<FeishuFlowStatus | null> => {
      return runFlowAction(
        auto ? 'auto-auth' : 'primary',
        () => apiRef.current.startFeishuAuthFlow(),
        '已拉起飞书登录，浏览器完成后会自动刷新状态。'
      )
    },
    [runFlowAction]
  )

  const handlePrimaryAction = useCallback(async () => {
    if (!state) return

    let nextState = state
    if (state.runtime_status === 'not_installed') {
      const installed = await runStateAction(
        'primary',
        () => apiRef.current.installFeishuCli(),
        'Vonvon 已安装并接管自己的 Lark CLI。'
      )
      if (!installed) return
      nextState = installed
    }

    if (!nextState.config_initialized) {
      await startConfigFlow()
      return
    }

    await startAuthFlow()
  }, [runStateAction, startAuthFlow, startConfigFlow, state])

  useEffect(() => {
    const link = activeFlow?.verification_url?.trim()
    if (!link) return
    if (openedBrowserLinks.current.has(link)) return
    openedBrowserLinks.current.add(link)
    void openLink(link)
  }, [activeFlow?.verification_url, openLink])

  useEffect(() => {
    if (!activeFlow?.flow_id || !activeFlow.status) return
    if (!['starting', 'running', 'waiting_user'].includes(activeFlow.status)) return

    const timer = window.setInterval(async () => {
      try {
        const next = await apiRef.current.getFeishuFlowStatus(activeFlow.flow_id)
        setActiveFlow((prev) => {
          if (!prev || prev.flow_id !== activeFlow.flow_id) return next
          return {
            ...next,
            verification_url: next.verification_url ?? prev.verification_url,
            device_code: next.device_code ?? prev.device_code,
          }
        })
      } catch (err: any) {
        setError(err?.message ?? '轮询飞书流程失败')
      }
    }, 1500)

    return () => window.clearInterval(timer)
  }, [activeFlow?.flow_id, activeFlow?.status])

  useEffect(() => {
    if (!activeFlow) return

    if (
      activeFlow.kind === 'config_init'
      && activeFlow.status === 'success'
      && !autoAdvancedConfigFlows.current.has(activeFlow.flow_id)
    ) {
      autoAdvancedConfigFlows.current.add(activeFlow.flow_id)
      setHint('应用配置完成，正在继续拉起飞书登录…')
      void loadState().then(async (nextState) => {
        if (!nextState || nextState.authenticated) return
        await startAuthFlow(true)
      })
      return
    }

    if (
      activeFlow.kind === 'auth_login'
      && activeFlow.status === 'waiting_user'
      && activeFlow.device_code
      && !autoResumedAuthFlows.current.has(activeFlow.flow_id)
    ) {
      autoResumedAuthFlows.current.add(activeFlow.flow_id)
      setHint('浏览器完成飞书登录后，vonvon 会自动更新状态。')
      void apiRef.current
        .completeFeishuAuthFlow(activeFlow.flow_id)
        .then((next) => {
          setActiveFlow(next)
        })
        .catch((err: any) => {
          setError(err?.message ?? '自动接续飞书登录失败')
        })
      return
    }

    if (activeFlow.kind === 'auth_login' && activeFlow.status === 'success') {
      setBrowserLink(null)
      setHint('飞书账号已登录完成。')
      void loadState()
      return
    }

    if (activeFlow.kind === 'config_init' && activeFlow.status === 'error') {
      setError(activeFlow.error ?? '飞书应用配置失败')
      return
    }

    if (activeFlow.kind === 'auth_login' && activeFlow.status === 'error') {
      setError(activeFlow.error ?? '飞书登录失败')
    }
  }, [activeFlow, browserLink, loadState, startAuthFlow])

  const primaryLabel = useMemo(() => {
    if (!state || state.runtime_status === 'not_installed') return '安装并初始化飞书'
    if (!state.config_initialized || !state.authenticated) return '继续初始化飞书'
    return '刷新登录'
  }, [state])

  const primaryBusyLabel = useMemo(() => {
    if (!state || state.runtime_status === 'not_installed') return '安装中…'
    if (!state.config_initialized || !state.authenticated) return '处理中…'
    return '登录中…'
  }, [state])

  const loginStatus = useMemo(() => {
    if (!state) return '读取中'
    if (state.authenticated) return '已登录'
    if (state.config_initialized) return '待登录'
    if (state.runtime_status === 'not_installed') return '未初始化'
    return '待配置'
  }, [state])

  const accountSummary = useMemo(() => {
    if (!state) return '—'
    if (state.authenticated) {
      return (
        state.account_display_name
        || state.account_identifier
        || state.logged_in_accounts[0]
        || '已登录飞书账号'
      )
    }
    if (state.auth_identity === 'bot') {
      return '当前只有 bot 租户身份可用，尚未登录飞书用户账号'
    }
    return state.auth_note || '尚未检测到已登录飞书账号'
  }, [state])

  const identitySummary = useMemo(() => {
    if (!state) return '—'
    const parts = []
    if (state.auth_identity) parts.push(`身份 ${state.auth_identity}`)
    if (state.auth_default_as) parts.push(`defaultAs ${state.auth_default_as}`)
    if (state.account_identifier) parts.push(state.account_identifier)
    return parts.length > 0 ? parts.join(' · ') : '—'
  }, [state])

  const guideTitle = useMemo(() => {
    if (!activeFlow) return '当前没有进行中的浏览器流程'
    return activeFlow.kind === 'config_init' ? '飞书应用配置' : '飞书账号登录'
  }, [activeFlow])

  const guideStatus = useMemo(() => {
    if (!activeFlow) return '待命'
    if (activeFlow.kind === 'config_init' && activeFlow.status === 'success') {
      return '应用配置完成，正在继续下一步'
    }
    if (activeFlow.kind === 'auth_login' && activeFlow.status === 'success') {
      return '飞书登录完成'
    }
    if (activeFlow.kind === 'auth_login' && activeFlow.status === 'waiting_user') {
      return '请在浏览器完成飞书登录'
    }
    if (activeFlow.kind === 'config_init' && activeFlow.status === 'waiting_user') {
      return '请在浏览器完成飞书应用配置'
    }
    return FLOW_STATUS_LABELS[activeFlow.status] ?? activeFlow.status
  }, [activeFlow])

  const showAdvancedActions = !!state && state.runtime_status !== 'not_installed'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{SPINNER_KEYFRAMES}</style>

      <SectionCard
        title="飞书 / Lark CLI"
        subtitle="vonvon 始终使用自己托管的 Lark CLI，不会复用你系统里已经安装的 `lark-cli`。"
        action={
          <button
            onClick={() => void runStateAction('refresh-state', () => apiRef.current.verifyFeishuRuntime())}
            style={btnGhostStyle}
            disabled={busyAction === 'refresh-state' || loading}
          >
            <ButtonLabel
              busy={busyAction === 'refresh-state'}
              idleLabel="刷新状态"
              busyLabel="刷新中…"
            />
          </button>
        }
      >
        {loading && !state ? (
          <div style={{ fontSize: 12, color: tokens.inkMuted }}>加载中…</div>
        ) : state ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 12,
              }}
            >
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: `1px solid ${tokens.border}`,
                  background: tokens.cardSoft,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {runtimeBadge(state)}
                </div>
                <div style={{ fontSize: 12, color: tokens.inkSoft, lineHeight: 1.6 }}>
                  登录状态 {loginStatus}
                  <br />
                  当前版本 {state.current_version ?? '—'}
                </div>
              </div>

              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: `1px solid ${tokens.border}`,
                  background: '#fff',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.ink }}>飞书账号</div>
                <div style={{ marginTop: 8, fontSize: 12, color: tokens.inkSoft, lineHeight: 1.6 }}>
                  {accountSummary}
                  <br />
                  {identitySummary}
                  <br />
                  最近验证 {formatTime(state.last_verified_at)}
                </div>
              </div>

              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: `1px solid ${tokens.border}`,
                  background: '#fff',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.ink }}>内部桥接</div>
                <div style={{ marginTop: 8, fontSize: 12, color: tokens.inkSoft, lineHeight: 1.6 }}>
                  {state.internal_skills_synced ? `已同步 ${state.internal_skill_count} 个内部 skill` : '未同步'}
                  <br />
                  最新版本 {state.latest_available_version ?? '未检查'}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                style={btnPrimaryStyle}
                disabled={busyAction === 'primary'}
                onClick={() => void handlePrimaryAction()}
              >
                <ButtonLabel
                  busy={busyAction === 'primary'}
                  idleLabel={primaryLabel}
                  busyLabel={primaryBusyLabel}
                  primary
                />
              </button>

              {showAdvancedActions && (
                <>
                  <button
                    style={btnGhostStyle}
                    disabled={busyAction === 'check-updates'}
                    onClick={() =>
                      void runStateAction(
                        'check-updates',
                        () => apiRef.current.checkFeishuCliUpdates(),
                        '已刷新 Lark CLI 更新状态。'
                      )
                    }
                  >
                    <ButtonLabel
                      busy={busyAction === 'check-updates'}
                      idleLabel="检查更新"
                      busyLabel="检查中…"
                    />
                  </button>

                  <button
                    style={btnGhostStyle}
                    disabled={busyAction === 'upgrade' || !state.upgrade_available}
                    onClick={() =>
                      void runStateAction(
                        'upgrade',
                        () => apiRef.current.upgradeFeishuCli(),
                        'Lark CLI 已升级并重新验证。'
                      )
                    }
                  >
                    <ButtonLabel
                      busy={busyAction === 'upgrade'}
                      idleLabel="升级 CLI"
                      busyLabel="升级中…"
                    />
                  </button>

                  <button
                    style={{
                      ...btnGhostStyle,
                      color: tokens.danger,
                      borderColor: '#f7c8c6',
                    }}
                    disabled={busyAction === 'uninstall'}
                    onClick={() =>
                      void runStateAction(
                        'uninstall',
                        () => apiRef.current.uninstallFeishuCli(),
                        '已卸载 vonvon 托管的 Lark CLI。'
                      ).then(() => {
                        setActiveFlow(null)
                        setBrowserLink(null)
                      })
                    }
                  >
                    <ButtonLabel
                      busy={busyAction === 'uninstall'}
                      idleLabel="卸载"
                      busyLabel="卸载中…"
                    />
                  </button>
                </>
              )}
            </div>

            {state.last_error && (
              <div
                style={{
                  fontSize: 12,
                  color: tokens.danger,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: '#fff7f7',
                  border: '1px solid #ffd7d5',
                }}
              >
                {state.last_error}
              </div>
            )}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="初始化与登录"
        subtitle="初次使用只需要一个入口。配置应用和账号登录会自动串起来，浏览器完成后这里会自动更新。"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 14,
              border: `1px solid ${tokens.border}`,
              background: '#fff',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.ink }}>{guideTitle}</div>
            <div style={{ marginTop: 6, fontSize: 12, color: tokens.inkSoft, lineHeight: 1.7 }}>
              {guideStatus}
              {hint ? (
                <>
                  <br />
                  {hint}
                </>
              ) : null}
            </div>
          </div>

          {browserLink && (
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 14,
                border: `1px solid ${tokens.border}`,
                background: tokens.cardSoft,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: 12, color: tokens.inkSoft, lineHeight: 1.6 }}>
                已为你打开浏览器。如果浏览器没有自动拉起，可以再次打开当前链接：
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: `1px solid ${tokens.border}`,
                  background: '#fff',
                  fontFamily: tokens.monoFont,
                  fontSize: 11,
                  lineHeight: 1.55,
                  wordBreak: 'break-all',
                  color: tokens.inkMuted,
                }}
              >
                {browserLink}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button style={btnGhostStyle} onClick={() => void openLink(browserLink)}>
                  重新打开浏览器
                </button>
                <button
                  style={btnGhostStyle}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(browserLink)
                      .then(() => setHint('链接已复制。'))
                      .catch(() => setError('复制链接失败'))
                  }
                >
                  复制链接
                </button>
              </div>
            </div>
          )}

          {activeFlow?.error && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: '#fff7f7',
                border: '1px solid #ffd7d5',
                fontSize: 12,
                color: tokens.danger,
                lineHeight: 1.6,
              }}
            >
              {activeFlow.error}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="飞书能力"
        subtitle="登录完成后，再控制 vonvon 是否启用飞书相关能力。"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ToggleRow
            title="启用飞书深度集成"
            description="控制 vonvon 是否允许进入飞书相关能力链路。"
            checked={!!state?.feature_enabled}
            disabled={!state || busyAction === 'toggle-feature' || state.runtime_status !== 'ready'}
            onChange={(enabled) =>
              void runStateAction(
                'toggle-feature',
                () => apiRef.current.setFeishuFeatureEnabled(enabled),
                enabled ? '已启用飞书深度集成。' : '已关闭飞书深度集成。'
              )
            }
          />
          <ToggleRow
            title="启用飞书内部 Skills"
            description="让 Hermes 可以调度 vonvon 内部封装的飞书能力，不会出现在普通 Skills 列表。"
            checked={!!state?.skills_enabled}
            disabled={!state || !state.feature_enabled || busyAction === 'toggle-skills'}
            onChange={(enabled) =>
              void runStateAction(
                'toggle-skills',
                () => apiRef.current.setFeishuSkillsEnabled(enabled),
                enabled ? '已启用飞书内部 Skills。' : '已关闭飞书内部 Skills。'
              )
            }
          />
          <ToggleRow
            title="允许粉球触发飞书 inspect"
            description="Phase 1 先保留 gate；下一步再把点击 vonvon 后的截图、识别和上下文注入接上。"
            checked={!!state?.orb_inspect_enabled}
            disabled={!state || !state.feature_enabled || busyAction === 'toggle-orb'}
            onChange={(enabled) =>
              void runStateAction(
                'toggle-orb',
                () => apiRef.current.setFeishuOrbInspectEnabled(enabled),
                enabled ? '已允许粉球触发飞书 inspect。' : '已关闭粉球触发飞书 inspect。'
              )
            }
          />
        </div>
      </SectionCard>

      <SectionCard title="权限状态" subtitle="后续飞书窗口识别会依赖这些系统权限。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              border: `1px solid ${tokens.border}`,
              background: '#fff',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.ink }}>Screen Recording</div>
            <div style={{ marginTop: 6, fontSize: 12, color: tokens.inkSoft }}>
              {state?.permissions.screen_recording ?? 'unknown'}
            </div>
          </div>
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              border: `1px solid ${tokens.border}`,
              background: '#fff',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.ink }}>Accessibility</div>
            <div style={{ marginTop: 6, fontSize: 12, color: tokens.inkSoft }}>
              {state?.permissions.accessibility ?? 'unknown'}
            </div>
          </div>
        </div>
      </SectionCard>

      {error && (
        <div style={{ fontSize: 12, color: tokens.danger, padding: '0 4px 8px' }}>{error}</div>
      )}
    </div>
  )
}
