'use strict';
/* snippit-good library window: a scrollable history of every capture on the
   left; images open in the annotation editor (vector op-list over a base
   image — undo/redo just moves the op stack), recordings open in a playback
   pane. Edits can be saved back to the library as re-editable variants. */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const viewport = document.getElementById('viewport');
const textLayer = document.getElementById('text-layer');
const dimsEl = document.getElementById('dims');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');
const sideList = document.getElementById('side-list');
const sideCount = document.getElementById('side-count');
const titleMeta = document.getElementById('title-meta');
const vplayer = document.getElementById('vplayer');

const SWATCH_COLORS = ['#ff5a4e', '#ff9f1c', '#ffe14d', '#35e0b4', '#3da9ff', '#c084fc', '#ffffff', '#111418'];
const WIDTHS = [2, 4, 6, 10];
const TEXT_SIZES = { 2: 18, 4: 26, 6: 36, 10: 52 };

const state = {
  tool: 'pen',
  color: '#ff5a4e',
  width: 4,
  zoom: 1,
  fitMode: true,
  ops: [],
  redo: [],
  tempOp: null,
  cropMode: false,
  drawing: false,
  snip: null,   // the currently open library item (image mode)
  dirty: false, // unsaved annotation changes since the item was loaded
};

let items = [];       // library listing for the sidebar
let currentId = null; // selected item id

const baseImg = new Image();

/* ---------------- geometry ---------------- */

function fullRect() { return { x: 0, y: 0, w: baseImg.naturalWidth, h: baseImg.naturalHeight }; }

function effectiveCrop() {
  let crop = fullRect();
  for (const op of state.ops) {
    if (op.type === 'crop') crop = { ...op.rect };
    else if (op.type === 'uncrop') crop = fullRect();
  }
  return crop;
}

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// pointer event -> image-space coords
function toImage(e) {
  const r = canvas.getBoundingClientRect();
  const crop = effectiveCrop();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width) + crop.x,
    y: (e.clientY - r.top) * (canvas.height / r.height) + crop.y,
  };
}

/* ---------------- rendering ---------------- */

function drawOp(op) {
  switch (op.type) {
    case 'pen':
    case 'highlight': {
      const pts = op.points;
      if (!pts.length) return;
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (op.type === 'highlight') {
        ctx.globalAlpha = 0.36;
        ctx.lineWidth = op.width * 3.5;
        ctx.lineCap = 'butt';
      } else {
        ctx.lineWidth = op.width;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) ctx.lineTo(pts[0].x + 0.1, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
      }
      if (pts.length > 1) ctx.lineTo(pts.at(-1).x, pts.at(-1).y);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'rect': {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineJoin = 'round';
      ctx.strokeRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h);
      ctx.restore();
      break;
    }
    case 'ellipse': {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.beginPath();
      ctx.ellipse(op.rect.x + op.rect.w / 2, op.rect.y + op.rect.h / 2, op.rect.w / 2, op.rect.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'line':
    case 'arrow': {
      ctx.save();
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineCap = 'round';
      const { a, b } = op;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      let end = b;
      const head = Math.max(12, op.width * 3.2);
      if (op.type === 'arrow') {
        // pull the shaft back so it doesn't poke through the head
        end = { x: b.x - Math.cos(angle) * head * 0.6, y: b.y - Math.sin(angle) * head * 0.6 };
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      if (op.type === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - Math.cos(angle - 0.42) * head, b.y - Math.sin(angle - 0.42) * head);
        ctx.lineTo(b.x - Math.cos(angle + 0.42) * head, b.y - Math.sin(angle + 0.42) * head);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case 'text': {
      ctx.save();
      ctx.fillStyle = op.color;
      ctx.font = `600 ${op.size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      op.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, op.x, op.y + i * op.size * 1.25);
      });
      ctx.restore();
      break;
    }
    case 'pixelate': {
      const r = op.rect;
      if (r.w < 2 || r.h < 2) return;
      const block = Math.max(8, Math.round(Math.min(r.w, r.h) / 9));
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.ceil(r.w / block));
      off.height = Math.max(1, Math.ceil(r.h / block));
      const octx = off.getContext('2d');
      octx.imageSmoothingEnabled = true;
      octx.drawImage(baseImg, r.x, r.y, r.w, r.h, 0, 0, off.width, off.height);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, off.width, off.height, r.x, r.y, r.w, r.h);
      ctx.restore();
      break;
    }
    case 'crop-preview': {
      const r = op.rect;
      ctx.save();
      ctx.fillStyle = 'rgba(8, 10, 14, 0.55)';
      const c = effectiveCrop();
      ctx.fillRect(c.x, c.y, c.w, r.y - c.y);
      ctx.fillRect(c.x, r.y + r.h, c.w, c.y + c.h - r.y - r.h);
      ctx.fillRect(c.x, r.y, r.x - c.x, r.h);
      ctx.fillRect(r.x + r.w, r.y, c.x + c.w - r.x - r.w, r.h);
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = Math.max(1, 1.5 / state.zoom);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
      break;
    }
  }
}

function render() {
  const crop = effectiveCrop();
  canvas.width = Math.max(1, Math.round(crop.w));
  canvas.height = Math.max(1, Math.round(crop.h));
  ctx.save();
  ctx.translate(-crop.x, -crop.y);
  ctx.drawImage(baseImg, 0, 0);
  for (const op of state.ops) drawOp(op);
  if (state.tempOp) drawOp(state.tempOp);
  ctx.restore();

  applyZoom();
  dimsEl.textContent = `${canvas.width} × ${canvas.height}`;
  document.getElementById('btn-undo').disabled = state.ops.length === 0;
  document.getElementById('btn-redo').disabled = state.redo.length === 0;
}

function applyZoom() {
  canvas.style.width = `${canvas.width * state.zoom}px`;
  canvas.style.height = `${canvas.height * state.zoom}px`;
  document.getElementById('zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitZoom() {
  const pad = 48;
  const zw = (viewport.clientWidth - pad) / canvas.width;
  const zh = (viewport.clientHeight - pad) / canvas.height;
  state.zoom = Math.max(0.05, Math.min(1, zw, zh));
  state.fitMode = true;
  applyZoom();
}

function setZoom(z) {
  state.zoom = Math.min(5, Math.max(0.05, z));
  state.fitMode = false;
  applyZoom();
}

/* ---------------- ops / history ---------------- */

function pushOp(op) {
  state.ops.push(op);
  state.redo = [];
  state.dirty = true;
  render();
}

function undo() {
  if (!state.ops.length) return;
  commitText();
  state.redo.push(state.ops.pop());
  state.dirty = true;
  render();
}

function redo() {
  if (!state.redo.length) return;
  state.ops.push(state.redo.pop());
  state.dirty = true;
  render();
}

/* ---------------- drawing interactions ---------------- */

let dragStart = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  commitText();
  const p = toImage(e);

  if (state.cropMode) {
    state.drawing = true;
    dragStart = p;
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  switch (state.tool) {
    case 'pen':
    case 'highlight':
      state.tempOp = { type: state.tool, color: state.color, width: state.width, points: [p] };
      break;
    case 'rect':
    case 'ellipse':
    case 'pixelate':
      state.tempOp = { type: state.tool, color: state.color, width: state.width, rect: normRect(p, p) };
      break;
    case 'line':
    case 'arrow':
      state.tempOp = { type: state.tool, color: state.color, width: state.width, a: p, b: p };
      break;
    case 'text':
      openTextInput(p);
      return;
  }
  state.drawing = true;
  dragStart = p;
  canvas.setPointerCapture(e.pointerId);
  render();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  const p = toImage(e);

  if (state.cropMode) {
    state.tempOp = { type: 'crop-preview', rect: normRect(dragStart, p) };
    render();
    return;
  }

  const op = state.tempOp;
  if (!op) return;
  if (op.points) op.points.push(p);
  else if (op.rect) op.rect = normRect(dragStart, p);
  else { op.b = p; }
  render();
});

canvas.addEventListener('pointerup', () => {
  if (!state.drawing) return;
  state.drawing = false;

  if (state.cropMode) {
    const r = state.tempOp && state.tempOp.rect;
    state.tempOp = null;
    setCropMode(false);
    if (r && r.w >= 8 && r.h >= 8) {
      const crop = effectiveCrop();
      const clamped = {
        x: Math.max(crop.x, r.x),
        y: Math.max(crop.y, r.y),
      };
      clamped.w = Math.min(crop.x + crop.w, r.x + r.w) - clamped.x;
      clamped.h = Math.min(crop.y + crop.h, r.y + r.h) - clamped.y;
      if (clamped.w >= 8 && clamped.h >= 8) {
        pushOp({ type: 'crop', rect: clamped });
        if (state.fitMode) fitZoom();
      }
    }
    render();
    return;
  }

  const op = state.tempOp;
  state.tempOp = null;
  if (!op) return;
  // ignore zero-size shapes (accidental clicks)
  if (op.rect && (op.rect.w < 3 || op.rect.h < 3) && op.type !== 'pixelate') { render(); return; }
  if (op.rect && op.type === 'pixelate' && (op.rect.w < 3 || op.rect.h < 3)) { render(); return; }
  if (op.a && Math.hypot(op.b.x - op.a.x, op.b.y - op.a.y) < 3) { render(); return; }
  pushOp(op);
});

/* ---------------- text tool ---------------- */

let activeText = null;

function openTextInput(p) {
  commitText();
  const crop = effectiveCrop();
  const size = TEXT_SIZES[state.width] || 26;
  const ta = document.createElement('textarea');
  ta.rows = 1;
  ta.style.left = `${(p.x - crop.x) * state.zoom}px`;
  ta.style.top = `${(p.y - crop.y) * state.zoom}px`;
  ta.style.fontSize = `${size * state.zoom}px`;
  ta.style.color = state.color;
  ta.style.lineHeight = '1.25';
  textLayer.appendChild(ta);
  activeText = { ta, p, size, color: state.color };
  setTimeout(() => ta.focus(), 0);

  const grow = () => {
    ta.style.width = 'auto';
    ta.style.height = 'auto';
    ta.style.width = `${Math.max(40, ta.scrollWidth + 8)}px`;
    ta.style.height = `${ta.scrollHeight}px`;
  };
  ta.addEventListener('input', grow);
  grow();

  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
    if (e.key === 'Escape') { activeText = null; ta.remove(); }
  });
  ta.addEventListener('blur', () => commitText());
}

function commitText() {
  if (!activeText) return;
  const { ta, p, size, color } = activeText;
  activeText = null;
  const text = ta.value.trimEnd();
  ta.remove();
  if (text) pushOp({ type: 'text', x: p.x, y: p.y, text, size, color });
}

/* ---------------- toolbar wiring ---------------- */

const toolBtns = [...document.querySelectorAll('.tool')];
function setTool(tool) {
  state.tool = tool;
  setCropMode(false);
  toolBtns.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.classList.toggle('tool-text', tool === 'text');
}
toolBtns.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

function setCropMode(on) {
  state.cropMode = on;
  document.getElementById('btn-crop').classList.toggle('active', on);
}
document.getElementById('btn-crop').addEventListener('click', () => {
  commitText();
  setCropMode(!state.cropMode);
});
document.getElementById('btn-reset').addEventListener('click', () => {
  commitText();
  const crop = effectiveCrop();
  const full = fullRect();
  if (crop.x === full.x && crop.y === full.y && crop.w === full.w && crop.h === full.h) return;
  pushOp({ type: 'uncrop' });
  if (state.fitMode) fitZoom();
  render();
});

/* colour popover */
const colorPop = document.getElementById('color-pop');
const swatchHolder = colorPop.querySelector('.swatches');
SWATCH_COLORS.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.title = c;
  b.addEventListener('click', () => { setColor(c); hidePopovers(); });
  swatchHolder.appendChild(b);
});
document.getElementById('color-input').addEventListener('input', (e) => setColor(e.target.value));

function setColor(c) {
  state.color = c;
  document.getElementById('color-swatch').style.background = c;
  [...swatchHolder.children].forEach((b) => b.classList.toggle('active', b.title === c));
}

/* width popover */
const widthPop = document.getElementById('width-pop');
WIDTHS.forEach((w) => {
  const b = document.createElement('button');
  b.className = 'width-opt';
  b.dataset.w = w;
  b.innerHTML = `<span>${w}px</span><span class="bar" style="height:${w}px"></span>`;
  b.addEventListener('click', () => { setWidth(w); hidePopovers(); });
  widthPop.appendChild(b);
});

function setWidth(w) {
  state.width = w;
  document.getElementById('width-dot').style.setProperty('--dot', `${Math.min(14, w + 3)}px`);
  [...widthPop.children].forEach((b) => b.classList.toggle('active', Number(b.dataset.w) === w));
}

function togglePopover(pop, anchor) {
  const wasHidden = pop.hidden;
  hidePopovers();
  if (wasHidden) {
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.hidden = false;
  }
}
function hidePopovers() { colorPop.hidden = true; widthPop.hidden = true; }
document.getElementById('color-btn').addEventListener('click', (e) => { e.stopPropagation(); togglePopover(colorPop, e.currentTarget); });
document.getElementById('width-btn').addEventListener('click', (e) => { e.stopPropagation(); togglePopover(widthPop, e.currentTarget); });
window.addEventListener('click', (e) => {
  if (!colorPop.contains(e.target) && !widthPop.contains(e.target)) hidePopovers();
});

/* undo / redo */
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

/* zoom */
document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
document.getElementById('btn-zoom-fit').addEventListener('click', fitZoom);
document.getElementById('zoom-label').addEventListener('click', () => setZoom(1));
viewport.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
}, { passive: false });
window.addEventListener('resize', () => { if (state.fitMode) fitZoom(); });

/* copy / save */
let toastTimer = null;
function showToast(text) {
  toastText.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
}

async function copyToClipboard() {
  commitText();
  state.tempOp = null;
  render();
  const ok = await window.snippit.copyImage(canvas.toDataURL('image/png'));
  showToast(ok ? 'Copied to clipboard' : 'Copy failed');
}

async function saveImage() {
  commitText();
  state.tempOp = null;
  render();
  const stamp = new Date(state.snip ? state.snip.createdAt : Date.now())
    .toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const ok = await window.snippit.saveImage(canvas.toDataURL('image/png'), `snip-${stamp}.png`);
  if (ok) showToast('Image saved');
}

document.getElementById('btn-copy').addEventListener('click', copyToClipboard);
document.getElementById('btn-save').addEventListener('click', saveImage);

/* keyboard */
window.addEventListener('keydown', (e) => {
  if (activeText) return;
  if (!shareModal.hidden) {
    if (e.key === 'Escape') closeShareDialog();
    return; // the dialog owns the keyboard while open
  }
  const k = e.key.toLowerCase();
  if (document.body.classList.contains('mode-video')) {
    // playback pane: Ctrl+C copies the video file
    if (e.ctrlKey && k === 'c' && currentId) {
      e.preventDefault();
      window.snippit.copySnip(currentId).then((ok) => showToast(ok ? 'File copied — paste it anywhere' : 'Copy failed'));
    }
    return;
  }
  if (document.body.classList.contains('mode-empty')) return;
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && k === 'c') { e.preventDefault(); copyToClipboard(); return; }
  if (e.ctrlKey && k === 's') { e.preventDefault(); saveImage(); return; }
  if (e.ctrlKey) return;
  const map = { p: 'pen', h: 'highlight', r: 'rect', c: 'ellipse', l: 'line', a: 'arrow', t: 'text', x: 'pixelate' };
  if (map[k]) setTool(map[k]);
  if (e.key === 'Escape') { state.tempOp = null; state.drawing = false; setCropMode(false); render(); }
});

/* ---------------- save as variant ---------------- */

async function saveVariant() {
  if (document.body.classList.contains('mode-video') || !state.snip) return;
  commitText();
  state.tempOp = null;
  render();
  if (!state.ops.length) {
    showToast('Draw something first — variants capture your edits');
    return;
  }
  // ops always replay over the ORIGINAL pixels: when a variant is open, its
  // parent is the true owner of the base image
  const parentId = state.snip.ops ? (state.snip.parentId || state.snip.id) : state.snip.id;
  const newId = await window.snippit.libraryAddVariant({
    parentId,
    dataUrl: canvas.toDataURL('image/png'),
    ops: state.ops,
  });
  if (newId) {
    state.dirty = false;
    showToast('Saved to library');
  } else {
    showToast('Could not save the variant');
  }
}
document.getElementById('btn-variant').addEventListener('click', saveVariant);

/* ---------------- history sidebar ---------------- */

const KIND_ICONS = {
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10.5 22 7v10l-7-3.5"/></svg>',
};

function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return time;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${time}`;
}

function makeCard(it) {
  const card = document.createElement('div');
  card.className = 'side-item';
  card.dataset.id = it.id;
  if (it.id === currentId) card.classList.add('active');
  card.title = it.fileName;

  if (it.thumbUrl) {
    const img = document.createElement('img');
    img.src = it.thumbUrl;
    img.loading = 'lazy';
    img.draggable = false;
    card.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'no-thumb';
    ph.innerHTML = KIND_ICONS[it.kind] || KIND_ICONS.image;
    card.appendChild(ph);
  }

  if (it.kind === 'video') {
    const tag = document.createElement('span');
    tag.className = 'tag video';
    tag.textContent = fmtDuration(it.durationMs);
    card.appendChild(tag);
  } else if (it.parentId) {
    const tag = document.createElement('span');
    tag.className = 'tag edit';
    tag.textContent = 'EDIT';
    card.appendChild(tag);
  }

  const meta = document.createElement('div');
  meta.className = 'side-meta';
  meta.innerHTML = `${KIND_ICONS[it.kind] || KIND_ICONS.image}<span>${it.width} × ${it.height}</span>`;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = fmtWhen(it.createdAt);
  meta.appendChild(when);
  card.appendChild(meta);

  const del = document.createElement('button');
  del.className = 'side-del';
  del.title = 'Delete from history (removes the file)';
  del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('Delete this capture permanently? The file is removed from disk.')) {
      window.snippit.removeSnip(it.id);
    }
  });
  card.appendChild(del);

  card.addEventListener('click', () => selectItem(it.id));
  return card;
}

/* Variants nest under their original so edit chains stay visible as one
   group. Groups order by their latest activity — editing an old capture
   floats the whole family back to the top. */
function renderList() {
  sideList.replaceChildren();
  sideCount.textContent = items.length ? `${items.length}` : '';
  const ids = new Set(items.map((i) => i.id));
  const kids = new Map();
  const roots = [];
  for (const it of items) {
    if (it.parentId && ids.has(it.parentId)) {
      if (!kids.has(it.parentId)) kids.set(it.parentId, []);
      kids.get(it.parentId).push(it);
    } else {
      roots.push(it); // orphaned variants surface as top-level items
    }
  }
  const activity = (r) => Math.max(r.createdAt, ...(kids.get(r.id) || []).map((k) => k.createdAt));
  roots.sort((a, b) => activity(b) - activity(a));
  for (const root of roots) {
    sideList.appendChild(makeCard(root));
    const variants = (kids.get(root.id) || []).sort((a, b) => a.createdAt - b.createdAt);
    for (const v of variants) {
      const row = document.createElement('div');
      row.className = 'nest-row';
      row.appendChild(makeCard(v));
      sideList.appendChild(row);
    }
  }
}

function setMode(mode) {
  document.body.classList.toggle('mode-video', mode === 'video');
  document.body.classList.toggle('mode-empty', mode === 'empty');
  document.getElementById('empty-pane').hidden = mode !== 'empty';
  document.getElementById('video-pane').hidden = mode !== 'video';
  if (mode !== 'video') {
    vplayer.pause();
    vplayer.removeAttribute('src');
    vplayer.load();
  }
}

async function selectItem(id, opts = {}) {
  if (id === currentId && !opts.force) return;
  if (state.dirty && !opts.force
    && !confirm('Discard the unsaved annotations on the current image?')) return;
  const item = await window.snippit.libraryGet(id);
  if (!item) { await refreshList(); return; }
  currentId = id;
  state.dirty = false;
  sideList.querySelectorAll('.side-item').forEach((el) =>
    el.classList.toggle('active', el.dataset.id === id));
  titleMeta.textContent = item.fileName || '';

  if (item.kind === 'video') {
    setMode('video');
    state.snip = null;
    document.getElementById('video-meta').textContent =
      `${item.width} × ${item.height} · ${fmtDuration(item.durationMs)}`;
    vplayer.src = item.fileUrl;
    // MediaRecorder webm files report Infinity until the tail is parsed
    vplayer.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(vplayer.duration)) {
        const back = () => { vplayer.currentTime = 0; vplayer.removeEventListener('seeked', back); };
        vplayer.addEventListener('seeked', back);
        vplayer.currentTime = 1e7;
      }
    }, { once: true });
    return;
  }

  setMode('image');
  if (activeText) { activeText.ta.remove(); activeText = null; } // drop, don't commit into the new item
  state.snip = item;
  state.tempOp = null;
  state.drawing = false;
  state.cropMode = false;
  state.redo = [];
  state.ops = Array.isArray(item.ops) ? JSON.parse(JSON.stringify(item.ops)) : [];
  await new Promise((resolve, reject) => {
    baseImg.onload = resolve;
    baseImg.onerror = reject;
    baseImg.src = item.dataUrl;
  }).catch(() => {});
  render();
  fitZoom();
}

async function refreshList(keepSelection = true) {
  items = await window.snippit.libraryList();
  if (!items.length) {
    currentId = null;
    state.snip = null;
    renderList();
    setMode('empty');
    titleMeta.textContent = '';
    return;
  }
  const stillThere = keepSelection && items.some((i) => i.id === currentId);
  renderList();
  if (!stillThere) await selectItem(items[0].id, { force: true });
}

/* ---------------- share links ---------------- */

const shareModal = document.getElementById('share-modal');
const shareGo = document.getElementById('share-go');
const shareErr = document.getElementById('share-error');
const shareResult = document.getElementById('share-result');
const shareUrlEl = document.getElementById('share-url');
const shareProgress = document.getElementById('share-progress');
const shareFill = document.getElementById('share-progress-fill');
let shareBusy = false;

function openShareDialog() {
  if (!currentId) return;
  shareBusy = false;
  shareErr.hidden = true;
  shareResult.hidden = true;
  shareProgress.hidden = true;
  shareFill.style.width = '0%';
  shareGo.disabled = false;
  shareGo.hidden = false;
  document.getElementById('share-expiry').value = '30';
  document.getElementById('share-password').value = '';
  document.getElementById('share-maxviews').value = '';
  shareModal.hidden = false;
}

function closeShareDialog() {
  if (!shareBusy) shareModal.hidden = true;
}

document.getElementById('share-cancel').addEventListener('click', closeShareDialog);
shareModal.addEventListener('click', (e) => { if (e.target === shareModal) closeShareDialog(); });

shareGo.addEventListener('click', async () => {
  if (shareBusy) return;
  shareBusy = true;
  shareGo.disabled = true;
  shareErr.hidden = true;
  shareProgress.hidden = false;
  shareFill.style.width = '0%';

  const expiry = document.getElementById('share-expiry').value;
  const payload = {
    expiresInDays: expiry ? Number(expiry) : null,
    password: document.getElementById('share-password').value || null,
    maxViews: Number(document.getElementById('share-maxviews').value) || null,
  };
  if (document.body.classList.contains('mode-video')) {
    payload.id = currentId; // the recording file uploads as-is
  } else {
    // images share the canvas as rendered, annotations included
    commitText();
    state.tempOp = null;
    render();
    payload.dataUrl = canvas.toDataURL('image/png');
    payload.fileName = `${((state.snip && state.snip.fileName) || 'snip.png').replace(/\.[^.]+$/, '')}.png`;
  }

  const res = await window.snippit.shareCreate(payload);
  shareBusy = false;
  shareProgress.hidden = true;
  if (res.ok) {
    shareGo.hidden = true;
    shareResult.hidden = false;
    shareUrlEl.value = res.url;
    showToast('Share link copied');
  } else {
    shareGo.disabled = false;
    shareErr.hidden = false;
    shareErr.textContent = res.error || 'Share failed.';
  }
});

window.snippit.onShareProgress(({ pct }) => {
  if (!shareModal.hidden) shareFill.style.width = `${pct}%`;
});
shareUrlEl.addEventListener('click', () => shareUrlEl.select());
document.getElementById('btn-vshare').addEventListener('click', openShareDialog);
document.getElementById('btn-share').addEventListener('click', openShareDialog);

/* video pane actions */
document.getElementById('btn-vcopy').addEventListener('click', async () => {
  showToast((await window.snippit.copySnip(currentId)) ? 'File copied — paste it anywhere' : 'Copy failed');
});
document.getElementById('btn-vsave').addEventListener('click', async () => {
  if (await window.snippit.saveVideo(currentId)) showToast('Saved');
});
document.getElementById('btn-vfolder').addEventListener('click', () => {
  window.snippit.libraryShowInFolder(currentId);
});

window.snippit.onLibraryChanged(() => refreshList(true));
window.snippit.onLibrarySelect((id) => selectItem(id));

/* ---------------- boot ---------------- */

(async function boot() {
  setColor(state.color);
  setWidth(state.width);
  const id = new URLSearchParams(location.search).get('id');
  items = await window.snippit.libraryList();
  renderList();
  if (!items.length) { setMode('empty'); return; }
  const target = id && items.some((i) => i.id === id) ? id : items[0].id;
  await selectItem(target, { force: true });
})();
