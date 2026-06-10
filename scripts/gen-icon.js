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

/* Background detection: flood-fill from the image borders across pixels that
   look like backdrop — transparent, white, or the light low-chroma grey of a
   baked-in "transparency" checkerboard. Whatever the fill cannot reach (the
   artwork encloses it) is kept, so the artwork's own silhouette becomes the
   icon shape and no corner radius needs to be assumed. */
function findBackground(bmp, w, h) {
  const fillable = (i) => {
    if (bmp[i + 3] < 16) return true;
    const r = bmp[i + 2], g = bmp[i + 1], b = bmp[i];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return min > 180 && max - min < 25; // white or light checkerboard grey
  };
  const bg = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (!bg[p] && fillable(p * 4)) { bg[p] = 1; queue.push(p); }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (queue.length) {
    const p = queue.pop();
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  // dilate by 1px to eat the anti-aliased halo between backdrop and artwork
  const dilated = Uint8Array.from(bg);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bg[y * w + x]) continue;
      if ((x > 0 && bg[y * w + x - 1]) || (x < w - 1 && bg[y * w + x + 1]) ||
          (y > 0 && bg[(y - 1) * w + x]) || (y < h - 1 && bg[(y + 1) * w + x])) {
        dilated[y * w + x] = 1;
      }
    }
  }
  return dilated;
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

  // 1. flood-fill the backdrop, then crop to the artwork's bounding box
  const bg = findBackground(src, sw, sh);
  let minX = sw, minY = sh, maxX = -1, maxY = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (!bg[y * sw + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('source image appears to be blank');
  const bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  const size = Math.max(bbox.w, bbox.h);
  const offX = bbox.x - Math.floor((size - bbox.w) / 2);
  const offY = bbox.y - Math.floor((size - bbox.h) / 2);

  // 2. copy onto a centred square canvas with the backdrop made transparent
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = offX + x, sy = offY + y;
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue; // transparent
      if (bg[sy * sw + sx]) continue;
      const o = (y * size + x) * 4;
      const i = (sy * sw + sx) * 4;
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = src[i + 3];
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
