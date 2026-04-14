#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { extname, resolve, dirname, join, relative, sep } from 'path'

const REQUIRED_STATES = [
  'floating',
  'snapping',
  'dockedExpanded',
  'dockedCollapsed',
]

const ALLOWED_EXTENSIONS = new Set(['.svg', '.png'])

let errorCount = 0
let warningCount = 0

function logInfo(message) {
  console.log(message)
}

function logWarn(message) {
  warningCount += 1
  console.warn(`WARN  ${message}`)
}

function logError(message) {
  errorCount += 1
  console.error(`ERROR ${message}`)
}

function isDirectory(pathname) {
  try {
    return statSync(pathname).isDirectory()
  } catch {
    return false
  }
}

function parseNumber(raw) {
  if (typeof raw !== 'string') return Number.NaN
  const match = raw.trim().match(/^(-?\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : Number.NaN
}

function parsePngDimensions(filePath) {
  const buffer = readFileSync(filePath)
  const signature = '89504e470d0a1a0a'
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('invalid PNG header')
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function parseSvgDimensions(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const viewBoxMatch = text.match(/\bviewBox\s*=\s*['"]([^'"]+)['"]/i)
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      return {
        width: parts[2],
        height: parts[3],
      }
    }
  }

  const widthMatch = text.match(/\bwidth\s*=\s*['"]([^'"]+)['"]/i)
  const heightMatch = text.match(/\bheight\s*=\s*['"]([^'"]+)['"]/i)
  const width = widthMatch ? parseNumber(widthMatch[1]) : Number.NaN
  const height = heightMatch ? parseNumber(heightMatch[1]) : Number.NaN
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return { width, height }
  }

  throw new Error('missing readable viewBox/width/height')
}

function assertFiniteNumber(label, value, packName) {
  if (!Number.isFinite(value)) {
    logError(`${packName}: ${label} must be a finite number`)
    return false
  }
  return true
}

function normalizeFrameEntries(stateDef) {
  if (Array.isArray(stateDef.frames) && stateDef.frames.length > 0) {
    return stateDef.frames.map((frame) =>
      typeof frame === 'string'
        ? { src: frame, durationMs: stateDef.frameDurationMs ?? 100 }
        : { src: frame?.src, durationMs: frame?.durationMs ?? stateDef.frameDurationMs ?? 100 }
    )
  }

  if (typeof stateDef.src === 'string' && stateDef.src.length > 0) {
    return [{ src: stateDef.src, durationMs: stateDef.frameDurationMs ?? 100 }]
  }

  return []
}

function validateAssetReference(packDir, packName, label, assetPath, panelWidth, panelHeight) {
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    logError(`${packName}: ${label} has an empty asset path`)
    return
  }

  const resolved = resolve(packDir, assetPath)
  const rel = relative(packDir, resolved)
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    logError(`${packName}: ${label} points outside the pack directory: ${assetPath}`)
    return
  }

  const extension = extname(resolved).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    logError(
      `${packName}: ${label} uses unsupported extension "${extension || '(none)'}"; expected .svg or .png`
    )
    return
  }

  if (!existsSync(resolved)) {
    logError(`${packName}: ${label} is missing file ${assetPath}`)
    return
  }

  try {
    const dims = extension === '.png'
      ? parsePngDimensions(resolved)
      : parseSvgDimensions(resolved)
    if (dims.width !== panelWidth || dims.height !== panelHeight) {
      logError(
        `${packName}: ${label} has size ${dims.width}x${dims.height}, expected ${panelWidth}x${panelHeight}`
      )
    }
  } catch (err) {
    logError(
      `${packName}: ${label} could not be inspected (${err instanceof Error ? err.message : String(err)})`
    )
  }
}

function validatePack(packDir) {
  const manifestPath = join(packDir, 'manifest.json')
  const packName = relative(process.cwd(), packDir) || packDir

  logInfo(`\nChecking ${packName}`)

  if (!existsSync(manifestPath)) {
    logError(`${packName}: missing manifest.json`)
    return
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    logError(`${packName}: manifest.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
    return
  }

  const panelWidth = manifest?.layout?.panel?.width ?? 120
  const panelHeight = manifest?.layout?.panel?.height ?? 120
  const anchorX = manifest?.layout?.anchor?.x ?? 60
  const anchorY = manifest?.layout?.anchor?.y ?? 60
  const hitCx = manifest?.layout?.hitArea?.cx ?? 60
  const hitCy = manifest?.layout?.hitArea?.cy ?? 60
  const hitR = manifest?.layout?.hitArea?.r ?? 40

  if (
    assertFiniteNumber('layout.panel.width', panelWidth, packName) &&
    assertFiniteNumber('layout.panel.height', panelHeight, packName)
  ) {
    if (panelWidth <= 0 || panelHeight <= 0) {
      logError(`${packName}: layout.panel width/height must be > 0`)
    }
  }

  if (assertFiniteNumber('layout.anchor.x', anchorX, packName) && assertFiniteNumber('layout.anchor.y', anchorY, packName)) {
    if (anchorX < 0 || anchorX > panelWidth || anchorY < 0 || anchorY > panelHeight) {
      logError(`${packName}: anchor (${anchorX}, ${anchorY}) must stay inside the panel ${panelWidth}x${panelHeight}`)
    }
  }

  if (manifest?.layout?.hitArea?.type && manifest.layout.hitArea.type !== 'circle') {
    logWarn(`${packName}: hitArea.type="${manifest.layout.hitArea.type}" is not yet consumed by native code; only circle is documented`)
  }

  if (
    assertFiniteNumber('layout.hitArea.cx', hitCx, packName) &&
    assertFiniteNumber('layout.hitArea.cy', hitCy, packName) &&
    assertFiniteNumber('layout.hitArea.r', hitR, packName)
  ) {
    if (hitR <= 0) {
      logError(`${packName}: hitArea.r must be > 0`)
    }
    if (hitCx - hitR < 0 || hitCy - hitR < 0 || hitCx + hitR > panelWidth || hitCy + hitR > panelHeight) {
      logWarn(
        `${packName}: hit area circle (${hitCx}, ${hitCy}, r=${hitR}) exceeds the panel bounds ${panelWidth}x${panelHeight}`
      )
    }
  }

  if (!manifest?.states || typeof manifest.states !== 'object') {
    logError(`${packName}: missing states object`)
    return
  }

  if (manifest.transitions && typeof manifest.transitions === 'object') {
    for (const [transitionName, transitionDef] of Object.entries(manifest.transitions)) {
      if (!transitionDef || typeof transitionDef !== 'object') continue
      const frames = normalizeFrameEntries(transitionDef)
      if (frames.length === 0) continue
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index]
        if (!Number.isFinite(frame.durationMs) || frame.durationMs <= 0) {
          logError(`${packName}: transition "${transitionName}" frame ${index + 1} has invalid durationMs`)
        }
        validateAssetReference(
          packDir,
          packName,
          `transition "${transitionName}" frame ${index + 1}`,
          frame.src,
          panelWidth,
          panelHeight
        )
      }
    }
  }

  for (const stateName of REQUIRED_STATES) {
    const stateDef = manifest.states[stateName]
    if (!stateDef || typeof stateDef !== 'object') {
      logError(`${packName}: missing required state "${stateName}"`)
      continue
    }

    const frames = normalizeFrameEntries(stateDef)
    if (frames.length === 0) {
      logError(`${packName}: state "${stateName}" must provide "src" or a non-empty "frames" array`)
      continue
    }

    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      if (!Number.isFinite(frame.durationMs) || frame.durationMs <= 0) {
        logError(`${packName}: state "${stateName}" frame ${index + 1} has invalid durationMs`)
      }
      validateAssetReference(
        packDir,
        packName,
        `state "${stateName}" frame ${index + 1}`,
        frame.src,
        panelWidth,
        panelHeight
      )
    }
  }
}

function collectPackDirectories(targetPath) {
  if (!existsSync(targetPath)) {
    logError(`target does not exist: ${targetPath}`)
    return []
  }

  if (!isDirectory(targetPath)) {
    logError(`target is not a directory: ${targetPath}`)
    return []
  }

  if (existsSync(join(targetPath, 'manifest.json'))) {
    return [targetPath]
  }

  return readdirSync(targetPath)
    .map((entry) => join(targetPath, entry))
    .filter((entry) => isDirectory(entry) && existsSync(join(entry, 'manifest.json')))
}

function main() {
  const targetArg = process.argv[2] ?? 'public/kirby-packs'
  const targetPath = resolve(process.cwd(), targetArg)
  const packDirs = collectPackDirectories(targetPath)

  if (packDirs.length === 0) {
    logError(`no kirby packs found under ${targetPath}`)
  }

  for (const packDir of packDirs) {
    validatePack(packDir)
  }

  console.log(`\nKirby pack validation finished: ${errorCount} error(s), ${warningCount} warning(s)`)
  if (errorCount > 0) {
    process.exitCode = 1
  }
}

main()
