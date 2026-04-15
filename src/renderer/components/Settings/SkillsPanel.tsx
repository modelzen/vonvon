import React, {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useHermesConfig, SkillView, SkillDiscoverItem, SkillJobStatus } from '../../hooks/useHermesConfig'
import { SectionCard } from './SectionCard'
import { tokens, btnPrimaryStyle as BTN_PRIMARY, btnGhostStyle as BTN_GHOST } from './settingsStyles'

const BADGE: Record<string, React.CSSProperties> = {
  official: { background: '#e3f2fd', color: '#1565c0' },
  trusted: { background: '#e8f5e9', color: '#2e7d32' },
  community: { background: '#fff8e1', color: '#f57f17' },
  builtin: { background: '#e3f2fd', color: '#1565c0' },
}

const DISCOVER_PAGE_SIZE = 48
const DISCOVER_SOURCE_ORDER = ['all', 'built-in', 'optional', 'anthropic', 'lobehub'] as const
const DISCOVER_SOURCE_LABELS: Record<(typeof DISCOVER_SOURCE_ORDER)[number], string> = {
  all: '全部',
  'built-in': 'Built-in',
  optional: 'Optional',
  anthropic: 'Anthropic',
  lobehub: 'LobeHub',
}

function trustBadge(trust: string): React.ReactElement {
  const s = BADGE[trust] ?? BADGE.community
  return (
    <span style={{ ...s, fontSize: 10, borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>
      {trust}
    </span>
  )
}

function mergeDiscoverItems(
  prev: SkillDiscoverItem[],
  next: SkillDiscoverItem[]
): SkillDiscoverItem[] {
  const merged = new Map<string, SkillDiscoverItem>()
  for (const item of prev) merged.set(item.identifier, item)
  for (const item of next) merged.set(item.identifier, item)
  return Array.from(merged.values())
}

function useJobPoller(pollSkillJob: (id: string) => Promise<SkillJobStatus>) {
  const [jobs, setJobs] = useState<Record<string, SkillJobStatus>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const trackJob = useCallback((job: SkillJobStatus) => {
    setJobs((prev) => ({ ...prev, [job.job_id]: job }))
    if (job.status === 'pending' || job.status === 'running') {
      timers.current[job.job_id] = setTimeout(async () => {
        try {
          const updated = await pollSkillJob(job.job_id)
          setJobs((prev) => ({ ...prev, [updated.job_id]: updated }))
          if (updated.status === 'pending' || updated.status === 'running') {
            trackJob(updated)
          }
        } catch {}
      }, 2000)
    }
  }, [pollSkillJob])

  useEffect(() => () => {
    Object.values(timers.current).forEach(clearTimeout)
  }, [])

  return { jobs, trackJob }
}

function InstalledTab({
  skills, onToggle, onUninstall, jobs,
}: {
  skills: SkillView[]
  onToggle: (name: string, enabled: boolean) => void
  onUninstall: (name: string) => void
  jobs: Record<string, SkillJobStatus>
}) {
  const uninstallJobs = Object.values(jobs).filter(
    (j) => j.kind === 'uninstall' && (j.status === 'pending' || j.status === 'running')
  )
  const uninstallingNames = new Set(uninstallJobs.map((j) => j.identifier))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {skills.length === 0 && (
        <div style={{ fontSize: 12, color: '#aaa' }}>暂无已安装 skill</div>
      )}
      {skills.map((s) => {
        const uninstalling = uninstallingNames.has(s.name)
        return (
          <div key={s.name} style={{
            padding: '8px 10px', borderRadius: 6,
            background: '#fafafa', border: '1px solid #eee',
            opacity: s.enabled ? 1 : 0.72,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#333', flex: 1 }}>
                {s.name}
                {s.category && <span style={{ color: '#aaa', fontWeight: 400, marginLeft: 4 }}>{s.category}</span>}
              </span>
              <button
                onClick={() => onUninstall(s.name)}
                disabled={uninstalling}
                style={{ fontSize: 11, color: '#e53935', background: 'none', border: 'none', cursor: 'pointer', opacity: uninstalling ? 0.5 : 1 }}
              >
                {uninstalling ? '卸载中…' : '卸载'}
              </button>
            </div>
            {s.description && (
              <div style={{ fontSize: 11, color: '#777', marginBottom: 6 }}>
                {s.description.length > 60 ? `${s.description.slice(0, 60)}…` : s.description}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 11, color: '#999' }}>
                {s.enabled ? '在对话页可见，可被选择和触发' : '已停用，不会出现在 / 弹出里，也不会被触发'}
              </div>
              <label style={{ fontSize: 11, color: '#555', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => onToggle(s.name, e.target.checked)}
                />
                启用
              </label>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DiscoverTab({
  onInstalled,
  onError,
  jobs,
  trackJob,
  refreshToken,
}: {
  onInstalled: () => void
  onError: (message: string) => void
  jobs: Record<string, SkillJobStatus>
  trackJob: (job: SkillJobStatus) => void
  refreshToken: number
}) {
  const { listDiscoverSkills, startInstallSkill, startImportSkill, installSkillTemplate } = useHermesConfig()
  const [query, setQuery] = useState('')
  const [importSource, setImportSource] = useState('')
  const [importingSource, setImportingSource] = useState(false)
  const deferredQuery = useDeferredValue(query.trim())
  const [items, setItems] = useState<SkillDiscoverItem[]>([])
  const [loadingInitial, setLoadingInitial] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [activeSource, setActiveSource] = useState<(typeof DISCOVER_SOURCE_ORDER)[number]>('all')
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const completedJobs = useRef<Set<string>>(new Set())
  const requestIdRef = useRef(0)
  const fetchingRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // useHermesConfig() returns fresh function identities on every render.
  // Keep the latest APIs in refs so our effects only re-run when the actual
  // query/source inputs change, not on every state update inside this tab.
  const listDiscoverSkillsRef = useRef(listDiscoverSkills)
  const startInstallSkillRef = useRef(startInstallSkill)
  const startImportSkillRef = useRef(startImportSkill)
  const installSkillTemplateRef = useRef(installSkillTemplate)
  listDiscoverSkillsRef.current = listDiscoverSkills
  startInstallSkillRef.current = startInstallSkill
  startImportSkillRef.current = startImportSkill
  installSkillTemplateRef.current = installSkillTemplate

  const fetchPage = useCallback(async (requestedOffset: number, reset: boolean) => {
    if (fetchingRef.current && !reset) return
    const requestId = ++requestIdRef.current
    fetchingRef.current = true
    if (reset) {
      setLoadingInitial(true)
    } else {
      setLoadingMore(true)
    }

    try {
      const page = await listDiscoverSkillsRef.current(
        deferredQuery,
        DISCOVER_PAGE_SIZE,
        activeSource,
        requestedOffset
      )
      if (requestId !== requestIdRef.current) return

      startTransition(() => {
        setItems((prev) => (reset ? page.items : mergeDiscoverItems(prev, page.items)))
        setTotal(page.total)
        setHasMore(page.has_more)
      })
    } catch (e: any) {
      if (requestId !== requestIdRef.current) return
      onError(e.message ?? '加载 skill hub 失败')
    } finally {
      if (requestId !== requestIdRef.current) return
      fetchingRef.current = false
      if (reset) setLoadingInitial(false)
      else setLoadingMore(false)
    }
  }, [activeSource, deferredQuery, onError])

  useEffect(() => {
    void fetchPage(0, true)
  }, [fetchPage, refreshToken])

  useEffect(() => {
    let shouldRefresh = false
    Object.values(jobs).forEach((job) => {
      if (
        (job.kind !== 'install' && job.kind !== 'import')
        || job.status !== 'success'
        || completedJobs.current.has(job.job_id)
      ) {
        return
      }
      completedJobs.current.add(job.job_id)
      shouldRefresh = true
    })
    if (shouldRefresh) {
      void fetchPage(0, true)
      onInstalled()
    }
  }, [fetchPage, jobs, onInstalled])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !hasMore || loadingInitial || loadingMore || typeof IntersectionObserver === 'undefined') {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void fetchPage(items.length, false)
        }
      },
      { root: null, rootMargin: '240px 0px' }
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [fetchPage, hasMore, items.length, loadingInitial, loadingMore])

  const installJobs = Object.values(jobs).filter(
    (job) => job.kind === 'install' && (job.status === 'pending' || job.status === 'running')
  )
  const installingIds = new Set(installJobs.map((job) => job.identifier))

  const groups = useMemo(() => {
    const grouped: Record<string, SkillDiscoverItem[]> = {}
    for (const item of items) {
      if (!grouped[item.category_label]) grouped[item.category_label] = []
      grouped[item.category_label].push(item)
    }
    return grouped
  }, [items])

  const hasRemoteCatalog = items.some((item) => item.source !== 'built-in')
  const showSyncHint = !loadingInitial && !deferredQuery && activeSource === 'all' && !hasRemoteCatalog
  const emptyMessage = !deferredQuery && activeSource === 'all'
    ? '远程 skill 目录尚未同步，点击右上角“更新源”获取最新列表'
    : '无匹配 skill'

  const handleInstall = async (item: SkillDiscoverItem) => {
    const { identifier } = item
    setInstalling((prev) => new Set(prev).add(identifier))
    setErrors((prev) => {
      const next = { ...prev }
      delete next[identifier]
      return next
    })
    try {
      if (item.install_kind === 'template') {
        await installSkillTemplateRef.current(identifier)
        await fetchPage(0, true)
        onInstalled()
      } else {
        const job = await startInstallSkillRef.current(identifier)
        trackJob(job)
      }
    } catch (e: any) {
      onError(e.message ?? '安装失败')
      setErrors((prev) => ({ ...prev, [identifier]: e.message ?? '安装失败' }))
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev)
        next.delete(identifier)
        return next
      })
    }
  }

  const handleImport = async () => {
    const source = importSource.trim()
    if (!source || importingSource) return
    setImportingSource(true)
    try {
      const job = await startImportSkillRef.current({
        source,
        conflict_strategy: 'error',
      })
      trackJob(job)
      setImportSource('')
    } catch (e: any) {
      onError(e.message ?? '导入失败')
    } finally {
      setImportingSource(false)
    }
  }

  return (
    <div>
      <div
        style={{
          marginBottom: 10,
          borderRadius: 12,
          border: `1px solid ${tokens.border}`,
          background: 'rgba(255, 245, 249, 0.85)',
          padding: '10px 12px',
        }}
      >
        <div style={{ fontSize: 12, color: tokens.inkSoft, marginBottom: 8, lineHeight: 1.55 }}>
          从 GitHub repo/tree/raw URL 或本地目录导入 skill。优先复用现成 `SKILL.md`，必要时自动转成 Hermes 兼容格式。
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={importSource}
            onChange={(e) => setImportSource(e.target.value)}
            placeholder="例如：https://github.com/alibaba-flyai/flyai-skill 或 ~/Downloads/my-skill"
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: 12,
              border: '1px solid #fce4ec',
              borderRadius: 6,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <button
            onClick={() => void handleImport()}
            disabled={!importSource.trim() || importingSource}
            style={{
              ...BTN_PRIMARY,
              fontSize: 11,
              padding: '6px 10px',
              opacity: !importSource.trim() || importingSource ? 0.6 : 1,
            }}
          >
            {importingSource ? '导入中…' : '导入'}
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {DISCOVER_SOURCE_ORDER.map((tab) => {
            const active = activeSource === tab
            return (
              <button
                key={tab}
                onClick={() => setActiveSource(tab)}
                style={{
                  ...BTN_GHOST,
                  fontSize: 11,
                  padding: '4px 10px',
                  color: active ? tokens.blossom : tokens.inkMuted,
                  borderColor: active ? tokens.blossom : tokens.inkHair,
                  background: active ? 'rgba(255, 105, 180, 0.08)' : '#fff',
                }}
              >
                {DISCOVER_SOURCE_LABELS[tab]}
              </button>
            )
          })}
        </div>
        <div style={{ fontSize: 11, color: tokens.inkMuted }}>
          已显示 {items.length} / {total}
        </div>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="过滤 skill（名称、描述、分类、标签）…"
        style={{
          width: '100%', padding: '6px 10px', fontSize: 12,
          border: '1px solid #fce4ec', borderRadius: 6, outline: 'none',
          boxSizing: 'border-box', marginBottom: 10,
        }}
      />

      {showSyncHint && (
        <div
          style={{
            marginBottom: 10,
            borderRadius: 12,
            border: `1px solid ${tokens.border}`,
            background: 'rgba(255, 245, 249, 0.85)',
            padding: '10px 12px',
            fontSize: 12,
            color: tokens.inkSoft,
            lineHeight: 1.55,
          }}
        >
          当前只展示本地 built-in skill。点右上角“更新源”后，下面会继续按滚动逐页加载远程目录。
        </div>
      )}

      {loadingInitial && <div style={{ fontSize: 12, color: '#aaa' }}>加载中…</div>}
      {!loadingInitial && items.length === 0 && (
        <div style={{ fontSize: 12, color: '#aaa' }}>{emptyMessage}</div>
      )}

      {Object.entries(groups).map(([category, categoryItems], groupIdx) => (
        <div key={category}>
          <div style={{
            fontSize: 11, color: '#FF69B4', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.5,
            margin: groupIdx === 0 ? '0 0 6px' : '12px 0 6px',
            padding: '0 2px',
          }}>
            {category} ({categoryItems.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {categoryItems.map((item) => {
              const isInstalling = installing.has(item.identifier) || installingIds.has(item.identifier)
              const err = errors[item.identifier]
              return (
                <div key={item.identifier} style={{
                  padding: '8px 10px', borderRadius: 6, background: '#fafafa', border: '1px solid #eee',
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>
                        {item.name}
                      </div>
                      <span style={{ fontSize: 10, color: tokens.inkMuted }}>{item.source_label}</span>
                      {trustBadge(item.trust_level)}
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      {item.description.length > 110 ? `${item.description.slice(0, 110)}…` : item.description}
                    </div>
                    {item.tags.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
                        {item.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            style={{
                              fontSize: 10,
                              borderRadius: 999,
                              padding: '2px 6px',
                              background: '#fff8e1',
                              color: '#b28704',
                              border: '1px solid #ffe9a8',
                            }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {err && (
                      <div style={{ fontSize: 11, color: '#e53935', marginTop: 4 }}>{err}</div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    {item.installed ? (
                      <span style={{ fontSize: 11, color: '#aaa' }}>✓ 已安装</span>
                    ) : isInstalling ? (
                      <button disabled style={{ ...BTN_PRIMARY, fontSize: 11, padding: '3px 10px', opacity: 0.6 }}>
                        安装中…
                      </button>
                    ) : (
                      <button
                        onClick={() => handleInstall(item)}
                        style={{ ...BTN_PRIMARY, fontSize: 11, padding: '3px 10px' }}
                      >
                        安装
                      </button>
                    )}
                    {err && (
                      <button onClick={() => handleInstall(item)} style={{ ...BTN_GHOST }}>
                        重试
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div ref={sentinelRef} style={{ height: 1 }} />
      {!loadingInitial && loadingMore && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.inkMuted }}>
          正在继续加载更多 skill…
        </div>
      )}
      {!loadingInitial && !loadingMore && items.length > 0 && !hasMore && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.inkMuted }}>
          已经到底了
        </div>
      )}
    </div>
  )
}

export function SkillsPanel(): React.ReactElement {
  const {
    listSkills,
    toggleSkill,
    startUninstallSkill,
    pollSkillJob,
    refreshDiscoverSkillsSource,
  } = useHermesConfig()
  const [skills, setSkills] = useState<SkillView[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'installed' | 'discover'>('installed')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [updatingSource, setUpdatingSource] = useState(false)
  const [discoverRefreshToken, setDiscoverRefreshToken] = useState(0)

  const { jobs, trackJob } = useJobPoller(pollSkillJob)

  const refresh = () => {
    listSkills()
      .then(setSkills)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const handleRefreshSource = async () => {
    setUpdatingSource(true)
    setError('')
    setNotice('')
    try {
      const result = await refreshDiscoverSkillsSource()
      setDiscoverRefreshToken((prev) => prev + 1)
      setNotice(`技能源已更新，已同步 ${result.count} 个远程 skill`)
    } catch (e: any) {
      const message = String(e?.message ?? '')
      if (message.includes('404')) {
        setError('当前后端还没加载到“更新源”接口，请重启应用或后端后再试')
      } else {
        setError(e.message ?? '更新技能源失败')
      }
    } finally {
      setUpdatingSource(false)
    }
  }

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      const updated = await toggleSkill({ name, enabled, scope: 'both' })
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, ...updated } : s)))
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleUninstall = async (name: string) => {
    try {
      const job = await startUninstallSkill(name)
      trackJob(job)
      setTimeout(refresh, 3000)
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <SectionCard
      title="Skill 管理"
      subtitle={skills.length > 0 ? `已安装 ${skills.length} 个 skill` : '安装 skill 以扩展 agent 的能力'}
      action={
        <button
          onClick={handleRefreshSource}
          disabled={updatingSource}
          style={{ ...BTN_GHOST, opacity: updatingSource ? 0.65 : 1 }}
        >
          {updatingSource ? '更新中…' : '更新源'}
        </button>
      }
    >
      <div
        style={{
          display: 'flex',
          gap: 0,
          marginBottom: 14,
          borderBottom: `1px solid ${tokens.inkHair}`,
        }}
      >
        {(['installed', 'discover'] as const).map((tab) => {
          const active = activeTab === tab
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '8px 18px',
                fontSize: 12,
                fontFamily: tokens.bodyFont,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontWeight: active ? 600 : 500,
                color: active ? tokens.blossom : tokens.inkMuted,
                borderBottom: active ? `2px solid ${tokens.blossom}` : '2px solid transparent',
                marginBottom: -1,
                transition: `color ${tokens.durFast} ${tokens.easeOut}`,
              }}
            >
              {tab === 'installed' ? `已安装 (${skills.length})` : '发现'}
            </button>
          )
        })}
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: tokens.inkMuted }}>加载中…</div>
      ) : activeTab === 'installed' ? (
        <InstalledTab
          skills={skills}
          onToggle={handleToggle}
          onUninstall={handleUninstall}
          jobs={jobs}
        />
      ) : (
        <DiscoverTab
          onInstalled={refresh}
          onError={setError}
          jobs={jobs}
          trackJob={trackJob}
          refreshToken={discoverRefreshToken}
        />
      )}

      {notice && <div style={{ marginTop: 10, fontSize: 12, color: '#2e7d32' }}>{notice}</div>}
      {error && <div style={{ marginTop: 10, fontSize: 12, color: tokens.danger }}>{error}</div>}
    </SectionCard>
  )
}
