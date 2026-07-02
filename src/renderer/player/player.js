'use strict';
const id = new URLSearchParams(location.search).get('id');
const v = document.getElementById('v');
const metaEl = document.getElementById('meta');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');
let toastTimer = null;

function showToast(text) {
  toastText.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
}

function fmt(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

(async function boot() {
  const snip = await window.snippit.getVideoSnip(id);
  if (!snip) {
    v.hidden = true;
    document.getElementById('missing').hidden = false;
    return;
  }
  metaEl.textContent = `${snip.width} × ${snip.height} · ${fmt(snip.durationMs || 0)}`;
  v.src = snip.fileUrl;
  // MediaRecorder webm files report Infinity until the tail is parsed — force it
  v.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(v.duration)) {
      const back = () => { v.currentTime = 0; v.removeEventListener('seeked', back); };
      v.addEventListener('seeked', back);
      v.currentTime = 1e7;
    }
  }, { once: true });
})();

document.getElementById('btn-copy').addEventListener('click', async () => {
  showToast((await window.snippit.copySnip(id)) ? 'File copied — paste it anywhere' : 'Copy failed');
});
document.getElementById('btn-save').addEventListener('click', async () => {
  if (await window.snippit.saveVideo(id)) showToast('Saved');
});
document.getElementById('btn-folder').addEventListener('click', () => {
  window.snippit.showVideoInFolder(id);
});
