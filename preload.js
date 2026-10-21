'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  /** Último estado conocido del servidor. */
  getStatus: () => ipcRenderer.invoke('dsh:status'),
  /** Suscripción a cambios de estado; devuelve la función para desuscribirse. */
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('dsh:status', listener)
    return () => ipcRenderer.removeListener('dsh:status', listener)
  },
  retry: () => ipcRenderer.send('dsh:retry'),
  openLogs: () => ipcRenderer.send('dsh:open-logs'),
  quit: () => ipcRenderer.send('dsh:quit'),
})
