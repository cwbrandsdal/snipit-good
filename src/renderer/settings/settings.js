'use strict';
const autoCopyBtn = document.getElementById('autocopy');
const recAudioBtn = document.getElementById('recaudio');
const recMicBtn = document.getElementById('recmic');
const armRecordBtn = document.getElementById('armrecord');

// segmented pickers: { element, settings key, default value }
const SEGS = [
  { el: document.getElementById('seg-mode'), key: 'defaultMode', def: 'image' },
  { el: document.getElementById('seg-audioq'), key: 'audioQuality', def: 'standard' },
];

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
  recMicBtn.setAttribute('aria-checked', String(!!current.recordMic));
  armRecordBtn.setAttribute('aria-checked', String(current.armBeforeRecord !== false));
  autoUpdateBtn.setAttribute('aria-checked', String(current.autoUpdate !== false));
  for (const s of SEGS) {
    const value = current[s.key] || s.def;
    s.el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === value));
  }
  syncMicSelect();
  document.getElementById('save-dir').textContent = current.saveDir || '…';
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
recMicBtn.addEventListener('click', () => apply({ recordMic: !current.recordMic }, recField));

/* --- account (WorkOS / Nivalo) --- */

const authStatusEl = document.getElementById('auth-status');
const authBtn = document.getElementById('btn-auth');
const authErrorEl = document.getElementById('auth-error');
let authState = null;

function paintAuth() {
  if (!authState) return;
  authBtn.hidden = false;
  if (authState.status === 'signed-in') {
    const who = (authState.user && authState.user.email) || 'your account';
    authStatusEl.textContent = `Signed in as ${who} (mtnauth.com).`;
    authBtn.textContent = 'Sign out';
  } else if (authState.status === 'unknown') {
    authStatusEl.textContent = 'Checking session…';
    authBtn.hidden = true;
  } else {
    authStatusEl.textContent = 'Signed out — snips and recordings are locked until you sign in with mtnauth.com.';
    authBtn.textContent = 'Sign in…';
  }
}

authBtn.addEventListener('click', async () => {
  authErrorEl.textContent = '';
  authErrorEl.className = 'status';
  if (authState && authState.status === 'signed-in') {
    window.snippit.authLogout();
    return;
  }
  authStatusEl.textContent = 'Waiting for the browser sign-in…';
  authBtn.hidden = true;
  const res = await window.snippit.authLogin();
  if (!res.ok && res.error !== 'cancelled') {
    authErrorEl.textContent = res.error || 'Sign-in failed.';
    authErrorEl.className = 'status err';
  }
  authState = await window.snippit.authGetState();
  paintAuth();
});

window.snippit.onAuthState((s) => { authState = s; paintAuth(); loadShares(); });

/* --- share links --- */

const shareListEl = document.getElementById('share-list');
const shareStatusEl = document.getElementById('share-status');

function fmtShareMeta(s) {
  const bits = [];
  if (s.status === 'active') {
    bits.push(`${s.viewCount} view${s.viewCount === 1 ? '' : 's'}${s.maxViews ? ` of ${s.maxViews}` : ''}`);
    if (s.expiresAt) bits.push(`expires ${new Date(s.expiresAt).toLocaleDateString()}`);
    if (s.hasPassword) bits.push('password');
  } else {
    bits.push(s.status);
  }
  return bits.join(' · ');
}

async function loadShares() {
  shareStatusEl.textContent = '';
  shareStatusEl.className = 'status';
  const res = await window.snippit.shareList();
  shareListEl.replaceChildren();
  if (!res.ok) {
    shareStatusEl.textContent = res.error || 'Could not load your share links.';
    shareStatusEl.className = 'status err';
    return;
  }
  const shares = res.shares.filter((s) => s.status !== 'pending');
  if (!shares.length) {
    const empty = document.createElement('p');
    empty.className = 'share-empty';
    empty.textContent = 'No share links yet — use “Share link” on a capture in the library or the bar.';
    shareListEl.appendChild(empty);
    return;
  }
  for (const s of shares) {
    const row = document.createElement('div');
    row.className = `share-row${s.status !== 'active' ? ' dead' : ''}`;

    const info = document.createElement('div');
    info.className = 'share-info';
    const name = document.createElement('div');
    name.className = 'share-name';
    name.textContent = s.fileName;
    name.title = s.url;
    const meta = document.createElement('div');
    meta.className = 'share-meta';
    meta.textContent = fmtShareMeta(s);
    info.append(name, meta);
    row.appendChild(info);

    if (s.status === 'active') {
      const copy = document.createElement('button');
      copy.className = 'btn-ghost small';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        await window.snippit.shareCopyLink(s.url);
        copy.textContent = 'Copied ✓';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      });
      const revoke = document.createElement('button');
      revoke.className = 'btn-ghost small danger';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!confirm(`Revoke this share link? Anyone with the link loses access and the upload is deleted.\n\n${s.fileName}`)) return;
        const r = await window.snippit.shareRevoke(s.id);
        if (!r.ok) {
          shareStatusEl.textContent = r.error || 'Revoke failed.';
          shareStatusEl.className = 'status err';
        }
        loadShares();
      });
      row.append(copy, revoke);
    }
    shareListEl.appendChild(row);
  }
}

document.getElementById('btn-shares-refresh').addEventListener('click', loadShares);

/* --- microphone device picker --- */

const micSelect = document.getElementById('mic-device');

async function loadMicDevices() {
  let inputs = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    // labels stay hidden until the mic has been used once — a brief silent
    // grab (immediately stopped) reveals the real device names
    if (inputs.length && inputs.every((d) => !d.label)) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
        inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      } catch {}
    }
  } catch {}
  micSelect.replaceChildren();
  const mk = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  micSelect.appendChild(mk('', 'System default'));
  let n = 0;
  for (const d of inputs) {
    // skip Chromium's virtual duplicates of the default device
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
    n++;
    micSelect.appendChild(mk(d.deviceId, d.label || `Microphone ${n}`));
  }
  syncMicSelect();
}

function syncMicSelect() {
  const wanted = current.micDeviceId || '';
  micSelect.value = [...micSelect.options].some((o) => o.value === wanted) ? wanted : '';
}

micSelect.addEventListener('change', () => apply({ micDeviceId: micSelect.value }, recField));
try { navigator.mediaDevices.addEventListener('devicechange', loadMicDevices); } catch {}
armRecordBtn.addEventListener('click', () => apply({ armBeforeRecord: current.armBeforeRecord === false }, recField));
for (const s of SEGS) {
  s.el.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => apply({ [s.key]: b.dataset.v }, recField)));
}

document.getElementById('btn-change-dir').addEventListener('click', async () => {
  current = await window.snippit.pickSaveDir();
  paint();
});
document.getElementById('btn-open-dir').addEventListener('click', () => window.snippit.openSaveDir());

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
  authState = await window.snippit.authGetState();
  paintAuth();
  paintUpdate(await window.snippit.getUpdateState());
  loadMicDevices();
  loadShares();
})();
