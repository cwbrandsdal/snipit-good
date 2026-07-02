'use strict';
const panes = {
  checking: document.getElementById('pane-checking'),
  signin: document.getElementById('pane-signin'),
  waiting: document.getElementById('pane-waiting'),
};
const errorEl = document.getElementById('error');
let waiting = false;

function showPane(name) {
  for (const [key, el] of Object.entries(panes)) el.hidden = key !== name;
}

function setError(message) {
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
}

function paint(state) {
  if (waiting) return; // the in-flight login owns the UI until it settles
  if (!state || state.status === 'unknown') { showPane('checking'); return; }
  showPane('signin'); // signed-in state closes this window from main
}

async function signIn() {
  setError('');
  waiting = true;
  showPane('waiting');
  const res = await window.snippit.authLogin(); // { ok, error }
  waiting = false;
  if (!res.ok) {
    if (res.error !== 'cancelled') setError(res.error || 'Sign-in failed — try again.');
    paint(await window.snippit.authGetState());
  }
  // success: main closes this window
}

document.getElementById('btn-signin').addEventListener('click', signIn);
document.getElementById('btn-cancel').addEventListener('click', () => {
  window.snippit.authCancelLogin();
});

window.snippit.onAuthState(paint);

(async function boot() {
  paint(await window.snippit.authGetState());
})();
