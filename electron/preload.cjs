// The only bridge between the page and the desktop shell. Kept deliberately
// tiny: the page can read/set the drone's and the boat's Pi addresses and test them, nothing else.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('varuna', {
  isDesktop: true,
  getConfig: () => ipcRenderer.invoke('varuna:getConfig'),
  setPiAddress: (address) => ipcRenderer.invoke('varuna:setPiAddress', String(address ?? '')),
  testPiAddress: (address) => ipcRenderer.invoke('varuna:testPiAddress', String(address ?? '')),
  setBoatAddress: (address) => ipcRenderer.invoke('varuna:setBoatAddress', String(address ?? '')),
  testBoatAddress: (address) => ipcRenderer.invoke('varuna:testBoatAddress', String(address ?? '')),
  // Native AI engine: ask for a connection; the port arrives as a window
  // 'message' event { data: 'varuna:ai-port', ports: [port] } (src/lib/nativeAI.js).
  nativeAI: true,
  connectAI: () => ipcRenderer.send('varuna:ai-connect'),
})

ipcRenderer.on('varuna:ai-port', (event) => window.postMessage('varuna:ai-port', '*', event.ports))
ipcRenderer.on('varuna:ai-lost', () => window.postMessage('varuna:ai-lost', '*'))
