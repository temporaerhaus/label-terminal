// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  onError: (callback) => ipcRenderer.on('error', callback),
  onClear: (callback) => ipcRenderer.on('clear', callback),
  print: (file) => ipcRenderer.send('print', file)
});