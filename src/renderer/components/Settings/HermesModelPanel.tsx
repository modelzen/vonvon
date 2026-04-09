import React, { useEffect, useState } from 'react'
import { useHermesConfig, ProviderInfo } from '../../hooks/useHermesConfig'

const SECTION_STYLE: React.CSSProperties = { padding: '16px 0', borderBottom: '1px solid #fce4ec' }
const LABEL_STYLE: React.CSSProperties = { fontSize: 12, color: '#555', display: 'block', marginBottom: 4 }
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12,
  border: '1px solid #fce4ec', borderRadius: 6, outline: 'none', boxSizing: 'border-box',
}
const SELECT_STYLE: React.CSSProperties = { ...INPUT_STYLE, background: '#fff' }
const BTN_PRIMARY: React.CSSProperties = {
  padding: '6px 18px', fontSize: 12, borderRadius: 6, border: 'none',
  background: 'linear-gradient(135deg, #FF69B4, #FF1493)', color: '#fff',
  cursor: 'pointer', fontWeight: 600,
}

export function HermesModelPanel(): React.ReactElement {
  const { listModels, switchModel } = useHermesConfig()

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [currentProvider, setCurrentProvider] = useState('')

  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [persist, setPersist] = useState(false)

  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    listModels()
      .then((data) => {
        setProviders(data.providers)
        setCurrentModel(data.current)
        setCurrentProvider(data.current_provider)
        setSelectedProvider(data.current_provider || data.providers[0]?.slug || '')
        setSelectedModel(data.current)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const availableModels =
    providers.find((p) => p.slug === selectedProvider)?.models ?? []

  const handleApply = async () => {
    if (!selectedModel) return
    setApplying(true)
    setError(null)
    try {
      const res = await switchModel({
        model: selectedModel,
        provider: selectedProvider || undefined,
        base_url: baseUrl || undefined,
        persist,
      })
      setCurrentModel(res.model)
      setCurrentProvider(res.provider)
      setToast(persist ? '已持久化到 hermes 配置' : '已切换（本次会话有效）')
      setTimeout(() => setToast(null), 3000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setApplying(false)
    }
  }

  if (loading) {
    return (
      <div style={SECTION_STYLE}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#d81b60', marginBottom: 8 }}>模型选择</h3>
        <div style={{ fontSize: 12, color: '#aaa' }}>加载中…</div>
      </div>
    )
  }

  return (
    <div style={SECTION_STYLE}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#d81b60', marginBottom: 12 }}>模型选择</h3>

      {providers.length === 0 ? (
        <div style={{ fontSize: 12, color: '#888', padding: '8px 0' }}>
          请先在下方"认证"区配置 provider
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 10 }}>
            <label style={LABEL_STYLE}>Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value)
                setSelectedModel('')
              }}
              style={SELECT_STYLE}
            >
              {providers.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name} ({p.total_models} 个模型)
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={LABEL_STYLE}>模型</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              style={SELECT_STYLE}
            >
              <option value="">— 选择模型 —</option>
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={LABEL_STYLE}>Base URL（可选，覆盖默认端点）</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              style={INPUT_STYLE}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input
              type="checkbox"
              id="model-persist"
              checked={persist}
              onChange={(e) => setPersist(e.target.checked)}
            />
            <label htmlFor="model-persist" style={{ fontSize: 12, color: '#555', cursor: 'pointer' }}>
              持久化到 hermes 配置（重启后生效）
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={handleApply} disabled={applying || !selectedModel} style={{
              ...BTN_PRIMARY, opacity: (applying || !selectedModel) ? 0.6 : 1,
              cursor: (applying || !selectedModel) ? 'default' : 'pointer',
            }}>
              {applying ? '切换中…' : '应用'}
            </button>
            <span style={{ fontSize: 11, color: '#aaa' }}>
              当前：{currentProvider ? `${currentProvider} / ` : ''}{currentModel || '—'}
            </span>
          </div>
        </>
      )}

      {toast && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#4caf50' }}>{toast}</div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#e53935' }}>{error}</div>
      )}
    </div>
  )
}
