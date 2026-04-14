import { useBackend } from './useBackend'

// ─── Response types ────────────────────────────────────────────────────────────

export interface ProviderInfo {
  slug: string
  name: string
  models: string[]
  total_models: number
  is_current: boolean
  source?: string
}

export interface ListModelsResponse {
  providers: ProviderInfo[]
  current: string
  current_provider: string
}

export interface SwitchModelRequest {
  model: string
  provider?: string
  base_url?: string
  persist?: boolean
}

export interface SwitchModelResponse {
  model: string
  provider: string
  base_url?: string
  api_mode?: string
  persisted: boolean
  warning?: string
}

export interface CredentialView {
  id: string
  provider: string
  label: string
  auth_type: string
  last4: string
  source: string
  status?: string
  is_current: boolean
}

export interface OAuthStartResponse {
  flow_id: string
  provider: string
  user_code: string
  verification_url: string
  interval: number
  expires_in_seconds: number
}

export interface OAuthPollResponse {
  status: 'pending' | 'success' | 'error' | 'timeout'
  credential?: CredentialView
  error?: string
}

export interface McpServerConfig {
  name: string
  url?: string
  command?: string
  args?: string[]
  headers?: Record<string, string>
  env?: Record<string, string>
  enabled?: boolean
}

export interface McpServerView extends McpServerConfig {
  tools_count?: number
  last_probed_at?: number
  last_error?: string
}

export interface McpProbeResult {
  ok: boolean
  latency_ms: number
  tools: Array<{ name: string; description: string }>
  error?: string
}

export interface McpServerEnabledRequest {
  enabled: boolean
}

export interface SkillView {
  name: string
  category?: string
  description: string
  install_path: string
  version?: string
  source?: string
  enabled_global: boolean
  enabled_vonvon: boolean
}

export interface SkillToggleRequest {
  name: string
  enabled: boolean
  scope: 'vonvon' | 'global'
}

export interface SkillSearchResult {
  identifier: string
  name: string
  description: string
  source: string
  trust_level: string
}

export interface SkillDiscoverItem {
  identifier: string
  name: string
  description: string
  source: string
  source_label: string
  trust_level: string
  category: string
  category_label: string
  tags: string[]
  install_kind: 'template' | 'hub'
  installed: boolean
}

export interface SkillDiscoverPage {
  items: SkillDiscoverItem[]
  total: number
  offset: number
  limit: number
  has_more: boolean
}

export interface SkillDiscoverRefreshResponse {
  count: number
  updated_at: number
  sources: Record<string, number>
}

export interface SkillTemplate {
  name: string
  category: string
  description: string
  identifier: string
  installed: boolean
}

export interface SkillJobStatus {
  job_id: string
  kind: string
  identifier: string
  status: 'pending' | 'running' | 'success' | 'error'
  error?: string
  skill?: SkillView
  started_at: number
  updated_at: number
}

export interface WorkspaceState {
  path: string
  exists: boolean
  is_dir: boolean
  is_sandbox: boolean
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useHermesConfig() {
  const { apiFetch } = useBackend()

  async function json<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await apiFetch(path, options)
    if (!res.ok) {
      let detail = res.statusText
      try {
        const body = await res.json()
        detail = body.detail ?? body.message ?? detail
      } catch {}
      throw new Error(`API error ${res.status}: ${detail}`)
    }
    return res.json() as Promise<T>
  }

  function post<T>(path: string, body?: unknown): Promise<T> {
    return json<T>(path, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  function del<T>(path: string): Promise<T> {
    return json<T>(path, { method: 'DELETE' })
  }

  // ── Models ──────────────────────────────────────────────────────────────────

  const listModels = () => json<ListModelsResponse>('/api/models')

  const switchModel = (req: SwitchModelRequest) =>
    post<SwitchModelResponse>('/api/models/current', req)

  // ── Credentials ─────────────────────────────────────────────────────────────

  const listCredentials = () => json<CredentialView[]>('/api/auth/credentials')

  const addApiKey = (req: {
    provider: string
    api_key: string
    label?: string
    base_url?: string
  }) => post<CredentialView>('/api/auth/credentials', { ...req, auth_type: 'api_key' })

  const removeCredential = (provider: string, cred_id: string): Promise<void> =>
    del(`/api/auth/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(cred_id)}`)

  const setCurrentCredential = (provider: string, cred_id: string) =>
    post<CredentialView>(
      `/api/auth/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(cred_id)}/current`
    )

  // ── OAuth (codex) ────────────────────────────────────────────────────────────

  const startCodexOAuth = (label?: string) => {
    const params = new URLSearchParams({ provider: 'openai-codex' })
    if (label?.trim()) params.set('label', label.trim())
    return post<OAuthStartResponse>(`/api/auth/oauth/start?${params.toString()}`)
  }

  const pollCodexOAuth = (flow_id: string) =>
    json<OAuthPollResponse>(`/api/auth/oauth/poll?flow_id=${encodeURIComponent(flow_id)}`)

  const cancelCodexOAuth = (flow_id: string): Promise<void> =>
    del(`/api/auth/oauth/flows/${encodeURIComponent(flow_id)}`)

  // ── MCP ─────────────────────────────────────────────────────────────────────

  const listMcpServers = () => json<McpServerView[]>('/api/mcp/servers')

  const addMcpServer = (cfg: McpServerConfig, probe = true) =>
    post<McpServerView>(`/api/mcp/servers?probe=${probe}`, cfg)

  const removeMcpServer = (name: string): Promise<void> =>
    del(`/api/mcp/servers/${encodeURIComponent(name)}`)

  const setMcpServerEnabled = (name: string, enabled: boolean) =>
    post<McpServerView>(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, { enabled })

  const testMcpServer = (name: string) =>
    post<McpProbeResult>(`/api/mcp/servers/${encodeURIComponent(name)}/test`)

  // ── Skills ──────────────────────────────────────────────────────────────────

  const listSkills = () => json<SkillView[]>('/api/skills')

  const toggleSkill = (req: SkillToggleRequest) =>
    post<SkillView>('/api/skills/toggle', req)

  const searchSkills = (q: string, limit = 10) =>
    json<SkillSearchResult[]>(
      `/api/skills/search?q=${encodeURIComponent(q)}&limit=${limit}`
    )

  const listDiscoverSkills = (q = '', limit = 60, source = 'all', offset = 0) =>
    json<SkillDiscoverPage>(
      `/api/skills/discover?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&source=${encodeURIComponent(source)}`
    )

  const refreshDiscoverSkillsSource = () =>
    post<SkillDiscoverRefreshResponse>('/api/skills/discover/refresh')

  const startInstallSkill = (identifier: string) =>
    post<SkillJobStatus>('/api/skills/install', { identifier })

  const startUninstallSkill = (name: string) =>
    post<SkillJobStatus>(`/api/skills/uninstall?name=${encodeURIComponent(name)}`)

  const pollSkillJob = (job_id: string) =>
    json<SkillJobStatus>(`/api/skills/jobs/${encodeURIComponent(job_id)}`)

  const checkSkillUpdates = () =>
    json<{ updates: unknown[]; error: string | null }>('/api/skills/updates')

  const listSkillTemplates = () => json<SkillTemplate[]>('/api/skills/templates')

  const installSkillTemplate = (identifier: string) =>
    post<SkillView>('/api/skills/templates/install', { identifier })

  // ── Workspace ────────────────────────────────────────────────────────────────

  const getWorkspace = () => json<WorkspaceState>('/api/workspace')

  const setWorkspace = (path: string) =>
    post<WorkspaceState>('/api/workspace', { path })

  const resetWorkspace = () => post<WorkspaceState>('/api/workspace/reset')

  return {
    listModels,
    switchModel,
    listCredentials,
    addApiKey,
    removeCredential,
    setCurrentCredential,
    startCodexOAuth,
    pollCodexOAuth,
    cancelCodexOAuth,
    listMcpServers,
    addMcpServer,
    removeMcpServer,
    setMcpServerEnabled,
    testMcpServer,
    listSkills,
    toggleSkill,
    searchSkills,
    listDiscoverSkills,
    refreshDiscoverSkillsSource,
    startInstallSkill,
    startUninstallSkill,
    pollSkillJob,
    checkSkillUpdates,
    listSkillTemplates,
    installSkillTemplate,
    getWorkspace,
    setWorkspace,
    resetWorkspace,
  }
}
