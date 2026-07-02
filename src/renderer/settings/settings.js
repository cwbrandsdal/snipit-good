'use strict';
const autoCopyBtn = document.getElementById('autocopy');
const recAudioBtn = document.getElementById('recaudio');
const armRecordBtn = document.getElementById('armrecord');

const DEFAULT_SHORTCUT = 'Ctrl+Shift+S';
const DEFAULT_RECORD_SHORTCUT = 'Ctrl+Alt+R';
let current = { shortcut: DEFAULT_SHORTCUT, recordShortcut: DEFAULT_RECORD_SHORTCUT, autoCopy: false, recordAudio: true };

/* --- shortcut recorders (one per field) --- */

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

const shortcutFields = [];
let recordingField = null; // the field currently listening for keys

function makeShortcutField({ fieldId, resetId, statusId, key, def }) {
  const field = document.getElementById(fieldId);
  const resetBtn = document.getElementById(resetId);
  const statusEl = document.getElementById(statusId);
  let statusTimer = null;

  const entry = {
    key,
    field,
    setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = `status ${cls || ''}`;
      clearTimeout(statusTimer);
      if (text) statusTimer = setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status'; }, 2600);
    },
    paint() { field.textContent = current[key] || 'Not set'; },
    stop() {
      if (recordingField === entry) recordingField = null;
      field.classList.remove('recording');
      entry.paint();
    },
  };

  field.addEventListener('click', () => {
    if (recordingField) recordingField.stop();
    recordingField = entry;
    field.classList.add('recording');
    field.textContent = 'Press keys…';
    field.focus();
  });
  resetBtn.addEventListener('click', () => apply({ [key]: def }, entry));

  shortcutFields.push(entry);
  return entry;
}

const snipField = makeShortcutField({
  fieldId: 'shortcut-field', resetId: 'shortcut-reset', statusId: 'shortcut-status',
  key: 'shortcut', def: DEFAULT_SHORTCUT,
});
const recField = makeShortcutField({
  fieldId: 'rec-shortcut-field', resetId: 'rec-shortcut-reset', statusId: 'rec-shortcut-status',
  key: 'recordShortcut', def: DEFAULT_RECORD_SHORTCUT,
});

window.addEventListener('keydown', (e) => {
  if (!recordingField) return;
  e.preventDefault();
  if (e.key === 'Escape') { recordingField.stop(); return; }
  const key = keyFromEvent(e);
  if (!key) return; // a bare modifier — keep waiting
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const needsMods = !/^F\d{1,2}$/.test(key) && key !== 'PrintScreen';
  if (needsMods && mods.length === 0) {
    recordingField.field.textContent = 'Add a modifier…';
    return;
  }
  const target = recordingField;
  target.stop();
  apply({ [target.key]: [...mods, key].join('+') }, target);
});

window.addEventListener('blur', () => { if (recordingField) recordingField.stop(); });

function paint() {
  for (const f of shortcutFields) f.paint();
  autoCopyBtn.setAttribute('aria-checked', String(!!current.autoCopy));
  recAudioBtn.setAttribute('aria-checked', String(current.recordAudio !== false));
  armRecordBtn.setAttribute('aria-checked', String(current.armBeforeRecord !== false));
  autoUpdateBtn.setAttribute('aria-checked', String(current.autoUpdate !== false));
}

async function apply(patch, statusTarget) {
  const res = await window.snippit.setSettings(patch);
  current = res.settings;
  paint();
  const target = statusTarget || snipField;
  if (!res.ok) target.setStatus(res.error || 'Could not save', 'err');
  else target.setStatus('Saved', 'ok');
}

autoCopyBtn.addEventListener('click', () => apply({ autoCopy: !current.autoCopy }));
recAudioBtn.addEventListener('click', () => apply({ recordAudio: current.recordAudio === false }, recField));
armRecordBtn.addEventListener('click', () => apply({ armBeforeRecord: current.armBeforeRecord === false }, recField));

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
