import { app, BrowserWindow, ipcMain, screen, Menu } from 'electron'
import { join } from 'path'
import {
  openSettingsWindow,
  openFloatingChatWindow,
  closeFloatingChatWindow,
  isFloatingChatWindowOpen,
} from '../windows'

type FeishuBounds = { x: number; y: number; width: number; height: number }

type KirbyNative = {
  createKirbyWindow(x: number, y: number): void
  destroyKirbyWindow(): void
  getKirbyState(): 'floating' | 'snapping' | 'docked'
  loadContent(url: string): void
  setVisible(visible: boolean): void
  onSnapProximity(cb: (distance: number) => void): void
  onSnapComplete(cb: (feishuBounds: FeishuBounds) => void): void
  onDetach(cb: () => void): void
  detachToFloating(): void
  onRightClick?(cb: () => void): void
}

let native: KirbyNative | null = null
let _mainWin: BrowserWindow | null = null
let _kirbyUrl = ''

function loadAddon(): KirbyNative | null {
  if (native) return native
  try {
    const addonPath = join(app.getAppPath(), 'native/build/Release/kirby_native.node')
    native = require(addonPath) as KirbyNative
    return native
  } catch (err) {
    console.error('[kirby] native addon not found – run `cd native && npx cmake-js build` first:', err)
    return null
  }
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
  _kirbyUrl = isDev
    ? 'http://localhost:5173/components/Kirby/kirby.html'
    : `file://${join(app.getAppPath(), 'dist/renderer/components/Kirby/kirby.html')}`
  addon.loadContent(_kirbyUrl)

  // Bridge native callbacks → Electron main window management
  addon.onSnapProximity((distance) => {
    _mainWin?.webContents.send('kirby:snap-proximity', distance)
  })

  addon.onSnapComplete((feishuBounds: FeishuBounds) => {
    // NSPanel is already hidden by the native animator.
    // Snapping to Feishu is mutually exclusive with the standalone chat
    // window — if one is open, close it.
    if (isFloatingChatWindowOpen()) {
      closeFloatingChatWindow()
    }

    // Now show + position the main BrowserWindow as sidebar next to Feishu
    if (_mainWin) {
      // feishuBounds uses CG coordinates (top-left origin, y-down)
      // Electron setBounds also uses screen coordinates (top-left origin, y-down)
      const sidebarX = Math.round(feishuBounds.x + feishuBounds.width)
      const sidebarY = Math.round(feishuBounds.y)
      const sidebarH = Math.round(feishuBounds.height)

      // Recall the user's last preferred width if any; default to 360.
      const currentW = _mainWin.getBounds().width
      const persistedW =
        currentW >= 280 && currentW <= 800 ? currentW : 360

      _mainWin.setBounds({
        x: sidebarX,
        y: sidebarY,
        width: persistedW,
        height: sidebarH
      })
      // Lock height to Feishu's height but leave width freely resizable
      // within reasonable bounds. Electron treats (0, 0) as "no limit",
      // which is what we want for an unbounded width ceiling.
      _mainWin.setMinimumSize(280, sidebarH)
      _mainWin.setMaximumSize(900, sidebarH)
      _mainWin.setAlwaysOnTop(true, 'floating')
      _mainWin.show()
    }

    _mainWin?.webContents.send('kirby:snap-complete')
  })

  addon.onDetach(() => {
    // Hide the main BrowserWindow sidebar
    if (_mainWin) {
      _mainWin.setAlwaysOnTop(false)
      // Release the height-lock installed on snap, otherwise any future
      // resize attempts on the hidden window could get clamped.
      _mainWin.setMinimumSize(0, 0)
      _mainWin.setMaximumSize(0, 0)
      _mainWin.hide()
    }

    // NSPanel is already made visible and resized by performDetachAnimation
    // Just reload the kirby bubble content
    addon.loadContent(_kirbyUrl)

    _mainWin?.webContents.send('kirby:detach')
  })

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
      // popup() needs a BrowserWindow reference. The Kirby panel is a
      // native NSPanel (not a BrowserWindow), so we use _mainWin as the
      // anchor — it's allowed to be hidden, and Electron places the menu
      // at the current cursor position regardless.
      const anchor =
        _mainWin && !_mainWin.isDestroyed()
          ? _mainWin
          : BrowserWindow.getAllWindows()[0]
      if (anchor) {
        menu.popup({ window: anchor })
      } else {
        menu.popup()
      }
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

  ipcMain.handle('kirby:getState', () =>
    loadAddon()?.getKirbyState() ?? 'floating'
  )
}

export function destroyKirby(): void {
  native?.destroyKirbyWindow()
  native = null
}
