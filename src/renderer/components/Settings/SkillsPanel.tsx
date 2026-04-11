import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useHermesConfig, SkillView, SkillTemplate, SkillJobStatus } from '../../hooks/useHermesConfig'
import { SectionCard } from './SectionCard'
import { tokens, btnPrimaryStyle as BTN_PRIMARY, btnGhostStyle as BTN_GHOST } from './settingsStyles'
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
    <SectionCard
      title="Skill 管理"
      index="04"
      subtitle={skills.length > 0 ? `已安装 ${skills.length} 个 skill` : '安装 skill 以扩展 agent 的能力'}
      action={
        <button onClick={handleCheckUpdates} style={{ ...BTN_GHOST, position: 'relative' }}>
          检查更新
          {updateBadge > 0 && (
            <span
              style={{
                position: 'absolute',
                top: -5,
                right: -5,
                background: tokens.danger,
                color: '#fff',
                borderRadius: '50%',
                width: 15,
                height: 15,
                fontSize: 9,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 6px rgba(214,69,69,0.35)',
              }}
            >
              {updateBadge}
            </span>
          )}
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
        <DiscoverTab onInstalled={refresh} />
      )}

      {error && <div style={{ marginTop: 10, fontSize: 12, color: tokens.danger }}>{error}</div>}
    </SectionCard>
  )
}
