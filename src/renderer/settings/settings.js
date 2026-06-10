'use strict';
const field = document.getElementById('shortcut-field');
const statusEl = document.getElementById('shortcut-status');
const resetBtn = document.getElementById('shortcut-reset');
const autoCopyBtn = document.getElementById('autocopy');

const DEFAULT_SHORTCUT = 'Ctrl+Shift+S';
let current = { shortcut: DEFAULT_SHORTCUT, autoCopy: false };
let recording = false;
let statusTimer = null;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls || ''}`;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status'; }, 2600);
}

function paint() {
  field.textContent = current.shortcut;
  autoCopyBtn.setAttribute('aria-checked', String(!!current.autoCopy));
  autoUpdateBtn.setAttribute('aria-checked', String(current.autoUpdate !== false));
}

async function apply(patch) {
  const res = await window.snippit.setSettings(patch);
  current = res.settings;
  paint();
  if (!res.ok) setStatus(res.error || 'Could not save', 'err');
  else setStatus('Saved', 'ok');
}

/* --- shortcut recorder --- */

// e.code -> accelerator key name (layout-independent for letters/digits)
function keyFromEvent(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F\d{1,2}$/.test(c)) return c;
  const map = {
    Space: 'Space', PrintScreen: 'PrintScreen', Insert: 'Insert', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/',
  };
  return map[c] || null;
}

function stopRecording() {
  recording = false;
  field.classList.remove('recording');
  paint();
}

field.addEventListener('click', () => {
  recording = true;
  field.classList.add('recording');
  field.textContent = 'Press keys…';
  field.focus();
});

window.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') { stopRecording(); return; }
  const key = keyFromEvent(e);
  if (!key) return; // a bare modifier — keep waiting
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const needsMods = !/^F\d{1,2}$/.test(key) && key !== 'PrintScreen';
  if (needsMods && mods.length === 0) {
    field.textContent = 'Add a modifier…';
    return;
  }
  stopRecording();
  apply({ shortcut: [...mods, key].join('+') });
});

window.addEventListener('blur', () => { if (recording) stopRecording(); });

resetBtn.addEventListener('click', () => apply({ shortcut: DEFAULT_SHORTCUT }));
autoCopyBtn.addEventListener('click', () => apply({ autoCopy: !current.autoCopy }));

/* --- updates --- */

const autoUpdateBtn = document.getElementById('autoupdate');
const checkBtn = document.getElementById('btn-check-update');
const restartBtn = document.getElementById('btn-restart-update');
const updateStatus = document.getElementById('update-status');

function paintUpdate(state) {
  if (state.currentVersion) {
    document.getElementById('cur-ver').textContent = state.currentVersion;
    document.getElementById('footer-ver').textContent = `v${state.currentVersion}`;
  }
  let text = '';
  let cls = '';
  let busy = false;
  let ready = false;
  switch (state.status) {
    case 'checking': text = 'Checking for updates…'; cls = 'busy'; busy = true; break;
    case 'downloading':
      text = `Downloading v${state.version}… ${state.progress || 0}%`;
      cls = 'busy';
      busy = true;
      break;
    case 'ready': text = `v${state.version} downloaded`; cls = 'ok'; ready = true; break;
    case 'uptodate': text = 'You’re up to date'; cls = 'ok'; break;
    case 'error': text = `Update check failed: ${state.error || 'unknown error'}`; cls = 'err'; break;
    case 'dev': text = 'Updates only work in the installed app'; cls = 'busy'; busy = true; break;
    default: text = '';
  }
  updateStatus.textContent = text;
  updateStatus.className = `status ${cls}`;
  checkBtn.disabled = busy || ready;
  restartBtn.hidden = !ready;
}

checkBtn.addEventListener('click', () => {
  paintUpdate({ status: 'checking' });
  window.snippit.checkForUpdates();
});
restartBtn.addEventListener('click', () => window.snippit.installUpdate());
autoUpdateBtn.addEventListener('click', () => apply({ autoUpdate: !current.autoUpdate }));
window.snippit.onUpdateState(paintUpdate);
document.getElementById('gh-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.snippit.openReleasesPage();
});

(async function boot() {
  current = await window.snippit.getSettings();
  paint();
  paintUpdate(await window.snippit.getUpdateState());
})();
