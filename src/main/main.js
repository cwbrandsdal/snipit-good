'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const {
  app, BrowserWindow, globalShortcut, screen, desktopCapturer,
  clipboard, nativeImage, Tray, Menu, ipcMain, dialog, shell, session,
  powerMonitor,
} = require('electron');

const gdi = require('./gdi-capture');
const winEnum = require('./win-enum');
const auth = require('./auth');
const share = require('./share');

const SMOKE = process.argv.includes('--smoke');
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // every 4 hours
const SELFTEST = process.argv.includes('--selftest');
const MAX_SNIPS = 3;
const BAR_WIDTH = 196;
const BAR_MARGIN = 14;
const RECORD_FPS = 30;
const MAX_RECORD_MS = 30 * 60 * 1000; // hard cap so a forgotten recording can't fill the disk

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const renderer = (p) => path.join(__dirname, '..', 'renderer', p);
const asset = (p) => path.join(__dirname, '..', '..', 'assets', p);

const DEFAULT_SETTINGS = {
  shortcut: 'Ctrl+Shift+S',
  recordShortcut: 'Ctrl+Alt+R',
  defaultMode: 'image', // what the main shortcut opens: 'image' | 'video'
  autoCopy: true,
  pinBar: false,
  autoUpdate: true,
  recordAudio: true, // recordings START with system audio on (mutable from the HUD)
  recordMic: false,  // recordings START with the microphone on (toggleable from the HUD)
  micDeviceId: '',   // chosen input device; '' = system default
  audioQuality: 'standard', // low | standard | high
  armBeforeRecord: true, // pick a region, adjust it, press Record — vs. record instantly
  saveDir: '', // where captures are written; resolved to Pictures\snipit-good when empty
};

const AUDIO_BITRATES = { low: 64000, standard: 128000, high: 192000 };

let settings = { ...DEFAULT_SETTINGS };
// the library keeps EVERY capture — nothing is trimmed automatically.
// { id, kind: 'image'|'video', file, poster?, thumb?, width, height,
//   durationMs?, createdAt, parentId?, ops? }
// parentId/ops: an edited variant — ops replay over the parent image, so
// variants stay re-editable as long as the parent file exists.
let library = [];
let tray = null;
let barWin = null;
let barHeight = 120; // last content height reported by the bar renderer
let settingsWin = null;
let libraryWin = null; // singleton editor/library window
let overlays = []; // { win, display, image }
let capturing = false;
let snipMode = 'image'; // what a finished overlay drag does: 'image' | 'video'
let quitting = false;

const snipsDir = () => path.join(app.getPath('userData'), 'snips'); // pre-library store, kept for migration
const thumbsDir = () => path.join(app.getPath('userData'), 'thumbs');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const metaFile = () => path.join(snipsDir(), 'snips.json');
const libraryFile = () => path.join(app.getPath('userData'), 'library.json');

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/* ---------------- persistence ---------------- */

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch { settings = { ...DEFAULT_SETTINGS }; }
  if (!settings.saveDir) settings.saveDir = defaultSaveDir();
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

function defaultSaveDir() {
  return path.join(app.getPath('pictures'), 'snipit-good');
}

/* One-time migration from the pre-rename app name (snippit-good -> snipit-good):
   the renamed app gets a fresh %APPDATA%/snipit-good, so copy the settings,
   library index, saved session and thumbnails over on first launch. Capture
   files are referenced by absolute path in library.json and are left in place,
   so the whole history keeps working. Runs only for the real installed app. */
function migrateLegacyUserData() {
  try {
    const cur = app.getPath('userData');
    if (path.basename(cur).toLowerCase() !== 'snipit-good') return;
    // already initialised in the new location — never clobber
    if (fs.existsSync(path.join(cur, 'library.json')) || fs.existsSync(settingsFile())) return;
    const legacy = path.join(path.dirname(cur), 'snippit-good');
    if (legacy === cur || !fs.existsSync(legacy)) return;
    fs.mkdirSync(cur, { recursive: true });
    for (const name of ['settings.json', 'library.json', 'auth.json']) {
      const src = path.join(legacy, name);
      const dst = path.join(cur, name);
      try { if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst); } catch {}
    }
    const srcThumbs = path.join(legacy, 'thumbs');
    const dstThumbs = path.join(cur, 'thumbs');
    if (fs.existsSync(srcThumbs) && !fs.existsSync(dstThumbs)) {
      try {
        fs.mkdirSync(dstThumbs, { recursive: true });
        for (const f of fs.readdirSync(srcThumbs)) {
          try { fs.copyFileSync(path.join(srcThumbs, f), path.join(dstThumbs, f)); } catch {}
        }
      } catch {}
    }
    console.log('migrated user data from the previous app name (snippit-good)');
  } catch (err) {
    console.error('legacy user-data migration failed:', err.message);
  }
}

// capture destination; falls back to the default when the chosen folder is
// gone (unplugged drive, deleted folder, …) so captures never get lost
function resolveSaveDir() {
  let dir = settings.saveDir || defaultSaveDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    dir = defaultSaveDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

// human-readable, collision-free file name: <prefix>-YYYYMMDD-HHMMSS[-n]
function stampName(dir, prefix, ext) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const taken = (name) => (ext ? [ext] : ['mp4', 'webm'])
    .some((x) => fs.existsSync(path.join(dir, `${name}.${x}`)));
  let name = `${prefix}-${stamp}`;
  for (let i = 2; taken(name); i++) name = `${prefix}-${stamp}-${i}`;
  return name;
}

function loadLibrary() {
  try {
    library = JSON.parse(fs.readFileSync(libraryFile(), 'utf8')).filter((it) => it && it.file);
  } catch {
    library = [];
    // one-time migration from the old last-3 snip store
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
      library = meta
        .filter((s) => s && s.file && fs.existsSync(s.file))
        .map((s) => ({ kind: 'image', ...s }));
      if (library.length) saveLibrary();
      try { fs.unlinkSync(metaFile()); } catch {}
    } catch {}
  }
  library = library.filter((it) => {
    try { return fs.existsSync(it.file); } catch { return false; }
  });
}

function saveLibrary() {
  try { fs.writeFileSync(libraryFile(), JSON.stringify(library, null, 2)); } catch (err) {
    console.error('failed to save library index:', err);
  }
}

// thumbnails live in userData so the user's capture folder stays clean
function writeThumb(id, image) {
  try {
    fs.mkdirSync(thumbsDir(), { recursive: true });
    const file = path.join(thumbsDir(), `${id}.jpg`);
    fs.writeFileSync(file, image.resize({ width: 360 }).toJPEG(80));
    return file;
  } catch { return null; }
}

function notifyLibraryChanged() {
  if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('library:changed');
}

/* ---------------- snips bar ---------------- */

function createBar() {
  barWin = new BrowserWindow({
    width: BAR_WIDTH,
    height: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  barWin.setAlwaysOnTop(true, 'status');
  barWin.setContentProtection(true); // keep the bar out of captured snips
  barWin.loadFile(renderer('bar/bar.html'));
  barWin.webContents.on('did-finish-load', () => pushSnipsToBar());
  // a GPU reset or session switch (lock, RDP) can kill the hidden bar's
  // renderer — a transparent window with a dead renderer shows nothing
  barWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('bar renderer gone:', details.reason);
    recreateBar();
  });
  barWin.on('close', (e) => { if (!quitting) { e.preventDefault(); barWin.hide(); } });
}

function recreateBar() {
  if (quitting) return;
  const old = barWin;
  const wasVisible = !!(old && !old.isDestroyed() && old.isVisible());
  barWin = null;
  if (old && !old.isDestroyed()) { try { old.destroy(); } catch {} }
  createBar();
  if (wasVisible) barWin.webContents.once('did-finish-load', () => showBar());
}

function positionBar(height) {
  barHeight = height;
  if (!barWin || barWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  barWin.setBounds({
    x: wa.x + BAR_MARGIN,
    y: wa.y + wa.height - height - BAR_MARGIN,
    width: BAR_WIDTH,
    height,
  });
}

// the bar shows the newest few library items for quick access
function snipPayload() {
  return library.slice(0, MAX_SNIPS).map((s) => {
    let thumb = '';
    try {
      const src = s.thumb || s.poster || (s.kind !== 'video' ? s.file : null);
      if (src && fs.existsSync(src)) {
        const img = nativeImage.createFromPath(src);
        if (!img.isEmpty()) thumb = img.resize({ width: 360 }).toDataURL();
      }
    } catch {}
    return {
      id: s.id,
      kind: s.kind || 'image',
      width: s.width,
      height: s.height,
      durationMs: s.durationMs || 0,
      createdAt: s.createdAt,
      thumb,
    };
  });
}

function pushSnipsToBar(event) {
  if (!barWin || barWin.isDestroyed()) return;
  barWin.webContents.send('snips:changed', {
    snips: snipPayload(),
    shortcut: settings.shortcut,
    pinBar: !!settings.pinBar,
    event: event || null,
  });
  if (library.length === 0) barWin.hide();
}

function showBar() {
  if (!auth.isSignedIn()) return; // nothing shows before login
  if (!barWin || barWin.isDestroyed() || library.length === 0) return;
  if (barWin.webContents.isCrashed()) recreateBar();
  const win = barWin;
  const present = () => {
    if (win !== barWin || win.isDestroyed()) return;
    /* Never trust the stored bounds: display sleep and RDP round-trips
       change the desktop geometry while the bar is hidden, and a window
       stranded off-screen counts as occluded — its renderer stops painting,
       so the bar:resize/positionBar loop that would move it back never runs.
       Repositioning from the main process on every show breaks that cycle. */
    positionBar(barHeight);
    win.setAlwaysOnTop(true, 'status'); // re-assert after session switches
    if (!win.isVisible()) win.showInactive();
    try { win.webContents.invalidate(); } catch {} // repaint a stale surface
    // (re)arm the renderer's auto-hide countdown
    win.webContents.send('bar:visible');
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', present);
  else present();
}

/* ---------------- capture flow ---------------- */

let gdiMode = false; // set when desktopCapturer can't capture screens on this machine

function physicalBounds(display, virtualScreen) {
  let origin;
  if (typeof screen.dipToScreenPoint === 'function') {
    origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
  } else {
    origin = {
      x: Math.round(display.bounds.x * display.scaleFactor),
      y: Math.round(display.bounds.y * display.scaleFactor),
    };
  }
  return {
    x: origin.x - virtualScreen.x,
    y: origin.y - virtualScreen.y,
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
}

async function captureViaDesktopCapturer(displays) {
  const maxW = Math.max(...displays.map((d) => Math.ceil(d.bounds.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.ceil(d.bounds.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
  });
  const result = displays.map((display, i) => {
    const source =
      sources.find((s) => s.display_id === String(display.id)) || sources[i] || sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    return { display, image: source.thumbnail };
  });
  return result.every(Boolean) ? result : null;
}

async function captureViaGdi(displays) {
  const shot = await gdi.captureVirtualScreen();
  const full = nativeImage.createFromPath(shot.file);
  try { fs.unlinkSync(shot.file); } catch {}
  if (full.isEmpty()) throw new Error('gdi capture produced no image');
  const size = full.getSize();
  return displays.map((display) => {
    const r = physicalBounds(display, shot);
    const rect = {
      x: Math.max(0, Math.min(r.x, size.width - 1)),
      y: Math.max(0, Math.min(r.y, size.height - 1)),
    };
    rect.width = Math.max(1, Math.min(r.width, size.width - rect.x));
    rect.height = Math.max(1, Math.min(r.height, size.height - rect.y));
    return { display, image: full.crop(rect) };
  });
}

// -> [{ display, image }] one full-res screenshot per display.
// desktopCapturer (WGC) first with a couple of retries — its first frame can
// be empty right after startup; GDI BitBlt as a last resort for machines
// where WGC screen capture is broken.
async function captureAllDisplays() {
  const displays = screen.getAllDisplays();
  if (!gdiMode) {
    const delays = [0, 120, 200, 350, 550];
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const result = await captureViaDesktopCapturer(displays);
        if (result) return result;
      } catch {}
    }
    gdi.warmUp();
  }
  try {
    const result = await captureViaGdi(displays);
    gdiMode = true; // GDI works here — skip the failing path next time
    return result;
  } catch (err) {
    gdiMode = false;
    throw new Error(`screen capture failed (${err.message})`);
  }
}

/* Overlay windows are created once per display, pre-loaded and kept hidden,
   so the hotkey only has to show them — that's what makes snipping feel
   instant. They are content-protected (excluded from screen capture), which
   lets the dim overlay appear immediately while the clean screenshot is
   taken in parallel behind it. */
const overlayPool = new Map(); // display.id -> BrowserWindow
let pendingSelection = null;   // user finished dragging before the capture landed
let captureSession = 0;

function createOverlayWindow(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: false,
    minimizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  win.setContentProtection(true); // never appears in its own captures
  win.setAlwaysOnTop(true, 'screen-saver');
  // size over the full display (incl. taskbar) while still resizable —
  // Windows clamps non-resizable windows to the work area while sizing
  win.setBounds(display.bounds);
  win.setResizable(false);
  win.loadFile(renderer('overlay/overlay.html'));
  win.webContents.once('did-finish-load', () => {
    // invisible warm-up paint so the first real show composites instantly
    if (win.isDestroyed()) return;
    win.setIgnoreMouseEvents(true);
    win.setOpacity(0);
    win.showInactive();
    setTimeout(() => {
      if (win.isDestroyed()) return;
      if (!overlays.some((o) => o.win === win)) win.hide();
      win.setOpacity(1);
      win.setIgnoreMouseEvents(false);
    }, 120);
  });
  win.on('closed', () => {
    for (const [id, w] of overlayPool) if (w === win) overlayPool.delete(id);
  });
  return win;
}

function ensureOverlayPool() {
  const displays = screen.getAllDisplays();
  const valid = new Set(displays.map((d) => d.id));
  for (const [id, win] of overlayPool) {
    if (!valid.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      overlayPool.delete(id);
    }
  }
  for (const d of displays) {
    const existing = overlayPool.get(d.id);
    if (!existing || existing.isDestroyed()) overlayPool.set(d.id, createOverlayWindow(d));
  }
}

function armOverlay(rec, after) {
  const { win, display } = rec;
  const arm = () => {
    if (!overlays.includes(rec) || win.isDestroyed()) return;
    // bounds are set at creation; only re-do the unlock/size/lock dance if
    // the display has changed since (it's the slow part of showing)
    const b = win.getBounds();
    const db = display.bounds;
    if (b.x !== db.x || b.y !== db.y || b.width !== db.width || b.height !== db.height) {
      win.setResizable(true);
      win.setBounds(db);
      win.setResizable(false);
    }
    win.webContents.send('overlay:arm', { displayId: display.id, mode: snipMode });
    win.show();
    win.focus();
    if (after) after();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', arm);
  else arm();
}

function sendOverlayImage(rec) {
  if (!rec.image || !rec.win || rec.win.isDestroyed()) return;
  rec.win.webContents.send('overlay:image', {
    dataUrl: `data:image/jpeg;base64,${rec.image.toJPEG(82).toString('base64')}`,
  });
}

/* ---- window snapping: hovering a window in the overlay highlights it,
   a plain click selects its full bounds ---- */

// shell/housekeeping windows that must never be snap targets
const SNAP_EXCLUDE_CLASSES = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow', 'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow',
]);

function ownWindowHandles() {
  const own = new Set();
  for (const w of BrowserWindow.getAllWindows()) {
    try { own.add(w.getNativeWindowHandle().readBigUInt64LE(0).toString()); } catch {}
  }
  return own;
}

// enumerate app windows and hand each overlay the ones on its display,
// in z-order, as display-local DIP rects clamped to that display
function sendWindowSnapTargets(session) {
  winEnum.listWindows().then((wins) => {
    if (session !== captureSession || !overlays.length) return;
    const own = ownWindowHandles();
    const targets = [];
    for (const w of wins) {
      if (own.has(w.hwnd) || SNAP_EXCLUDE_CLASSES.has(w.className)) continue;
      let dip;
      try { dip = screen.screenToDipRect(null, w.rect); } catch { continue; }
      targets.push({ ...dip, title: w.title });
      if (targets.length >= 80) break;
    }
    for (const o of overlays) {
      if (!o.win || o.win.isDestroyed()) continue;
      const db = o.display.bounds;
      const local = [];
      for (const t of targets) {
        const x = Math.max(0, t.x - db.x);
        const y = Math.max(0, t.y - db.y);
        const w = Math.min(db.width, t.x + t.width - db.x) - x;
        const h = Math.min(db.height, t.y + t.height - db.y) - y;
        if (w >= 24 && h >= 24) local.push({ x, y, w, h, title: t.title });
      }
      o.win.webContents.send('overlay:windows', local);
    }
  }).catch((err) => console.error('window enumeration failed:', err.message));
}

async function startSnip(mode = 'image') {
  if (capturing || recording) return;
  if (!requireAuth()) return;
  capturing = true;
  snipMode = mode === 'video' ? 'video' : 'image';
  const session = ++captureSession;
  pendingSelection = null;
  try {
    ensureOverlayPool();

    if (gdiMode) {
      if (barWin && barWin.isVisible()) barWin.hide();
      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) settingsWin.hide();
      // GDI BitBlt may not honour content protection — capture first, then show
      await new Promise((r) => setTimeout(r, 120));
      const captures = await captureAllDisplays();
      if (session !== captureSession) return;
      presentOverlays(captures);
      return;
    }

    // fast path: dim the screen NOW, capture behind it in parallel
    overlays = screen.getAllDisplays().map((display) => ({
      win: overlayPool.get(display.id),
      display,
      image: null,
    })).filter((o) => o.win && !o.win.isDestroyed());
    for (const o of overlays) armOverlay(o);
    sendWindowSnapTargets(session);
    globalShortcut.register('Escape', () => cancelSnip());
    // the bar sits under the overlay and is content-protected, so hiding it
    // can happen after the overlay is already up
    if (barWin && barWin.isVisible()) barWin.hide();
    if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) settingsWin.hide();

    captureAllDisplays().then((captures) => {
      if (session !== captureSession) return;
      for (const c of captures) {
        const rec = overlays.find((o) => o.display.id === c.display.id);
        if (rec) {
          rec.image = c.image;
          sendOverlayImage(rec);
        }
      }
      if (pendingSelection) {
        const { displayId, rect } = pendingSelection;
        pendingSelection = null;
        const c = captures.find((x) => x.display.id === displayId);
        if (c) cropAndAdd(c.image, c.display, rect);
      }
    }).catch((err) => {
      console.error('capture failed:', err);
      if (session === captureSession) cancelSnip();
    });
  } catch (err) {
    console.error('snip failed:', err);
    cancelSnip();
  }
}

// arm overlays that already have their image (GDI path + selftest)
function presentOverlays(captures) {
  overlays = captures.map(({ display, image }) => ({
    win: overlayPool.get(display.id),
    display,
    image,
  })).filter((o) => o.win && !o.win.isDestroyed());
  for (const o of overlays) armOverlay(o, () => sendOverlayImage(o));
  if (overlays.length === 0) { cancelSnip(); return; }
  sendWindowSnapTargets(captureSession);
  globalShortcut.register('Escape', () => cancelSnip());
}

function hideOverlays(opts = {}) {
  globalShortcut.unregister('Escape');
  for (const o of overlays) {
    if (o.win && !o.win.isDestroyed()) {
      o.win.hide();
      o.win.webContents.send('overlay:reset'); // drop the big frame from memory
    }
  }
  overlays = [];
  capturing = false;
  if (!opts.skipBar) showBar();
}

// the user changed snip/record mode on one overlay — sync every display
function setSnipMode(mode) {
  snipMode = mode === 'video' ? 'video' : 'image';
  for (const o of overlays) {
    if (o.win && !o.win.isDestroyed()) o.win.webContents.send('overlay:mode', snipMode);
  }
}

function cancelSnip() {
  pendingSelection = null;
  hideOverlays();
}

function cropAndAdd(image, display, rect) {
  const size = image.getSize();
  const sx = size.width / display.bounds.width;
  const sy = size.height / display.bounds.height;
  const crop = {
    x: Math.max(0, Math.round(rect.x * sx)),
    y: Math.max(0, Math.round(rect.y * sy)),
    width: Math.round(rect.w * sx),
    height: Math.round(rect.h * sy),
  };
  crop.width = Math.min(crop.width, size.width - crop.x);
  crop.height = Math.min(crop.height, size.height - crop.y);
  if (crop.width < 2 || crop.height < 2) return;
  addSnip(image.crop(crop));
}

function finalizeCapture(displayId, rect) {
  const rec = overlays.find((o) => o.display.id === displayId);
  if (!rec) return cancelSnip();
  if (rec.image) {
    const { image, display } = rec;
    hideOverlays();
    cropAndAdd(image, display, rect);
  } else {
    // capture still in flight — remember the selection, crop when it lands
    pendingSelection = { displayId, rect };
    hideOverlays();
  }
}

function addSnip(image) {
  const id = newId();
  let file;
  try {
    const dir = resolveSaveDir();
    file = path.join(dir, `${stampName(dir, 'snip', 'png')}.png`);
    fs.writeFileSync(file, image.toPNG());
  } catch (err) {
    console.error('failed to save snip:', err);
    return;
  }
  const { width, height } = image.getSize();
  library.unshift({
    id, kind: 'image', file, thumb: writeThumb(id, image), width, height, createdAt: Date.now(),
  });
  saveLibrary();

  let event = { type: 'captured', id };
  if (settings.autoCopy) {
    clipboard.writeImage(image);
    event = { type: 'captured-copied', id };
  }
  pushSnipsToBar(event);
  showBar();
  notifyLibraryChanged();
}

// explicit delete: removes the capture from the library AND from disk
function removeSnip(id) {
  const idx = library.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const it = library[idx];
  for (const f of [it.file, it.poster, it.thumb]) {
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }
  library.splice(idx, 1);
  saveLibrary();
  pushSnipsToBar();
  notifyLibraryChanged();
}

/* ---------------- screen recording ---------------- */
/* Record mode reuses the snip overlay for region selection, then records that
   region: a hidden <video> of the display's stream is cropped through a canvas
   into a MediaRecorder living in the control-bar window (see record/hud.js).
   Two always-on-top HUD windows appear while recording — a click-through red
   frame sized just OUTSIDE the region (so it can't leak into the video even
   where content protection is ignored) and the control bar. */

const REC_FRAME_PAD = 3; // red border thickness; sits outside the recorded region
const REC_BAR = { width: 392, height: 52, gap: 10 };

let recording = null;
// { id, display, rect, source, frameWin, barWin, file, poster, stream, meta,
//   status: 'armed'|'starting'|'recording'|'paused'|'stopping', startedAt,
//   finalizing, safetyTimer, autoStopTimer }
// 'armed': region picked but not recording yet — the frame is adjustable and
// the HUD shows a Record button (settings.armBeforeRecord)

// getDisplayMedia from the recorder window resolves to the screen we picked;
// anything else is denied
function initDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const rec = recording;
    let allowed = false;
    try {
      allowed = !!(rec && rec.source && rec.barWin && !rec.barWin.isDestroyed()
        && request.frame === rec.barWin.webContents.mainFrame);
    } catch { allowed = false; }
    try {
      // loopback is always granted when asked for — the recorder keeps the
      // track around so system audio can be muted/unmuted live; the settings
      // toggle only decides whether it STARTS muted
      if (!allowed) callback(null);
      else if (request.audioRequested) callback({ video: rec.source, audio: 'loopback' });
      else callback({ video: rec.source });
    } catch (err) {
      console.error('display media handler:', err.message);
    }
  });
}

async function findScreenSource(display) {
  const displays = screen.getAllDisplays();
  const idx = Math.max(0, displays.findIndex((d) => d.id === display.id));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  if (!sources.length) throw new Error('no screens available to record');
  // display_id can be empty on some machines — fall back to matching by index
  return sources.find((s) => s.display_id === String(display.id)) || sources[idx] || sources[0];
}


// control bar goes under the region, above it when there's no room, and as a
// last resort inside its bottom edge
function recBarBounds(display, rect) {
  const wa = display.workArea;
  const { width: w, height: h, gap } = REC_BAR;
  let x = display.bounds.x + rect.x + rect.w / 2 - w / 2;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  let y = display.bounds.y + rect.y + rect.h + REC_FRAME_PAD + gap;
  if (y + h > wa.y + wa.height - 8) {
    y = display.bounds.y + rect.y - REC_FRAME_PAD - gap - h;
    if (y < wa.y + 8) y = display.bounds.y + rect.y + rect.h - h - 14;
  }
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

function makeHudWindow(bounds, opts = {}) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    movable: !!opts.movable,
    minimizable: false,
    maximizable: false,
    focusable: false, // never steal focus from the app being recorded
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: opts.preload
      ? { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
      : { contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // keep the HUD out of the recording where the OS honours it
  // Windows clamps non-resizable windows to the (primary) work area while
  // sizing, which cut the full-display frame off on taller side monitors —
  // same dance as the overlay pool: size first, lock afterwards
  win.setBounds(bounds);
  win.setResizable(false);
  return win;
}

function finalizeRecordSelection(displayId, rect) {
  const rec = overlays.find((o) => o.display.id === displayId);
  const display = rec ? rec.display
    : screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  pendingSelection = null;
  hideOverlays({ skipBar: true }); // popping the bar under a starting recording would be noise
  startRecording(display, rect);
}

async function startRecording(display, rect) {
  if (recording || capturing) return;
  if (!requireAuth()) return;
  rect = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  };
  rect.w = Math.min(rect.w, display.bounds.width - rect.x);
  rect.h = Math.min(rect.h, display.bounds.height - rect.y);
  if (rect.w < 8 || rect.h < 8) { showBar(); return; }

  const id = newId();
  fs.mkdirSync(thumbsDir(), { recursive: true });
  recording = {
    id, display, rect,
    source: null, frameWin: null, barWin: null,
    file: null, poster: path.join(thumbsDir(), `${id}.jpg`),
    stream: null, meta: null, status: 'starting',
    startedAt: 0, finalizing: false, safetyTimer: null, autoStopTimer: null,
  };
  refreshTray();
  try {
    recording.source = await findScreenSource(display);
  } catch (err) {
    failRecording(`Could not find a screen to record (${err.message}).`);
    return;
  }
  if (!recording || recording.id !== id) return; // cancelled while looking up the source

  const armed = !!settings.armBeforeRecord;
  recording.status = armed ? 'armed' : 'starting';
  refreshTray();

  // the frame covers the whole display: armed mode needs the full surface to
  // host resize handles anywhere while staying click-through in between
  const frameWin = makeHudWindow({ ...display.bounds }, { preload: true });
  frameWin.setIgnoreMouseEvents(true, armed ? { forward: true } : undefined);
  frameWin.loadFile(renderer('record/frame.html'));
  frameWin.webContents.once('did-finish-load', () => {
    if (frameWin.isDestroyed() || !recording || recording.frameWin !== frameWin) return;
    frameWin.webContents.send('frame:setup', { rect: recording.rect, locked: !armed });
    frameWin.showInactive();
  });

  const barWin = makeHudWindow(recBarBounds(display, rect), { movable: true, preload: true });
  barWin.loadFile(renderer('record/hud.html'));
  barWin.webContents.once('did-finish-load', () => {
    if (barWin.isDestroyed() || !recording || recording.barWin !== barWin) return;
    barWin.showInactive();
    barWin.moveTop(); // above the full-display frame window
    if (armed) {
      barWin.webContents.send('rec:arm', {
        audio: !!settings.recordAudio,
        mic: !!settings.recordMic,
      });
    } else {
      barWin.webContents.send('rec:init', recInitPayload(recording));
    }
  });
  // recorder window died mid-recording — keep whatever already reached the disk
  barWin.on('closed', () => {
    if (recording && recording.barWin === barWin && !recording.finalizing) {
      finalizeRecording({
        durationMs: recording.startedAt ? Date.now() - recording.startedAt : 0,
        discard: !recording.startedAt, // nothing was ever written — no error balloon
      });
    }
  });
  barWin.webContents.on('render-process-gone', () => {
    try { barWin.destroy(); } catch {}
  });

  recording.frameWin = frameWin;
  recording.barWin = barWin;
}

function recInitPayload(rec) {
  return {
    rect: rec.rect,
    displayBounds: rec.display.bounds,
    fps: RECORD_FPS,
    audio: !!settings.recordAudio,
    mic: !!settings.recordMic,
    micDeviceId: settings.micDeviceId || '',
    audioBitrate: AUDIO_BITRATES[settings.audioQuality] || AUDIO_BITRATES.standard,
    sourceId: rec.source.id,
  };
}

// armed -> actually recording: lock the frame and spin up the recorder
function beginArmedRecording() {
  const rec = recording;
  if (!rec || rec.finalizing || rec.status !== 'armed') return;
  if (!rec.barWin || rec.barWin.isDestroyed()) { stopRecording(true); return; }
  rec.status = 'starting';
  refreshTray();
  if (rec.frameWin && !rec.frameWin.isDestroyed()) {
    rec.frameWin.setIgnoreMouseEvents(true);
    rec.frameWin.webContents.send('frame:lock');
  }
  rec.barWin.webContents.send('rec:init', recInitPayload(rec));
}

function cleanupRecordingWindows(rec) {
  for (const w of [rec.frameWin, rec.barWin]) {
    if (w && !w.isDestroyed()) { try { w.destroy(); } catch {} }
  }
}

function deleteRecordingFiles(rec) {
  for (const f of [rec.file, rec.poster]) {
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }
}

function notifyRecordingProblem(title, content) {
  console.error(`${title}: ${content}`);
  try { tray.displayBalloon({ title, content, iconType: 'error' }); } catch {}
}

function failRecording(message) {
  const rec = recording;
  if (!rec || rec.finalizing) return;
  rec.finalizing = true;
  recording = null;
  clearTimeout(rec.safetyTimer);
  clearTimeout(rec.autoStopTimer);
  cleanupRecordingWindows(rec);
  if (rec.stream) { try { rec.stream.destroy(); } catch {} }
  deleteRecordingFiles(rec);
  refreshTray();
  notifyRecordingProblem('Recording failed', message);
  showBar();
}

function stopRecording(discard = false) {
  const rec = recording;
  if (!rec || rec.finalizing || rec.status === 'stopping') return;
  if (rec.status === 'starting' || rec.status === 'armed') {
    // nothing has been recorded yet (the stream only opens once the recorder
    // reports rec:started) — just abandon the attempt
    rec.finalizing = true;
    recording = null;
    cleanupRecordingWindows(rec);
    deleteRecordingFiles(rec);
    refreshTray();
    showBar();
    return;
  }
  rec.status = 'stopping';
  refreshTray();
  if (rec.barWin && !rec.barWin.isDestroyed()) {
    rec.barWin.webContents.send('rec:stop', { discard });
    // if the recorder never answers, salvage what's on disk
    rec.safetyTimer = setTimeout(() => {
      if (recording === rec && !rec.finalizing) {
        finalizeRecording({ durationMs: rec.startedAt ? Date.now() - rec.startedAt : 0, discard });
      }
    }, 5000);
  } else {
    finalizeRecording({ durationMs: rec.startedAt ? Date.now() - rec.startedAt : 0, discard });
  }
}

async function finalizeRecording({ durationMs = 0, discard = false, videoFrames = -1 } = {}) {
  const rec = recording;
  if (!rec || rec.finalizing) return;
  rec.finalizing = true;
  recording = null;
  clearTimeout(rec.safetyTimer);
  clearTimeout(rec.autoStopTimer);
  cleanupRecordingWindows(rec);
  refreshTray();
  if (rec.stream) {
    await new Promise((resolve) => { try { rec.stream.end(resolve); } catch { resolve(); } });
  }
  let fileOk = false;
  try { fileOk = !!rec.file && fs.statSync(rec.file).size > 1024; } catch {}
  if (discard || !fileOk) {
    deleteRecordingFiles(rec);
    if (!discard) notifyRecordingProblem('Recording failed', 'No video data was captured.');
    showBar();
    if (quitting) app.quit();
    return;
  }
  if (videoFrames === 0) {
    // stream opened but never delivered frames (broken capture API) — the file
    // is valid, just black; tell the user instead of silently shipping it
    notifyRecordingProblem('Recording may be blank', 'The screen stream delivered no frames on this machine.');
  }
  addVideoSnip(rec, Math.max(0, Math.round(durationMs)));
  if (quitting) app.quit();
}

function addVideoSnip(rec, durationMs) {
  const meta = rec.meta || {};
  const poster = fs.existsSync(rec.poster) ? rec.poster : null;
  library.unshift({
    id: rec.id,
    kind: 'video',
    file: rec.file,
    poster,
    thumb: poster,
    width: meta.width || rec.rect.w,
    height: meta.height || rec.rect.h,
    durationMs,
    createdAt: Date.now(),
  });
  saveLibrary();
  let event = { type: 'captured', id: rec.id };
  if (settings.autoCopy) {
    copyFileToClipboard(rec.file);
    event = { type: 'captured-copied', id: rec.id };
  }
  pushSnipsToBar(event);
  showBar();
  notifyLibraryChanged();
}

/* a video can't go on the clipboard as pixels — copy it as a *file* drop list
   (CF_HDROP), which pastes into Explorer, Teams, Slack, mail, … PowerShell 5.1's
   Set-Clipboard does that natively. */
function copyFileToClipboard(file) {
  return new Promise((resolve) => {
    try {
      const script = `Set-Clipboard -LiteralPath '${file.replace(/'/g, "''")}'`;
      const ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { stdio: 'ignore', windowsHide: true });
      ps.on('exit', (code) => resolve(code === 0));
      ps.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

/* recorder window -> main */

const fromRecorder = (e) => !!(recording && recording.barWin
  && !recording.barWin.isDestroyed() && e.sender === recording.barWin.webContents);

ipcMain.on('rec:started', (e, meta) => {
  if (!fromRecorder(e)) return;
  const rec = recording;
  rec.meta = meta || {};
  const ext = rec.meta.ext === 'mp4' ? 'mp4' : 'webm';
  try {
    const dir = resolveSaveDir();
    rec.file = path.join(dir, `${stampName(dir, 'rec', ext)}.${ext}`);
    rec.stream = fs.createWriteStream(rec.file);
  } catch (err) {
    failRecording(`Could not write the video file (${err.message}).`);
    return;
  }
  rec.stream.on('error', (err) => failRecording(`Could not write the video file (${err.message}).`));
  rec.status = 'recording';
  rec.startedAt = Date.now();
  rec.autoStopTimer = setTimeout(() => stopRecording(false), MAX_RECORD_MS);
  refreshTray();
});

ipcMain.on('rec:chunk', (e, chunk) => {
  if (!fromRecorder(e)) return;
  const rec = recording;
  if (rec.stream && !rec.stream.destroyed) {
    try { rec.stream.write(Buffer.from(chunk)); } catch {}
  }
});

ipcMain.on('rec:poster', (e, dataUrl) => {
  if (!fromRecorder(e)) return;
  try {
    const b64 = String(dataUrl).split(',')[1] || '';
    if (b64) fs.writeFileSync(recording.poster, Buffer.from(b64, 'base64'));
  } catch {}
});

ipcMain.on('rec:status', (e, status) => {
  if (!fromRecorder(e)) return;
  if (status === 'paused' || status === 'recording') {
    recording.status = status;
    refreshTray();
  }
});

ipcMain.on('rec:done', (e, payload) => {
  if (!fromRecorder(e)) return;
  finalizeRecording(payload || {});
});

ipcMain.on('rec:error', (e, message) => {
  if (!fromRecorder(e)) return;
  failRecording(String(message || 'Unknown recorder error.'));
});

ipcMain.on('rec:record', (e) => {
  if (!fromRecorder(e)) return;
  beginArmedRecording();
});

/* region frame window -> main (armed adjustments) */

const fromFrame = (e) => !!(recording && recording.frameWin
  && !recording.frameWin.isDestroyed() && e.sender === recording.frameWin.webContents);

ipcMain.on('frame:set-ignore', (e, ignore) => {
  if (!fromFrame(e) || recording.status !== 'armed') return;
  if (ignore) recording.frameWin.setIgnoreMouseEvents(true, { forward: true });
  else recording.frameWin.setIgnoreMouseEvents(false);
});

ipcMain.on('frame:rect', (e, r) => {
  if (!fromFrame(e) || recording.status !== 'armed' || !r) return;
  const b = recording.display.bounds;
  const rect = {
    x: Math.max(0, Math.min(Math.round(r.x) || 0, b.width - 8)),
    y: Math.max(0, Math.min(Math.round(r.y) || 0, b.height - 8)),
    w: Math.max(8, Math.round(r.w) || 0),
    h: Math.max(8, Math.round(r.h) || 0),
  };
  rect.w = Math.min(rect.w, b.width - rect.x);
  rect.h = Math.min(rect.h, b.height - rect.y);
  recording.rect = rect;
  if (recording.barWin && !recording.barWin.isDestroyed()) {
    recording.barWin.setBounds(recBarBounds(recording.display, rect));
  }
});

/* ---------------- library window (editor + history + playback) ---------------- */

function openLibrary(id) {
  if (!requireAuth()) return;
  if (libraryWin && !libraryWin.isDestroyed()) {
    libraryWin.show();
    libraryWin.focus();
    if (id) libraryWin.webContents.send('library:select', id);
    return;
  }
  libraryWin = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#15161b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#15161b', symbolColor: '#a7adba', height: 42 },
    icon: asset('icon.png'),
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  libraryWin.loadFile(renderer('editor/editor.html'), { query: { id: id || '' } });
  libraryWin.once('ready-to-show', () => libraryWin.show());
  libraryWin.on('closed', () => { libraryWin = null; });
}

/* ---------------- auth gate (WorkOS / Nivalo) ---------------- */

let loginWin = null;

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.show();
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#15161b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#15161b', symbolColor: '#a7adba', height: 40 },
    icon: asset('icon.png'),
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  loginWin.loadFile(renderer('login/login.html'));
  loginWin.once('ready-to-show', () => loginWin.show());
  loginWin.on('closed', () => { loginWin = null; auth.cancelLogin(); });
}

// every user-facing entry point funnels through this: signed out -> login window
function requireAuth() {
  if (auth.isSignedIn()) return true;
  openLogin();
  return false;
}

let bootBarPending = false; // show the recents bar once the boot session verifies

function broadcastAuthState(state) {
  for (const win of [loginWin, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('auth:state', state);
  }
  refreshTray();
  if (state.status === 'signed-in' && loginWin && !loginWin.isDestroyed()) {
    loginWin.close();
  }
  if (state.status === 'signed-in' && bootBarPending) {
    bootBarPending = false;
    setTimeout(showBar, 120);
  }
  if (state.status === 'signed-out') {
    // lock visible surfaces; an in-flight recording is finalized, not discarded
    if (recording && !recording.finalizing) stopRecording(false);
    if (capturing) cancelSnip();
    if (libraryWin && !libraryWin.isDestroyed()) libraryWin.close();
    if (barWin && !barWin.isDestroyed()) barWin.hide();
  }
}

ipcMain.handle('auth:get-state', () => auth.getState());
ipcMain.handle('auth:login', async () => {
  try {
    await auth.beginLogin();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Sign-in failed.' };
  }
});
ipcMain.on('auth:cancel-login', () => auth.cancelLogin());
ipcMain.on('auth:logout', () => auth.signOut());

/* ---------------- settings window ---------------- */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 760,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#15161b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#15161b', symbolColor: '#a7adba', height: 42 },
    icon: asset('icon.png'),
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(renderer('settings/settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
}

/* ---------------- shortcuts ---------------- */

// both hotkeys stop an active recording (or fire an armed one); with the
// overlay already open they just flip its snip/record mode. 'default'
// resolves to the user's configured default capture mode at press time.
function hotkeyPressed(mode) {
  const m = mode === 'default'
    ? (settings.defaultMode === 'video' ? 'video' : 'image')
    : mode;
  if (recording) {
    if (recording.status === 'armed') beginArmedRecording();
    else stopRecording(false);
    return;
  }
  if (!requireAuth()) return;
  if (capturing) { setSnipMode(m); return; }
  startSnip(m);
}

function regHotkey(accel, mode) {
  if (!accel) return false;
  try {
    return globalShortcut.register(accel, () => hotkeyPressed(mode));
  } catch { return false; }
}

// swap both hotkeys to a new pair; rolls back to the current pair on failure.
// Returns null on success, otherwise a user-facing error.
function bindHotkeys(shortcut, recordShortcut) {
  globalShortcut.unregister(settings.shortcut);
  if (settings.recordShortcut) globalShortcut.unregister(settings.recordShortcut);
  const okSnip = regHotkey(shortcut, 'default');
  const okRec = !recordShortcut || regHotkey(recordShortcut, 'video');
  if (okSnip && okRec) return null;
  if (okSnip) globalShortcut.unregister(shortcut);
  if (okRec && recordShortcut) globalShortcut.unregister(recordShortcut);
  regHotkey(settings.shortcut, 'default');
  if (settings.recordShortcut) regHotkey(settings.recordShortcut, 'video');
  const bad = okSnip ? recordShortcut : shortcut;
  return `${bad} could not be registered — it may be in use.`;
}

/* ---------------- auto update (GitHub releases) ---------------- */

let updateReadyVersion = null;
let updater = null;
let updateStartTimer = null;
let updateIntervalTimer = null;
// status: idle | checking | downloading | ready | uptodate | error | dev
let updateState = { status: 'idle', version: null, progress: 0, error: null };

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('update:state', updateState);
  }
}

function initUpdater() {
  if (updater) return updater;
  if (!app.isPackaged) return null; // dev runs have no update metadata
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch { return null; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // updates apply on normal quit too
  updater.on('checking-for-update', () => setUpdateState({ status: 'checking', error: null }));
  updater.on('update-available', (info) =>
    setUpdateState({ status: 'downloading', version: info.version, progress: 0 }));
  updater.on('update-not-available', () =>
    setUpdateState({ status: 'uptodate', version: null, progress: 0 }));
  updater.on('download-progress', (p) =>
    setUpdateState({ status: 'downloading', progress: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => {
    updateReadyVersion = info.version;
    setUpdateState({ status: 'ready', version: info.version, progress: 100 });
    if (tray && tray.rebuildMenu) tray.rebuildMenu();
    tray?.setToolTip(`snipit-good — update v${info.version} ready, restart to apply`);
  });
  updater.on('error', (err) => {
    console.error('auto-update:', err.message);
    setUpdateState({ status: 'error', error: err.message });
  });
  app.applyUpdate = () => { quitting = true; updater.quitAndInstall(); };
  return updater;
}

function checkForUpdates() {
  const u = initUpdater();
  if (!u) { setUpdateState({ status: 'dev' }); return; }
  if (updateState.status === 'downloading' || updateState.status === 'ready') return;
  u.checkForUpdates().catch((err) => setUpdateState({ status: 'error', error: err.message }));
}

// honours the autoUpdate setting: check shortly after start, then periodically
function applyAutoUpdateSetting() {
  clearTimeout(updateStartTimer);
  clearInterval(updateIntervalTimer);
  if (!settings.autoUpdate) return;
  updateStartTimer = setTimeout(checkForUpdates, 15 * 1000); // don't compete with startup
  updateIntervalTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
}

/* ---------------- tray ---------------- */

function createTray() {
  tray = new Tray(asset('tray.png'));
  const rebuild = () => {
    const authState = auth.getState();
    const signedIn = authState.status === 'signed-in';
    const armed = recording && recording.status === 'armed';
    tray.setToolTip(!signedIn
      ? 'snipit-good — sign in to start capturing'
      : armed
        ? 'snipit-good — adjust the area, then press Record'
        : recording
          ? 'snipit-good — recording… (press the shortcut to stop)'
          : 'snipit-good — quick snips');
    const items = [];
    if (!signedIn) {
      items.push({ label: 'Sign in with mtnauth.com…', click: () => openLogin() });
      items.push({ type: 'separator' });
    } else if (authState.user && authState.user.email) {
      items.push({ label: authState.user.email, enabled: false });
      items.push({ type: 'separator' });
    }
    if (armed) {
      items.push({ label: 'Start recording', click: () => beginArmedRecording() });
      items.push({ label: 'Cancel', click: () => stopRecording(true) });
      items.push({ type: 'separator' });
    } else if (recording) {
      items.push({ label: 'Stop recording — save', click: () => stopRecording(false) });
      items.push({ label: 'Cancel recording — discard', click: () => stopRecording(true) });
      items.push({ type: 'separator' });
    }
    items.push({
      label: `New snip\t${settings.shortcut}`,
      enabled: signedIn && !recording,
      click: () => { if (!recording) startSnip('image'); },
    });
    items.push({
      label: `New recording${settings.recordShortcut ? `\t${settings.recordShortcut}` : ''}`,
      enabled: signedIn && !recording,
      click: () => { if (!recording) startSnip('video'); },
    });
    items.push({
      label: 'Show recent snips',
      enabled: signedIn,
      click: () => { if (auth.isSignedIn() && library.length) showBar(); },
    });
    items.push({ label: 'Library — all captures', enabled: signedIn, click: () => openLibrary() });
    items.push({ label: 'Settings…', click: () => openSettings() });
    items.push({ label: 'Check for updates…', click: () => { openSettings(); checkForUpdates(); } });
    if (updateReadyVersion) {
      items.push({ type: 'separator' });
      items.push({
        label: `Restart to update to v${updateReadyVersion}`,
        click: () => app.applyUpdate && app.applyUpdate(),
      });
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Quit snipit-good', click: () => { quitting = true; app.quit(); } });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  rebuild();
  tray.on('double-click', () => hotkeyPressed('default'));
  tray.rebuildMenu = rebuild;
}

function refreshTray() {
  if (tray && tray.rebuildMenu) tray.rebuildMenu();
}

/* ---------------- ipc ---------------- */

ipcMain.on('overlay:select', (_e, { displayId, rect, mode }) => {
  if (mode === 'video') finalizeRecordSelection(displayId, rect);
  else finalizeCapture(displayId, rect);
});
ipcMain.on('overlay:cancel', () => cancelSnip());
ipcMain.on('overlay:mode', (_e, mode) => setSnipMode(mode));

ipcMain.on('bar:resize', (_e, height) => {
  positionBar(Math.max(60, Math.min(640, Math.round(height))));
});
ipcMain.on('bar:hide', () => barWin && barWin.hide());
ipcMain.on('snip:new', () => startSnip('image'));
ipcMain.on('snip:edit', (_e, id) => openLibrary(id));
ipcMain.on('snip:remove', (_e, id) => removeSnip(id));
ipcMain.on('settings:open', () => openSettings());
ipcMain.on('video:play', (_e, id) => openLibrary(id));
ipcMain.on('library:open', () => openLibrary());

ipcMain.handle('snip:copy', (_e, id) => {
  const snip = library.find((s) => s.id === id);
  if (!snip) return false;
  if (snip.kind === 'video') return copyFileToClipboard(snip.file);
  try {
    clipboard.writeImage(nativeImage.createFromPath(snip.file));
    return true;
  } catch { return false; }
});

/* --- library window api --- */

ipcMain.handle('library:list', () => {
  // prune entries whose files were deleted outside the app
  const alive = library.filter((it) => {
    try { return fs.existsSync(it.file); } catch { return false; }
  });
  if (alive.length !== library.length) {
    library = alive;
    saveLibrary();
    pushSnipsToBar();
  }
  // backfill thumbnails for items migrated from the pre-library store
  let thumbed = false;
  for (const it of library) {
    if (!it.thumb && it.kind !== 'video') {
      try {
        const img = nativeImage.createFromPath(it.file);
        if (!img.isEmpty()) { it.thumb = writeThumb(it.id, img); thumbed = true; }
      } catch {}
    }
  }
  if (thumbed) saveLibrary();
  return library.map((it) => {
    const t = it.thumb || it.poster || (it.kind !== 'video' ? it.file : null);
    return {
      id: it.id,
      kind: it.kind || 'image',
      width: it.width,
      height: it.height,
      durationMs: it.durationMs || 0,
      createdAt: it.createdAt,
      parentId: it.parentId || null,
      fileName: path.basename(it.file),
      thumbUrl: t && fs.existsSync(t) ? pathToFileURL(t).href : '',
    };
  });
});

ipcMain.handle('library:get-item', (_e, id) => {
  const it = library.find((s) => s.id === id);
  if (!it || !fs.existsSync(it.file)) return null;
  const base = {
    id: it.id,
    kind: it.kind || 'image',
    width: it.width,
    height: it.height,
    durationMs: it.durationMs || 0,
    createdAt: it.createdAt,
    parentId: it.parentId || null,
    fileName: path.basename(it.file),
  };
  if (it.kind === 'video') return { ...base, fileUrl: pathToFileURL(it.file).href };
  // a variant with stored ops reopens as parent image + replayed annotations,
  // so it stays fully editable; if the parent is gone, fall back to the
  // baked-in pixels
  if (it.ops && it.parentId) {
    const parent = library.find((s) => s.id === it.parentId);
    if (parent && parent.kind !== 'video' && fs.existsSync(parent.file)) {
      return { ...base, dataUrl: nativeImage.createFromPath(parent.file).toDataURL(), ops: it.ops };
    }
  }
  return { ...base, dataUrl: nativeImage.createFromPath(it.file).toDataURL(), ops: null };
});

// "save to library": the annotated result becomes a NEW item; the original is
// never touched. Ops are stored so the variant can be re-edited later.
ipcMain.handle('library:add-variant', (_e, payload) => {
  const { parentId, dataUrl, ops } = payload || {};
  const img = nativeImage.createFromDataURL(String(dataUrl || ''));
  if (img.isEmpty()) return null;
  const parent = library.find((s) => s.id === parentId && s.kind !== 'video');
  const id = newId();
  let file;
  try {
    const dir = resolveSaveDir();
    file = path.join(dir, `${stampName(dir, 'snip-edit', 'png')}.png`);
    fs.writeFileSync(file, img.toPNG());
  } catch (err) {
    console.error('failed to save variant:', err);
    return null;
  }
  let keptOps = null;
  try {
    if (parent && Array.isArray(ops) && ops.length && JSON.stringify(ops).length < 500000) keptOps = ops;
  } catch {}
  const { width, height } = img.getSize();
  library.unshift({
    id, kind: 'image', file, thumb: writeThumb(id, img), width, height,
    createdAt: Date.now(), parentId: parent ? parent.id : null, ops: keptOps,
  });
  saveLibrary();
  pushSnipsToBar();
  notifyLibraryChanged();
  return id;
});

ipcMain.on('library:show-in-folder', (_e, id) => {
  const it = library.find((s) => s.id === id);
  if (it && fs.existsSync(it.file)) shell.showItemInFolder(it.file);
});

ipcMain.handle('video:save', async (e, id) => {
  const snip = library.find((s) => s.id === id && s.kind === 'video');
  if (!snip || !fs.existsSync(snip.file)) return false;
  const ext = path.extname(snip.file).slice(1) || 'webm';
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save recording',
    defaultPath: path.join(app.getPath('videos'), path.basename(snip.file)),
    filters: [{ name: `${ext.toUpperCase()} video`, extensions: [ext] }],
  });
  if (canceled || !filePath) return false;
  try {
    fs.copyFileSync(snip.file, filePath);
    return true;
  } catch { return false; }
});

/* --- share links (snipit-good.io) --- */

/* Uploads a capture and puts the share URL on the clipboard. Accepts either
   { id } (a library item's file, used for videos and quick shares) or
   { dataUrl, fileName } (the editor's annotated canvas). */
async function createShareFromPayload(payload, sender) {
  if (!auth.isSignedIn()) return { ok: false, error: 'Sign in with mtnauth.com first.' };
  const p = payload || {};
  let filePath;
  let fileName;
  let tempFile = null;
  if (p.dataUrl) {
    const img = nativeImage.createFromDataURL(String(p.dataUrl));
    if (img.isEmpty()) return { ok: false, error: 'Nothing to share.' };
    tempFile = path.join(app.getPath('temp'), `snipit-share-${Date.now()}.png`);
    try { fs.writeFileSync(tempFile, img.toPNG()); } catch (err) {
      return { ok: false, error: `Could not stage the image (${err.message}).` };
    }
    filePath = tempFile;
    fileName = String(p.fileName || 'snip.png');
  } else {
    const it = library.find((s) => s.id === p.id);
    if (!it || !fs.existsSync(it.file)) return { ok: false, error: 'That capture is no longer on disk.' };
    filePath = it.file;
    fileName = path.basename(it.file);
  }
  try {
    let lastPct = -1;
    const result = await share.createShare({
      filePath,
      fileName,
      expiresInDays: Number(p.expiresInDays) || null,
      password: typeof p.password === 'string' && p.password ? p.password : null,
      maxViews: Number(p.maxViews) || null,
    }, (frac) => {
      const pct = Math.round(frac * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      if (sender && !sender.isDestroyed()) sender.send('share:progress', { pct });
    });
    clipboard.writeText(result.url);
    return { ok: true, url: result.url, share: result.share };
  } catch (err) {
    return { ok: false, error: err.message || 'Share failed.' };
  } finally {
    if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
  }
}

ipcMain.handle('share:create', (e, payload) => createShareFromPayload(payload, e.sender));

ipcMain.handle('share:list', async () => {
  if (!auth.isSignedIn()) return { ok: false, error: 'Sign in to see your share links.' };
  try { return { ok: true, shares: await share.listShares() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('share:revoke', async (_e, id) => {
  if (!auth.isSignedIn()) return { ok: false, error: 'Sign in first.' };
  try { await share.revokeShare(String(id)); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('share:copy-link', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    clipboard.writeText(url);
    return true;
  }
  return false;
});

/* --- storage folder --- */

ipcMain.handle('settings:pick-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where captures are stored',
    defaultPath: resolveSaveDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!canceled && filePaths && filePaths[0]) {
    settings.saveDir = filePaths[0];
    saveSettings();
  }
  return settings;
});
ipcMain.on('settings:open-folder', () => { shell.openPath(resolveSaveDir()); });

ipcMain.handle('image:copy', (_e, dataUrl) => {
  try {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    return true;
  } catch { return false; }
});

ipcMain.handle('image:save', async (e, { dataUrl, name }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save snip',
    defaultPath: path.join(app.getPath('pictures'), name || 'snip.png'),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return false;
  try {
    fs.writeFileSync(filePath, nativeImage.createFromDataURL(dataUrl).toPNG());
    return true;
  } catch { return false; }
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('update:get-state', () => ({
  ...(!app.isPackaged && updateState.status === 'idle' ? { ...updateState, status: 'dev' } : updateState),
  currentVersion: app.getVersion(),
}));
ipcMain.on('update:check', () => checkForUpdates());
ipcMain.on('update:install', () => { if (updateReadyVersion && app.applyUpdate) app.applyUpdate(); });
ipcMain.on('open-releases-page', () =>
  shell.openExternal('https://github.com/cwbrandsdal/snipit-good/releases'));
ipcMain.handle('settings:set', (_e, patch) => {
  const next = { ...settings, ...patch };
  const shortcutsChanged = next.shortcut !== settings.shortcut
    || next.recordShortcut !== settings.recordShortcut;
  if (shortcutsChanged) {
    if (next.recordShortcut && next.recordShortcut === next.shortcut) {
      return { ok: false, error: 'Snip and recording shortcuts must be different.', settings };
    }
    const error = bindHotkeys(next.shortcut, next.recordShortcut);
    if (error) return { ok: false, error, settings };
  }
  const autoUpdateChanged = next.autoUpdate !== settings.autoUpdate;
  settings = next;
  saveSettings();
  refreshTray();
  if (autoUpdateChanged) applyAutoUpdateSetting();
  pushSnipsToBar();
  return { ok: true, settings };
});

/* ---------------- self test (dev only) ---------------- */
/* Drives the whole pipeline with synthetic input and screenshots each window
   to .selftest/ so visual output can be reviewed without manual clicking. */
async function runSelfTest() {
  const outDir = path.join(__dirname, '..', '..', '.selftest');
  fs.mkdirSync(outDir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shoot = async (win, name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
  };
  // colourful test card so UI checks don't depend on live screen capture,
  // which is unreliable in remote sessions
  const makeTestImage = (w, h) => {
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const grid = x % 80 < 2 || y % 80 < 2;
        buf[i] = grid ? 60 : Math.round(40 + 140 * (y / h));        // B
        buf[i + 1] = grid ? 224 : Math.round(30 + 90 * (x / w));    // G
        buf[i + 2] = grid ? 53 : 30;                                // R
        buf[i + 3] = 255;
      }
    }
    return nativeImage.createFromBitmap(buf, { width: w, height: h });
  };
  try {
    await sleep(1500);
    let full = null;
    try {
      full = (await captureAllDisplays())[0].image;
      console.log('selftest capture:', full.getSize(), gdiMode ? '(gdi)' : '(desktopCapturer)');
    } catch (err) {
      console.log('selftest: live capture unavailable, using test card —', err.message);
    }
    if (full && full.getSize().width > 1200) {
      addSnip(full.crop({ x: 80, y: 80, width: 1100, height: 680 }));
      addSnip(full.crop({ x: 400, y: 300, width: 800, height: 500 }));
    } else {
      addSnip(makeTestImage(1100, 680));
      addSnip(makeTestImage(800, 500));
    }
    await sleep(800);
    await shoot(barWin, 'bar.png');

    openLibrary(library[0].id);
    const ed = libraryWin;
    await new Promise((res) => ed.webContents.once('did-finish-load', res));
    await sleep(1400); // sidebar list + selected image load
    const sideCount = await ed.webContents.executeJavaScript(
      `document.querySelectorAll('.side-item').length`);
    console.log(`library sidebar lists ${sideCount} items (expect ${library.length})`);
    const zoomInfo = await ed.webContents.executeJavaScript(
      `({ label: document.getElementById('zoom-label').textContent,
          canvasCss: document.getElementById('canvas').style.width,
          canvasPx: document.getElementById('canvas').width,
          viewportW: document.getElementById('viewport').clientWidth })`);
    console.log('editor zoom:', JSON.stringify(zoomInfo));
    await shoot(ed, 'editor.png');

    // draw annotations with synthetic input, then verify copy-to-clipboard
    const cv = await ed.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('canvas').getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const drag = async (tool, x1, y1, x2, y2) => {
      await ed.webContents.executeJavaScript(
        `document.querySelector('[data-tool="${tool}"]').click()`);
      const send = (ev) => ed.webContents.sendInputEvent(ev);
      send({ type: 'mouseDown', x: Math.round(cv.x + x1), y: Math.round(cv.y + y1), button: 'left', clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        send({ type: 'mouseMove', x: Math.round(cv.x + x1 + ((x2 - x1) * i) / steps), y: Math.round(cv.y + y1 + ((y2 - y1) * i) / steps) });
        await sleep(15);
      }
      send({ type: 'mouseUp', x: Math.round(cv.x + x2), y: Math.round(cv.y + y2), button: 'left', clickCount: 1 });
      await sleep(120);
    };
    await drag('rect', 60, 60, 280, 180);
    await drag('ellipse', 320, 90, 520, 230);
    await drag('arrow', 120, 320, 420, 200);
    await drag('pen', 480, 300, 660, 380);
    const opCount = await ed.webContents.executeJavaScript('state.ops.length');
    console.log(`editor ops after synthetic drawing: ${opCount} (expect 4)`);
    await shoot(ed, 'editor-annotated.png');

    clipboard.clear();
    await ed.webContents.executeJavaScript(`document.getElementById('btn-copy').click()`);
    await sleep(500);
    const clip = clipboard.readImage();
    console.log('clipboard after copy:', clip.isEmpty() ? 'EMPTY (FAIL)' : `${clip.getSize().width}x${clip.getSize().height}`);
    ed.close();

    openSettings();
    await new Promise((res) => settingsWin.webContents.once('did-finish-load', res));
    await sleep(700);
    await shoot(settingsWin, 'settings.png');
    // the mic picker should list real devices (label reveal can take a moment)
    let micOpts = { count: 0, labels: [] };
    for (let i = 0; i < 10 && micOpts.count < 2; i++) {
      await sleep(300);
      micOpts = await settingsWin.webContents.executeJavaScript(
        `({ count: document.getElementById('mic-device').options.length,
            labels: [...document.getElementById('mic-device').options].map((o) => o.textContent) })`);
    }
    console.log(micOpts.count >= 2
      ? `MIC_PICKER_OK ${micOpts.count - 1} device(s): ${micOpts.labels.slice(1).join(' | ').slice(0, 90)}`
      : micOpts.count === 1
        ? 'MIC_PICKER_EMPTY only "System default" (no mics visible here)'
        : `MIC_PICKER_FAIL ${JSON.stringify(micOpts)}`);
    settingsWin.close();

    // overlay: synthetic drag, screenshot mid-drag, then complete the capture.
    // Falls back to a test-card "screen" when live capture is unavailable so
    // the selection/crop pipeline is still exercised end to end.
    const before = library.length;
    const t0 = Date.now();
    await startSnip();
    let shownAt = null;
    while (Date.now() - t0 < 3000) {
      if (overlays.length && overlays[0].win.isVisible()) { shownAt = Date.now() - t0; break; }
      await sleep(10);
    }
    console.log(shownAt === null
      ? 'overlay never became visible'
      : `overlay visible ${shownAt}ms after hotkey`);
    // before the frame lands the overlay must paint NOTHING — pre-capture
    // pixels can leak into the snip on DXGI-duplication machines
    if (overlays.length && !overlays[0].image) {
      const page = await overlays[0].win.webContents.capturePage();
      const bmp = page.toBitmap();
      let painted = 0;
      for (let i = 3; i < bmp.length; i += 4) {
        if (bmp[i] !== 0) { painted++; if (painted > 200) break; }
      }
      console.log(painted > 200
        ? 'PRE_IMAGE_LEAK overlay painted before the frame landed'
        : 'PRE_IMAGE_CLEAN overlay paints nothing before the frame lands');
    } else {
      console.log('PRE_IMAGE_CHECK skipped (frame already landed)');
    }
    // wait for the parallel capture to land (or fail and clear the overlays)
    let waited = 0;
    while (waited < 6000 && overlays.length && !overlays[0].image) {
      await sleep(100);
      waited += 100;
    }
    if (overlays.length && overlays[0].image) console.log(`capture landed ~${shownAt + waited}ms after hotkey`);
    await sleep(300);
    if (!overlays.length) {
      console.log('selftest: overlay using test card (no live screen capture here)');
      const d = screen.getPrimaryDisplay();
      capturing = true;
      captureSession++;
      presentOverlays([{
        display: d,
        image: makeTestImage(
          Math.round(d.bounds.width * d.scaleFactor),
          Math.round(d.bounds.height * d.scaleFactor)),
      }]);
      await sleep(900);
    }
    if (overlays.length) {
      const ov = overlays[0].win;
      const ob = ov.getBounds();
      const db = overlays[0].display.bounds;
      const covers = ob.x === db.x && ob.y === db.y && ob.width === db.width && ob.height === db.height;
      console.log(`overlay bounds ${JSON.stringify(ob)} vs display ${JSON.stringify(db)} -> ${covers ? 'COVER_OK' : 'COVER_MISMATCH'}`);
      const send = (ev) => ov.webContents.sendInputEvent(ev);
      send({ type: 'mouseDown', x: 320, y: 280, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        send({ type: 'mouseMove', x: 320 + i * 52, y: 280 + i * 34 });
        await sleep(20);
      }
      await sleep(250);
      await shoot(ov, 'overlay.png');
      send({ type: 'mouseUp', x: 840, y: 620, button: 'left', clickCount: 1 });
      await sleep(800);
      const captured = library.length === before + 1 &&
        library[0].width > 0 && library[0].height > 0;
      console.log(captured
        ? `SELFTEST_OK capture=${library[0].width}x${library[0].height}`
        : 'SELFTEST_FAIL synthetic capture did not produce a snip');
      await sleep(300);
      await shoot(barWin, 'bar-after-capture.png');
    } else {
      console.log('SELFTEST_PARTIAL ui ok; overlay skipped (no live screen capture here)');
    }

    // --- record mode, end to end: Tab toggle -> drag -> pause/resume -> stop ---
    {
      // run on the TALLEST side monitor when there is one: side monitors taller
      // than the primary used to clip the frame window, and the bug was only
      // visible with the region in the display's lower part, below the
      // primary's height — so that's exactly where the test region goes
      const dPrim = screen.getPrimaryDisplay();
      const dRec = screen.getAllDisplays()
        .filter((d) => d.id !== dPrim.id)
        .sort((a, b) => b.bounds.height - a.bounds.height)[0] || dPrim;
      console.log(`record test on ${dRec === dPrim ? 'PRIMARY (no side monitor attached)' : 'side monitor'}`
        + ` bounds=${JSON.stringify(dRec.bounds)}`);
      const ry = dRec.bounds.height - 460; // region top: low on the display
      if (!capturing) {
        capturing = true;
        captureSession++;
        presentOverlays([{
          display: dRec,
          image: makeTestImage(
            Math.round(dRec.bounds.width * dRec.scaleFactor),
            Math.round(dRec.bounds.height * dRec.scaleFactor)),
        }]);
        await sleep(800);
      }
      if (!overlays.length) {
        console.log('REC_SKIP no overlay window to drive record mode');
      } else {
        const ovw = overlays[0].win;
        ovw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        ovw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        await sleep(300);
        const m = await ovw.webContents.executeJavaScript('document.body.dataset.mode');
        console.log(m === 'video'
          ? 'MODE_TOGGLE_OK Tab switched the overlay to record mode'
          : `MODE_TOGGLE_FAIL overlay mode is '${m}' after Tab`);
        await shoot(ovw, 'overlay-record-mode.png');

        // drag out a region — this is the real drag-to-record flow, ending in
        // overlay:select {mode:'video'} -> startRecording
        const send = (ev) => ovw.webContents.sendInputEvent(ev);
        send({ type: 'mouseDown', x: 100, y: ry, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 8; i++) {
          send({ type: 'mouseMove', x: 100 + i * 61, y: ry + i * 40 });
          await sleep(15);
        }
        send({ type: 'mouseUp', x: 588, y: ry + 320, button: 'left', clickCount: 1 });

        // default settings ARM the recording first: adjustable frame + Record button
        let waited = 0;
        while (waited < 5000 && (!recording || recording.status !== 'armed')) {
          await sleep(100);
          waited += 100;
          if (!recording && waited >= 3000) break; // selection never armed one
        }
        let ready = false;
        if (!recording || recording.status !== 'armed') {
          console.log(`ARM_FAIL drag did not arm a recording (status=${recording ? recording.status : 'none'})`);
          if (recording) stopRecording(true);
        } else {
          console.log(`ARMED_OK region armed ~${waited}ms after drag rect=${JSON.stringify(recording.rect)}`);
          await sleep(500); // let the frame window paint its handles
          const fw = recording.frameWin;

          // the frame window must COVER the whole display — taller-than-primary
          // side monitors used to get it clipped at the primary's height.
          // (A px or two of overhang from DIP<->physical rounding is fine.)
          const fb = fw.getBounds();
          const db = dRec.bounds;
          const coversDisplay = fb.x <= db.x && fb.y <= db.y
            && fb.x + fb.width >= db.x + db.width
            && fb.y + fb.height >= db.y + db.height;
          console.log(coversDisplay
            ? `FRAME_COVER_OK frame covers the full display (frame ${fb.width}x${fb.height} vs display ${db.width}x${db.height})`
            : `FRAME_COVER_CLIPPED frame=${JSON.stringify(fb)} display=${JSON.stringify(db)}`);

          // real on-screen rendering of the HUD island: drop its content
          // protection for a moment and grab the live screen, so corner
          // transparency can actually be inspected (capturePage can't show it)
          try {
            recording.barWin.setContentProtection(false);
            await sleep(350);
            const caps = await captureAllDisplays();
            recording.barWin.setContentProtection(true);
            const cap = caps.find((c) => c.display.id === dRec.id);
            if (cap) {
              const csize = cap.image.getSize();
              const kx = csize.width / dRec.bounds.width;
              const ky = csize.height / dRec.bounds.height;
              const bb = recording.barWin.getBounds();
              const crop = {
                x: Math.max(0, Math.round((bb.x - dRec.bounds.x - 30) * kx)),
                y: Math.max(0, Math.round((bb.y - dRec.bounds.y - 30) * ky)),
                width: Math.round((bb.width + 60) * kx),
                height: Math.round((bb.height + 60) * ky),
              };
              crop.width = Math.min(crop.width, csize.width - crop.x);
              crop.height = Math.min(crop.height, csize.height - crop.y);
              fs.writeFileSync(path.join(outDir, 'hud-onscreen.png'), cap.image.crop(crop).toPNG());
              console.log('HUD_ONSCREEN saved live-screen crop of the control bar');
            } else {
              console.log('HUD_ONSCREEN skipped: no capture for that display');
            }
          } catch (err) {
            console.log(`HUD_ONSCREEN skipped: ${err.message}`);
          }

          await shoot(fw, 'rec-frame-armed.png');
          // resize by dragging the SE handle +60/+60 (the box border sits 3px outside
          // the rect). Forwarding is paused so the REAL cursor's forwarded moves
          // can't pollute the synthetic drag.
          fw.setIgnoreMouseEvents(true);
          const gx = 100 + 488 + 3;
          const gy = ry + 320 + 3;
          const fsend = (ev) => fw.webContents.sendInputEvent(ev);
          fsend({ type: 'mouseDown', x: gx, y: gy, button: 'left', clickCount: 1 });
          for (let i = 1; i <= 6; i++) {
            fsend({ type: 'mouseMove', x: gx + i * 10, y: gy + i * 10, modifiers: ['leftButtonDown'] });
            await sleep(20);
          }
          fsend({ type: 'mouseUp', x: gx + 60, y: gy + 60, button: 'left', clickCount: 1 });
          await sleep(300);
          fw.setIgnoreMouseEvents(true, { forward: true });
          const rr = recording.rect;
          console.log(rr.w === 548 && rr.h === 380
            ? `RESIZE_OK region resized to ${rr.w}x${rr.h} via SE handle`
            : `RESIZE_FAIL rect=${JSON.stringify(rr)} (expected 548x380)`);
          await shoot(recording.barWin, 'rec-hud-armed.png');

          // audio toggles must flip state while armed (they set start states)
          const tog = await recording.barWin.webContents.executeJavaScript(
            `(() => {
               const b = document.body;
               const before = b.dataset.sys;
               document.getElementById('btn-sys').click();
               const mid = b.dataset.sys;
               document.getElementById('btn-sys').click();
               return { before, mid, after: b.dataset.sys };
             })()`);
          console.log(tog.before === 'on' && tog.mid === 'off' && tog.after === 'on'
            ? 'AUDIO_TOGGLE_OK system-audio mute toggles in the armed HUD'
            : `AUDIO_TOGGLE_FAIL ${JSON.stringify(tog)}`);

          // press the HUD's real Record button
          await recording.barWin.webContents.executeJavaScript(
            `document.getElementById('btn-record').click()`);
          waited = 0;
          while (waited < 10000 && recording
            && (recording.status === 'armed' || recording.status === 'starting')) {
            await sleep(100);
            waited += 100;
          }
          ready = !!recording && recording.status === 'recording';
        }
        if (!ready) {
          console.log('REC_FAIL recording did not start after Record press');
          if (recording) stopRecording(true);
        } else {
          console.log(`recording started ~${waited}ms after Record press`
            + ` mime=${recording.meta ? recording.meta.mimeType : '?'}`);
          await sleep(400);
          if (recording.barWin && !recording.barWin.isDestroyed()) {
            await shoot(recording.barWin, 'rec-hud.png');
          }
          const hud = recording.barWin.webContents;

          // the recording must carry ONE mixed audio track (loopback via WebAudio)
          const audioInfo = await hud.executeJavaScript(
            `({ tracks: recorder ? recorder.stream.getAudioTracks().length : -1,
                sys: document.body.dataset.sys, mic: document.body.dataset.mic })`);
          console.log(audioInfo.tracks === 1
            ? `AUDIO_TRACK_OK mixed audio track present (sys=${audioInfo.sys} mic=${audioInfo.mic})`
            : `AUDIO_TRACK_FAIL ${JSON.stringify(audioInfo)}`);

          // try enabling the microphone live (no mic on this machine is fine)
          const micState = await hud.executeJavaScript(
            `(async () => {
               document.getElementById('btn-mic').click();
               await new Promise((r) => setTimeout(r, 1200));
               const s = document.body.dataset.mic;
               if (s === 'on') document.getElementById('btn-mic').click(); // back off
               return s;
             })()`);
          console.log(micState === 'on'
            ? 'MIC_LIVE_OK microphone joined mid-recording'
            : `MIC_STATE ${micState} (no microphone in this session is acceptable)`);

          // pause / resume through the HUD's real buttons
          await hud.executeJavaScript(`document.getElementById('btn-pause').click()`);
          await sleep(200);
          const pausedState = await hud.executeJavaScript('document.body.dataset.status');
          await sleep(500);
          await hud.executeJavaScript(`document.getElementById('btn-pause').click()`);
          await sleep(200);
          const resumedState = await hud.executeJavaScript('document.body.dataset.status');
          console.log(pausedState === 'paused' && resumedState === 'recording'
            ? 'PAUSE_OK pause/resume round-trip works'
            : `PAUSE_FAIL paused=${pausedState} resumed=${resumedState}`);
          await sleep(1800);
          stopRecording(false);
          let waitedStop = 0;
          while (waitedStop < 8000 && recording) {
            await sleep(100);
            waitedStop += 100;
          }
          const v = library[0];
          if (!recording && v && v.kind === 'video' && fs.existsSync(v.file) && v.durationMs > 500) {
            const kb = Math.round(fs.statSync(v.file).size / 1024);
            console.log(`REC_OK ${v.width}x${v.height} ${v.durationMs}ms ${kb}KB`
              + ` ${path.extname(v.file)} poster=${v.poster ? 'yes' : 'no'}`);
            await sleep(400);
            await shoot(barWin, 'bar-video.png');

            // library window: video playback pane + sidebar history
            openLibrary(v.id);
            const lw = libraryWin;
            await new Promise((res) => lw.webContents.once('did-finish-load', res));
            await sleep(1500);
            const ls = await lw.webContents.executeJavaScript(
              `({ count: document.querySelectorAll('.side-item').length,
                  videoMode: document.body.classList.contains('mode-video'),
                  vw: document.getElementById('vplayer').videoWidth })`);
            console.log(ls.videoMode && ls.vw > 0 && ls.count >= 4
              ? `LIBRARY_OK sidebar has ${ls.count} items, video decodes at ${ls.vw}px wide`
              : `LIBRARY_FAIL ${JSON.stringify(ls)}`);
            await shoot(lw, 'library-video.png');

            // switch to an image, add an op, save it as a variant
            const libBefore = library.length;
            await lw.webContents.executeJavaScript(
              `(async () => {
                 const img = items.find((i) => i.kind === 'image');
                 await selectItem(img.id, { force: true });
               })()`);
            await sleep(900);
            await lw.webContents.executeJavaScript(
              `(async () => {
                 state.ops.push({ type: 'rect', color: '#ff5a4e', width: 4,
                                  rect: { x: 12, y: 12, w: 140, h: 90 } });
                 render();
                 await saveVariant();
               })()`);
            await sleep(900);
            const variant = library[0];
            console.log(library.length === libBefore + 1 && variant.parentId
              && Array.isArray(variant.ops) && variant.ops.length === 1
              && fs.existsSync(variant.file)
              ? `VARIANT_OK saved as ${path.basename(variant.file)} (parent + 1 op stored)`
              : `VARIANT_FAIL len=${library.length}/${libBefore} newest=${JSON.stringify({ p: variant.parentId, ops: variant.ops && variant.ops.length })}`);

            // reopening the variant must replay its ops over the parent image
            await lw.webContents.executeJavaScript(
              `selectItem(${JSON.stringify(variant.id)}, { force: true })`);
            await sleep(900);
            const reedit = await lw.webContents.executeJavaScript(
              `({ ops: state.ops.length, w: document.getElementById('canvas').width })`);
            console.log(reedit.ops === 1 && reedit.w > 0
              ? `VARIANT_REEDIT_OK variant reopened with ${reedit.ops} editable op`
              : `VARIANT_REEDIT_FAIL ${JSON.stringify(reedit)}`);

            // the variant must render NESTED under its parent in the sidebar
            const nest = await lw.webContents.executeJavaScript(
              `(() => {
                 const card = document.querySelector('.side-item[data-id=${JSON.stringify(variant.id)}]');
                 if (!card) return { ok: false, why: 'card missing' };
                 const row = card.closest('.nest-row');
                 if (!row) return { ok: false, why: 'not in a nest-row' };
                 let el = row.previousElementSibling;
                 while (el && el.classList.contains('nest-row')) el = el.previousElementSibling;
                 return { ok: !!el && el.dataset.id === ${JSON.stringify(variant.parentId)},
                          why: el ? el.dataset.id : 'no preceding root' };
               })()`);
            console.log(nest.ok
              ? 'NESTED_OK variant renders indented under its parent'
              : `NESTED_FAIL ${JSON.stringify(nest)}`);
            await shoot(lw, 'library-variant.png');
            lw.close();
          } else {
            console.log(`REC_FAIL stuck=${!!recording}`
              + ` newest=${v ? `${v.kind}/${v.durationMs}ms` : 'none'}`);
            if (recording) { try { stopRecording(true); } catch {} }
          }
        }
      }
    }

    // --- instant mode: armBeforeRecord=false records the moment the drag ends ---
    {
      const prevArm = settings.armBeforeRecord;
      settings.armBeforeRecord = false;
      await startRecording(screen.getPrimaryDisplay(), { x: 140, y: 140, w: 320, h: 200 });
      let t2 = 0;
      while (t2 < 10000 && recording && recording.status === 'starting') {
        await sleep(100);
        t2 += 100;
      }
      if (recording && recording.status === 'recording') {
        await sleep(1300);
        stopRecording(false);
        t2 = 0;
        while (t2 < 8000 && recording) { await sleep(100); t2 += 100; }
        const v2 = library[0];
        console.log(!recording && v2 && v2.kind === 'video' && fs.existsSync(v2.file)
          ? `REC2_OK instant mode ${v2.width}x${v2.height} ${v2.durationMs}ms`
          : 'REC2_FAIL instant mode did not produce a video');
      } else {
        console.log('REC2_FAIL instant recording never started');
        if (recording) stopRecording(true);
      }
      settings.armBeforeRecord = prevArm;
    }

    // --- share link: initiate -> direct PUT -> complete, against a mock API ---
    {
      const mock = { created: null, uploadedBytes: -1, completed: false, base: '' };
      const srv = require('node:http').createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/shares') {
          let b = '';
          req.on('data', (c) => { b += c; });
          req.on('end', () => {
            try { mock.created = JSON.parse(b); } catch { mock.created = null; }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              id: 'selftestselftestselft1',
              shareUrl: `${mock.base}/s/selftestselftestselft1`,
              uploadUrl: `${mock.base}/blob/selftest.bin`,
              uploadHeaders: { 'x-ms-blob-type': 'BlockBlob' },
            }));
          });
        } else if (req.method === 'PUT' && req.url === '/blob/selftest.bin') {
          let n = 0;
          req.on('data', (c) => { n += c.length; });
          req.on('end', () => { mock.uploadedBytes = n; res.statusCode = 201; res.end(); });
        } else if (req.method === 'POST' && req.url === '/api/shares/selftestselftestselft1/complete') {
          mock.completed = true;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ id: 'selftestselftestselft1', status: 'active', viewCount: 0 }));
        } else { res.statusCode = 404; res.end(); }
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      mock.base = `http://127.0.0.1:${srv.address().port}`;
      const prevApi = process.env.SNIPIT_SHARE_API;
      process.env.SNIPIT_SHARE_API = mock.base;
      try {
        const target = library.find((it) => it.kind === 'video' && fs.existsSync(it.file)) || library[0];
        const res = await createShareFromPayload({ id: target.id, expiresInDays: 7 }, null);
        const wantBytes = fs.statSync(target.file).size;
        const clipOk = clipboard.readText() === (res.url || '');
        const declaredOk = !!mock.created && mock.created.size === wantBytes
          && mock.created.expiresInDays === 7;
        console.log(res.ok && mock.completed && mock.uploadedBytes === wantBytes && clipOk && declaredOk
          ? `SHARE_OK ${target.kind} uploaded ${mock.uploadedBytes} bytes, link on clipboard`
          : `SHARE_FAIL ${JSON.stringify({
            ok: res.ok, error: res.error, bytes: mock.uploadedBytes, wantBytes,
            completed: mock.completed, clipOk, declaredOk,
          })}`);
      } catch (err) {
        console.log(`SHARE_FAIL ${err.message}`);
      }
      if (prevApi === undefined) delete process.env.SNIPIT_SHARE_API;
      else process.env.SNIPIT_SHARE_API = prevApi;
      srv.close();
    }

    // --- window snapping: enumeration + click-a-window capture ---
    {
      try {
        const wins = await winEnum.listWindows();
        console.log(wins.length
          ? `WINENUM_OK ${wins.length} windows (top: "${wins[0].title.slice(0, 40)}" ${wins[0].rect.width}x${wins[0].rect.height})`
          : 'WINENUM_EMPTY no windows enumerated');
      } catch (err) {
        console.log(`WINENUM_FAIL ${err.message}`);
      }

      capturing = true;
      captureSession++;
      snipMode = 'image'; // the record test left the overlay in video mode
      const dS = screen.getPrimaryDisplay();
      presentOverlays([{
        display: dS,
        image: makeTestImage(
          Math.round(dS.bounds.width * dS.scaleFactor),
          Math.round(dS.bounds.height * dS.scaleFactor)),
      }]);
      await sleep(1600); // let the REAL window list land first, then override it
      if (overlays.length) {
        const ov = overlays[0].win;
        // near-full-display fake window: the REAL mouse can wander over the
        // overlay during the test, and any position must still hit the target
        const fw2 = { x: 40, y: 40, w: dS.bounds.width - 80, h: dS.bounds.height - 80 };
        ov.webContents.send('overlay:windows', [{ ...fw2, title: 'Fake App Window' }]);
        await sleep(250);
        ov.webContents.sendInputEvent({ type: 'mouseMove', x: 300, y: 220 });
        await sleep(200);
        const snapState = await ov.webContents.executeJavaScript(
          `({ selVisible: !document.getElementById('sel').hidden,
              dims: document.getElementById('dims').textContent })`);
        const libBefore = library.length;
        ov.webContents.sendInputEvent({ type: 'mouseDown', x: 300, y: 220, button: 'left', clickCount: 1 });
        await sleep(80);
        ov.webContents.sendInputEvent({ type: 'mouseUp', x: 300, y: 220, button: 'left', clickCount: 1 });
        await sleep(900);
        const s0 = library[0];
        const grew = library.length === libBefore + 1 && s0 && s0.kind === 'image';
        const expW = Math.round(fw2.w * dS.scaleFactor);
        const expH = Math.round(fw2.h * dS.scaleFactor);
        const sizeOk = grew && Math.abs(s0.width - expW) < 40 && Math.abs(s0.height - expH) < 40;
        console.log(snapState.selVisible && snapState.dims.includes('Fake App') && sizeOk
          ? `SNAP_OK hover highlighted ("${snapState.dims}"), click captured ${s0.width}x${s0.height}`
          : `SNAP_FAIL hover=${JSON.stringify(snapState)} grew=${grew} size=${s0 ? `${s0.width}x${s0.height}` : 'n/a'} expected~${expW}x${expH}`);
      } else {
        console.log('SNAP_SKIP no overlay window');
        capturing = false;
      }
    }

    // --- default capture mode: the main shortcut honours settings.defaultMode ---
    {
      const prevDefault = settings.defaultMode;
      settings.defaultMode = 'video';
      hotkeyPressed('default');
      await sleep(1000);
      const m = overlays.length && overlays[0].win && !overlays[0].win.isDestroyed()
        ? await overlays[0].win.webContents.executeJavaScript('document.body.dataset.mode')
        : 'no-overlay';
      console.log(m === 'video'
        ? 'DEFAULT_MODE_OK main shortcut opened the overlay in record mode'
        : `DEFAULT_MODE_FAIL mode=${m}`);
      cancelSnip();
      settings.defaultMode = prevDefault;
      await sleep(400);
    }

    // --- auth gate: signed out must block captures and open the login window ---
    {
      auth._setBypass(false); // drop the test bypass -> signed-out
      await sleep(300);
      await startSnip('image');
      await sleep(700);
      const gateBlocked = !capturing && overlays.length === 0;
      const loginShown = !!(loginWin && !loginWin.isDestroyed());
      console.log(gateBlocked && loginShown
        ? 'AUTH_GATE_OK signed-out capture was blocked and the login window opened'
        : `AUTH_GATE_FAIL blocked=${gateBlocked} login=${loginShown}`);
      if (capturing) cancelSnip(); // never leak an overlay out of this block
      if (loginWin && !loginWin.isDestroyed()) {
        await new Promise((res) => {
          if (!loginWin.webContents.isLoading()) res();
          else loginWin.webContents.once('did-finish-load', res);
        });
        await sleep(600);
        await shoot(loginWin, 'login.png');
        loginWin.close();
      }
      auth._setBypass(true);
      await sleep(300);
    }

    // --- keep-everything: nothing may be trimmed, the bar still shows 3 ---
    {
      const allOnDisk = library.every((it) => fs.existsSync(it.file));
      console.log(library.length >= 6 && allOnDisk
        ? `KEEP_ALL_OK library retains all ${library.length} captures on disk`
        : `KEEP_ALL_FAIL count=${library.length} allOnDisk=${allOnDisk}`);
      console.log(snipPayload().length <= MAX_SNIPS
        ? `BAR_LIMIT_OK bar shows ${snipPayload().length} of ${library.length}`
        : 'BAR_LIMIT_FAIL');
      console.log(`library folder: ${resolveSaveDir()}`);
    }

    // the bar should fade away on its own ~10s after it appeared
    await sleep(11500);
    if (barWin.isVisible()) {
      const st = await barWin.webContents.executeJavaScript('({ hovering, pinned })');
      console.log(st.hovering || st.pinned
        ? `AUTO_HIDE_SKIP bar held open by ${st.pinned ? 'pin' : 'real mouse hover'}`
        : 'AUTO_HIDE_FAIL bar still visible after 11.5s');
    } else {
      console.log('AUTO_HIDE_OK bar hid itself');
    }
  } catch (err) {
    console.error('SELFTEST_FAIL', err);
  }
  quitting = true;
  app.quit();
}

/* ---------------- app lifecycle ---------------- */

// dev/test runs get their own profile: they must not fight the installed
// app's single-instance lock or pollute its settings and snips
if (SMOKE || SELFTEST) {
  app.setPath('userData', path.join(require('node:os').tmpdir(), 'snipit-good-test-profile'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => hotkeyPressed('default'));

  app.whenReady().then(() => {
    app.setAppUserModelId('no.cwb.snipit-good');
    migrateLegacyUserData();
    loadSettings();
    // test runs must never write captures into the user's real library folder
    if (SMOKE || SELFTEST) settings.saveDir = path.join(app.getPath('userData'), 'library');
    loadLibrary();
    createBar();
    createTray();
    // the mtnauth.com gate: everything capture-related requires a signed-in session
    auth.init({
      bypass: SMOKE || SELFTEST, // test runs exercise the gate explicitly instead
      onChange: broadcastAuthState,
    }).then(() => {
      if (!auth.isSignedIn()) openLogin();
    });
    initDisplayMediaHandler();
    ensureOverlayPool(); // pre-load overlay windows so the hotkey is instant
    winEnum.warmUp(); // window snapping needs the enumeration helper warm
    const displaysChanged = () => {
      ensureOverlayPool();
      positionBar(barHeight); // keep the bar glued to the primary work area
    };
    screen.on('display-added', displaysChanged);
    screen.on('display-removed', displaysChanged);
    screen.on('display-metrics-changed', displaysChanged);
    // after a lock (RDP takes the console too) or sleep, rebuild the hidden
    // bar outright: its renderer or composited surface may have died in a
    // way isCrashed() can't see, and a rebuild is invisible while hidden
    for (const ev of ['unlock-screen', 'resume']) {
      powerMonitor.on(ev, () => {
        if (barWin && !barWin.isDestroyed() && !barWin.isVisible()) recreateBar();
      });
    }
    applyAutoUpdateSetting();
    if (!regHotkey(settings.shortcut, 'default')) {
      settings.shortcut = DEFAULT_SETTINGS.shortcut;
      regHotkey(settings.shortcut, 'default');
    }
    if (settings.recordShortcut === settings.shortcut) settings.recordShortcut = '';
    if (settings.recordShortcut && !regHotkey(settings.recordShortcut, 'video')) {
      // fall back to the default record shortcut, else run without one
      settings.recordShortcut = settings.recordShortcut !== DEFAULT_SETTINGS.recordShortcut
        && DEFAULT_SETTINGS.recordShortcut !== settings.shortcut
        && regHotkey(DEFAULT_SETTINGS.recordShortcut, 'video')
        ? DEFAULT_SETTINGS.recordShortcut : '';
      refreshTray();
    }
    if (library.length) {
      // bar shows once content has loaded AND the session is verified
      bootBarPending = true;
      barWin.webContents.once('did-finish-load', () => setTimeout(showBar, 80));
    }
    if (SMOKE) {
      setTimeout(() => {
        console.log('SMOKE_OK');
        quitting = true;
        app.quit();
      }, 2500);
    }
    if (SELFTEST) runSelfTest();
  });

  // tray app: keep running with no windows
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    quitting = true;
    if (recording && !recording.finalizing) {
      // let the recorder flush to disk first, then re-quit. The re-quit MUST
      // be async: a synchronous app.quit() inside a before-quit handler that
      // just called preventDefault() is swallowed, which left the app running
      // forever after quitting mid-recording.
      e.preventDefault();
      stopRecording(false);
      const retry = () => { if (!recording) app.quit(); else setTimeout(retry, 250); };
      setTimeout(retry, 100);
    }
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    gdi.dispose();
    winEnum.dispose();
    auth.dispose();
  });
}
