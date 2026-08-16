// preload.js
// Runs in a privileged context but exposes only a narrow, explicit API
// to index.html/renderer.js. The renderer never gets raw access to
// Node.js or mpv — just these named functions. This is the standard,
// secure way to structure an Electron app.

const { contextBridge, ipcRenderer } = require('electron');

// Builds the same set of functions for a given player label ('tv' or
// 'radio') instead of writing tv-specific and radio-specific versions
// by hand — same pattern as createMpvPlayer() on the main-process side.
function playerAPI(label) {
  return {
    loadStream: (url) => ipcRenderer.invoke(`${label}-load`, url),
    play: () => ipcRenderer.invoke(`${label}-play`),
    pause: () => ipcRenderer.invoke(`${label}-pause`),
    setSpeed: (value) => ipcRenderer.invoke(`${label}-set-speed`, value),
    toggleMute: () => ipcRenderer.invoke(`${label}-toggle-mute`),
    setVolume: (value) => ipcRenderer.invoke(`${label}-set-volume`, value),
    toggleFullscreen: () => ipcRenderer.invoke(`${label}-toggle-fullscreen`),
    onStatus: (callback) => {
      ipcRenderer.on(`${label}-status`, (_event, status) => callback(status));
    },
  };
}

contextBridge.exposeInMainWorld('api', {
  tv: playerAPI('tv'),
  radio: playerAPI('radio'),
  // Global — not per-player — since sync status describes the
  // relationship between both streams, not either one alone.
  onSyncStatus: (callback) => {
    ipcRenderer.on('sync-status', (_event, status) => callback(status));
  },
});
