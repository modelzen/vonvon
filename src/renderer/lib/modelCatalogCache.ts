import type { CredentialView, ListModelsResponse } from '../hooks/useHermesConfig'

const MODEL_CATALOG_KEY = 'hermesModelCatalog'

type StoredModelCatalog = ListModelsResponse & {
  fetchedAt?: number
  contextFingerprint?: string | null
}

type LoadModelCatalogOptions = {
  forceRefresh?: boolean
  getFingerprint?: () => Promise<string | null>
}

type SaveStoredModelCatalogOptions = {
  fingerprint?: string | null
  preserveFingerprint?: boolean
}

function isProviderList(value: unknown): value is ListModelsResponse['providers'] {
  return Array.isArray(value)
}

function toCatalogResponse(stored: StoredModelCatalog): ListModelsResponse {
  return {
    providers: stored.providers,
    current: typeof stored.current === 'string' ? stored.current : '',
    current_provider:
      typeof stored.current_provider === 'string' ? stored.current_provider : '',
  }
}

async function readStoredModelCatalog(): Promise<StoredModelCatalog | null> {
  const stored = (await window.electron.storeGet(MODEL_CATALOG_KEY)) as StoredModelCatalog | null
  if (!stored || typeof stored !== 'object' || !isProviderList(stored.providers)) return null
  return stored
}

export async function loadStoredModelCatalog(): Promise<ListModelsResponse | null> {
  const stored = await readStoredModelCatalog()
  if (!stored) return null
  return toCatalogResponse(stored)
}

export async function buildModelCatalogFingerprint(
  listCredentials: () => Promise<CredentialView[]>
): Promise<string | null> {
  const [backendUrl, backendEnabled, credentials] = await Promise.all([
    window.electron.storeGet('backendUrl'),
    window.electron.storeGet('backendEnabled'),
    listCredentials(),
  ])

  const normalizedCredentials = [...credentials]
    .map((credential) => ({
      provider: credential.provider,
      id: credential.id,
      auth_type: credential.auth_type,
      source: credential.source,
      last4: credential.last4,
      base_url: credential.base_url ?? '',
      base_url_override: credential.base_url_override === true,
      status: credential.status ?? '',
      is_current: credential.is_current,
    }))
    .sort((left, right) =>
      `${left.provider}:${left.id}`.localeCompare(`${right.provider}:${right.id}`)
    )

  // No configured credentials is a special case: the empty list before and
  // after a delete would otherwise hash to the same fingerprint and keep a
  // stale model catalog alive. In that state we always re-validate against
  // the backend instead of trusting cached providers.
  if (normalizedCredentials.length === 0) {
    return null
  }

  return JSON.stringify({
    backendUrl: typeof backendUrl === 'string' ? backendUrl : '',
    backendEnabled: backendEnabled !== false,
    credentials: normalizedCredentials,
  })
}

export async function saveStoredModelCatalog(
  payload: ListModelsResponse,
  options?: SaveStoredModelCatalogOptions
): Promise<void> {
  let contextFingerprint = options?.fingerprint ?? null
  if (options?.preserveFingerprint) {
    contextFingerprint = (await readStoredModelCatalog())?.contextFingerprint ?? null
  }

  await window.electron.storeSet(MODEL_CATALOG_KEY, {
    ...payload,
    fetchedAt: Date.now(),
    contextFingerprint,
  } satisfies StoredModelCatalog)
}

export async function clearStoredModelCatalog(): Promise<void> {
  await window.electron.storeSet(MODEL_CATALOG_KEY, null)
}

export async function loadModelCatalog(
  listModels: () => Promise<ListModelsResponse>,
  options?: LoadModelCatalogOptions
): Promise<ListModelsResponse> {
  const stored = options?.forceRefresh ? null : await readStoredModelCatalog()
  let fingerprint: string | null = null
  let fingerprintLoaded = false

  if (options?.getFingerprint) {
    try {
      fingerprint = await options.getFingerprint()
      fingerprintLoaded = true
    } catch {
      fingerprint = null
    }
  }

  if (stored) {
    if (!options?.getFingerprint) return toCatalogResponse(stored)
    if (
      fingerprintLoaded &&
      typeof stored.contextFingerprint === 'string' &&
      stored.contextFingerprint === fingerprint
    ) {
      return toCatalogResponse(stored)
    }
  }

  const fresh = await listModels()
  if (options?.getFingerprint && !fingerprintLoaded) {
    fingerprint = await options.getFingerprint()
    fingerprintLoaded = true
  }
  await saveStoredModelCatalog(fresh, { fingerprint: fingerprintLoaded ? fingerprint : null })
  return fresh
}
