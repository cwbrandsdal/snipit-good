'use strict';
/* Armed-state region adjustment. The window covers the whole display and is
   click-through by default (forwarded mouse-moves keep arriving); hovering a
   handle or border line makes the window interactive so the drag can happen,
   and leaving them hands the mouse back to the desktop underneath. */

const PAD = 3;        // border thickness; the box is drawn PAD outside the region
const MIN = 24;       // smallest selectable region edge, CSS px

const box = document.getElementById('box');
const dims = document.getElementById('dims');

let rect = { x: 0, y: 0, w: 0, h: 0 };
let locked = true;
let ignoring = true;  // mirrors main's setIgnoreMouseEvents state
let drag = null;      // { k, x0, y0, r0 }

const W = () => window.innerWidth;
const H = () => window.innerHeight;

function paint() {
  box.style.left = `${rect.x - PAD}px`;
  box.style.top = `${rect.y - PAD}px`;
  box.style.width = `${rect.w + PAD * 2}px`;
  box.style.height = `${rect.h + PAD * 2}px`;
  dims.textContent = `${rect.w} × ${rect.h}`;
  box.classList.toggle('flip-dims', rect.y + rect.h > H() - 56);
}

function setIgnore(v) {
  if (locked || ignoring === v) return;
  ignoring = v;
  window.snippit.frameSetIgnore(v);
}

function applyDrag(k, dx, dy, r0) {
  let { x, y, w, h } = r0;
  if (k === 'move') {
    x = Math.max(0, Math.min(r0.x + dx, W() - r0.w));
    y = Math.max(0, Math.min(r0.y + dy, H() - r0.h));
    return { x, y, w, h };
  }
  if (k.includes('w')) { x = r0.x + dx; w = r0.w - dx; }
  if (k.includes('e')) { w = r0.w + dx; }
  if (k.includes('n')) { y = r0.y + dy; h = r0.h - dy; }
  if (k.includes('s')) { h = r0.h + dy; }
  if (w < MIN) { if (k.includes('w')) x = r0.x + r0.w - MIN; w = MIN; }
  if (h < MIN) { if (k.includes('n')) y = r0.y + r0.h - MIN; h = MIN; }
  x = Math.max(0, Math.min(x, W() - MIN));
  y = Math.max(0, Math.min(y, H() - MIN));
  w = Math.min(w, W() - x);
  h = Math.min(h, H() - y);
  return { x, y, w, h };
}

window.snippit.onFrameSetup(({ rect: r, locked: l }) => {
  rect = r;
  locked = !!l;
  ignoring = true; // main starts every setup in click-through mode
  document.body.classList.toggle('locked', locked);
  paint();
});

window.snippit.onFrameLock(() => {
  locked = true;
  drag = null;
  document.body.classList.add('locked');
  document.body.style.cursor = '';
  paint();
});

window.addEventListener('mousedown', (e) => {
  if (locked || e.button !== 0) return;
  const hit = e.target.closest('[data-k]');
  if (!hit) return;
  e.preventDefault();
  drag = { k: hit.dataset.k, x0: e.clientX, y0: e.clientY, r0: { ...rect } };
  document.body.style.cursor = getComputedStyle(hit).cursor;
});

function endDrag(e) {
  drag = null;
  document.body.style.cursor = '';
  window.snippit.frameRect(rect);
  setIgnore(!e.target.closest('[data-k]'));
}

window.addEventListener('mousemove', (e) => {
  if (locked) return;
  if (drag) {
    // a move without the left button held means we missed the mouseup
    if ((e.buttons & 1) === 0) { endDrag(e); return; }
    rect = applyDrag(drag.k, e.clientX - drag.x0, e.clientY - drag.y0, drag.r0);
    paint();
    window.snippit.frameRect(rect);
    return;
  }
  // hover routing: interactive over handles/edges, click-through elsewhere
  setIgnore(!e.target.closest('[data-k]'));
});

window.addEventListener('mouseup', (e) => {
  if (drag) endDrag(e);
});

window.addEventListener('contextmenu', (e) => e.preventDefault());
