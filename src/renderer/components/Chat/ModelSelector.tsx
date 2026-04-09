import React, { useEffect, useState } from 'react'

interface ProviderModel { provider: string; model: string; configured: boolean }
interface ModelSelectorProps { selectedModel: string; onModelChange: (model: string) => void }

export function ModelSelector({ selectedModel, onModelChange }: ModelSelectorProps): React.ReactElement {
  const [providers, setProviders] = useState<ProviderModel[]>([])
  useEffect(() => { window.electron.listProviders().then(setProviders).catch(() => {}) }, [])

  const configured = providers.filter(p => p.configured)
  const unconfigured = providers.filter(p => !p.configured)

  return (
    <select value={selectedModel} onChange={e => onModelChange(e.target.value)}
      style={{
        fontSize: 11, fontWeight: 500, color: '#FF69B4',
        background: 'rgba(255,105,180,0.06)', border: '1px solid rgba(255,105,180,0.15)',
        borderRadius: 12, padding: '3px 20px 3px 8px', cursor: 'pointer', outline: 'none',
        appearance: 'none' as const,
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' fill='%23FF69B4' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M4 5L0 0h8L4 5z'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center'
      }}>
      {configured.length > 0 && <optgroup label="已配置">{configured.map(({ provider, model }) => <option key={`${provider}:${model}`} value={model}>{model}</option>)}</optgroup>}
      {unconfigured.length > 0 && <optgroup label="未配置">{unconfigured.map(({ provider, model }) => <option key={`${provider}:${model}`} value={model} disabled>{model}</option>)}</optgroup>}
      {providers.length === 0 && <option value={selectedModel}>{selectedModel}</option>}
    </select>
  )
}
