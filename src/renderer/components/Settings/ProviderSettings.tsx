import React, { useState } from 'react'

interface ProviderCardProps {
  providerId: string; label: string; hasKey: boolean
  onValidate: (providerId: string, apiKey: string) => Promise<{ valid: boolean; error?: string }>
}

function ProviderCard({ providerId, label, hasKey, onValidate }: ProviderCardProps): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<'idle' | 'validating' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const handleValidate = async () => {
    if (!apiKey.trim()) return
    setStatus('validating'); setErrorMsg('')
    const result = await onValidate(providerId, apiKey.trim())
    if (result.valid) { setStatus('success'); setApiKey('') }
    else { setStatus('error'); setErrorMsg(result.error || '验证失败') }
  }

  return (
    <div style={{
      border: '1px solid #fce4ec', borderRadius: 12, padding: '12px 14px',
      background: 'rgba(255,255,255,0.7)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#333' }}>{label}</span>
        {(hasKey || status === 'success') && (
          <span style={{ fontSize: 11, color: '#4CAF50', fontWeight: 500 }}>✓ 已配置</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input type={showKey ? 'text' : 'password'} value={apiKey}
            onChange={e => { setApiKey(e.target.value); if (status !== 'idle') setStatus('idle') }}
            onKeyDown={e => { if (e.key === 'Enter') handleValidate() }}
            placeholder={hasKey ? '输入新 Key 覆盖' : `粘贴 ${label} API Key`}
            style={{
              width: '100%', padding: '7px 30px 7px 10px', fontSize: 12,
              border: '1px solid #fce4ec', borderRadius: 8, outline: 'none',
              background: 'rgba(255,245,249,0.5)', color: '#333'
            }}
          />
          <button onClick={() => setShowKey(v => !v)} style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, color: '#aaa'
          }}>{showKey ? '隐藏' : '显示'}</button>
        </div>
        <button onClick={handleValidate} disabled={!apiKey.trim() || status === 'validating'}
          style={{
            padding: '7px 12px', fontSize: 11, fontWeight: 600, color: '#fff', border: 'none',
            borderRadius: 8, cursor: 'pointer', flexShrink: 0,
            background: (!apiKey.trim() || status === 'validating') ? '#ddd' : 'linear-gradient(135deg, #FF69B4, #FF1493)',
            opacity: (!apiKey.trim() || status === 'validating') ? 0.5 : 1
          }}>
          {status === 'validating' ? '…' : '验证'}
        </button>
      </div>
      {status === 'error' && <p style={{ fontSize: 11, color: '#e53935', marginTop: 6 }}>{errorMsg}</p>}
    </div>
  )
}

interface ProviderSettingsProps {
  apiKeys: Record<string, boolean>
  onValidate: (providerId: string, apiKey: string) => Promise<{ valid: boolean; error?: string }>
}

export function ProviderSettings({ apiKeys, onValidate }: ProviderSettingsProps): React.ReactElement {
  return (
    <div>
      <p style={{ fontSize: 11, fontWeight: 600, color: '#FF69B4', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>API Keys</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ProviderCard providerId="openai" label="OpenAI" hasKey={!!apiKeys['openai']} onValidate={onValidate} />
        <ProviderCard providerId="anthropic" label="Anthropic" hasKey={!!apiKeys['anthropic']} onValidate={onValidate} />
      </div>
    </div>
  )
}
