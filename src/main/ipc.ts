import {
  app,
  ipcMain,
  dialog,
  shell,
  systemPreferences,
  desktopCapturer,
  BrowserWindow,
  nativeImage,
  screen,
} from 'electron'
import type { DesktopCapturerSource } from 'electron'
import { existsSync } from 'fs'
import { chatStore } from './store'
import { registry } from './providers/registry'
import { registerKirbyIpcHandlers } from './native/kirby'
import { openSettingsWindow, closeSettingsWindow } from './windows'

type LarkPermissionState = {
  screen_recording: string
  accessibility: string
}

type LarkCaptureRequest = {
  windowId: number
  windowTitle?: string
  x?: number
  y?: number
  width?: number
  height?: number
}

type LarkCaptureFailureReason =
  | 'invalid-window-id'
  | 'screen-permission-denied'
  | 'window-not-found'
  | 'empty-thumbnail'
  | 'capture-error'

type LarkCaptureResult =
  | {
      ok: true
      dataUrl: string
    }
  | {
      ok: false
      reason: LarkCaptureFailureReason
      permissionState: LarkPermissionState
      requestedWindowId: number
      requestedWindowTitle?: string
    }

const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const SCREEN_CAPTURE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

function larkWindowSourceId(windowId: number): string | null {
  const normalized = Math.trunc(Number(windowId) || 0)
  return normalized > 0 ? `window:${normalized}:0` : null
}

function desktopCapturerSourceWindowId(sourceId: string): number | null {
  const match = /^window:(\d+)(?::|$)/.exec(sourceId.trim())
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeWindowTitle(title: string | undefined): string {
  return (title || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function summarizeDesktopSources(sources: DesktopCapturerSource[]): Array<{ id: string; name: string }> {
  return sources.slice(0, 12).map((source) => ({
    id: source.id,
    name: source.name,
  }))
}

function isMostlyBlankImageDataUrl(dataUrl: string): {
  blank: boolean
  reason?: string
  stats?: Record<string, number>
} {
  try {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) {
      return { blank: true, reason: 'native-image-empty' }
    }

    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) {
      return { blank: true, reason: 'invalid-size', stats: { width, height } }
    }

    const bitmap = image.toBitmap()
    if (!bitmap || bitmap.length < 4) {
      return { blank: true, reason: 'bitmap-empty', stats: { width, height } }
    }

    const stepX = Math.max(1, Math.floor(width / 48))
    const stepY = Math.max(1, Math.floor(height / 48))
    let samples = 0
    let opaqueSamples = 0
    let alphaSum = 0
    let luminanceSum = 0
    let minLuminance = 255
    let maxLuminance = 0

    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const idx = (y * width + x) * 4
        if (idx + 3 >= bitmap.length) continue
        const blue = bitmap[idx]
        const green = bitmap[idx + 1]
        const red = bitmap[idx + 2]
        const alpha = bitmap[idx + 3]
        const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        samples += 1
        alphaSum += alpha
        luminanceSum += luminance
        if (alpha > 12) opaqueSamples += 1
        if (luminance < minLuminance) minLuminance = luminance
        if (luminance > maxLuminance) maxLuminance = luminance
      }
    }

    if (samples === 0) {
      return { blank: true, reason: 'no-samples', stats: { width, height } }
    }

    const opaqueRatio = opaqueSamples / samples
    const meanAlpha = alphaSum / samples
    const meanLuminance = luminanceSum / samples
    const luminanceRange = maxLuminance - minLuminance
    const stats = {
      width,
      height,
      samples,
      opaqueRatio: Number(opaqueRatio.toFixed(4)),
      meanAlpha: Number(meanAlpha.toFixed(2)),
      meanLuminance: Number(meanLuminance.toFixed(2)),
      luminanceRange: Number(luminanceRange.toFixed(2)),
    }

    if (opaqueRatio < 0.02 || meanAlpha < 10) {
      return { blank: true, reason: 'mostly-transparent', stats }
    }

    if (luminanceRange < 6 && meanLuminance > 247) {
      return { blank: true, reason: 'near-solid-white', stats }
    }

    if (luminanceRange < 4 && meanLuminance < 8) {
      return { blank: true, reason: 'near-solid-black', stats }
    }

    return { blank: false, stats }
  } catch (error) {
    console.warn('[lark capture] failed to inspect capture content', error)
    return { blank: false }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function captureLarkDisplayRegion(
  sources: DesktopCapturerSource[],
  request: LarkCaptureRequest
): string | null {
  const x = Number(request.x)
  const y = Number(request.y)
  const width = Number(request.width)
  const height = Number(request.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null
  }

  const targetDisplay = screen.getDisplayMatching({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  })
  const screenSource = sources.find(
    (source) => source.display_id && source.display_id === String(targetDisplay.id)
  )
  if (!screenSource) {
    console.warn('[lark capture] no screen source matched target display', {
      request,
      targetDisplayId: targetDisplay.id,
      targetDisplayBounds: targetDisplay.bounds,
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        display_id: source.display_id,
      })),
    })
    return null
  }

  const thumbnail = screenSource.thumbnail
  if (thumbnail.isEmpty()) {
    console.warn('[lark capture] matched screen source thumbnail is empty', {
      request,
      sourceId: screenSource.id,
      sourceName: screenSource.name,
      displayId: screenSource.display_id,
    })
    return null
  }

  const thumbnailSize = thumbnail.getSize()
  const displayBounds = targetDisplay.bounds
  const relativeX = x - displayBounds.x
  const relativeY = y - displayBounds.y
  const scaleX = thumbnailSize.width / Math.max(displayBounds.width, 1)
  const scaleY = thumbnailSize.height / Math.max(displayBounds.height, 1)
  const cropX = Math.round(relativeX * scaleX)
  const cropY = Math.round(relativeY * scaleY)
  const cropWidth = Math.round(width * scaleX)
  const cropHeight = Math.round(height * scaleY)

  const safeX = clamp(cropX, 0, Math.max(thumbnailSize.width - 1, 0))
  const safeY = clamp(cropY, 0, Math.max(thumbnailSize.height - 1, 0))
  const maxWidth = Math.max(thumbnailSize.width - safeX, 0)
  const maxHeight = Math.max(thumbnailSize.height - safeY, 0)
  const safeWidth = clamp(cropWidth, 1, maxWidth)
  const safeHeight = clamp(cropHeight, 1, maxHeight)

  if (maxWidth <= 0 || maxHeight <= 0 || safeWidth <= 0 || safeHeight <= 0) {
    console.warn('[lark capture] computed screen crop is outside thumbnail bounds', {
      request,
      targetDisplayBounds: displayBounds,
      thumbnailSize,
      crop: { cropX, cropY, cropWidth, cropHeight },
    })
    return null
  }

  const cropped = thumbnail.crop({
    x: safeX,
    y: safeY,
    width: safeWidth,
    height: safeHeight,
  })
  if (cropped.isEmpty()) {
    console.warn('[lark capture] cropped screen thumbnail is empty', {
      request,
      targetDisplayBounds: displayBounds,
      thumbnailSize,
      crop: { x: safeX, y: safeY, width: safeWidth, height: safeHeight },
    })
    return null
  }

  return cropped.toDataURL()
}

function findRequestedLarkSource(
  sources: DesktopCapturerSource[],
  request: LarkCaptureRequest
): DesktopCapturerSource | null {
  const requestedId = Math.trunc(Number(request.windowId) || 0)
  const preferredSourceId = larkWindowSourceId(request.windowId)
  const normalizedRequestedTitle = normalizeWindowTitle(request.windowTitle)

  if (preferredSourceId) {
    const exactIdMatch = sources.find((source) => source.id === preferredSourceId)
    if (exactIdMatch) return exactIdMatch
  }

  if (requestedId > 0) {
    const numericIdMatch = sources.find(
      (source) => desktopCapturerSourceWindowId(source.id) === requestedId
    )
    if (numericIdMatch) return numericIdMatch
  }

  if (!normalizedRequestedTitle) return null

  const exactTitleMatch = sources.find(
    (source) => normalizeWindowTitle(source.name) === normalizedRequestedTitle
  )
  if (exactTitleMatch) return exactTitleMatch

  return (
    sources.find((source) => {
      const normalizedSourceTitle = normalizeWindowTitle(source.name)
      return (
        normalizedSourceTitle.includes(normalizedRequestedTitle) ||
        normalizedRequestedTitle.includes(normalizedSourceTitle)
      )
    }) ?? null
  )
}

function getLarkPermissionState(): LarkPermissionState {
  if (process.platform !== 'darwin') {
    return {
      screen_recording: 'unsupported',
      accessibility: 'unsupported',
    }
  }

  return {
    screen_recording: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
  }
}

async function requestLarkPermissions(): Promise<LarkPermissionState> {
  const before = getLarkPermissionState()
  if (process.platform !== 'darwin') return before

  const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(true)
  const screenRecording = systemPreferences.getMediaAccessStatus('screen')

  if (!accessibilityGranted) {
    await shell.openExternal(ACCESSIBILITY_SETTINGS_URL)
  }
  if (screenRecording !== 'granted') {
    await shell.openExternal(SCREEN_CAPTURE_SETTINGS_URL)
  }

  return {
    screen_recording: screenRecording,
    accessibility: accessibilityGranted ? 'granted' : 'denied',
  }
}

async function captureLarkWindow(request: LarkCaptureRequest): Promise<LarkCaptureResult> {
  const requestedWindowId = Math.trunc(Number(request.windowId) || 0)
  const permissionState = getLarkPermissionState()

  if (requestedWindowId <= 0) {
    console.warn('[lark capture] invalid requested window id', request)
    return {
      ok: false,
      reason: 'invalid-window-id',
      permissionState,
      requestedWindowId,
      requestedWindowTitle: request.windowTitle,
    }
  }

  if (process.platform === 'darwin' && permissionState.screen_recording !== 'granted') {
    return {
      ok: false,
      reason: 'screen-permission-denied',
      permissionState,
      requestedWindowId,
      requestedWindowTitle: request.windowTitle,
    }
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: false,
      thumbnailSize: {
        width: 2560,
        height: 1600,
      },
    })

    const displayCapture = captureLarkDisplayRegion(sources, request)
    if (displayCapture) {
      const displayBlankCheck = isMostlyBlankImageDataUrl(displayCapture)
      if (!displayBlankCheck.blank) {
        return {
          ok: true,
          dataUrl: displayCapture,
        }
      }
      console.warn('[lark capture] display-region capture looked blank', {
        requestedWindowId,
        requestedWindowTitle: request.windowTitle,
        request,
        blankCheck: displayBlankCheck,
      })
    }

    const matchedSource = findRequestedLarkSource(sources, request)
    if (!matchedSource) {
      console.warn('[lark capture] matching source not found', {
        requestedWindowId,
        requestedWindowTitle: request.windowTitle,
        permissionState,
        sources: summarizeDesktopSources(sources),
      })
      return {
        ok: false,
        reason: 'window-not-found',
        permissionState,
        requestedWindowId,
        requestedWindowTitle: request.windowTitle,
      }
    }

    const thumbnail = matchedSource.thumbnail
    if (thumbnail.isEmpty()) {
      console.warn('[lark capture] matched source thumbnail is empty', {
        requestedWindowId,
        requestedWindowTitle: request.windowTitle,
        permissionState,
        sourceId: matchedSource.id,
        sourceName: matchedSource.name,
      })
      return {
        ok: false,
        reason: 'empty-thumbnail',
        permissionState,
        requestedWindowId,
        requestedWindowTitle: request.windowTitle,
      }
    }

    const thumbnailDataUrl = thumbnail.toDataURL()
    const thumbnailBlankCheck = isMostlyBlankImageDataUrl(thumbnailDataUrl)
    if (thumbnailBlankCheck.blank) {
      console.warn('[lark capture] matched source thumbnail looked blank', {
        requestedWindowId,
        requestedWindowTitle: request.windowTitle,
        permissionState,
        sourceId: matchedSource.id,
        sourceName: matchedSource.name,
        blankCheck: thumbnailBlankCheck,
      })
      return {
        ok: false,
        reason: 'empty-thumbnail',
        permissionState,
        requestedWindowId,
        requestedWindowTitle: request.windowTitle,
      }
    }

    return {
      ok: true,
      dataUrl: thumbnailDataUrl,
    }
  } catch (error) {
    console.warn('[lark capture] desktopCapturer.getSources failed', {
      requestedWindowId,
      requestedWindowTitle: request.windowTitle,
      permissionState,
      error,
    })
    return {
      ok: false,
      reason: 'capture-error',
      permissionState,
      requestedWindowId,
      requestedWindowTitle: request.windowTitle,
    }
  }
}

export function registerIpcHandlers(): void {
  ipcMain.on('sessions:changed', (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      if (win.webContents.isDestroyed()) continue
      if (win.webContents.id === event.sender.id) continue
      win.webContents.send('sessions:changed')
    }
  })

  // Chat: send message with streaming response
  ipcMain.handle('chat:send', async (event, message: string, model: string) => {
    const { randomUUID } = await import('crypto')
    const messageId = randomUUID()

    const provider = registry.getAll().find((p) => p.models.includes(model))
    if (!provider) return { error: `No provider found for model: ${model}` }
    if (!provider.isConfigured()) return { error: 'Provider not configured. Please set API key in settings.' }

    const stored = await chatStore.getMessages()
    const history = stored.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    await chatStore.addUserMessage(message)

    try {
      let fullContent = ''
      await provider.chatCompletion({
        model,
        messages: [...history, { role: 'user', content: message }],
        onChunk: (chunk) => {
          if (event.sender.isDestroyed()) return
          if (!chunk.done) {
            fullContent += chunk.content
            event.sender.send('chat:chunk', { messageId, chunk: chunk.content })
          } else {
            event.sender.send('chat:done', { messageId })
          }
        }
      })
      await chatStore.addAssistantMessage(fullContent)
      return { messageId }
    } catch (err: any) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('chat:error', { error: err.message })
      }
      return { error: err.message }
    }
  })

  // Providers: list all models with configured status
  ipcMain.handle('providers:list', async () => {
    const configured = new Set(registry.getConfigured().map((p) => p.name))
    return registry.getAllModels().map(({ provider, model }) => ({
      provider,
      model,
      configured: configured.has(provider)
    }))
  })

  // Generic store handlers
  ipcMain.handle('store:get', async (_event, key: string) => {
    if (key === 'settings') return chatStore.getSettings()
    if (key === 'messages') return chatStore.getMessages()
    if (key === 'backendUrl' || key === 'backendEnabled') {
      const cfg = await chatStore.getBackendConfig()
      return key === 'backendUrl' ? cfg.url : cfg.enabled
    }
    if (key === 'modelWhitelist') return chatStore.getModelWhitelist()
    if (key === 'hermesModelCatalog') return chatStore.getHermesModelCatalog()
    if (key === 'openTabs') return chatStore.getOpenTabs()
    if (key === 'activeTabId') return chatStore.getActiveTabId()
    if (key === 'autoTitleEnabled') return chatStore.getAutoTitleEnabled()
    if (key === 'titleSummaryModel') return chatStore.getTitleSummaryModel()
    return null
  })

  ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
    if (key === 'messages' && value === null) {
      await chatStore.clearMessages()
    } else if (key === 'backendUrl') {
      await chatStore.setBackendConfig({ url: value as string })
    } else if (key === 'backendEnabled') {
      await chatStore.setBackendConfig({ enabled: value as boolean })
    } else if (key === 'modelWhitelist') {
      await chatStore.setModelWhitelist(Array.isArray(value) ? (value as string[]) : [])
    } else if (key === 'hermesModelCatalog') {
      const catalog =
        value && typeof value === 'object'
          ? (value as {
              providers: Array<{
                slug: string
                name: string
                models: string[]
                total_models: number
                is_current: boolean
                source?: string
              }>
              current: string
              current_provider: string
            })
          : null
      await chatStore.setHermesModelCatalog(catalog)
    } else if (key === 'openTabs') {
      await chatStore.setOpenTabs(Array.isArray(value) ? (value as string[]) : [])
    } else if (key === 'activeTabId') {
      await chatStore.setActiveTabId(typeof value === 'string' ? value : null)
    } else if (key === 'autoTitleEnabled') {
      await chatStore.setAutoTitleEnabled(typeof value === 'boolean' ? value : true)
    } else if (key === 'titleSummaryModel') {
      const m = value as any
      await chatStore.setTitleSummaryModel(
        m && typeof m === 'object' && typeof m.model === 'string'
          ? (m as { model: string; provider: string })
          : null
      )
    }
  })

  ipcMain.handle('backend:config:get', async () => {
    return chatStore.getBackendConfig()
  })

  ipcMain.handle('backend:config:set', async (_event, config: Partial<{ url: string; enabled: boolean }>) => {
    await chatStore.setBackendConfig(config)
  })

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion()
  })

  // Settings window — opened on right-click in chat sidebar header
  ipcMain.on('settings:open', () => {
    openSettingsWindow()
  })
  ipcMain.on('settings:close', () => {
    closeSettingsWindow()
  })

  // Settings: get current settings (apiKeys as booleans, no raw keys exposed)
  ipcMain.handle('settings:get', async () => {
    return chatStore.getSettings()
  })

  // Settings: validate API key and save if valid
  ipcMain.handle(
    'settings:validateApiKey',
    async (_event, { providerId, apiKey }: { providerId: string; apiKey: string }) => {
      try {
        let valid = false
        if (providerId === 'openai') {
          const { OpenAI } = await import('openai')
          const client = new OpenAI({ apiKey })
          await client.models.list()
          valid = true
        } else if (providerId === 'anthropic') {
          const Anthropic = await import('@anthropic-ai/sdk')
          const client = new Anthropic.default({ apiKey })
          await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }]
          })
          valid = true
        }
        if (valid) {
          await chatStore.setApiKey(providerId, apiKey)
          registry.updateApiKey(providerId, apiKey)
        }
        return { valid }
      } catch (err: any) {
        return { valid: false, error: err.message || 'Validation failed' }
      }
    }
  )

  // Settings: directly set API key (no validation)
  ipcMain.handle(
    'settings:setApiKey',
    async (_event, { providerId, apiKey }: { providerId: string; apiKey: string }) => {
      await chatStore.setApiKey(providerId, apiKey)
      registry.updateApiKey(providerId, apiKey)
      return { success: true }
    }
  )

  // Settings: update default provider
  ipcMain.handle('settings:setDefaultProvider', async (_event, providerId: string) => {
    await chatStore.setDefaultProvider(providerId)
  })

  // Settings: update default model
  ipcMain.handle('settings:setDefaultModel', async (_event, modelId: string) => {
    await chatStore.setDefaultModel(modelId)
  })

  // Workspace: pick directory via native file dialog
  ipcMain.handle('workspace:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择项目工作区',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Shell: open URL in system browser (whitelist enforced in renderer before calling)
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Shell: reveal path in Finder/Explorer (path comes from trusted backend state)
  ipcMain.handle('shell:showItemInFolder', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('fs:exists', (_event, path: string) => {
    if (typeof path !== 'string' || path.trim() === '') return false
    try {
      return existsSync(path)
    } catch {
      return false
    }
  })

  ipcMain.handle('lark:permissions:get', () => {
    return getLarkPermissionState()
  })

  ipcMain.handle('lark:permissions:request', async () => {
    return requestLarkPermissions()
  })

  ipcMain.handle('lark:captureWindow', async (_event, request: LarkCaptureRequest) => {
    return captureLarkWindow(request)
  })

  // Kirby/native handlers — Stage 2
  registerKirbyIpcHandlers()
}
