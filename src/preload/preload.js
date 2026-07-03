'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snippit', {
  // overlay
  onOverlayArm: (cb) => ipcRenderer.on('overlay:arm', (_e, p) => cb(p)),
  onOverlayImage: (cb) => ipcRenderer.on('overlay:image', (_e, p) => cb(p)),
  onOverlayReset: (cb) => ipcRenderer.on('overlay:reset', () => cb()),
  onOverlayMode: (cb) => ipcRenderer.on('overlay:mode', (_e, m) => cb(m)),
  onOverlayWindows: (cb) => ipcRenderer.on('overlay:windows', (_e, list) => cb(list)),
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

  // library window (editor + history + playback)
  openLibrary: () => ipcRenderer.send('library:open'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryGet: (id) => ipcRenderer.invoke('library:get-item', id),
  libraryAddVariant: (payload) => ipcRenderer.invoke('library:add-variant', payload),
  libraryShowInFolder: (id) => ipcRenderer.send('library:show-in-folder', id),
  onLibraryChanged: (cb) => ipcRenderer.on('library:changed', () => cb()),
  onLibrarySelect: (cb) => ipcRenderer.on('library:select', (_e, id) => cb(id)),

  // editor
  copyImage: (dataUrl) => ipcRenderer.invoke('image:copy', dataUrl),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('image:save', { dataUrl, name }),

  // recording region frame (armed: resizable/movable before recording starts)
  onFrameSetup: (cb) => ipcRenderer.on('frame:setup', (_e, p) => cb(p)),
  onFrameLock: (cb) => ipcRenderer.on('frame:lock', () => cb()),
  frameSetIgnore: (ignore) => ipcRenderer.send('frame:set-ignore', ignore),
  frameRect: (rect) => ipcRenderer.send('frame:rect', rect),

  // recording HUD (control bar window doubles as the recorder)
  onRecArm: (cb) => ipcRenderer.on('rec:arm', (_e, p) => cb(p)),
  onRecInit: (cb) => ipcRenderer.on('rec:init', (_e, p) => cb(p)),
  onRecStop: (cb) => ipcRenderer.on('rec:stop', (_e, p) => cb(p)),
  recRecord: () => ipcRenderer.send('rec:record'),
  recStarted: (meta) => ipcRenderer.send('rec:started', meta),
  recChunk: (chunk) => ipcRenderer.send('rec:chunk', chunk),
  recPoster: (dataUrl) => ipcRenderer.send('rec:poster', dataUrl),
  recStatus: (status) => ipcRenderer.send('rec:status', status),
  recDone: (payload) => ipcRenderer.send('rec:done', payload),
  recError: (message) => ipcRenderer.send('rec:error', message),

  // video
  playVideo: (id) => ipcRenderer.send('video:play', id),
  saveVideo: (id) => ipcRenderer.invoke('video:save', id),

  // auth (WorkOS / Nivalo sign-in)
  authGetState: () => ipcRenderer.invoke('auth:get-state'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  authCancelLogin: () => ipcRenderer.send('auth:cancel-login'),
  authLogout: () => ipcRenderer.send('auth:logout'),
  onAuthState: (cb) => ipcRenderer.on('auth:state', (_e, p) => cb(p)),

  // share links (snipit-good.io)
  shareCreate: (payload) => ipcRenderer.invoke('share:create', payload),
  shareList: () => ipcRenderer.invoke('share:list'),
  shareRevoke: (id) => ipcRenderer.invoke('share:revoke', id),
  shareCopyLink: (url) => ipcRenderer.invoke('share:copy-link', url),
  onShareProgress: (cb) => ipcRenderer.on('share:progress', (_e, p) => cb(p)),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickSaveDir: () => ipcRenderer.invoke('settings:pick-folder'),
  openSaveDir: () => ipcRenderer.send('settings:open-folder'),

  // updates
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, p) => cb(p)),
  openReleasesPage: () => ipcRenderer.send('open-releases-page'),
});
