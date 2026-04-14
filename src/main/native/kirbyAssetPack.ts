import { readFileSync } from 'fs'
import { join } from 'path'
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

const REQUIRED_FORMS: KirbyVisualForm[] = [
  'floating',
  'snapping',
  'dockedExpanded',
  'dockedCollapsed',
]

function unpackedAppPath(): string {
  return app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
}

function resolveManifestPath(packId: string): string {
  if (app.isPackaged) {
    return join(
      unpackedAppPath(),
      'out/renderer/kirby-packs',
      packId,
      'manifest.json'
    )
  }

  return join(app.getAppPath(), 'public/kirby-packs', packId, 'manifest.json')
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

function loadPackManifest(packId: string): KirbyAssetPackManifest {
  const manifestPath = resolveManifestPath(packId)
  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as KirbyAssetPackManifest
  validateManifest(packId, manifest)
  return manifest
}

export function resolveKirbyAssetPack(
  kirbyHtmlUrl: string,
  requestedPackId: string = process.env.VONVON_KIRBY_PACK ?? 'default'
): KirbyAssetPackRuntimeConfig {
  const candidates = requestedPackId === 'default'
    ? ['default']
    : [requestedPackId, 'default']

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
