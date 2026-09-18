import { readFileSync, readdirSync, statSync } from 'fs'
import { dirname, extname, join, relative, resolve } from 'path'
import { app } from 'electron'

export type KirbyVisualForm =
  | 'floating'
  | 'snapping'
  | 'dockedExpanded'
  | 'dockedCollapsed'

type KirbyFrameManifest =
  | string
  | {
      src: string
      durationMs?: number
    }

type KirbyStateManifest = {
  displayName?: string
  kind?: 'single' | 'sequence'
  src?: string
  frames?: KirbyFrameManifest[]
  frameDurationMs?: number
  loop?: boolean
  description?: string
}

export type KirbyAssetPackManifest = {
  meta?: {
    id?: string
    name?: string
    version?: number
    specVersion?: number
    author?: string
  }
  layout?: {
    panel?: {
      width?: number
      height?: number
    }
    anchor?: {
      x?: number
      y?: number
      description?: string
    }
    hitArea?: {
      type?: 'circle'
      cx?: number
      cy?: number
      r?: number
    }
  }
  transitions?: {
    formSwitch?: {
      durationMs?: number
      scaleFrom?: number
      scaleTo?: number
      easing?: string
    }
    detach?: {
      description?: string
      frames?: KirbyFrameManifest[]
      frameDurationMs?: number
    }
    panelMove?: {
      durationMs?: number
      easing?: string
    }
    sidebarEnter?: {
      durationMs?: number
      origin?: string
      scaleAxis?: string
    }
    sidebarExit?: {
      durationMs?: number
      origin?: string
      scaleAxis?: string
    }
  }
  states: Record<KirbyVisualForm, KirbyStateManifest>
}

export type KirbyAssetPackRuntimeConfig = {
  packId: string
  assetBase: string
  packData: string
  manifest: KirbyAssetPackManifest
}

export type KirbyAssetPackSummary = {
  id: string
  name: string
  version?: number
  author?: string
  previewDataUrl?: string
}

export const DEFAULT_KIRBY_PACK_ID = 'cat'
const FALLBACK_KIRBY_PACK_ID = DEFAULT_KIRBY_PACK_ID

const REQUIRED_FORMS: KirbyVisualForm[] = [
  'floating',
  'snapping',
  'dockedExpanded',
  'dockedCollapsed',
]

function unpackedAppPath(): string {
  return app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
}

function resolvePacksRoot(): string {
  if (app.isPackaged) {
    return join(unpackedAppPath(), 'out/renderer/kirby-packs')
  }

  return join(app.getAppPath(), 'public/kirby-packs')
}

export function normalizeKirbyPackId(packId: string | null | undefined): string {
  const normalized = typeof packId === 'string' ? packId.trim() : ''
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) return DEFAULT_KIRBY_PACK_ID
  return normalized
}

function resolveManifestPath(packId: string): string {
  return join(resolvePacksRoot(), normalizeKirbyPackId(packId), 'manifest.json')
}

function resolveAssetBase(packId: string, kirbyHtmlUrl: string): string {
  return new URL(`../../kirby-packs/${packId}/`, kirbyHtmlUrl).toString()
}

function validateManifest(packId: string, manifest: KirbyAssetPackManifest): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`[kirby] asset pack "${packId}" manifest is empty`)
  }

  if (!manifest.states || typeof manifest.states !== 'object') {
    throw new Error(`[kirby] asset pack "${packId}" is missing "states"`)
  }

  for (const form of REQUIRED_FORMS) {
    const state = manifest.states[form]
    if (!state || typeof state !== 'object') {
      throw new Error(`[kirby] asset pack "${packId}" is missing state "${form}"`)
    }

    const hasSingle = typeof state.src === 'string' && state.src.length > 0
    const hasFrames = Array.isArray(state.frames) && state.frames.length > 0
    if (!hasSingle && !hasFrames) {
      throw new Error(
        `[kirby] asset pack "${packId}" state "${form}" must define "src" or "frames"`
      )
    }
  }
}

export function loadPackManifest(packId: string): KirbyAssetPackManifest {
  const manifestPath = resolveManifestPath(packId)
  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as KirbyAssetPackManifest
  validateManifest(packId, manifest)
  return manifest
}

function resolvePackAssetPath(packId: string, assetPath: string): string | null {
  const packDir = dirname(resolveManifestPath(packId))
  const resolved = resolve(packDir, assetPath)
  const rel = relative(packDir, resolved)
  if (rel.startsWith('..') || rel === '') return null
  return resolved
}

function mimeForAsset(assetPath: string): string | null {
  const extension = extname(assetPath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.svg') return 'image/svg+xml'
  return null
}

function buildPreviewDataUrl(packId: string, manifest: KirbyAssetPackManifest): string | undefined {
  const previewSrc = manifest.states.floating?.src
  if (!previewSrc) return undefined

  const mime = mimeForAsset(previewSrc)
  const previewPath = resolvePackAssetPath(packId, previewSrc)
  if (!mime || !previewPath) return undefined

  try {
    return `data:${mime};base64,${readFileSync(previewPath).toString('base64')}`
  } catch (err) {
    console.warn(`[kirby] failed to read preview for asset pack "${packId}":`, err)
    return undefined
  }
}

export function listKirbyAssetPacks(): KirbyAssetPackSummary[] {
  const root = resolvePacksRoot()
  let entries: string[] = []

  try {
    entries = readdirSync(root)
  } catch (err) {
    console.warn('[kirby] failed to list asset packs:', err)
    return []
  }

  const packs: KirbyAssetPackSummary[] = []
  for (const entry of entries) {
    const packId = normalizeKirbyPackId(entry)
    if (packId !== entry) continue

    try {
      const manifestPath = resolveManifestPath(packId)
      if (!statSync(dirname(manifestPath)).isDirectory()) continue
      const manifest = loadPackManifest(packId)
      packs.push({
        id: packId,
        name: manifest.meta?.name || packId,
        version: manifest.meta?.version,
        author: manifest.meta?.author,
        previewDataUrl: buildPreviewDataUrl(packId, manifest),
      })
    } catch (err) {
      console.warn(`[kirby] skipping invalid asset pack "${packId}":`, err)
    }
  }

  return packs.sort((a, b) => {
    if (a.id === DEFAULT_KIRBY_PACK_ID) return -1
    if (b.id === DEFAULT_KIRBY_PACK_ID) return 1
    return a.name.localeCompare(b.name)
  })
}

export function resolveKirbyAssetPack(
  kirbyHtmlUrl: string,
  requestedPackId: string = process.env.VONVON_KIRBY_PACK ?? DEFAULT_KIRBY_PACK_ID
): KirbyAssetPackRuntimeConfig {
  const normalizedPackId = normalizeKirbyPackId(requestedPackId)
  const candidates = Array.from(new Set([normalizedPackId, FALLBACK_KIRBY_PACK_ID]))

  let lastError: unknown = null

  for (const packId of candidates) {
    try {
      const manifest = loadPackManifest(packId)
      return {
        packId,
        assetBase: resolveAssetBase(packId, kirbyHtmlUrl),
        packData: Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64url'),
        manifest,
      }
    } catch (err) {
      lastError = err
      console.warn(`[kirby] failed to load asset pack "${packId}":`, err)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('[kirby] failed to resolve any asset pack')
}
