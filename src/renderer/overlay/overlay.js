'use strict';
const shot = document.getElementById('shot');
const shade = document.getElementById('shade');
const sel = document.getElementById('sel');
const dims = document.getElementById('dims');
const hint = document.getElementById('hint');
const hintText = document.getElementById('hint-text');
const modeImageBtn = document.getElementById('mode-image');
const modeVideoBtn = document.getElementById('mode-video');

const MIN_SIZE = 6; // selections smaller than this are treated as accidental

let displayId = null;
let dragging = false;
let start = { x: 0, y: 0 };
let mode = 'image'; // 'image' snips a still, 'video' starts a screen recording

function paintMode() {
  document.body.dataset.mode = mode;
  modeImageBtn.classList.toggle('active', mode === 'image');
  modeVideoBtn.classList.toggle('active', mode === 'video');
  hintText.textContent = mode === 'video' ? 'Drag to record' : 'Drag to capture';
}

// armed: the window goes up instantly but paints NOTHING (only the crosshair
// cursor) until the clean screenshot lands — anything we draw before that
// could leak into the captured frame on machines where the OS capture API
// ignores content protection (e.g. DXGI desktop duplication). Drags are
// tracked from the first moment; the visuals catch up when the frame arrives.
window.snippit.onOverlayArm(({ displayId: id, mode: m }) => {
  displayId = id;
  dragging = false;
  mode = m === 'video' ? 'video' : 'image';
  paintMode();
  document.body.classList.remove('ready');
  shot.removeAttribute('src');
  shot.hidden = true;
  sel.hidden = true;
  shade.hidden = false;
  hint.classList.remove('gone');
});

window.snippit.onOverlayImage(({ dataUrl }) => {
  shot.src = dataUrl;
  shot.hidden = false;
  document.body.classList.add('ready'); // capture is done — safe to paint
});

// hidden again — release the decoded full-screen frame
window.snippit.onOverlayReset(() => {
  dragging = false;
  document.body.classList.remove('ready');
  shot.removeAttribute('src');
  shot.hidden = true;
  sel.hidden = true;
});

// mode changes echo back from main so every display's overlay stays in sync
window.snippit.onOverlayMode((m) => {
  mode = m === 'video' ? 'video' : 'image';
  paintMode();
});

modeImageBtn.addEventListener('click', () => window.snippit.setOverlayMode('image'));
modeVideoBtn.addEventListener('click', () => window.snippit.setOverlayMode('video'));

function rectFrom(a, b) {
  return {
    x: Math.max(0, Math.min(a.x, b.x)),
    y: Math.max(0, Math.min(a.y, b.y)),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function paintSel(r) {
  sel.style.left = `${r.x}px`;
  sel.style.top = `${r.y}px`;
  sel.style.width = `${r.w}px`;
  sel.style.height = `${r.h}px`;
  dims.textContent = `${r.w} × ${r.h}`;
  sel.classList.toggle('flip-dims', r.y + r.h > window.innerHeight - 56);
}

window.addEventListener('mousedown', (e) => {
  if (e.button === 2) return; // right-click cancels on mouseup below
  if (e.target.closest('#hint')) return; // clicks on the hint pill aren't drags
  dragging = true;
  start = { x: e.clientX, y: e.clientY };
  hint.classList.add('gone');
  shade.hidden = true;
  sel.hidden = false;
  paintSel(rectFrom(start, start));
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  paintSel(rectFrom(start, { x: e.clientX, y: e.clientY }));
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2) { window.snippit.overlayCancel(); return; }
  if (!dragging) return;
  dragging = false;
  const r = rectFrom(start, { x: e.clientX, y: e.clientY });
  if (r.w < MIN_SIZE || r.h < MIN_SIZE) {
    // accidental click — reset and keep snipping
    sel.hidden = true;
    shade.hidden = false;
    hint.classList.remove('gone');
    return;
  }
  window.snippit.overlaySelect({ displayId, rect: r, mode });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.snippit.overlayCancel();
  if (e.key === 'Tab') {
    e.preventDefault();
    window.snippit.setOverlayMode(mode === 'image' ? 'video' : 'image');
  }
});

window.addEventListener('contextmenu', (e) => e.preventDefault());
