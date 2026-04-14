import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'

const isDev = !app.isPackaged
const DEFAULT_STANDALONE_WINDOW_WIDTH = 1040
const DEFAULT_STANDALONE_WINDOW_HEIGHT = 780

// ─── Settings window ─────────────────────────────────────────────────────────

let settingsWindow: BrowserWindow | null = null

/**
 * The settings window is a standalone, freely-resizable BrowserWindow that
 * loads the same renderer bundle but with `#settings` in the URL. The
 * renderer's main.tsx switches the root component based on that hash.
 *
 * Triggered by right-clicking the Kirby ball → context menu → "设置".
 * Closed via the native macOS red traffic-light button.
 */
export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const width = DEFAULT_STANDALONE_WINDOW_WIDTH
  const height = DEFAULT_STANDALONE_WINDOW_HEIGHT
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2)
  const y = Math.round(display.workArea.y + (display.workArea.height - height) / 2)

  settingsWindow = new BrowserWindow({
    width,
    height,
    minWidth: 980,
    minHeight: 520,
    x,
    y,
    title: 'Vonvon 设置',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fff8fb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    settingsWindow.loadURL('http://localhost:5173/#settings')
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'settings' })
  }

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close()
  }
}

// ─── Floating chat window ────────────────────────────────────────────────────

let floatingChatWindow: BrowserWindow | null = null

/**
 * Standalone chat BrowserWindow — same UI as the Feishu-snapped sidebar,
 * but freely resizable (both width and height). The user can keep this
 * open instead of relying on the Feishu snap behavior.
 *
 * Triggered by right-clicking the Kirby ball → context menu → "打开独立窗口".
 *
 * Loads the same `index.html` as the sidebar (no hash), so the renderer's
 * main.tsx renders <App /> with full SessionProvider.
 */
export function openFloatingChatWindow(): void {
  if (floatingChatWindow && !floatingChatWindow.isDestroyed()) {
    if (floatingChatWindow.isMinimized()) floatingChatWindow.restore()
    floatingChatWindow.show()
    floatingChatWindow.focus()
    return
  }

  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const width = DEFAULT_STANDALONE_WINDOW_WIDTH
  const height = DEFAULT_STANDALONE_WINDOW_HEIGHT
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2)
  const y = Math.round(display.workArea.y + (display.workArea.height - height) / 2)

  floatingChatWindow = new BrowserWindow({
    width,
    height,
    minWidth: 320,
    minHeight: 480,
    x,
    y,
    title: 'Vonvon',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fff8fb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  floatingChatWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    floatingChatWindow.loadURL('http://localhost:5173/#floating')
  } else {
    floatingChatWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'floating' })
  }

  floatingChatWindow.once('ready-to-show', () => {
    floatingChatWindow?.show()
  })

  floatingChatWindow.on('closed', () => {
    floatingChatWindow = null
  })
}

export function closeFloatingChatWindow(): void {
  if (floatingChatWindow && !floatingChatWindow.isDestroyed()) {
    floatingChatWindow.close()
  }
}

export function isFloatingChatWindowOpen(): boolean {
  return !!(floatingChatWindow && !floatingChatWindow.isDestroyed())
}
