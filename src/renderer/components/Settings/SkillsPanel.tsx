import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useHermesConfig, SkillView, SkillTemplate, SkillJobStatus } from '../../hooks/useHermesConfig'

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

function DiscoverTab({ onInstalled }: { onInstalled: () => void }) {
  const { listSkillTemplates, installSkillTemplate } = useHermesConfig()
  const [query, setQuery] = useState('')
  const [templates, setTemplates] = useState<SkillTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    listSkillTemplates()
      .then(setTemplates)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = query.trim()
    ? templates.filter((t) => {
        const q = query.toLowerCase()
        return (
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q)
        )
      })
    : templates

  // Group by category
  const groups: Record<string, SkillTemplate[]> = {}
  for (const t of filtered) {
    if (!groups[t.category]) groups[t.category] = []
    groups[t.category].push(t)
  }

  const handleInstall = async (identifier: string) => {
    setInstalling((prev) => new Set(prev).add(identifier))
    setErrors((prev) => { const next = { ...prev }; delete next[identifier]; return next })
    try {
      await installSkillTemplate(identifier)
      setTemplates((prev) =>
        prev.map((t) => t.identifier === identifier ? { ...t, installed: true } : t)
      )
      onInstalled()
    } catch (e: any) {
      setErrors((prev) => ({ ...prev, [identifier]: e.message ?? '安装失败' }))
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev)
        next.delete(identifier)
        return next
      })
    }
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="过滤模板（按名称、描述、分类）…"
        style={{
          width: '100%', padding: '6px 10px', fontSize: 12,
          border: '1px solid #fce4ec', borderRadius: 6, outline: 'none',
          boxSizing: 'border-box', marginBottom: 10,
        }}
      />
      {loading && <div style={{ fontSize: 12, color: '#aaa' }}>加载中…</div>}
      {!loading && filtered.length === 0 && (
        <div style={{ fontSize: 12, color: '#aaa' }}>无匹配模板</div>
      )}
      {Object.entries(groups).map(([category, items], groupIdx) => (
        <div key={category}>
          <div style={{
            fontSize: 11, color: '#FF69B4', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.5,
            margin: groupIdx === 0 ? '0 0 6px' : '12px 0 6px',
            padding: '0 2px',
          }}>
            {category} ({items.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((t) => {
              const isInstalling = installing.has(t.identifier)
              const err = errors[t.identifier]
              return (
                <div key={t.identifier} style={{
                  padding: '8px 10px', borderRadius: 6, background: '#fafafa', border: '1px solid #eee',
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 2 }}>
                      {t.name}
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      {t.description.length > 80 ? t.description.slice(0, 80) + '…' : t.description}
                    </div>
                    {err && (
                      <div style={{ fontSize: 11, color: '#e53935', marginTop: 2 }}>{err}</div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    {t.installed ? (
                      <span style={{ fontSize: 11, color: '#aaa' }}>✓ 已安装</span>
                    ) : isInstalling ? (
                      <button disabled style={{ ...BTN_PRIMARY, fontSize: 11, padding: '3px 10px', opacity: 0.6 }}>
                        安装中…
                      </button>
                    ) : (
                      <button
                        onClick={() => handleInstall(t.identifier)}
                        style={{ ...BTN_PRIMARY, fontSize: 11, padding: '3px 10px' }}
                      >
                        安装
                      </button>
                    )}
                    {err && (
                      <button onClick={() => handleInstall(t.identifier)} style={{ ...BTN_GHOST }}>
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
        />
      )}

      {error && <div style={{ marginTop: 8, fontSize: 12, color: '#e53935' }}>{error}</div>}
    </div>
  )
}
