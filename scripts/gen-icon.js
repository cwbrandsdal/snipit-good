// Generates all app icons from assets/icon-source.png (run: npm run gen-icon).
//
// The source is artwork on a white background, so this script:
//   1. trims the white margin down to the rounded-square artwork
//   2. applies an anti-aliased rounded-corner alpha mask so the corners
//      are transparent instead of white
//   3. emits icon.png (256), tray.png (32), icon-preview-128.png and a
//      multi-resolution icon.ico for the installer / Start menu / taskbar
//
// Runs under Electron (not plain node) for nativeImage's high-quality
// resampling: `npx electron scripts/gen-icon.js`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const CORNER_RADIUS = 0.225; // of edge length — matches the artwork's squircle

function findArtworkBBox(bmp, w, h) {
  // background is (near-)white; artwork pixels are anything darker
  const isArt = (x, y) => {
    const i = (y * w + x) * 4;
    return bmp[i] < 240 || bmp[i + 1] < 240 || bmp[i + 2] < 240;
  };
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isArt(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('source image appears to be blank');
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// signed distance to a rounded rectangle centred in a size×size square
function roundedRectSDF(px, py, size, radius) {
  const half = size / 2;
  const qx = Math.abs(px - half) - (half - radius);
  const qy = Math.abs(py - half) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) - radius;
}

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

function main() {
  const source = nativeImage.createFromPath(path.join(ASSETS, 'icon-source.png'));
  if (source.isEmpty()) throw new Error('assets/icon-source.png not found or unreadable');
  const { width: sw, height: sh } = source.getSize();
  const src = source.toBitmap(); // BGRA

  // 1. trim the white margin, pad to a centred square
  const bbox = findArtworkBBox(src, sw, sh);
  const size = Math.max(bbox.w, bbox.h);
  const offX = bbox.x - Math.floor((size - bbox.w) / 2);
  const offY = bbox.y - Math.floor((size - bbox.h) / 2);

  // 2. copy into a square canvas, masking corners transparent (anti-aliased)
  const out = Buffer.alloc(size * size * 4);
  const radius = size * CORNER_RADIUS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = offX + x, sy = offY + y;
      const o = (y * size + x) * 4;
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue; // transparent
      const i = (sy * sw + sx) * 4;
      const coverage = Math.max(0, Math.min(1, 0.5 - roundedRectSDF(x + 0.5, y + 0.5, size, radius)));
      if (coverage === 0) continue;
      // premultiplied BGRA
      out[o] = Math.round(src[i] * coverage);
      out[o + 1] = Math.round(src[i + 1] * coverage);
      out[o + 2] = Math.round(src[i + 2] * coverage);
      out[o + 3] = Math.round(255 * coverage);
    }
  }
  const master = nativeImage.createFromBitmap(out, { width: size, height: size });

  // 3. emit every size
  const px = (s) => master.resize({ width: s, height: s, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), px(256));
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), px(32));
  fs.writeFileSync(path.join(ASSETS, 'icon-preview-128.png'), px(128));
  fs.writeFileSync(
    path.join(ASSETS, 'icon.ico'),
    buildIco([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, data: px(s) }))),
  );
  console.log(`wrote icon.png, tray.png, icon-preview-128.png, icon.ico (master ${size}px from ${sw}x${sh} source)`);
}

app.whenReady().then(() => {
  try { main(); } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
  app.quit();
});
