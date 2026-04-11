import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { useHermesConfig, ProviderInfo } from '../../hooks/useHermesConfig'

/**
 * Agent-mode model picker shown in the chat page header.
 *
 * Only surfaces models that the user whitelisted in settings
 * (`modelWhitelist` persisted via electron-store). Switching is immediate:
 * every change POSTs to `/api/models/current` with `persist: true`, so
 * the hermes backend remembers the choice across restarts.
 *
 * Grouped by provider via `<optgroup>` for clarity when multiple providers
 * expose models simultaneously.
 */
export function AgentModelSelector(): React.ReactElement {
  const { listModels, switchModel } = useHermesConfig()

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [whitelist, setWhitelist] = useState<Set<string>>(new Set())
  const [current, setCurrent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Load providers + whitelist once on mount, and also whenever the window
  // regains focus (cheap way to pick up settings changes without wiring up
  // a full event bus).
  const refresh = useCallback(async () => {
    try {
      const [data, stored] = await Promise.all([
        listModels(),
        window.electron.storeGet('modelWhitelist') as Promise<unknown>,
      ])
      setProviders(data.providers)
      setCurrent(data.current)
      setWhitelist(new Set(Array.isArray(stored) ? (stored as string[]) : []))
    } catch (e: any) {
      setError(e?.message ?? 'load failed')
    }
  }, [listModels])

  useEffect(() => {
    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Build the grouped option list, keeping only whitelisted models.
  const groups = useMemo(() => {
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter((m) => whitelist.has(m)),
      }))
      .filter((p) => p.models.length > 0)
  }, [providers, whitelist])

  const hasAny = groups.length > 0

  // If the current backend model isn't whitelisted we still include it in
  // the <select> (via a separate disabled group) so the control reflects
  // reality and doesn't jump to an unrelated option.
  const currentIsInWhitelist = hasAny && groups.some((g) => g.models.includes(current))

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    if (!value || value === current) return
    // Find which provider owns it so we can pass provider hint along.
    const owner = providers.find((p) => p.models.includes(value))
    try {
      await switchModel({
        model: value,
        provider: owner?.slug,
        persist: true,
      })
      setCurrent(value)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'switch failed')
      // Revert select to the last known current
      e.target.value = current
    }
  }

  // If no whitelist is configured yet, show a hint that links nowhere
  // functionally but signals the state without breaking the header layout.
  if (!hasAny) {
    return (
      <div
        title="在设置页勾选要使用的模型"
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: '#A89098',
          padding: '4px 12px',
          borderRadius: 999,
          background: 'rgba(255, 30, 131, 0.06)',
          border: '1px solid rgba(255, 30, 131, 0.14)',
          fontFamily:
            '"DM Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          letterSpacing: 0.2,
        }}
      >
        未选模型
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <select
        value={current}
        onChange={handleChange}
        title={error ?? undefined}
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: '#C4126A',
          background: 'rgba(255, 30, 131, 0.06)',
          border: `1px solid ${error ? '#D64545' : 'rgba(255, 30, 131, 0.18)'}`,
          borderRadius: 999,
          padding: '4px 22px 4px 11px',
          cursor: 'pointer',
          outline: 'none',
          appearance: 'none',
          fontFamily:
            '"DM Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' fill='%23C4126A' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M4 5L0 0h8L4 5z'/%3E%3C/svg%3E\")",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 8px center',
          maxWidth: 200,
          textOverflow: 'ellipsis',
        }}
      >
        {!currentIsInWhitelist && current && (
          <optgroup label="当前 (未勾选)">
            <option value={current}>{current}</option>
          </optgroup>
        )}
        {groups.map((g) => (
          <optgroup key={g.slug} label={g.name}>
            {g.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
