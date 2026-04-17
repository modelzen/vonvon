export const DEFAULT_BACKEND_HOST = '127.0.0.1'
export const DEFAULT_BACKEND_PORT = 18423
export const DEFAULT_BACKEND_URL = `http://${DEFAULT_BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`

const LEGACY_DEFAULT_BACKEND_URLS = new Set([
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:8423',
  'http://127.0.0.1:8423',
])

export function sanitizeBackendUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.replace(/\/+$/, '')
}

export function isLegacyDefaultBackendUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  return LEGACY_DEFAULT_BACKEND_URLS.has(sanitizeBackendUrl(url))
}
