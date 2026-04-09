import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'

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
    // NSPanel is already hidden by the native animator
    // Now show + position the main BrowserWindow as sidebar next to Feishu
    if (_mainWin) {
      // feishuBounds uses CG coordinates (top-left origin, y-down)
      // Electron setBounds also uses screen coordinates (top-left origin, y-down)
      const sidebarX = Math.round(feishuBounds.x + feishuBounds.width)
      const sidebarY = Math.round(feishuBounds.y)
      const sidebarH = Math.round(feishuBounds.height)

      _mainWin.setBounds({
        x: sidebarX,
        y: sidebarY,
        width: 360,
        height: sidebarH
      })
      _mainWin.setAlwaysOnTop(true, 'floating')
      _mainWin.show()
    }

    _mainWin?.webContents.send('kirby:snap-complete')
  })

  addon.onDetach(() => {
    // Hide the main BrowserWindow sidebar
    if (_mainWin) {
      _mainWin.setAlwaysOnTop(false)
      _mainWin.hide()
    }

    // NSPanel is already made visible and resized by performDetachAnimation
    // Just reload the kirby bubble content
    addon.loadContent(_kirbyUrl)

    _mainWin?.webContents.send('kirby:detach')
  })
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
