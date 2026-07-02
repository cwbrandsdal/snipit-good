'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snippit', {
  // overlay
  onOverlayArm: (cb) => ipcRenderer.on('overlay:arm', (_e, p) => cb(p)),
  onOverlayImage: (cb) => ipcRenderer.on('overlay:image', (_e, p) => cb(p)),
  onOverlayReset: (cb) => ipcRenderer.on('overlay:reset', () => cb()),
  onOverlayMode: (cb) => ipcRenderer.on('overlay:mode', (_e, m) => cb(m)),
  setOverlayMode: (mode) => ipcRenderer.send('overlay:mode', mode),
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

  // recording region frame (armed: resizable/movable before recording starts)
  onFrameSetup: (cb) => ipcRenderer.on('frame:setup', (_e, p) => cb(p)),
  onFrameLock: (cb) => ipcRenderer.on('frame:lock', () => cb()),
  frameSetIgnore: (ignore) => ipcRenderer.send('frame:set-ignore', ignore),
  frameRect: (rect) => ipcRenderer.send('frame:rect', rect),

  // recording HUD (control bar window doubles as the recorder)
  onRecArm: (cb) => ipcRenderer.on('rec:arm', () => cb()),
  onRecInit: (cb) => ipcRenderer.on('rec:init', (_e, p) => cb(p)),
  onRecStop: (cb) => ipcRenderer.on('rec:stop', (_e, p) => cb(p)),
  recRecord: () => ipcRenderer.send('rec:record'),
  recStarted: (meta) => ipcRenderer.send('rec:started', meta),
  recChunk: (chunk) => ipcRenderer.send('rec:chunk', chunk),
  recPoster: (dataUrl) => ipcRenderer.send('rec:poster', dataUrl),
  recStatus: (status) => ipcRenderer.send('rec:status', status),
  recDone: (payload) => ipcRenderer.send('rec:done', payload),
  recError: (message) => ipcRenderer.send('rec:error', message),

  // video player
  playVideo: (id) => ipcRenderer.send('video:play', id),
  getVideoSnip: (id) => ipcRenderer.invoke('player:get-snip', id),
  saveVideo: (id) => ipcRenderer.invoke('video:save', id),
  showVideoInFolder: (id) => ipcRenderer.send('video:show-in-folder', id),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // updates
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, p) => cb(p)),
  openReleasesPage: () => ipcRenderer.send('open-releases-page'),
});
