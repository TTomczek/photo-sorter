const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photoSorter', Object.freeze({
  isDesktop: true,
  chooseRoot: (collectionId) => ipcRenderer.invoke('photo-sorter:choose-root', collectionId),
  setAutostart: (enabled) => ipcRenderer.invoke('photo-sorter:set-autostart', enabled),
}));
