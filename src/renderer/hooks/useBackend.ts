import { useState, useCallback, useEffect } from 'react'
import { DEFAULT_BACKEND_URL } from '../../shared/backendDefaults'

export function useBackend() {
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL)
  // Vonvon is always in agent mode now — the old direct-mode toggle has
  // been removed from the UI. The state stays around so legacy callers
  // (useHermesConfig etc.) keep working without refactoring, but it is
  // effectively a constant `true`.
  const [backendEnabled, setBackendEnabled] = useState(true)
  const [isConnected, setIsConnected] = useState(false)

  // Load config from Electron store on mount
  useEffect(() => {
    window.electron.storeGet('backendUrl').then((url) => {
      if (typeof url === 'string' && url) setBackendUrl(url)
    })
    window.electron.storeGet('backendEnabled').then((enabled) => {
      if (typeof enabled === 'boolean') setBackendEnabled(enabled)
    })
  }, [])

  const testConnection = useCallback(
    async (url?: string): Promise<boolean> => {
      const target = url ?? backendUrl
      try {
        const res = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(3000) })
        const ok = res.ok
        setIsConnected(ok)
        return ok
      } catch {
        setIsConnected(false)
        return false
      }
    },
    [backendUrl]
  )

  const saveConfig = useCallback(
    async (url: string, enabled: boolean) => {
      await window.electron.storeSet('backendUrl', url)
      await window.electron.storeSet('backendEnabled', enabled)
      setBackendUrl(url)
      setBackendEnabled(enabled)
    },
    []
  )

  const apiFetch = useCallback(
    (path: string, options?: RequestInit): Promise<Response> => {
      return fetch(`${backendUrl}${path}`, options)
    },
    [backendUrl]
  )

  return { backendUrl, backendEnabled, isConnected, testConnection, saveConfig, apiFetch }
}
