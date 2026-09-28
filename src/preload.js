// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  quit: () => ipcRenderer.invoke('quit'),
  isProduction: () => ipcRenderer.invoke('isProduction'),
  onError: (callback) => ipcRenderer.on('error', callback),
  onClear: (callback) => ipcRenderer.on('clear', callback),
  print: (file, settings, format) => ipcRenderer.send('print', file, settings, format),
  getPrinters: () => new Promise(resolve => {
    ipcRenderer.once('getPrintersResult', (event, printers) => resolve(printers));
    ipcRenderer.send('getPrinters');
  })
});