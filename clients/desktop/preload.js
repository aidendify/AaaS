const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  save: (url) => ipcRenderer.send('save-url', String(url || '')),
});
