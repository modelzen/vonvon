import React, { useEffect, useState } from 'react'
import { SectionCard } from './SectionCard'
import { tokens } from './settingsStyles'
import { useHermesConfig } from '../../hooks/useHermesConfig'
import type { ProviderInfo } from '../../hooks/useHermesConfig'

interface TitleModel {
  model: string
  provider: string
}

const AUTO_TITLE_KEY = 'autoTitleEnabled'
const TITLE_MODEL_KEY = 'titleSummaryModel'

// Flat list of {model, provider} from providers array
function flattenModels(providers: ProviderInfo[]): TitleModel[] {
  const out: TitleModel[] = []
  for (const p of providers) {
    for (const m of p.models) {
      out.push({ model: m, provider: p.slug })
    }
  }
  return out
}

export function ChatPreferencesPanel(): React.ReactElement {
  const { listModels } = useHermesConfig()

  const [enabled, setEnabled] = useState(true)
  const [models, setModels] = useState<TitleModel[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [titleModel, setTitleModel] = useState<TitleModel | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    ;(async () => {
      const [val, stored, data] = await Promise.all([
        window.electron?.storeGet?.(AUTO_TITLE_KEY),
        window.electron?.storeGet?.(TITLE_MODEL_KEY) as Promise<TitleModel | null>,
        listModels().catch(() => ({ providers: [], current: '', current_provider: '' })),
      ])
      setEnabled(val !== false)
      setTitleModel(stored ?? null)
      setModels(flattenModels(data.providers))
      setCurrentModel(data.current)
      setLoaded(true)
    })()
  }, [])

  const toggleEnabled = async () => {
    const next = !enabled
    setEnabled(next)
    await window.electron?.storeSet?.(AUTO_TITLE_KEY, next)
  }

  const selectModel = async (tm: TitleModel | null) => {
    setTitleModel(tm)
    await window.electron?.storeSet?.(TITLE_MODEL_KEY, tm)
  }

  if (!loaded) return <></>

  const selectedLabel = titleModel
    ? titleModel.model
    : currentModel
      ? `当前模型 (${currentModel})`
      : '当前模型'

  return (
    <SectionCard title="聊天偏好">
      {/* Auto-title toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 0 10px',
        }}
      >
        <div>
          <div style={{ fontSize: 13, color: tokens.ink, fontWeight: 500 }}>
            自动总结会话标题
          </div>
          <div style={{ fontSize: 11, color: tokens.inkMuted, marginTop: 2 }}>
            首轮对话结束后用 AI 生成会话名称
          </div>
        </div>
        <button
          onClick={toggleEnabled}
          style={{
            width: 40,
            height: 22,
            borderRadius: 11,
            border: 'none',
            background: enabled ? tokens.brand : '#ddd',
            cursor: 'pointer',
            position: 'relative',
            flexShrink: 0,
            transition: 'background 0.2s',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: enabled ? 21 : 3,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }}
          />
        </button>
      </div>

      {/* Model selector — only shown when feature is enabled */}
      {enabled && (
        <div style={{ borderTop: `1px solid ${tokens.border}`, paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: tokens.inkMuted, marginBottom: 6 }}>
            总结使用的模型
          </div>
          <select
            value={titleModel ? `${titleModel.provider}::${titleModel.model}` : ''}
            onChange={(e) => {
              const v = e.target.value
              if (!v) {
                selectModel(null)
              } else {
                const [provider, model] = v.split('::')
                selectModel({ model, provider })
              }
            }}
            style={{
              width: '100%',
              padding: '5px 8px',
              fontSize: 12,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              background: '#fff5f9',
              color: tokens.ink,
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="">当前模型 {currentModel ? `(${currentModel})` : ''}</option>
            {models.map((m) => (
              <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
                {m.model}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 10, color: tokens.inkMuted, marginTop: 4 }}>
            当前选择：{selectedLabel}
          </div>
        </div>
      )}
    </SectionCard>
  )
}
