/**
 * EatPan P4 Terminal — Electron Main Process (CJS)
 * 
 * Використовує require('electron') — працює коректно тому що
 * launch.cjs тимчасово перейменовує node_modules/electron/ 
 * перед запуском, дозволяючи Electron використати вбудований модуль.
 * 
 * libp2p (ESM-only) завантажується через dynamic import().
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const isDev = process.argv.includes('--dev')

let mainWindow = null
let p2pBackend = null

// ═══════════════════════════════════════════
//  Вікно
// ═══════════════════════════════════════════

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 480,
    minHeight: 500,
    title: 'EatPan',
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  if (isDev) mainWindow.webContents.openDevTools()
  mainWindow.on('closed', () => { mainWindow = null })
}

// ═══════════════════════════════════════════
//  IPC
// ═══════════════════════════════════════════

function setupIPC() {
  ipcMain.on('send-message', (_event, text) => {
    if (p2pBackend) p2pBackend.sendChat(text)
  })
  ipcMain.handle('get-status', () => {
    if (!p2pBackend) return null
    return p2pBackend.getStatus()
  })
}

// ═══════════════════════════════════════════
//  Auto-Updater
// ═══════════════════════════════════════════

async function setupAutoUpdater() {
  if (isDev) return
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    // Логування
    autoUpdater.logger = {
      info: (...args) => console.log('[Updater]', ...args),
      warn: (...args) => console.warn('[Updater]', ...args),
      error: (...args) => console.error('[Updater]', ...args),
      debug: (...args) => console.log('[Updater:debug]', ...args),
    }

    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] Checking for update...')
    })
    autoUpdater.on('update-available', (info) => {
      console.log('[Updater] Update available:', info.version)
      if (mainWindow) mainWindow.webContents.send('update-available', {
        version: info.version, releaseNotes: info.releaseNotes
      })
    })
    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] No update available')
    })
    autoUpdater.on('download-progress', (progress) => {
      console.log(`[Updater] Download: ${Math.round(progress.percent)}%`)
      if (mainWindow) mainWindow.webContents.send('update-progress', {
        percent: Math.round(progress.percent)
      })
    })
    autoUpdater.on('update-downloaded', () => {
      console.log('[Updater] Download complete!')
      if (mainWindow) mainWindow.webContents.send('update-downloaded')
    })
    autoUpdater.on('error', (err) => {
      console.error('[Updater] Error:', err.message)
      if (mainWindow) mainWindow.webContents.send('update-error', {
        message: err.message
      })
    })

    ipcMain.on('download-update', async () => {
      try {
        console.log('[Updater] Starting download...')
        await autoUpdater.downloadUpdate()
      } catch (e) {
        console.error('[Updater] Download failed:', e.message)
        if (mainWindow) mainWindow.webContents.send('update-error', {
          message: e.message
        })
      }
    })
    ipcMain.on('install-update', () => autoUpdater.quitAndInstall())

    autoUpdater.checkForUpdates()
    setInterval(() => autoUpdater.checkForUpdates(), 30 * 60 * 1000)
  } catch (e) {
    console.log('Auto-updater not available:', e.message)
  }
}

// ═══════════════════════════════════════════
//  Запуск
// ═══════════════════════════════════════════

app.whenReady().then(async () => {
  setupIPC()

  // libp2p = ESM only — dynamic import
  // Polyfill CustomEvent для Node 18 (Electron 28)
  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class CustomEvent extends Event {
      constructor(type, params = {}) {
        super(type, params)
        this.detail = params.detail ?? null
      }
    }
  }
  try {
    const p2pModule = await import('./p2p.mjs')
    p2pBackend = await p2pModule.createP2PBackend({
      onChat: (msg) => {
        if (mainWindow) mainWindow.webContents.send('chat-message', msg)
      },
      onPeersUpdate: (peers) => {
        if (mainWindow) mainWindow.webContents.send('peers-update', peers)
      },
      onConnected: (peerId) => {
        if (mainWindow) mainWindow.webContents.send('peer-connected', peerId)
      },
      onDisconnected: (peerId) => {
        if (mainWindow) mainWindow.webContents.send('peer-disconnected', peerId)
      }
    })
    console.log('[P2P] Backend started')
  } catch (e) {
    console.error('[P2P] Failed to start:', e.message)
  }

  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  if (p2pBackend) await p2pBackend.stop()
  if (process.platform !== 'darwin') app.quit()
})
