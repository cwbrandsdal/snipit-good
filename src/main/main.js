'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, globalShortcut, screen, desktopCapturer,
  clipboard, nativeImage, Tray, Menu, ipcMain, dialog,
} = require('electron');

const gdi = require('./gdi-capture');

const SMOKE = process.argv.includes('--smoke');
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // every 4 hours
const SELFTEST = process.argv.includes('--selftest');
const MAX_SNIPS = 3;
const BAR_WIDTH = 196;
const BAR_MARGIN = 14;

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const renderer = (p) => path.join(__dirname, '..', 'renderer', p);
const asset = (p) => path.join(__dirname, '..', '..', 'assets', p);

const DEFAULT_SETTINGS = { shortcut: 'Ctrl+Shift+S', autoCopy: true, pinBar: false };

let settings = { ...DEFAULT_SETTINGS };
let snips = []; // { id, file, width, height, createdAt }
let tray = null;
let barWin = null;
let settingsWin = null;
let overlays = []; // { win, display, image }
let editors = new Map(); // snip id -> BrowserWindow
let capturing = false;
let quitting = false;

const snipsDir = () => path.join(app.getPath('userData'), 'snips');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const metaFile = () => path.join(snipsDir(), 'snips.json');

/* ---------------- persistence ---------------- */

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch { settings = { ...DEFAULT_SETTINGS }; }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

function loadSnips() {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
    snips = meta.filter((s) => fs.existsSync(s.file)).slice(0, MAX_SNIPS);
  } catch { snips = []; }
}

function saveSnipsMeta() {
  try {
    fs.mkdirSync(snipsDir(), { recursive: true });
    fs.writeFileSync(metaFile(), JSON.stringify(snips, null, 2));
  } catch {}
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
  barWin.on('close', (e) => { if (!quitting) { e.preventDefault(); barWin.hide(); } });
}

function positionBar(height) {
  if (!barWin || barWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  barWin.setBounds({
    x: wa.x + BAR_MARGIN,
    y: wa.y + wa.height - height - BAR_MARGIN,
    width: BAR_WIDTH,
    height,
  });
}

function snipPayload() {
  return snips.map((s) => {
    let thumb = '';
    try {
      const img = nativeImage.createFromPath(s.file);
      thumb = img.resize({ width: 360 }).toDataURL();
    } catch {}
    return { id: s.id, width: s.width, height: s.height, createdAt: s.createdAt, thumb };
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
  if (snips.length === 0) barWin.hide();
}

function showBar() {
  if (!barWin || barWin.isDestroyed() || snips.length === 0) return;
  if (!barWin.isVisible()) barWin.showInactive();
  // (re)arm the renderer's auto-hide countdown
  barWin.webContents.send('bar:visible');
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
    win.webContents.send('overlay:arm', { displayId: display.id });
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

async function startSnip() {
  if (capturing) return;
  capturing = true;
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
  globalShortcut.register('Escape', () => cancelSnip());
}

function hideOverlays() {
  globalShortcut.unregister('Escape');
  for (const o of overlays) {
    if (o.win && !o.win.isDestroyed()) {
      o.win.hide();
      o.win.webContents.send('overlay:reset'); // drop the big frame from memory
    }
  }
  overlays = [];
  capturing = false;
  showBar();
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
  fs.mkdirSync(snipsDir(), { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const file = path.join(snipsDir(), `snip-${id}.png`);
  try { fs.writeFileSync(file, image.toPNG()); } catch (err) {
    console.error('failed to save snip:', err);
    return;
  }
  const { width, height } = image.getSize();
  snips.unshift({ id, file, width, height, createdAt: Date.now() });
  for (const old of snips.splice(MAX_SNIPS)) {
    try { fs.unlinkSync(old.file); } catch {}
  }
  saveSnipsMeta();

  let event = { type: 'captured', id };
  if (settings.autoCopy) {
    clipboard.writeImage(image);
    event = { type: 'captured-copied', id };
  }
  pushSnipsToBar(event);
  showBar();
}

function removeSnip(id) {
  const idx = snips.findIndex((s) => s.id === id);
  if (idx === -1) return;
  try { fs.unlinkSync(snips[idx].file); } catch {}
  snips.splice(idx, 1);
  saveSnipsMeta();
  pushSnipsToBar();
}

/* ---------------- editor ---------------- */

function openEditor(id) {
  const snip = snips.find((s) => s.id === id);
  if (!snip) return;
  const existing = editors.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1160,
    height: 800,
    minWidth: 780,
    minHeight: 540,
    backgroundColor: '#15161b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#15161b', symbolColor: '#a7adba', height: 42 },
    icon: asset('icon.png'),
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(renderer('editor/editor.html'), { query: { id } });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => editors.delete(id));
  editors.set(id, win);
}

/* ---------------- settings window ---------------- */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 480,
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

/* ---------------- shortcut ---------------- */

function registerShortcut(accel) {
  if (settings.shortcut) globalShortcut.unregister(settings.shortcut);
  try {
    return globalShortcut.register(accel, () => startSnip());
  } catch { return false; }
}

/* ---------------- auto update (GitHub releases) ---------------- */

let updateReadyVersion = null;

function setupAutoUpdate() {
  if (!app.isPackaged) return; // dev runs have no update metadata
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // updates apply on normal quit too
  autoUpdater.on('update-downloaded', (info) => {
    updateReadyVersion = info.version;
    if (tray && tray.rebuildMenu) tray.rebuildMenu();
    tray?.setToolTip(`snippit-good — update v${info.version} ready, restart to apply`);
  });
  autoUpdater.on('error', (err) => console.error('auto-update:', err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15 * 1000); // don't compete with startup
  setInterval(check, UPDATE_CHECK_INTERVAL);
  app.applyUpdate = () => { quitting = true; autoUpdater.quitAndInstall(); };
}

/* ---------------- tray ---------------- */

function createTray() {
  tray = new Tray(asset('tray.png'));
  tray.setToolTip('snippit-good — quick snips');
  const rebuild = () => {
    const items = [
      { label: `New snip\t${settings.shortcut}`, click: () => startSnip() },
      { label: 'Show recent snips', click: () => { if (snips.length) showBar(); } },
      { label: 'Settings…', click: () => openSettings() },
    ];
    if (updateReadyVersion) {
      items.push({ type: 'separator' });
      items.push({
        label: `Restart to update to v${updateReadyVersion}`,
        click: () => app.applyUpdate && app.applyUpdate(),
      });
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Quit snippit-good', click: () => { quitting = true; app.quit(); } });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  rebuild();
  tray.on('double-click', () => startSnip());
  tray.rebuildMenu = rebuild;
}

/* ---------------- ipc ---------------- */

ipcMain.on('overlay:select', (_e, { displayId, rect }) => finalizeCapture(displayId, rect));
ipcMain.on('overlay:cancel', () => cancelSnip());

ipcMain.on('bar:resize', (_e, height) => {
  positionBar(Math.max(60, Math.min(640, Math.round(height))));
});
ipcMain.on('bar:hide', () => barWin && barWin.hide());
ipcMain.on('snip:new', () => startSnip());
ipcMain.on('snip:edit', (_e, id) => openEditor(id));
ipcMain.on('snip:remove', (_e, id) => removeSnip(id));
ipcMain.on('settings:open', () => openSettings());

ipcMain.handle('snip:copy', (_e, id) => {
  const snip = snips.find((s) => s.id === id);
  if (!snip) return false;
  try {
    clipboard.writeImage(nativeImage.createFromPath(snip.file));
    return true;
  } catch { return false; }
});

ipcMain.handle('editor:get-snip', (_e, id) => {
  const snip = snips.find((s) => s.id === id);
  if (!snip || !fs.existsSync(snip.file)) return null;
  return {
    id: snip.id,
    width: snip.width,
    height: snip.height,
    createdAt: snip.createdAt,
    dataUrl: nativeImage.createFromPath(snip.file).toDataURL(),
  };
});

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
ipcMain.handle('settings:set', (_e, patch) => {
  const next = { ...settings, ...patch };
  if (patch.shortcut && patch.shortcut !== settings.shortcut) {
    const prev = settings.shortcut;
    globalShortcut.unregister(prev);
    let ok = false;
    try { ok = globalShortcut.register(patch.shortcut, () => startSnip()); } catch {}
    if (!ok) {
      registerShortcut(prev);
      settings = { ...next, shortcut: prev };
      saveSettings();
      pushSnipsToBar();
      return { ok: false, error: 'That shortcut could not be registered — it may be in use.', settings };
    }
  }
  settings = next;
  saveSettings();
  if (tray && tray.rebuildMenu) tray.rebuildMenu();
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

    openEditor(snips[0].id);
    const ed = editors.get(snips[0].id);
    await new Promise((res) => ed.webContents.once('did-finish-load', res));
    await sleep(1000);
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
    settingsWin.close();

    // overlay: synthetic drag, screenshot mid-drag, then complete the capture.
    // Falls back to a test-card "screen" when live capture is unavailable so
    // the selection/crop pipeline is still exercised end to end.
    const before = snips.length;
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
      const captured = snips.length === Math.min(MAX_SNIPS, before + 1) &&
        snips[0].width > 0 && snips[0].height > 0;
      console.log(captured
        ? `SELFTEST_OK capture=${snips[0].width}x${snips[0].height}`
        : 'SELFTEST_FAIL synthetic capture did not produce a snip');
      await sleep(300);
      await shoot(barWin, 'bar-after-capture.png');
    } else {
      console.log('SELFTEST_PARTIAL ui ok; overlay skipped (no live screen capture here)');
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => startSnip());

  app.whenReady().then(() => {
    app.setAppUserModelId('no.cwb.snippit-good');
    loadSettings();
    loadSnips();
    createBar();
    createTray();
    ensureOverlayPool(); // pre-load overlay windows so the hotkey is instant
    screen.on('display-added', ensureOverlayPool);
    screen.on('display-removed', ensureOverlayPool);
    screen.on('display-metrics-changed', ensureOverlayPool);
    setupAutoUpdate();
    if (!registerShortcut(settings.shortcut)) {
      settings.shortcut = DEFAULT_SETTINGS.shortcut;
      registerShortcut(settings.shortcut);
    }
    if (snips.length) {
      // bar shows once content has loaded; size arrives via bar:resize
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
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    gdi.dispose();
  });
}
