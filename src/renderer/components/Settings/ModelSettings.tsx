import React from 'react'

interface ModelSettingsProps {
  defaultProvider: string
  defaultModel: string
  apiKeys: Record<string, boolean>
  onSetDefaultModel: (modelId: string) => Promise<void>
  onSetDefaultProvider: (providerId: string) => Promise<void>
}

const PROVIDER_MODELS: Array<{ provider: string; label: string; models: Array<{ id: string; name: string }> }> = [
  {
    provider: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
    ]
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }
    ]
  }
]

export function ModelSettings({
  defaultModel,
  apiKeys,
  onSetDefaultModel
}: ModelSettingsProps): React.ReactElement {
  const availableGroups = PROVIDER_MODELS.filter((g) => apiKeys[g.provider])

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    await onSetDefaultModel(e.target.value)
  }

  return (
    <div className="px-4 py-3">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
        默认模型
      </h2>
      {availableGroups.length === 0 ? (
        <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-4 py-3">
          请先配置 API Key，才能选择模型。
        </p>
      ) : (
        <select
          value={defaultModel}
          onChange={handleChange}
          className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-300 text-gray-700"
        >
          {availableGroups.map((group) => (
            <optgroup key={group.provider} label={group.label}>
              {group.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  )
}
