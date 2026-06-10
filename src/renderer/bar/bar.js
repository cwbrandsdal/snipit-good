'use strict';
const thumbsEl = document.getElementById('thumbs');
const chip = document.getElementById('chip');
const chipText = document.getElementById('chip-text');
const shortcutHint = document.getElementById('shortcut-hint');

let knownIds = new Set();
let chipTimer = null;

/* ---- auto-hide: the bar lingers, then fades away; hovering keeps it ---- */
const AUTO_HIDE_MS = 10000; // linger after appearing
const LEAVE_HIDE_MS = 4000; // linger after the mouse leaves
const FADE_MS = 500;
const barEl = document.getElementById('bar');
let hideTimer = null;
let fadeTimer = null;
let pinned = false;
let hovering = false;

function cancelAutoHide() {
  clearTimeout(hideTimer);
  clearTimeout(fadeTimer);
  hideTimer = fadeTimer = null;
  barEl.classList.remove('fading');
}

function armAutoHide(ms) {
  cancelAutoHide();
  if (pinned || hovering) return;
  hideTimer = setTimeout(() => {
    barEl.classList.add('fading');
    fadeTimer = setTimeout(() => {
      barEl.classList.remove('fading');
      window.snippit.hideBar();
    }, FADE_MS);
  }, ms);
}

document.body.addEventListener('mouseenter', () => {
  hovering = true;
  cancelAutoHide();
});
document.body.addEventListener('mouseleave', () => {
  hovering = false;
  armAutoHide(LEAVE_HIDE_MS);
});

window.snippit.onBarVisible(() => armAutoHide(AUTO_HIDE_MS));

const pinBtn = document.getElementById('btn-pin');
pinBtn.addEventListener('click', () => {
  window.snippit.setSettings({ pinBar: !pinned });
});

function paintPin() {
  pinBtn.classList.toggle('active', pinned);
  pinBtn.title = pinned ? 'Unpin — let the bar hide itself' : 'Keep bar open';
}

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/></svg>',
};

function showChip(text) {
  chipText.textContent = text;
  chip.hidden = false;
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => { chip.hidden = true; }, 1400);
}

function render({ snips, shortcut, pinBar, event }) {
  shortcutHint.textContent = shortcut || '';
  const wasPinned = pinned;
  pinned = !!pinBar;
  paintPin();
  if (pinned) cancelAutoHide();
  else if (wasPinned || (event && event.type.startsWith('captured'))) armAutoHide(AUTO_HIDE_MS);
  thumbsEl.replaceChildren();

  snips.forEach((snip, i) => {
    const card = document.createElement('div');
    card.className = 'thumb';
    if (i === 0) card.classList.add('newest');
    if (!knownIds.has(snip.id)) card.classList.add('enter');
    card.title = 'Open in editor';

    const img = document.createElement('img');
    img.src = snip.thumb;
    img.draggable = false;
    card.appendChild(img);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${snip.width} × ${snip.height}`;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const mkBtn = (icon, title, cls, fn) => {
      const b = document.createElement('button');
      b.className = `icon-btn ${cls || ''}`;
      b.title = title;
      b.innerHTML = ICONS[icon];
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    actions.appendChild(mkBtn('edit', 'Edit', '', () => window.snippit.editSnip(snip.id)));
    actions.appendChild(mkBtn('copy', 'Copy to clipboard', '', async () => {
      if (await window.snippit.copySnip(snip.id)) showChip('Copied');
    }));
    actions.appendChild(mkBtn('del', 'Remove from recent snips', 'del', () => window.snippit.removeSnip(snip.id)));
    card.appendChild(actions);

    card.addEventListener('click', () => window.snippit.editSnip(snip.id));
    thumbsEl.appendChild(card);
  });

  knownIds = new Set(snips.map((s) => s.id));

  if (event && event.type === 'captured-copied') showChip('Copied');

  // ask main to fit the window to the content
  requestAnimationFrame(() => {
    window.snippit.resizeBar(document.getElementById('bar').offsetHeight + 2);
  });
}

window.snippit.onSnips(render);

document.getElementById('btn-hide').addEventListener('click', () => window.snippit.hideBar());
document.getElementById('btn-new').addEventListener('click', () => window.snippit.newSnip());
document.getElementById('btn-settings').addEventListener('click', () => window.snippit.openSettings());
