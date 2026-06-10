// Generates assets/icon.png (256), assets/tray.png (32) and a 128px preview.
// Shapes are rendered analytically with 4x4 supersampling per pixel, so edges
// are properly anti-aliased without any image tooling in the repo.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------- minimal PNG encoder ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- analytic shapes (signed distance, unit coords 0..1) ---------- */

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/* ---------- the snippit-good mark ---------- */

const MINT_TOP = hex('#41efc6');
const MINT_BOT = hex('#14ad85');
const INK = hex('#06251c');
const CORAL = hex('#ff5a4e');

// returns [r,g,b,a] for a unit-space point
function shade(x, y) {
  // badge: rounded square, near-full bleed
  const badge = sdRoundedRect(x, y, 0.5, 0.5, 0.465, 0.465, 0.24);
  if (badge > 0) return null;

  // base: vertical mint gradient with a soft top-left highlight
  let rgb = [
    lerp(MINT_TOP[0], MINT_BOT[0], y),
    lerp(MINT_TOP[1], MINT_BOT[1], y),
    lerp(MINT_TOP[2], MINT_BOT[2], y),
  ];
  const hl = Math.max(0, 1 - Math.hypot(x - 0.28, y - 0.2) * 1.7) * 0.18;
  rgb = rgb.map((v) => Math.min(255, v + 255 * hl));

  // crop brackets: top-left and bottom-right L shapes
  const t = 0.052; // half-thickness of the stroke
  const arm = 0.21;
  const tlx = 0.275, tly = 0.275; // top-left corner
  const brx = 0.725, bry = 0.725; // bottom-right corner
  const dBracket = Math.min(
    sdSegment(x, y, tlx, tly, tlx + arm, tly),
    sdSegment(x, y, tlx, tly, tlx, tly + arm),
    sdSegment(x, y, brx, bry, brx - arm, bry),
    sdSegment(x, y, brx, bry, brx, bry - arm),
  ) - t;

  // capture dot, slightly toward the upper-right like a focus point
  const dDot = Math.hypot(x - 0.56, y - 0.44) - 0.115;

  if (dDot < 0) rgb = CORAL.slice();
  else if (dBracket < 0) rgb = INK.slice();

  return [rgb[0], rgb[1], rgb[2], 255];
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      // premultiply against the sample average so edges stay clean
      buf[i] = alpha ? Math.round(r / n) : 0;
      buf[i + 1] = alpha ? Math.round(g / n) : 0;
      buf[i + 2] = alpha ? Math.round(b / n) : 0;
      buf[i + 3] = Math.round(alpha);
    }
  }
  return encodePNG(size, size, buf);
}

/* ---------- ICO container (PNG-compressed entries, Vista+) ---------- */

function buildIco(sizes) {
  const pngs = sizes.map((s) => ({ size: s, data: render(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
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

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), render(256));
fs.writeFileSync(path.join(outDir, 'tray.png'), render(32));
fs.writeFileSync(path.join(outDir, 'icon-preview-128.png'), render(128));
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco([16, 24, 32, 48, 64, 128, 256]));
console.log('wrote assets/icon.png (256), tray.png (32), icon-preview-128.png, icon.ico');
