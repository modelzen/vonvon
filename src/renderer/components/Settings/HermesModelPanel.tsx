import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useHermesConfig, ProviderInfo } from '../../hooks/useHermesConfig'
import { SectionCard } from './SectionCard'
import { tokens } from './settingsStyles'
import { buildModelCatalogFingerprint, loadModelCatalog } from '../../lib/modelCatalogCache'

/**
 * "可用模型" whitelist panel.
 *
 * Settings page only curates which models the chat page is allowed to show
 * in its picker. The actual model switch happens on the chat page itself.
 *
 * Storage: electron-store key `modelWhitelist`, persisted via main/store.ts.
 * First-run seeded with the hermes backend's currently-selected model so the
 * chat picker is never empty.
 */
export function HermesModelPanel({
  refreshToken = 0,
}: {
  refreshToken?: number
} = {}): React.ReactElement {
  const { listModels, listCredentials } = useHermesConfig()
  const listModelsRef = useRef(listModels)
  const listCredentialsRef = useRef(listCredentials)
  listModelsRef.current = listModels
  listCredentialsRef.current = listCredentials

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [whitelist, setWhitelist] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [data, stored] = await Promise.all([
          loadModelCatalog(() => listModelsRef.current(), {
            getFingerprint: () => buildModelCatalogFingerprint(() => listCredentialsRef.current()),
          }),
          window.electron.storeGet('modelWhitelist') as Promise<unknown>,
        ])
        if (cancelled) return
        setProviders(data.providers)
        const availableModels = new Set(data.providers.flatMap((provider) => provider.models))
        const ids = Array.isArray(stored) ? (stored as string[]) : []
        const validIds = ids.filter((id) => availableModels.has(id))
        const currentIsAvailable = data.providers.some((provider) => provider.models.includes(data.current))
        if (validIds.length !== ids.length) {
          await window.electron.storeSet('modelWhitelist', validIds)
        }
        if (validIds.length === 0 && data.current && currentIsAvailable) {
          const seed = new Set([data.current])
          setWhitelist(seed)
          await window.electron.storeSet('modelWhitelist', Array.from(seed))
        } else {
          setWhitelist(new Set(validIds))
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const persist = async (next: Set<string>) => {
    setWhitelist(next)
    try {
      await window.electron.storeSet('modelWhitelist', Array.from(next))
    } catch (e) {
      console.error('persist whitelist failed', e)
    }
  }

  const toggle = (modelId: string) => {
    const next = new Set(whitelist)
    if (next.has(modelId)) next.delete(modelId)
    else next.add(modelId)
    persist(next)
  }

  const selectAllInProvider = (p: ProviderInfo) => {
    const next = new Set(whitelist)
    p.models.forEach((m) => next.add(m))
    persist(next)
  }

  const clearProvider = (p: ProviderInfo) => {
    const next = new Set(whitelist)
    p.models.forEach((m) => next.delete(m))
    persist(next)
  }

  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return providers
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter((m) => m.toLowerCase().includes(q)),
      }))
      .filter(
        (p) =>
          p.models.length > 0 ||
          p.name.toLowerCase().includes(q) ||
          (typeof p.error === 'string' && p.error.toLowerCase().includes(q))
      )
  }, [providers, query])

  const totalSelected = whitelist.size
  const totalAvailable = providers.reduce((sum, p) => sum + p.models.length, 0)
  const currentProvider = providers.find((provider) => provider.is_current) ?? null

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SectionCard title="可用模型" subtitle="勾选要在对话页下拉中显示的模型">
        <div style={{ fontSize: 12, color: tokens.inkMuted, padding: '6px 0' }}>加载中…</div>
      </SectionCard>
    )
  }

  if (providers.length === 0) {
    return (
      <SectionCard title="可用模型" subtitle="勾选要在对话页下拉中显示的模型">
        <div
          style={{
            fontSize: 12,
            color: tokens.inkMuted,
            padding: '14px',
            borderRadius: tokens.radiusControl,
            background: tokens.petal,
            lineHeight: 1.6,
          }}
        >
          还没有配置 provider。先到上面的&nbsp;
          <strong style={{ color: tokens.brandHeader }}>模型 Provider</strong>
          &nbsp;区域添加账号,这里就会出现可勾选的模型。
        </div>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="可用模型"
      subtitle={`勾选的模型会出现在对话页的切换菜单中。当前 ${totalSelected} / ${totalAvailable} 个`}
      action={
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="过滤…"
          style={{
            padding: '5px 12px',
            fontSize: 11,
            fontFamily: tokens.font,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radiusPill,
            outline: 'none',
            background: '#fff',
            color: tokens.ink,
            width: 130,
          }}
        />
      }
    >
      <div
        style={{
          marginBottom: 14,
          padding: '12px 14px',
          borderRadius: tokens.radiusControl,
          background: '#fff',
          border: `1px solid ${tokens.border}`,
          fontSize: 12,
          color: tokens.inkSoft,
          lineHeight: 1.65,
        }}
      >
        当前使用 Provider：
        <strong style={{ color: tokens.ink }}>
          {currentProvider?.name ?? '未设置'}
        </strong>
        {currentProvider?.usable === false && currentProvider.error && (
          <div style={{ marginTop: 6, color: tokens.danger }}>{currentProvider.error}</div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {filteredProviders.map((p) => {
          const selectedInGroup = p.models.filter((m) => whitelist.has(m)).length
          const allSelected = selectedInGroup === p.models.length && p.models.length > 0
          const unusable = p.usable === false
          const statusLabel = unusable ? '不可用' : p.models.length > 0 ? '可用' : '已配置'
          const statusColor = unusable ? tokens.danger : p.models.length > 0 ? tokens.success : tokens.inkMuted

          return (
            <div key={p.slug}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: tokens.ink }}>
                  {p.name}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: tokens.inkMuted,
                    fontFeatureSettings: '"tnum"',
                  }}
                >
                  {selectedInGroup}/{p.models.length}
                </span>
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: '2px 7px',
                    borderRadius: tokens.radiusPill,
                    background: '#fff',
                    color: statusColor,
                    border: `1px solid ${unusable ? '#ffd7d7' : tokens.border}`,
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                  }}
                >
                  {statusLabel}
                </span>
                {p.is_current && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      padding: '1px 7px',
                      borderRadius: tokens.radiusPill,
                      background: tokens.petal,
                      color: tokens.brandHeader,
                      border: `1px solid ${tokens.border}`,
                      letterSpacing: 0.3,
                      textTransform: 'uppercase',
                    }}
                  >
                    活跃
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {p.models.length > 0 && (
                  <button
                    onClick={() => (allSelected ? clearProvider(p) : selectAllInProvider(p))}
                    style={{
                      fontSize: 11,
                      color: tokens.brand,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px 4px',
                      fontWeight: 500,
                    }}
                  >
                    {allSelected ? '全部取消' : '全部勾选'}
                  </button>
                )}
              </div>

              {p.error && (
                <div
                  style={{
                    marginBottom: p.models.length > 0 ? 8 : 0,
                    padding: '10px 12px',
                    borderRadius: tokens.radiusControl,
                    border: `1px solid ${unusable ? '#ffd7d7' : tokens.border}`,
                    background: unusable ? '#fff7f7' : tokens.petal,
                    fontSize: 11,
                    lineHeight: 1.6,
                    color: unusable ? tokens.danger : tokens.inkSoft,
                  }}
                >
                  {p.error}
                </div>
              )}

              {p.models.length > 0 ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                    gap: 4,
                  }}
                >
                  {p.models.map((model) => {
                    const checked = whitelist.has(model)
                    return (
                      <label
                        key={model}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          padding: '7px 10px',
                          borderRadius: tokens.radiusControl,
                          cursor: 'pointer',
                          background: checked ? tokens.petal : 'transparent',
                          border: `1px solid ${checked ? tokens.border : 'transparent'}`,
                          transition: `background ${tokens.durFast} ${tokens.ease}`,
                          minWidth: 0,
                        }}
                        onMouseEnter={(e) => {
                          if (!checked)
                            (e.currentTarget as HTMLElement).style.background = '#fafafa'
                        }}
                        onMouseLeave={(e) => {
                          if (!checked)
                            (e.currentTarget as HTMLElement).style.background = 'transparent'
                        }}
                      >
                        <CustomCheckbox checked={checked} onChange={() => toggle(model)} />
                        <span
                          style={{
                            fontSize: 12,
                            color: checked ? tokens.ink : tokens.inkSoft,
                            fontFamily: tokens.monoFont,
                            fontWeight: checked ? 500 : 400,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            minWidth: 0,
                          }}
                        >
                          {model}
                        </span>
                      </label>
                    )
                  })}
                </div>
              ) : (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: tokens.radiusControl,
                    background: tokens.petal,
                    border: `1px solid ${tokens.border}`,
                    fontSize: 11,
                    color: tokens.inkMuted,
                    lineHeight: 1.6,
                  }}
                >
                  {unusable
                    ? '这个 Provider 目前不可用，先修复上面的报错后再勾选模型。'
                    : '这个 Provider 已配置，但还没有发现可勾选的模型。'}
                </div>
              )}
            </div>
          )
        })}

        {filteredProviders.length === 0 && query && (
          <div style={{ fontSize: 12, color: tokens.inkMuted, padding: '6px 2px' }}>
            没有匹配 "{query}" 的模型
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.danger }}>{error}</div>
      )}
    </SectionCard>
  )
}

// ─── Custom checkbox ────────────────────────────────────────────────────────

function CustomCheckbox({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: () => void
}): React.ReactElement {
  return (
    <span
      onClick={(e) => {
        e.preventDefault()
        onChange()
      }}
      style={{
        width: 14,
        height: 14,
        borderRadius: 4,
        border: `1.5px solid ${checked ? tokens.brand : tokens.border}`,
        background: checked
          ? `linear-gradient(135deg, ${tokens.brand}, ${tokens.brandStrong})`
          : '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: `all ${tokens.durFast} ${tokens.ease}`,
      }}
    >
      {checked && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path
            d="M1.5 5.2L4 7.5L8.5 2.5"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  )
}
