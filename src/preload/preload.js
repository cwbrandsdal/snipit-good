'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snippit', {
  // overlay
  onOverlayArm: (cb) => ipcRenderer.on('overlay:arm', (_e, p) => cb(p)),
  onOverlayImage: (cb) => ipcRenderer.on('overlay:image', (_e, p) => cb(p)),
  onOverlayReset: (cb) => ipcRenderer.on('overlay:reset', () => cb()),
  overlaySelect: (payload) => ipcRenderer.send('overlay:select', payload),
  overlayCancel: () => ipcRenderer.send('overlay:cancel'),

  // bar
  onSnips: (cb) => ipcRenderer.on('snips:changed', (_e, p) => cb(p)),
  onBarVisible: (cb) => ipcRenderer.on('bar:visible', () => cb()),
  resizeBar: (height) => ipcRenderer.send('bar:resize', height),
  hideBar: () => ipcRenderer.send('bar:hide'),
  newSnip: () => ipcRenderer.send('snip:new'),
  copySnip: (id) => ipcRenderer.invoke('snip:copy', id),
  editSnip: (id) => ipcRenderer.send('snip:edit', id),
  removeSnip: (id) => ipcRenderer.send('snip:remove', id),
  openSettings: () => ipcRenderer.send('settings:open'),

  // editor
  getSnip: (id) => ipcRenderer.invoke('editor:get-snip', id),
  copyImage: (dataUrl) => ipcRenderer.invoke('image:copy', dataUrl),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('image:save', { dataUrl, name }),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
});
