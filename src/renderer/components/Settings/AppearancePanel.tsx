import React, { useCallback, useEffect, useState } from 'react'
import { SectionCard } from './SectionCard'
import { btnPrimaryStyle, tokens } from './settingsStyles'

type KirbyAssetPackSummary = {
  id: string
  name: string
  version?: number
  author?: string
  previewDataUrl?: string
}

export function AppearancePanel(): React.ReactElement {
  const [packs, setPacks] = useState<KirbyAssetPackSummary[]>([])
  const [selectedPackId, setSelectedPackId] = useState('cat')
  const [busyPackId, setBusyPackId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadPacks = useCallback(async () => {
    const [nextPacks, nextSelectedPackId] = await Promise.all([
      window.electron.listKirbyAssetPacks(),
      window.electron.getKirbyAssetPack(),
    ])
    setPacks(nextPacks)
    setSelectedPackId(nextSelectedPackId)
  }, [])

  useEffect(() => {
    loadPacks().catch((err) => {
      setError(err instanceof Error ? err.message : '加载形象失败')
    })
  }, [loadPacks])

  const selectPack = async (packId: string) => {
    if (packId === selectedPackId || busyPackId) return
    setBusyPackId(packId)
    setError(null)
    try {
      const nextPackId = await window.electron.setKirbyAssetPack(packId)
      setSelectedPackId(nextPackId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换形象失败')
    } finally {
      setBusyPackId(null)
    }
  }

  return (
    <SectionCard title="形象">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10,
        }}
      >
        {packs.map((pack) => {
          const selected = pack.id === selectedPackId
          const busy = pack.id === busyPackId
          return (
            <button
              key={pack.id}
              onClick={() => void selectPack(pack.id)}
              disabled={busyPackId !== null}
              style={{
                minHeight: 168,
                border: `1px solid ${selected ? tokens.brandStrong : tokens.border}`,
                borderRadius: tokens.radiusControl,
                background: selected ? '#fff5f9' : '#ffffff',
                cursor: busyPackId ? 'default' : 'pointer',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                boxShadow: selected
                  ? '0 14px 28px -24px rgba(255, 20, 147, 0.55)'
                  : '0 1px 6px -5px rgba(40, 20, 30, 0.28)',
                opacity: busyPackId && !busy ? 0.62 : 1,
                transition: `border ${tokens.durFast} ${tokens.ease}, background ${tokens.durFast} ${tokens.ease}, opacity ${tokens.durFast} ${tokens.ease}`,
              }}
            >
              <div
                style={{
                  width: 92,
                  height: 92,
                  borderRadius: tokens.radiusControl,
                  background: tokens.petal,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  flexShrink: 0,
                }}
              >
                {pack.previewDataUrl ? (
                  <img
                    src={pack.previewDataUrl}
                    alt={pack.name}
                    style={{
                      width: 86,
                      height: 86,
                      objectFit: 'contain',
                    }}
                  />
                ) : (
                  <span style={{ color: tokens.inkMuted, fontSize: 12 }}>{pack.name.slice(0, 2)}</span>
                )}
              </div>

              <div style={{ minWidth: 0, textAlign: 'center' }}>
                <div
                  style={{
                    color: tokens.ink,
                    fontSize: 13,
                    fontWeight: 700,
                    lineHeight: 1.25,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {pack.name}
                </div>
                <div
                  style={{
                    color: selected ? tokens.brandStrong : tokens.inkMuted,
                    fontSize: 11,
                    fontWeight: selected ? 700 : 500,
                    marginTop: 5,
                    minHeight: 15,
                  }}
                >
                  {busy ? '切换中...' : selected ? '当前使用' : pack.id}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            color: tokens.danger,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}

      {packs.length === 0 && !error && (
        <button
          onClick={() => void loadPacks()}
          style={{
            ...btnPrimaryStyle,
            marginTop: 2,
          }}
        >
          刷新
        </button>
      )}
    </SectionCard>
  )
}
