'use strict';
/* Share-link uploads for snippit-good — talks to the snippit-share API
   (https://snippit-good.io by default; SNIPPIT_SHARE_API overrides, so the
   open-source app can point at any compatible self-hosted service).

   The API never touches file bytes: it hands back a short-lived Azure Blob
   SAS URL, the file PUTs straight to storage, and a complete call activates
   the link. Requests authenticate with the signed-in mtnauth.com (WorkOS)
   access token; a 401 triggers one token refresh + retry. */

const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');

// read lazily so tests can point at a mock service after startup
const apiBase = () => (process.env.SNIPPIT_SHARE_API || 'https://snippit-good.io').replace(/\/+$/, '');

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

async function apiFetch(pathname, options = {}, retryOn401 = true) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = auth.getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${apiBase()}${pathname}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Could not reach the share service — check your connection.');
  }
  // access tokens are short-lived; refresh once and retry before giving up
  if (res.status === 401 && retryOn401 && await auth.refresh()) {
    return apiFetch(pathname, options, false);
  }
  return res;
}

async function apiError(res, fallback) {
  try {
    const data = await res.json();
    if (data && data.error) return data.error;
  } catch {}
  if (res.status === 401) return 'Sign in with mtnauth.com to share.';
  return `${fallback} (HTTP ${res.status}).`;
}

// PUT the file straight to the storage SAS URL, streaming from disk
function putFile(urlStr, headers, filePath, size, onProgress) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? require('node:http') : require('node:https');
    const req = mod.request({
      method: 'PUT',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, 'Content-Length': size },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`The upload was rejected (HTTP ${res.statusCode}).`));
      });
    });
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('The upload timed out.')));
    req.on('error', (err) => reject(new Error(`Upload failed — ${err.message}`)));
    const stream = fs.createReadStream(filePath);
    let sent = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress(Math.min(1, sent / size));
    });
    stream.on('error', (err) => { try { req.destroy(err); } catch {} reject(err); });
    stream.pipe(req);
  });
}

/* Upload a file and return { url, share }. expiresInDays null = never,
   password null = open link, maxViews null = unlimited views. */
async function createShare({ filePath, fileName, expiresInDays, password, maxViews }, onProgress) {
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (!contentType) throw new Error('This file type cannot be shared.');
  const size = fs.statSync(filePath).size;
  if (!size) throw new Error('The file is empty.');

  const initiate = await apiFetch('/api/shares', {
    method: 'POST',
    body: JSON.stringify({
      fileName: fileName || path.basename(filePath),
      contentType,
      size,
      expiresInDays: expiresInDays || null,
      password: password || null,
      maxViews: maxViews || null,
    }),
  });
  if (!initiate.ok) throw new Error(await apiError(initiate, 'Could not create the share link'));
  const created = await initiate.json();

  await putFile(created.uploadUrl, created.uploadHeaders || {}, filePath, size, onProgress);

  const complete = await apiFetch(`/api/shares/${created.id}/complete`, { method: 'POST' });
  if (!complete.ok) throw new Error(await apiError(complete, 'Could not activate the share link'));
  return { url: created.shareUrl, share: await complete.json() };
}

async function listShares() {
  const res = await apiFetch('/api/shares');
  if (!res.ok) throw new Error(await apiError(res, 'Could not load your share links'));
  return res.json();
}

async function revokeShare(id) {
  const res = await apiFetch(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(await apiError(res, 'Could not revoke the link'));
}

module.exports = { createShare, listShares, revokeShare };
