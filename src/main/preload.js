const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('superVip', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  fetchVideoMetadata: (url) => ipcRenderer.invoke('video:metadata', url),
  getGuestPreloadPath: () => ipcRenderer.invoke('path:guest-preload'),
  getUserAgent: () => ipcRenderer.invoke('browser:user-agent'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onBrowserPopupUrl: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('browser:popup-url', listener);
    return () => ipcRenderer.removeListener('browser:popup-url', listener);
  }
});
