import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useHermesConfig, SkillView, SkillSearchResult, SkillJobStatus } from '../../hooks/useHermesConfig'

const SECTION_STYLE: React.CSSProperties = { padding: '16px 0', borderBottom: '1px solid #fce4ec' }
const BTN_PRIMARY: React.CSSProperties = {
  padding: '5px 14px', fontSize: 12, borderRadius: 6, border: 'none',
  background: 'linear-gradient(135deg, #FF69B4, #FF1493)', color: '#fff',
  cursor: 'pointer', fontWeight: 600,
}
const BTN_GHOST: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, borderRadius: 6,
  border: '1px solid #FF69B4', background: '#fff', color: '#FF69B4',
  cursor: 'pointer',
}
const BADGE: Record<string, React.CSSProperties> = {
  official: { background: '#e3f2fd', color: '#1565c0' },
  trusted: { background: '#e8f5e9', color: '#2e7d32' },
  community: { background: '#fff8e1', color: '#f57f17' },
  builtin: { background: '#e3f2fd', color: '#1565c0' },
}

function trustBadge(trust: string): React.ReactElement {
  const s = BADGE[trust] ?? BADGE.community
  return (
    <span style={{ ...s, fontSize: 10, borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>
      {trust}
    </span>
  )
}

// ── Job status tracker ───────────────────────────────────────────────────────

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

// ── Installed tab ────────────────────────────────────────────────────────────

function InstalledTab({
  skills, onToggle, onUninstall, jobs,
}: {
  skills: SkillView[]
  onToggle: (name: string, enabled: boolean, scope: 'vonvon' | 'global') => void
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
                {s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12 }}>
              <label style={{ fontSize: 11, color: '#555', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={s.enabled_vonvon}
                  onChange={(e) => onToggle(s.name, e.target.checked, 'vonvon')}
                />
                vonvon
              </label>
              <label style={{ fontSize: 11, color: '#555', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={s.enabled_global}
                  onChange={(e) => onToggle(s.name, e.target.checked, 'global')}
                />
                全局
              </label>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Discover tab ─────────────────────────────────────────────────────────────

function DiscoverTab({
  onInstalled, jobs, trackJob,
}: {
  onInstalled: () => void
  jobs: Record<string, SkillJobStatus>
  trackJob: (job: SkillJobStatus) => void
}) {
  const { searchSkills, startInstallSkill } = useHermesConfig()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SkillSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSearch = useCallback((q: string) => {
    if (!q.trim()) { setResults([]); return }
    setSearching(true)
    searchSkills(q, 10)
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setSearching(false))
  }, [searchSkills])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(query), 400)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, doSearch])

  const installJobs = Object.values(jobs).filter((j) => j.kind === 'install')
  const installingIds = new Set(
    installJobs.filter((j) => j.status === 'pending' || j.status === 'running').map((j) => j.identifier)
  )

  const handleInstall = async (identifier: string) => {
    try {
      const job = await startInstallSkill(identifier)
      trackJob(job)
    } catch {}
  }

  useEffect(() => {
    const justSucceeded = installJobs.some((j) => j.status === 'success')
    if (justSucceeded) onInstalled()
  }, [jobs])

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索 skill（如 pptx, git, web）…"
        style={{
          width: '100%', padding: '6px 10px', fontSize: 12,
          border: '1px solid #fce4ec', borderRadius: 6, outline: 'none',
          boxSizing: 'border-box', marginBottom: 10,
        }}
      />
      {searching && <div style={{ fontSize: 12, color: '#aaa' }}>搜索中…</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {results.map((r) => {
          const isInstalling = installingIds.has(r.identifier)
          const done = installJobs.find((j) => j.identifier === r.identifier && j.status === 'success')
          const failed = installJobs.find((j) => j.identifier === r.identifier && j.status === 'error')
          return (
            <div key={r.identifier} style={{
              padding: '8px 10px', borderRadius: 6, background: '#fafafa', border: '1px solid #eee',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>{r.name}</span>
                  {trustBadge(r.trust_level)}
                </div>
                <div style={{ fontSize: 11, color: '#777' }}>
                  {r.description.length > 70 ? r.description.slice(0, 70) + '…' : r.description}
                </div>
                {failed && <div style={{ fontSize: 11, color: '#e53935', marginTop: 2 }}>{failed.error}</div>}
              </div>
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                {done ? (
                  <span style={{ fontSize: 11, color: '#4caf50' }}>✓ 已安装</span>
                ) : (
                  <button
                    onClick={() => handleInstall(r.identifier)}
                    disabled={isInstalling}
                    style={{ ...BTN_PRIMARY, fontSize: 11, padding: '3px 10px', opacity: isInstalling ? 0.6 : 1 }}
                  >
                    {isInstalling ? '安装中…' : '安装'}
                  </button>
                )}
                {failed && (
                  <button onClick={() => handleInstall(r.identifier)} style={{ ...BTN_GHOST }}>重试</button>
                )}
              </div>
            </div>
          )
        })}
        {!searching && query && results.length === 0 && (
          <div style={{ fontSize: 12, color: '#aaa' }}>
            无匹配结果。如未配置 GitHub token，hub 搜索可能受限。
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function SkillsPanel(): React.ReactElement {
  const { listSkills, toggleSkill, startUninstallSkill, pollSkillJob, checkSkillUpdates } = useHermesConfig()
  const [skills, setSkills] = useState<SkillView[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'installed' | 'discover'>('installed')
  const [updateBadge, setUpdateBadge] = useState(0)
  const [error, setError] = useState('')

  const { jobs, trackJob } = useJobPoller(pollSkillJob)

  const refresh = () => {
    listSkills()
      .then(setSkills)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const handleCheckUpdates = () => {
    checkSkillUpdates()
      .then((res) => setUpdateBadge(res.updates.length))
      .catch(() => {})
  }

  const handleToggle = async (name: string, enabled: boolean, scope: 'vonvon' | 'global') => {
    try {
      const updated = await toggleSkill({ name, enabled, scope })
      setSkills((prev) => prev.map((s) => s.name === name ? { ...s, ...updated } : s))
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleUninstall = async (name: string) => {
    try {
      const job = await startUninstallSkill(name)
      trackJob(job)
      // Remove from list optimistically; refresh after job done
      setTimeout(refresh, 3000)
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div style={SECTION_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#d81b60' }}>Skill 管理</h3>
        <button onClick={handleCheckUpdates} style={{ ...BTN_GHOST, position: 'relative' }}>
          检查更新
          {updateBadge > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -4, background: '#e53935',
              color: '#fff', borderRadius: '50%', width: 14, height: 14,
              fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {updateBadge}
            </span>
          )}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 0, marginBottom: 12, borderBottom: '1px solid #eee' }}>
        {(['installed', 'discover'] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: '6px 16px', fontSize: 12, border: 'none', background: 'none',
            cursor: 'pointer', fontWeight: activeTab === tab ? 700 : 400,
            color: activeTab === tab ? '#FF69B4' : '#888',
            borderBottom: activeTab === tab ? '2px solid #FF69B4' : '2px solid transparent',
          }}>
            {tab === 'installed' ? `已安装 (${skills.length})` : '发现'}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: '#aaa' }}>加载中…</div>
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
          jobs={jobs}
          trackJob={trackJob}
        />
      )}

      {error && <div style={{ marginTop: 8, fontSize: 12, color: '#e53935' }}>{error}</div>}
    </div>
  )
}
