// The only bridge between the page and the desktop shell. Kept deliberately
// tiny: the page can read/set the Pi address and test it, nothing else.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('varuna', {
  isDesktop: true,
  getConfig: () => ipcRenderer.invoke('varuna:getConfig'),
  setPiAddress: (address) => ipcRenderer.invoke('varuna:setPiAddress', String(address ?? '')),
  testPiAddress: (address) => ipcRenderer.invoke('varuna:testPiAddress', String(address ?? '')),
})
