'use strict';
/* mtnauth.com sign-in (WorkOS AuthKit) for the desktop app — client-only
   setup: public client ID baked into the app, PKCE, no backend.

   - Sign-in opens the hosted mtnauth login page in the SYSTEM browser, so an
     existing company session is reused.
   - The redirect lands on a loopback HTTP listener (RFC 8252 native-app
     flow); the code is exchanged with PKCE — no client secret anywhere.
   - The rotating refresh token is persisted encrypted with Electron
     safeStorage (DPAPI); the session is refreshed at boot and periodically.
   - Losing the network does NOT lock the tool: a previously verified session
     stays usable and re-verifies when the connection returns. An explicit
     rejection (revoked/expired) signs the user out for real. */

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { app, shell, safeStorage } = require('electron');

// the mtnauth.com (WorkOS AuthKit) public client ID — shared company
// environment, baked into the app; env var only exists as an escape hatch
const CLIENT_ID = process.env.SNIPPIT_WORKOS_CLIENT_ID || 'client_01KDRG1Z0SHPJNYBDXS3CG54GJ';

/* Loopback callback ports, tried in order. 39179 is the redirect URI already
   whitelisted in the environment (it's also Jotly's app port, so it can be
   busy while Jotly runs); 39184 is snippit-good's own — add
   http://127.0.0.1:39184/auth/callback to the WorkOS dashboard redirects so
   sign-in works independently of Jotly. */
const AUTH_PORTS = [39179, 39184];
const REDIRECT_PATH = '/auth/callback';
const WORKOS_API = 'https://api.workos.com/user_management';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;

let opts = { onChange: () => {} };
let status = 'unknown'; // unknown (verifying) | signed-in | signed-out
let user = null;        // { email, firstName, lastName }
let accessToken = null; // in-memory only; consumed by share.js for API calls
let bypass = false;     // test runs skip auth entirely
let activeLogin = null; // { cancel }
let refreshTimer = null;
let retryTimer = null;

const authFile = () => path.join(app.getPath('userData'), 'auth.json');

/* ---------------- persistence ---------------- */

function encryptToken(text) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { data: safeStorage.encryptString(text).toString('base64'), plain: false };
    }
  } catch {}
  return { data: Buffer.from(text, 'utf8').toString('base64'), plain: true };
}

function decryptToken(stored) {
  try {
    const buf = Buffer.from(stored.data, 'base64');
    return stored.plain ? buf.toString('utf8') : safeStorage.decryptString(buf);
  } catch { return null; }
}

function loadStored() {
  try { return JSON.parse(fs.readFileSync(authFile(), 'utf8')); } catch { return null; }
}

function persistSession(refreshToken, userInfo) {
  try {
    fs.writeFileSync(authFile(), JSON.stringify({
      token: encryptToken(refreshToken),
      user: userInfo,
      at: Date.now(),
    }, null, 2));
  } catch (err) { console.error('auth: could not persist the session:', err.message); }
}

function clearStored() {
  try { fs.unlinkSync(authFile()); } catch {}
}

/* ---------------- state ---------------- */

function setStatus(next, nextUser) {
  status = next;
  user = nextUser || null;
  try { opts.onChange(getState()); } catch {}
}

function getState() {
  return {
    status: bypass ? 'signed-in' : status,
    user: bypass ? { email: 'test-bypass@local', firstName: 'Test' } : user,
  };
}

function isSignedIn() {
  return bypass || status === 'signed-in';
}

// current WorkOS access token (null when signed out / bypassed); short-lived —
// callers should refresh() and retry once on a 401
function getAccessToken() {
  return accessToken;
}

/* ---------------- WorkOS user-management api ---------------- */

async function authenticate(body) {
  const res = await fetch(`${WORKOS_API}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.message || data.error || `WorkOS HTTP ${res.status}`);
    // 4xx = the session/code itself was rejected; 5xx/network = transient
    err.authRejected = res.status >= 400 && res.status < 500;
    throw err;
  }
  return data;
}

function applySession(data) {
  accessToken = data.access_token || null;
  const u = data.user || {};
  const info = {
    email: u.email || '',
    firstName: u.first_name || '',
    lastName: u.last_name || '',
  };
  if (data.refresh_token) persistSession(data.refresh_token, info);
  setStatus('signed-in', info);
}

/* ---------------- session refresh ---------------- */

async function refresh() {
  if (bypass) return true;
  const stored = loadStored();
  if (!stored || !stored.token) {
    setStatus('signed-out');
    return false;
  }
  const token = decryptToken(stored.token);
  if (!token) {
    clearStored();
    setStatus('signed-out');
    return false;
  }
  try {
    applySession(await authenticate({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: token,
    }));
    return true;
  } catch (err) {
    if (err.authRejected) {
      console.error('auth: session rejected —', err.message);
      clearStored();
      setStatus('signed-out');
      return false;
    }
    // offline / WorkOS unreachable: keep the previously verified identity so
    // the tool keeps working, and try again later
    console.error('auth: could not reach WorkOS —', err.message);
    if (stored.user && stored.user.email) setStatus('signed-in', stored.user);
    else setStatus('signed-out');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => refresh(), RETRY_INTERVAL_MS);
    if (retryTimer.unref) retryTimer.unref();
    return isSignedIn();
  }
}

/* ---------------- interactive login (PKCE + loopback) ---------------- */

function resultPage(title, message, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    body{margin:0;height:100vh;display:grid;place-items:center;background:#15161b;color:#e9ecf1;
      font-family:'Segoe UI',system-ui,sans-serif}
    .card{text-align:center;padding:40px 48px;background:#1d1f26;border:1px solid rgba(255,255,255,.14);
      border-radius:16px;max-width:420px}
    h1{font-size:20px;margin:0 0 10px;color:${ok ? '#35e0b4' : '#ff6b6b'}}
    p{margin:0;color:#a7adba;line-height:1.5}
  </style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// bind the first free candidate port; its registered redirect URI is the one
// the authorize request uses
function listenOnFirstFreePort(handler) {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= AUTH_PORTS.length) {
        reject(new Error('All sign-in callback ports are busy — close Jotly (or other apps) and try again.'));
        return;
      }
      const server = http.createServer(handler);
      server.once('error', (err) => {
        try { server.close(); } catch {}
        if (err.code === 'EADDRINUSE') tryPort(i + 1);
        else reject(err);
      });
      server.listen(AUTH_PORTS[i], '127.0.0.1', () => resolve({ server, port: AUTH_PORTS[i] }));
    };
    tryPort(0);
  });
}

function beginLogin() {
  cancelLogin();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const nonce = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    let settled = false;
    let server = null;
    let timer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server) { try { server.close(); } catch {} }
      activeLogin = null;
      if (err) reject(err); else resolve(getState());
    };

    const handler = async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== REDIRECT_PATH) { res.writeHead(404); res.end(); return; }
      const respond = (title, message, ok) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultPage(title, message, ok));
      };
      if (url.searchParams.get('state') !== nonce) {
        respond('Sign-in failed', 'State mismatch — go back to snippit-good and try again.', false);
        finish(new Error('state mismatch'));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        const why = url.searchParams.get('error_description') || url.searchParams.get('error') || 'The sign-in was cancelled.';
        respond('Sign-in failed', why, false);
        finish(new Error(why));
        return;
      }
      try {
        const data = await authenticate({
          client_id: CLIENT_ID,
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
        });
        respond('Signed in', 'You can close this tab and go back to snippit-good.', true);
        applySession(data);
        finish(null);
      } catch (err) {
        respond('Sign-in failed', err.message, false);
        finish(err);
      }
    };

    listenOnFirstFreePort(handler).then(({ server: srv, port }) => {
      if (settled) { try { srv.close(); } catch {} return; }
      server = srv;
      timer = setTimeout(() => finish(new Error('Sign-in timed out — try again.')), LOGIN_TIMEOUT_MS);
      const u = new URL(`${WORKOS_API}/authorize`);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', CLIENT_ID);
      u.searchParams.set('redirect_uri', `http://127.0.0.1:${port}${REDIRECT_PATH}`);
      u.searchParams.set('provider', 'authkit');
      u.searchParams.set('state', nonce);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      shell.openExternal(u.toString());
    }).catch((err) => finish(err));

    activeLogin = { cancel: () => finish(new Error('cancelled')) };
  });
}

function cancelLogin() {
  if (activeLogin) { try { activeLogin.cancel(); } catch {} activeLogin = null; }
}

function signOut() {
  cancelLogin();
  clearStored();
  accessToken = null;
  setStatus('signed-out');
}

/* ---------------- lifecycle ---------------- */

async function init(options) {
  opts = { ...opts, ...options };
  if (options && options.bypass) {
    bypass = true;
    setStatus('signed-in', { email: 'test-bypass@local', firstName: 'Test' });
    return;
  }
  await refresh();
  refreshTimer = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
  if (refreshTimer.unref) refreshTimer.unref();
}

function dispose() {
  cancelLogin();
  clearInterval(refreshTimer);
  clearTimeout(retryTimer);
}

// selftest hook: temporarily lift the bypass to exercise the signed-out gate
function _setBypass(v) {
  bypass = !!v;
  if (!bypass) { status = 'signed-out'; user = null; }
  try { opts.onChange(getState()); } catch {}
}

module.exports = {
  init, refresh, beginLogin, cancelLogin, signOut,
  isSignedIn, getState, getAccessToken, dispose, _setBypass,
};
