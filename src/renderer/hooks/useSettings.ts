import { useState, useEffect, useCallback } from 'react'

interface Settings {
  defaultProvider: string
  defaultModel: string
  apiKeys: Record<string, boolean>
}

interface ValidateResult {
  valid: boolean
  error?: string
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)

  const loadSettings = useCallback(async () => {
    try {
      const s = await window.electron.getSettings()
      setSettings(s as Settings)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const validateApiKey = useCallback(
    async (providerId: string, apiKey: string): Promise<ValidateResult> => {
      const result = (await window.electron.validateApiKey(providerId, apiKey)) as ValidateResult
      if (result.valid) {
        await loadSettings()
      }
      return result
    },
    [loadSettings]
  )

  const setDefaultProvider = useCallback(
    async (providerId: string) => {
      await window.electron.setDefaultProvider(providerId)
      await loadSettings()
    },
    [loadSettings]
  )

  const setDefaultModel = useCallback(
    async (modelId: string) => {
      await window.electron.setDefaultModel(modelId)
      await loadSettings()
    },
    [loadSettings]
  )

  return { settings, loading, validateApiKey, setDefaultProvider, setDefaultModel }
}
