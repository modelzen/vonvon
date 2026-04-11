import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { initKirby, destroyKirby } from './native/kirby'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 600,
    show: false,          // Hidden at startup! Only shown when Kirby snaps.
    frame: false,         // Frameless sidebar
    // Resizable so the docked sidebar can be widened by dragging its left
    // edge. The height is locked to Feishu's height via setMinimumSize /
    // setMaximumSize applied on snap (see kirby.ts onSnapComplete), so in
    // practice users can only change the width.
    resizable: true,
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Do NOT auto-show on ready-to-show

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    // Don't open devtools automatically
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}


app.whenReady().then(() => {
  registerIpcHandlers()
  mainWindow = createMainWindow()

  // Wait for renderer to load before initializing Kirby
  mainWindow.webContents.once('did-finish-load', () => {
    initKirby(mainWindow!)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  destroyKirby()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
