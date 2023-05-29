// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  isProduction: () => ipcRenderer.invoke('isProduction'),
  onError: (callback) => ipcRenderer.on('error', callback),
  onClear: (callback, small) => ipcRenderer.on('clear', callback, small),
  print: (file, settings, small) => ipcRenderer.send('print', file, settings, small),
  getPrinters: () => new Promise(resolve => {
    ipcRenderer.once('getPrintersResult', (event, printers) => resolve(printers));
    ipcRenderer.send('getPrinters');
  })
});