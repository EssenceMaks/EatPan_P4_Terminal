/**
 * Preload Script (CommonJS) — безпечний міст між Electron і Renderer
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('eatpan', {
  // Chat
  sendMessage: (text) => ipcRenderer.send('send-message', text),
  onChatMessage: (cb) => ipcRenderer.on('chat-message', (_e, msg) => cb(msg)),

  // Peers
  onPeersUpdate: (cb) => ipcRenderer.on('peers-update', (_e, peers) => cb(peers)),
  onPeerConnected: (cb) => ipcRenderer.on('peer-connected', (_e, id) => cb(id)),
  onPeerDisconnected: (cb) => ipcRenderer.on('peer-disconnected', (_e, id) => cb(id)),

  // Status
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Updates
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, err) => cb(err)),
  downloadUpdate: () => ipcRenderer.send('download-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
})
