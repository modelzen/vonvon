import React, { useEffect, useMemo, useRef, useState } from 'react'
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

  // useHermesConfig() returns brand-new function references on every render.
  // If we put `listModels`/`switchModel` directly into a useCallback or
  // useEffect dep array, we get an infinite refresh loop:
  //   render → new listModels → useCallback recreates refresh → useEffect
  //   re-runs → calls refresh → setState → render → ...
  // and the loop overwrites our optimistic `current` on every tick (which is
  // exactly why model switching felt laggy). Capture them in refs so we can
  // call the latest version without invalidating any callbacks.
  const listModelsRef = useRef(listModels)
  const switchModelRef = useRef(switchModel)
  listModelsRef.current = listModels
  switchModelRef.current = switchModel

  // True while a user-initiated switch is in flight. When set, the periodic
  // (focus-triggered) refresh skips updating `current` so it can't clobber
  // the optimistic value before the backend has actually flipped.
  const switchingRef = useRef(false)

  // Load providers + whitelist once on mount, and again whenever the window
  // regains focus — cheap way to pick up settings changes without wiring a
  // full event bus.
  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      try {
        const [data, stored] = await Promise.all([
          listModelsRef.current(),
          window.electron.storeGet('modelWhitelist') as Promise<unknown>,
        ])
        if (cancelled) return
        setProviders(data.providers)
        if (!switchingRef.current) {
          setCurrent(data.current)
        }
        setWhitelist(new Set(Array.isArray(stored) ? (stored as string[]) : []))
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'load failed')
      }
    }

    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

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
    // Optimistic update — flip the displayed model immediately so the
    // dropdown reflects the user's choice without waiting on the round-trip
    // to /api/models/current. Switching models triggers credential pool
    // reloads on the backend and can take a noticeable beat.
    const previous = current
    setCurrent(value)
    setError(null)
    switchingRef.current = true
    const owner = providers.find((p) => p.models.includes(value))
    try {
      await switchModelRef.current({
        model: value,
        provider: owner?.slug,
        persist: true,
      })
    } catch (err: any) {
      setError(err?.message ?? 'switch failed')
      setCurrent(previous)
    } finally {
      switchingRef.current = false
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
