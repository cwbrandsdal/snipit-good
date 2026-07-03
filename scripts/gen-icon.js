// Generates all app icons from assets/icon-source.svg (run: npm run gen-icon).
//
// The source is a finished icon design (artwork on its own dark field). This
// script renders it to a centred square, then:
//   1. cover-fits the SVG into the square (trims a sliver of even margin)
//   2. rounds the corners with an anti-aliased mask so they're transparent,
//      matching the app-icon convention
//   3. emits icon.png (256), tray.png (32), icon-preview-128.png and a
//      multi-resolution icon.ico for the installer / Start menu / taskbar,
//      plus icon-source.png (a 1024 raster of the master, for previews)
//
// Runs under Electron (not plain node) for Chromium's SVG rendering and
// nativeImage's high-quality resampling: `npx electron scripts/gen-icon.js`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const MASTER = 1024;                        // master square edge (px)
const RADIUS = Math.round(MASTER * 0.20);   // rounded-corner radius

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bit depth
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// Render the SVG into a rounded square via a hidden renderer canvas, returning
// a nativeImage master (transparent outside the corner radius).
async function renderMaster() {
  const svg = fs.readFileSync(path.join(ASSETS, 'icon-source.svg'), 'utf8');
  const svgB64 = Buffer.from(svg, 'utf8').toString('base64');
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: {} });
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0">
    <canvas id="c" width="${MASTER}" height="${MASTER}"></canvas>
    <script>
      const S = ${MASTER}, R = ${RADIUS};
      const img = new Image();
      img.onload = () => {
        const cv = document.getElementById('c'), ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, S, S);
        ctx.save();
        ctx.beginPath(); ctx.roundRect(0, 0, S, S, R); ctx.clip();
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        const scale = Math.max(S / iw, S / ih);   // cover-fit, centred
        const dw = iw * scale, dh = ih * scale;
        ctx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
        ctx.restore();
        window.__png = cv.toDataURL('image/png');
        document.title = 'DONE';
      };
      img.onerror = () => { document.title = 'ERR'; };
      img.src = 'data:image/svg+xml;base64,${svgB64}';
    </script></body>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  let t = '';
  for (let i = 0; i < 100; i++) {
    t = win.getTitle();
    if (t === 'DONE' || t === 'ERR') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (t !== 'DONE') throw new Error('SVG could not be rendered');
  const dataUrl = await win.webContents.executeJavaScript('window.__png');
  win.destroy();
  const master = nativeImage.createFromDataURL(dataUrl);
  if (master.isEmpty()) throw new Error('rendered master is empty');
  return master;
}

async function main() {
  const master = await renderMaster();
  const px = (s) => master.resize({ width: s, height: s, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), px(256));
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), px(32));
  fs.writeFileSync(path.join(ASSETS, 'icon-preview-128.png'), px(128));
  fs.writeFileSync(
    path.join(ASSETS, 'icon.ico'),
    buildIco([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, data: px(s) }))),
  );
  fs.writeFileSync(path.join(ASSETS, 'icon-source.png'), master.toPNG());
  console.log(`wrote icon.png, tray.png, icon-preview-128.png, icon.ico, icon-source.png (master ${MASTER}px, radius ${RADIUS}px)`);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try { await main(); } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
  app.quit();
});
