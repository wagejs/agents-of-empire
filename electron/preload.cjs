// The only doors from the colony page into the desktop shell. CommonJS: a sandboxed preload can't be ESM.
const { contextBridge, ipcRenderer } = require('electron')

// Before any page script reads it: the storage the browser tab mirrored to the server.
try {
  const { local = {}, session = {} } = ipcRenderer.sendSync('storage') || {}
  for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v)
  for (const [k, v] of Object.entries(session)) sessionStorage.setItem(k, v)
} catch {
  /* no mirror yet: the page starts fresh */
}

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, value) => cb(value))

contextBridge.exposeInMainWorld('botCrossingApp', {
  waiting: (count, fresh) => ipcRenderer.send('waiting', count, fresh),
  onVisible: on('visible'),
  onSelect: on('select'),
  browser: {
    open: (url) => ipcRenderer.send('browser', 'open', url),
    bounds: (rect) => ipcRenderer.send('browser', 'bounds', rect),
    hide: () => ipcRenderer.send('browser', 'hide'),
    back: () => ipcRenderer.send('browser', 'back'),
    forward: () => ipcRenderer.send('browser', 'forward'),
    reload: () => ipcRenderer.send('browser', 'reload'),
    onState: on('browser-state'),
    onEscape: on('browser-escape'),
  },
})
