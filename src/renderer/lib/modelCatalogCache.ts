import type { ListModelsResponse } from '../hooks/useHermesConfig'

const MODEL_CATALOG_KEY = 'hermesModelCatalog'

type StoredModelCatalog = ListModelsResponse & { fetchedAt?: number }

export async function loadStoredModelCatalog(): Promise<ListModelsResponse | null> {
  const stored = (await window.electron.storeGet(MODEL_CATALOG_KEY)) as StoredModelCatalog | null
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.providers)) return null
  return {
    providers: stored.providers,
    current: typeof stored.current === 'string' ? stored.current : '',
    current_provider:
      typeof stored.current_provider === 'string' ? stored.current_provider : '',
  }
}

export async function saveStoredModelCatalog(payload: ListModelsResponse): Promise<void> {
  await window.electron.storeSet(MODEL_CATALOG_KEY, payload)
}

export async function clearStoredModelCatalog(): Promise<void> {
  await window.electron.storeSet(MODEL_CATALOG_KEY, null)
}

export async function loadModelCatalog(
  listModels: () => Promise<ListModelsResponse>,
  options?: { forceRefresh?: boolean }
): Promise<ListModelsResponse> {
  if (!options?.forceRefresh) {
    const stored = await loadStoredModelCatalog()
    if (stored) return stored
  }

  const fresh = await listModels()
  await saveStoredModelCatalog(fresh)
  return fresh
}
