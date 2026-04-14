import { app, BrowserWindow, ipcMain, screen, Menu } from 'electron'
import { join } from 'path'
import {
  openSettingsWindow,
  openFloatingChatWindow,
  closeFloatingChatWindow,
  isFloatingChatWindowOpen,
} from '../windows'
import { resolveKirbyAssetPack } from './kirbyAssetPack'

type FeishuBounds = {
  x: number
  y: number
  width: number
  height: number
  windowId: number
}

type KirbyForm = 'floating' | 'snapping' | 'dockedExpanded' | 'dockedCollapsed'

type KirbyNative = {
  createKirbyWindow(x: number, y: number): void
  destroyKirbyWindow(): void
  getKirbyState():
    | 'floating'
    | 'snapping'
    | 'dockedExpanded'
    | 'dockedCollapsed'
  loadContent(url: string): void
  setVisible(visible: boolean): void
  onSnapProximity(cb: (distance: number) => void): void
  onSnapComplete(cb: (feishuBounds: FeishuBounds) => void): void
  onDetach(cb: () => void): void
  onDockedClick?(cb: (feishuBounds: FeishuBounds) => void): void
  onDragLeave?(cb: () => void): void
  onCollapseSidebar?(cb: () => void): void
  onFeishuMoved?(cb: (feishuBounds: FeishuBounds) => void): void
  detachToFloating(): void
  setKirbyForm?(form: KirbyForm): void
  playKirbyTransition?(transitionName: 'detach'): void
  collapseSidebar?(): void
  onRightClick?(cb: () => void): void
}

let native: KirbyNative | null = null
let _mainWin: BrowserWindow | null = null
let _kirbyUrl = ''
let _sidebarZOrderTimer: NodeJS.Timeout | null = null
// Latest known Feishu bounds, kept in sync via onSnapComplete /
// onDockedClick callbacks. Used when the user hides→shows the sidebar via
// the ✕ button and we need to re-position on the current Feishu window.
let _lastFeishuBounds: FeishuBounds | null = null

function feishuMediaSourceId(feishu: FeishuBounds): string | null {
  return feishu.windowId > 0 ? `window:${Math.trunc(feishu.windowId)}:0` : null
}

function syncSidebarAboveFeishu(feishu: FeishuBounds | null): void {
  if (!_mainWin || !_mainWin.isVisible() || !feishu) return
  const sourceId = feishuMediaSourceId(feishu)
  if (!sourceId) return

  try {
    _mainWin.moveAbove(sourceId)
  } catch (err) {
    console.warn('[kirby] failed to move sidebar above Feishu window:', sourceId, err)
  }
}

function startSidebarZOrderSync(): void {
  if (_sidebarZOrderTimer) return
  _sidebarZOrderTimer = setInterval(() => {
    syncSidebarAboveFeishu(_lastFeishuBounds)
  }, 120)
}

function stopSidebarZOrderSync(): void {
  if (_sidebarZOrderTimer) {
    clearInterval(_sidebarZOrderTimer)
    _sidebarZOrderTimer = null
  }
}

/**
 * Apply the given Feishu bounds to the main BrowserWindow sidebar:
 * position it flush against Feishu's right edge, match its height, and
 * preserve the user's previously-dragged width (falling back to 360).
 * Caller is responsible for calling show() afterwards if needed.
 */
function applySidebarBounds(feishu: FeishuBounds): void {
  if (!_mainWin) return
  const sidebarX = Math.round(feishu.x + feishu.width)
  const sidebarY = Math.round(feishu.y)
  const sidebarH = Math.round(feishu.height)

  // Recall the user's last preferred width if any; default to 360.
  const currentW = _mainWin.getBounds().width
  const persistedW = currentW >= 280 && currentW <= 800 ? currentW : 360

  _mainWin.setBounds({
    x: sidebarX,
    y: sidebarY,
    width: persistedW,
    height: sidebarH,
  })
  // Lock height to Feishu's height but leave width freely resizable
  // within reasonable bounds. Electron treats (0, 0) as "no limit",
  // which is what we want for an unbounded width ceiling.
  _mainWin.setMinimumSize(280, sidebarH)
  _mainWin.setMaximumSize(900, sidebarH)
  _mainWin.setAlwaysOnTop(false)
  syncSidebarAboveFeishu(feishu)
}

/**
 * Hide the sidebar BrowserWindow and release the height-lock installed by
 * applySidebarBounds. Safe to call when already hidden.
 *
 * If `animate` is true, sends 'kirby:sidebar-hide' first so the renderer
 * plays the scaleX(1→0) exit animation, then hides after 240ms (matches
 * the keyframe duration in App.tsx). Pass false for "Feishu disappeared"
 * paths where we want an instant hide.
 */
function releaseSidebar(animate: boolean = false): void {
  if (!_mainWin) return
  stopSidebarZOrderSync()
  _mainWin.setAlwaysOnTop(false)
  _mainWin.setMinimumSize(0, 0)
  _mainWin.setMaximumSize(0, 0)
  if (!_mainWin.isVisible()) return

  if (animate) {
    const win = _mainWin
    win.webContents.send('kirby:sidebar-hide')
    setTimeout(() => {
      if (!win.isDestroyed() && win.isVisible()) {
        win.hide()
      }
    }, 240)
  } else {
    _mainWin.hide()
  }
}

function loadAddon(): KirbyNative | null {
  if (native) return native
  // In packaged mode, .node files are unpacked outside app.asar via
  // electron-builder's `asarUnpack`, so app.getAppPath() (which points at
  // the asar) needs swapping to app.asar.unpacked.
  const appPath = app.getAppPath()
  const unpackedPath = appPath.replace(/app\.asar$/, 'app.asar.unpacked')
  const candidates = [
    join(unpackedPath, 'native/build/Release/kirby_native.node'),
    join(appPath, 'native/build/Release/kirby_native.node'),
  ]
  for (const addonPath of candidates) {
    try {
      native = require(addonPath) as KirbyNative
      return native
    } catch {
      // try next
    }
  }
  console.error('[kirby] native addon not found – run `cd native && npx cmake-js build` first. Tried:', candidates)
  return null
}

export function initKirby(mainWindow: BrowserWindow): void {
  const addon = loadAddon()
  if (!addon) return

  _mainWin = mainWindow

  // Position near centre of primary display
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const x = Math.round(width / 2 - 40)
  const y = Math.round(height / 2 - 40)
  addon.createKirbyWindow(x, y)

  const isDev = !app.isPackaged
  if (isDev) {
    _kirbyUrl = 'http://localhost:5173/components/Kirby/kirby.html'
  } else {
    // Kirby is rendered by a raw WKWebView inside the native addon —
    // not an Electron BrowserWindow — so the file:// URL has to point
    // at a real on-disk file, not an entry inside app.asar. We rely on
    // electron-builder unpacking kirby.html to app.asar.unpacked/ via
    // the asarUnpack glob in electron-builder.yml.
    const appPath = app.getAppPath()
    const unpackedPath = appPath.replace(/app\.asar$/, 'app.asar.unpacked')
    _kirbyUrl = `file://${join(unpackedPath, 'out/renderer/components/Kirby/kirby.html')}`
  }
  const pack = resolveKirbyAssetPack(_kirbyUrl)
  const kirbyUrl = new URL(_kirbyUrl)
  kirbyUrl.searchParams.set('pack', pack.packId)
  kirbyUrl.searchParams.set('assetBase', pack.assetBase)
  kirbyUrl.searchParams.set('packData', pack.packData)
  console.log('[kirby] loading url:', kirbyUrl.toString(), 'pack:', pack.packId)
  addon.loadContent(kirbyUrl.toString())

  // Bridge native callbacks → Electron main window management
  addon.onSnapProximity((distance) => {
    _mainWin?.webContents.send('kirby:snap-proximity', distance)
  })

  addon.onSnapComplete((feishuBounds: FeishuBounds) => {
    // The ball NSPanel stays visible at Feishu's top-right corner — native
    // handles positioning + SVG form. We only show the sidebar here.
    // Snapping to Feishu is mutually exclusive with the standalone chat
    // window — if one is open, close it.
    if (isFloatingChatWindowOpen()) {
      closeFloatingChatWindow()
    }

    _lastFeishuBounds = feishuBounds
    if (_mainWin) {
      applySidebarBounds(feishuBounds)
      _mainWin.show()
      syncSidebarAboveFeishu(feishuBounds)
      startSidebarZOrderSync()
      // Notify renderer so it can play the entry animation.
      _mainWin.webContents.send('kirby:sidebar-show')
    }

    _mainWin?.webContents.send('kirby:snap-complete')
  })

  addon.onDetach(() => {
    // Hide the main BrowserWindow sidebar. Used when Feishu disappears
    // (minimized/hidden/quit) — native ran performDetachAnimation to put
    // the ball back at screen center.
    releaseSidebar()
    // Kirby bubble content is already reloaded by setForm → floating.
    _mainWin?.webContents.send('kirby:detach')
  })

  // Ball clicked while dockedCollapsed → native already switched state to
  // dockedExpanded + form dockedExpanded. Re-show the sidebar.
  if (typeof addon.onDockedClick === 'function') {
    addon.onDockedClick((feishuBounds: FeishuBounds) => {
      if (isFloatingChatWindowOpen()) {
        closeFloatingChatWindow()
      }
      _lastFeishuBounds = feishuBounds
      if (_mainWin) {
        applySidebarBounds(feishuBounds)
        _mainWin.show()
        syncSidebarAboveFeishu(feishuBounds)
        startSidebarZOrderSync()
        _mainWin.webContents.send('kirby:sidebar-show')
      }
    })
  }

  // User dragged the ball past 8px threshold while docked → native already
  // reset state+form; we hide the sidebar. Ball continues to follow mouse.
  // Animate the sidebar collapse so it visually retracts toward the ball.
  if (typeof addon.onDragLeave === 'function') {
    addon.onDragLeave(() => {
      addon.playKirbyTransition?.('detach')
      releaseSidebar(true)
      _mainWin?.webContents.send('kirby:detach')
    })
  }

  // Feishu window moved/resized while dockedExpanded → reposition the sidebar
  // so it follows the Feishu window without hiding.
  if (typeof addon.onFeishuMoved === 'function') {
    addon.onFeishuMoved((feishuBounds: FeishuBounds) => {
      _lastFeishuBounds = feishuBounds
      applySidebarBounds(feishuBounds)
      syncSidebarAboveFeishu(feishuBounds)
    })
  }

  // Right-clicking the Kirby ball (while floating) shows a context menu
  // with two actions: open settings, or open a standalone (resizable)
  // chat window. onRightClick was added in a later native addon version —
  // if the user is running an older build we log it so they can run
  // `npm run rebuild`.
  console.log('[kirby.ts] addon.onRightClick typeof =', typeof addon.onRightClick)
  if (typeof addon.onRightClick === 'function') {
    console.log('[kirby.ts] wiring right-click → context menu')
    addon.onRightClick(() => {
      console.log('[kirby.ts] right-click callback fired, popping up menu')
      const menu = Menu.buildFromTemplate([
        {
          label: '打开独立对话',
          click: () => openFloatingChatWindow(),
        },
        { type: 'separator' },
        {
          label: '设置',
          click: () => openSettingsWindow(),
        },
      ])
      // Let macOS' popUpContextMenu handle positioning natively. Calling
      // `menu.popup()` with no options uses the current NSEvent / mouse
      // location, which is correct across multiple displays.
      //
      // What did NOT work:
      //   - `menu.popup({ window: _mainWin })` — anchored to the sidebar
      //     BrowserWindow, which may live on a different monitor from the
      //     ball, so the menu appeared on the sidebar's screen.
      //   - `menu.popup({ x, y })` with global screen coords — Electron
      //     treats x/y as window-local, so without a window they land in
      //     a wrong slot (top-right of some screen).
      menu.popup()
    })
  } else {
    console.warn('[kirby] onRightClick not available — rebuild the native addon with `npm run rebuild`')
  }
  // IPC handlers are registered via ipc.ts → registerKirbyIpcHandlers()
}

export function registerKirbyIpcHandlers(): void {
  ipcMain.on('kirby:detach', () => {
    loadAddon()?.detachToFloating()
  })

  // Sidebar ✕ button: collapse the sidebar but keep the ball docked at
  // Feishu's top-right corner. Native transitions dockedExpanded →
  // dockedCollapsed + switches SVG form; we animate-hide the BrowserWindow
  // (releaseSidebar(true) sends 'kirby:sidebar-hide' first then hides
  // after the 240ms exit animation completes).
  ipcMain.on('kirby:close-sidebar', () => {
    const addon = loadAddon()
    if (addon && typeof addon.collapseSidebar === 'function') {
      addon.collapseSidebar()
    }
    releaseSidebar(true)
  })

  ipcMain.handle('kirby:getState', () =>
    loadAddon()?.getKirbyState() ?? 'floating'
  )
}

export function destroyKirby(): void {
  native?.destroyKirbyWindow()
  native = null
}
