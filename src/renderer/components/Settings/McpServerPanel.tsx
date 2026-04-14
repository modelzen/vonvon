import React, { useEffect, useState } from 'react'
import { useHermesConfig, McpServerConfig, McpServerView, McpProbeResult } from '../../hooks/useHermesConfig'
import { SectionCard } from './SectionCard'
import {
  tokens,
  inputStyle as INPUT_STYLE,
  btnPrimaryStyle as BTN_PRIMARY,
  btnGhostStyle as BTN_GHOST,
  labelStyle as LABEL_STYLE,
  applyFocusRing,
} from './settingsStyles'

type TransportKind = 'http' | 'stdio'
type ValueRow = { id: string; value: string }
type PairRow = { id: string; key: string; value: string }

const createId = () => Math.random().toString(36).slice(2, 10)
const createValueRow = (value = ''): ValueRow => ({ id: createId(), value })
const createPairRow = (key = '', value = ''): PairRow => ({ id: createId(), key, value })

const drawerCardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 18,
  padding: 24,
  width: 'min(720px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  border: `1px solid ${tokens.border}`,
  boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
}

const groupedSectionStyle: React.CSSProperties = {
  background: tokens.cardSoft,
  border: `1px solid ${tokens.border}`,
  borderRadius: 16,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: tokens.ink,
  margin: 0,
}

const sectionHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: tokens.inkMuted,
  margin: '-6px 0 0',
  lineHeight: 1.5,
}

const rowGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
  gap: 8,
  alignItems: 'center',
}

const valueGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 8,
  alignItems: 'center',
}

const removeRowButtonStyle: React.CSSProperties = {
  ...BTN_GHOST,
  width: 34,
  minWidth: 34,
  height: 34,
  padding: 0,
  lineHeight: 1,
  fontSize: 16,
  borderColor: tokens.border,
  color: tokens.inkSoft,
}

const addRowButtonStyle: React.CSSProperties = {
  ...BTN_GHOST,
  width: '100%',
  justifyContent: 'center',
  borderColor: tokens.border,
  color: tokens.inkSoft,
  background: '#fff',
}

function textInputProps(): Pick<React.InputHTMLAttributes<HTMLInputElement>, 'onFocus' | 'onBlur'> {
  return {
    onFocus: (e) => applyFocusRing(e, true),
    onBlur: (e) => applyFocusRing(e, false),
  }
}

const ENV_INTERPOLATION_RE = /^\$\{([^}]+)\}$/
const BEARER_ENV_RE = /^Bearer\s+\$\{([^}]+)\}$/

function valueRowsFromValues(values: string[]): ValueRow[] {
  if (values.length === 0) return [createValueRow()]
  return values.map((value) => createValueRow(value))
}

function pairRowsFromEntries(entries: Array<[string, string]>): PairRow[] {
  if (entries.length === 0) return [createPairRow()]
  return entries.map(([key, value]) => createPairRow(key, value))
}

function createDrawerSeed(server?: McpServerView) {
  if (!server) {
    return {
      transport: 'stdio' as TransportKind,
      name: '',
      url: '',
      command: '',
      argsRows: [createValueRow()],
      envRows: [createPairRow()],
      passthroughRows: [createValueRow()],
      headerRows: [createPairRow()],
      envHeaderRows: [createPairRow()],
      bearerTokenEnv: '',
      enabled: true,
    }
  }

  const transport: TransportKind = server.url ? 'http' : 'stdio'
  const staticHeaders: Array<[string, string]> = []
  const envHeaders: Array<[string, string]> = []
  let bearerTokenEnv = ''

  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (key.toLowerCase() === 'authorization') {
      const bearerMatch = value.match(BEARER_ENV_RE)
      if (bearerMatch) {
        bearerTokenEnv = bearerMatch[1]
        continue
      }
    }

    const envMatch = value.match(ENV_INTERPOLATION_RE)
    if (envMatch) {
      envHeaders.push([key, envMatch[1]])
    } else {
      staticHeaders.push([key, value])
    }
  }

  const directEnv: Array<[string, string]> = []
  const passthroughEnv: string[] = []

  for (const [key, value] of Object.entries(server.env ?? {})) {
    const envMatch = value.match(ENV_INTERPOLATION_RE)
    if (envMatch && envMatch[1] === key) {
      passthroughEnv.push(key)
    } else {
      directEnv.push([key, value])
    }
  }

  return {
    transport,
    name: server.name,
    url: server.url ?? '',
    command: server.command ?? '',
    argsRows: valueRowsFromValues(server.args ?? []),
    envRows: pairRowsFromEntries(directEnv),
    passthroughRows: valueRowsFromValues(passthroughEnv),
    headerRows: pairRowsFromEntries(staticHeaders),
    envHeaderRows: pairRowsFromEntries(envHeaders),
    bearerTokenEnv,
    enabled: server.enabled ?? true,
  }
}

function SegmentedTransport({
  value,
  onChange,
}: {
  value: TransportKind
  onChange: (transport: TransportKind) => void
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 6,
        padding: 5,
        borderRadius: 14,
        background: tokens.petal,
        border: `1px solid ${tokens.border}`,
      }}
    >
      {([
        ['stdio', 'STDIO'],
        ['http', '流式 HTTP'],
      ] as const).map(([kind, label]) => {
        const active = value === kind
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onChange(kind)}
            style={{
              border: 'none',
              borderRadius: 10,
              padding: '10px 14px',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              color: active ? '#fff' : tokens.inkSoft,
              background: active
                ? `linear-gradient(135deg, ${tokens.brand}, ${tokens.brandStrong})`
                : 'transparent',
              boxShadow: active ? '0 10px 22px -14px rgba(255, 20, 147, 0.7)' : 'none',
              transition: `all ${tokens.durFast} ${tokens.ease}`,
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function ValueListEditor({
  title,
  hint,
  placeholder,
  addLabel,
  rows,
  onChange,
}: {
  title: string
  hint?: string
  placeholder: string
  addLabel: string
  rows: ValueRow[]
  onChange: (rows: ValueRow[]) => void
}) {
  const updateRow = (id: string, value: string) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, value } : row)))
  }

  const removeRow = (id: string) => {
    if (rows.length === 1) {
      onChange([createValueRow()])
      return
    }
    onChange(rows.filter((row) => row.id !== id))
  }

  return (
    <div style={groupedSectionStyle}>
      <h5 style={sectionTitleStyle}>{title}</h5>
      {hint && <p style={sectionHintStyle}>{hint}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row) => (
          <div key={row.id} style={valueGridStyle}>
            <input
              value={row.value}
              onChange={(e) => updateRow(row.id, e.target.value)}
              placeholder={placeholder}
              style={INPUT_STYLE}
              {...textInputProps()}
            />
            <button type="button" onClick={() => removeRow(row.id)} style={removeRowButtonStyle} aria-label={`删除${title}`}>
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...rows, createValueRow()])} style={addRowButtonStyle}>
        + {addLabel}
      </button>
    </div>
  )
}

function PairListEditor({
  title,
  hint,
  leftLabel,
  rightLabel,
  leftPlaceholder,
  rightPlaceholder,
  addLabel,
  rows,
  onChange,
}: {
  title: string
  hint?: string
  leftLabel: string
  rightLabel: string
  leftPlaceholder: string
  rightPlaceholder: string
  addLabel: string
  rows: PairRow[]
  onChange: (rows: PairRow[]) => void
}) {
  const updateRow = (id: string, patch: Partial<PairRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const removeRow = (id: string) => {
    if (rows.length === 1) {
      onChange([createPairRow()])
      return
    }
    onChange(rows.filter((row) => row.id !== id))
  }

  return (
    <div style={groupedSectionStyle}>
      <h5 style={sectionTitleStyle}>{title}</h5>
      {hint && <p style={sectionHintStyle}>{hint}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row) => (
          <div key={row.id} style={rowGridStyle}>
            <div>
              <label style={LABEL_STYLE}>{leftLabel}</label>
              <input
                value={row.key}
                onChange={(e) => updateRow(row.id, { key: e.target.value })}
                placeholder={leftPlaceholder}
                style={INPUT_STYLE}
                {...textInputProps()}
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>{rightLabel}</label>
              <input
                value={row.value}
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
                placeholder={rightPlaceholder}
                style={INPUT_STYLE}
                {...textInputProps()}
              />
            </div>
            <button type="button" onClick={() => removeRow(row.id)} style={removeRowButtonStyle} aria-label={`删除${title}`}>
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...rows, createPairRow()])} style={addRowButtonStyle}>
        + {addLabel}
      </button>
    </div>
  )
}

function InlineSwitch({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onToggle}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: 'none',
        background: checked ? tokens.brand : '#ddd',
        cursor: disabled ? 'default' : 'pointer',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 0.2s',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  )
}

// ── Probe result modal ───────────────────────────────────────────────────────

function ProbeModal({ result, name, onClose }: { result: McpProbeResult; name: string; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: 20, width: 340, maxHeight: '70vh',
        overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h4 style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 12 }}>
          {name} — {result.ok ? `✓ 连接成功 (${result.latency_ms}ms)` : '✗ 连接失败'}
        </h4>
        {result.error && (
          <div style={{ fontSize: 12, color: '#e53935', marginBottom: 10 }}>{result.error}</div>
        )}
        {result.tools.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
              工具列表 ({result.tools.length}):
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.tools.map((t) => (
                <div key={t.name} style={{ fontSize: 11, padding: '4px 8px', background: '#f9f9f9', borderRadius: 4 }}>
                  <strong>{t.name}</strong>
                  {t.description && <span style={{ color: '#777', marginLeft: 4 }}>{t.description}</span>}
                </div>
              ))}
            </div>
          </>
        )}
        <button onClick={onClose} style={{ ...BTN_GHOST, width: '100%', marginTop: 16 }}>关闭</button>
      </div>
    </div>
  )
}

// ── Add server drawer ────────────────────────────────────────────────────────

function AddDrawer({
  onAdded,
  onClose,
  initialServer,
}: {
  onAdded: (s: McpServerView) => void
  onClose: () => void
  initialServer?: McpServerView | null
}) {
  const { addMcpServer } = useHermesConfig()
  const seed = createDrawerSeed(initialServer ?? undefined)
  const editing = Boolean(initialServer)
  const [transport, setTransport] = useState<TransportKind>(seed.transport)
  const [name, setName] = useState(seed.name)
  const [url, setUrl] = useState(seed.url)
  const [command, setCommand] = useState(seed.command)
  const [argsRows, setArgsRows] = useState<ValueRow[]>(seed.argsRows)
  const [envRows, setEnvRows] = useState<PairRow[]>(seed.envRows)
  const [passthroughRows, setPassthroughRows] = useState<ValueRow[]>(seed.passthroughRows)
  const [headerRows, setHeaderRows] = useState<PairRow[]>(seed.headerRows)
  const [envHeaderRows, setEnvHeaderRows] = useState<PairRow[]>(seed.envHeaderRows)
  const [bearerTokenEnv, setBearerTokenEnv] = useState(seed.bearerTokenEnv)
  const [probe, setProbe] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const handleAdd = async () => {
    if (!name.trim()) {
      setError('服务器名称不能为空')
      return
    }

    setAdding(true)
    setError('')

    const fail = (message: string) => {
      setError(message)
      setAdding(false)
    }

    try {
      const cfg: McpServerConfig = { name: name.trim(), enabled: seed.enabled }

      if (transport === 'http') {
        if (!url.trim()) {
          fail('流式 HTTP 模式需要填写 URL')
          return
        }
        cfg.url = url.trim()

        const headers: Record<string, string> = {}
        const seenHeaderKeys = new Map<string, string>()
        const addHeader = (rawKey: string, value: string, sourceLabel: string) => {
          const key = rawKey.trim()
          const normalized = key.toLowerCase()
          if (seenHeaderKeys.has(normalized)) {
            throw new Error(`标头 ${key} 在 ${sourceLabel} 中重复配置`)
          }
          seenHeaderKeys.set(normalized, sourceLabel)
          headers[key] = value
        }

        for (const row of headerRows) {
          const key = row.key.trim()
          const value = row.value.trim()
          if (!key && !value) continue
          if (!key || !value) {
            fail('请完整填写所有自定义标头的键和值')
            return
          }
          addHeader(key, value, '标头')
        }

        for (const row of envHeaderRows) {
          const key = row.key.trim()
          const envVar = row.value.trim()
          if (!key && !envVar) continue
          if (!key || !envVar) {
            fail('请完整填写所有环境变量标头的键和值')
            return
          }
          addHeader(key, `\${${envVar}}`, '来自环境变量的标头')
        }

        if (bearerTokenEnv.trim()) {
          addHeader('Authorization', `Bearer \${${bearerTokenEnv.trim()}}`, 'Bearer 令牌环境变量')
        }

        if (Object.keys(headers).length > 0) cfg.headers = headers
      } else {
        if (!command.trim()) {
          fail('STDIO 模式需要填写启动命令')
          return
        }
        cfg.command = command.trim()

        const args = argsRows.map((row) => row.value.trim()).filter(Boolean)
        if (args.length > 0) cfg.args = args

        const env: Record<string, string> = {}
        const seenEnvKeys = new Map<string, string>()
        const addEnv = (rawKey: string, value: string, sourceLabel: string) => {
          const key = rawKey.trim()
          if (seenEnvKeys.has(key)) {
            throw new Error(`环境变量 ${key} 在 ${sourceLabel} 中重复配置`)
          }
          seenEnvKeys.set(key, sourceLabel)
          env[key] = value
        }

        for (const row of envRows) {
          const key = row.key.trim()
          const value = row.value.trim()
          if (!key && !value) continue
          if (!key || !value) {
            fail('请完整填写所有环境变量的键和值')
            return
          }
          addEnv(key, value, '环境变量')
        }

        for (const row of passthroughRows) {
          const envVar = row.value.trim()
          if (!envVar) continue
          addEnv(envVar, `\${${envVar}}`, '环境变量传递')
        }

        if (Object.keys(env).length > 0) cfg.env = env
      }

      const server = await addMcpServer(cfg, probe)
      onAdded(server)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 900,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={drawerCardStyle}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          <h4 style={{ fontSize: 14, fontWeight: 700, color: '#333', margin: 0 }}>
            {editing ? '编辑 MCP 服务器' : '连接到自定义 MCP'}
          </h4>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: tokens.inkMuted, margin: 0 }}>
            这里会把 UI 配置映射到现有 MCP schema。STDIO 会生成 <code>command / args / env</code>，
            流式 HTTP 会生成 <code>url / headers</code>。
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={groupedSectionStyle}>
            <h5 style={sectionTitleStyle}>名称</h5>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="MCP server name"
              style={INPUT_STYLE}
              disabled={editing}
              aria-disabled={editing}
              {...textInputProps()}
            />
            {editing && (
              <p style={sectionHintStyle}>
                编辑时暂时不支持改名，避免把旧配置和新配置拆成两条。
              </p>
            )}
            <SegmentedTransport value={transport} onChange={setTransport} />
          </div>

          {transport === 'stdio' ? (
            <>
              <div style={groupedSectionStyle}>
                <h5 style={sectionTitleStyle}>启动命令</h5>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="openai-dev-mcp serve-sqlite"
                  style={INPUT_STYLE}
                  {...textInputProps()}
                />
              </div>

              <ValueListEditor
                title="参数"
                hint="每一行对应一个独立参数，提交时会组装成 args 数组。"
                placeholder="--port=8080"
                addLabel="添加参数"
                rows={argsRows}
                onChange={setArgsRows}
              />

              <PairListEditor
                title="环境变量"
                hint="显式写入到 MCP 子进程环境中。"
                leftLabel="键"
                rightLabel="值"
                leftPlaceholder="DATABASE_URL"
                rightPlaceholder="sqlite:///tmp/demo.db"
                addLabel="添加环境变量"
                rows={envRows}
                onChange={setEnvRows}
              />

              <ValueListEditor
                title="环境变量传递"
                hint="会映射成同名插值，例如 FOO -> ${FOO}，用于把当前环境变量传给 MCP 进程。"
                placeholder="OPENAI_API_KEY"
                addLabel="添加变量"
                rows={passthroughRows}
                onChange={setPassthroughRows}
              />
            </>
          ) : (
            <>
              <div style={groupedSectionStyle}>
                <h5 style={sectionTitleStyle}>URL</h5>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  style={INPUT_STYLE}
                  {...textInputProps()}
                />
              </div>

              <div style={groupedSectionStyle}>
                <h5 style={sectionTitleStyle}>Bearer 令牌环境变量</h5>
                <input
                  value={bearerTokenEnv}
                  onChange={(e) => setBearerTokenEnv(e.target.value)}
                  placeholder="MCP_BEARER_TOKEN"
                  style={INPUT_STYLE}
                  {...textInputProps()}
                />
                <p style={sectionHintStyle}>
                  填写后会生成 <code>Authorization: Bearer ${'{ENV_VAR}'}</code> 形式的标头。
                </p>
              </div>

              <PairListEditor
                title="标头"
                leftLabel="键"
                rightLabel="值"
                leftPlaceholder="X-API-Version"
                rightPlaceholder="2026-04-14"
                addLabel="添加标头"
                rows={headerRows}
                onChange={setHeaderRows}
              />

              <PairListEditor
                title="来自环境变量的标头"
                hint="会把值编码为 ${ENV_VAR}，由 Hermes 在读取配置时插值。"
                leftLabel="键"
                rightLabel="环境变量"
                leftPlaceholder="X-Api-Key"
                rightPlaceholder="MCP_API_KEY"
                addLabel="添加变量"
                rows={envHeaderRows}
                onChange={setEnvHeaderRows}
              />
            </>
          )}

          <div style={groupedSectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                id="mcp-probe"
                checked={probe}
                onChange={(e) => setProbe(e.target.checked)}
                style={{ width: 16, height: 16, margin: 0 }}
              />
              <label htmlFor="mcp-probe" style={{ fontSize: 12, color: '#555', cursor: 'pointer' }}>
                保存时测试连接
              </label>
            </div>
            <p style={sectionHintStyle}>
              测试失败时配置仍然会被保存，但会先标记为禁用，方便你稍后修正。
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={handleAdd} disabled={adding} style={{ ...BTN_PRIMARY, opacity: adding ? 0.6 : 1 }}>
              {adding ? '连接测试中…' : '保存'}
            </button>
            <button type="button" onClick={onClose} style={BTN_GHOST}>取消</button>
          </div>

          {error && (
            <div
              style={{
                fontSize: 12,
                color: tokens.danger,
                background: '#fff5f5',
                border: '1px solid #ffd6d6',
                borderRadius: 12,
                padding: '10px 12px',
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function McpServerPanel(): React.ReactElement {
  const { listMcpServers, removeMcpServer, setMcpServerEnabled, testMcpServer } = useHermesConfig()
  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServerView | null>(null)
  const [probeResult, setProbeResult] = useState<{ name: string; result: McpProbeResult } | null>(null)
  const [testingName, setTestingName] = useState<string | null>(null)
  const [togglingName, setTogglingName] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = () => {
    listMcpServers()
      .then(setServers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const handleRemove = async (name: string) => {
    try {
      await removeMcpServer(name)
      setServers((prev) => prev.filter((s) => s.name !== name))
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleTest = async (name: string) => {
    setTestingName(name)
    try {
      const result = await testMcpServer(name)
      setProbeResult({ name, result })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setTestingName(null)
    }
  }

  const handleToggleEnabled = async (server: McpServerView) => {
    setTogglingName(server.name)
    try {
      const updated = await setMcpServerEnabled(server.name, !server.enabled)
      setServers((prev) =>
        prev.map((item) => (item.name === server.name ? { ...item, ...updated } : item))
      )
    } catch (e: any) {
      setError(e.message)
    } finally {
      setTogglingName(null)
    }
  }

  return (
    <SectionCard
      title="MCP 服务器"
      subtitle={servers.length > 0 ? `已接入 ${servers.length} 个服务器` : '连接 Model Context Protocol 服务器以扩展工具'}
      action={
        <button onClick={() => setShowAdd(true)} style={BTN_PRIMARY}>
          + 添加
        </button>
      }
    >
      {loading ? (
        <div style={{ fontSize: 12, color: tokens.inkMuted }}>加载中…</div>
      ) : servers.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: tokens.inkMuted,
            padding: '14px 14px',
            borderRadius: 12,
            background: tokens.petal,
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          暂无 MCP 服务器
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {servers.map((s) => (
            <div
              key={s.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 12,
                background: tokens.cardSoft,
                border: `1px solid ${tokens.inkHair}`,
                transition: `all ${tokens.durFast} ${tokens.easeOut}`,
                opacity: s.enabled ? 1 : 0.72,
              }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600, color: tokens.ink, minWidth: 80 }}>
                {s.name}
              </span>
              <span style={{ fontSize: 11, color: tokens.inkMuted, flex: 1, fontFamily: tokens.monoFont }}>
                {s.url ?? s.command ?? '未配置'}
                {s.tools_count != null && ` · ${s.tools_count} tools`}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                <button
                  onClick={() => setEditingServer(s)}
                  style={{
                    fontSize: 11,
                    color: tokens.inkSoft,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  编辑
                </button>
                <button
                  onClick={() => handleTest(s.name)}
                  disabled={testingName === s.name}
                  style={{
                    fontSize: 11,
                    color: tokens.blossom,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: 500,
                    opacity: testingName === s.name ? 0.6 : 1,
                  }}
                >
                  {testingName === s.name ? '测试中…' : '测试'}
                </button>
                <button
                  onClick={() => handleRemove(s.name)}
                  style={{
                    fontSize: 11,
                    color: tokens.danger,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  删除
                </button>
                <InlineSwitch
                  checked={Boolean(s.enabled)}
                  disabled={togglingName === s.name}
                  onToggle={() => handleToggleEnabled(s)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <div style={{ marginTop: 10, fontSize: 12, color: tokens.danger }}>{error}</div>}

      {(showAdd || editingServer) && (
        <AddDrawer
          onAdded={(s) => {
            setServers((prev) => {
              const exists = prev.some((item) => item.name === s.name)
              if (!exists) return [...prev, s]
              return prev.map((item) => (item.name === s.name ? { ...item, ...s } : item))
            })
            setShowAdd(false)
            setEditingServer(null)
          }}
          onClose={() => {
            setShowAdd(false)
            setEditingServer(null)
          }}
          initialServer={editingServer}
        />
      )}

      {probeResult && (
        <ProbeModal
          name={probeResult.name}
          result={probeResult.result}
          onClose={() => setProbeResult(null)}
        />
      )}
    </SectionCard>
  )
}
