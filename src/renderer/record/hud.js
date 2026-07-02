'use strict';
/* The recording control bar IS the recorder: it acquires the screen stream,
   crops it through a canvas, and feeds a MediaRecorder. Living in a small
   visible window means Chromium never throttles its timers the way it can
   throttle hidden windows. Encoded chunks stream to the main process, which
   writes them to disk as they arrive. */

const timeEl = document.getElementById('time');
const recordBtn = document.getElementById('btn-record');
const pauseBtn = document.getElementById('btn-pause');
const stopBtn = document.getElementById('btn-stop');
const cancelBtn = document.getElementById('btn-cancel');
const video = document.getElementById('feed');
const canvas = document.getElementById('cv');

const state = {
  status: 'starting', // armed | starting | recording | paused | stopping
  elapsed: 0,         // ms of actual recording, accumulated across pauses
  lastResume: 0,
  discard: false,
};
let media = null;
let recorder = null;
let drawTimer = null;
let realFrames = 0;   // frames actually decoded from the screen stream
let posterSent = false;
let dead = false;     // cancelled before the stream came up

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function elapsedNow() {
  return state.elapsed + (state.status === 'recording' ? performance.now() - state.lastResume : 0);
}

function paint() {
  document.body.dataset.status = state.status;
  timeEl.textContent = state.status === 'armed' ? 'Ready'
    : state.status === 'starting' ? '…' : fmt(elapsedNow());
  pauseBtn.title = state.status === 'paused' ? 'Resume' : 'Pause';
}
setInterval(paint, 200);

function releaseMedia() {
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
  if (media) {
    for (const t of media.getTracks()) { try { t.stop(); } catch {} }
    media = null;
  }
}

/* getDisplayMedia goes through main's display-media handler, which hands over
   the right screen (and loopback audio on Windows). The legacy getUserMedia
   constraint is kept as a fallback for setups where that path misbehaves. */
async function acquireStream(audio, sourceId) {
  const attempts = [
    () => navigator.mediaDevices.getDisplayMedia({ video: true, audio }),
    ...(audio ? [() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })] : []),
    () => navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
    }),
  ];
  let lastErr = null;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('could not open a screen stream');
}

function pickMime(withAudio) {
  const candidates = withAudio ? [
    ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'mp4'],
    ['video/mp4;codecs="avc1.42E01E,opus"', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs="h264,opus"', 'webm'],
    ['video/webm;codecs="vp9,opus"', 'webm'],
    ['video/webm;codecs="vp8,opus"', 'webm'],
    ['video/webm', 'webm'],
  ] : [
    ['video/mp4;codecs="avc1.42E01E"', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs="h264"', 'webm'],
    ['video/webm;codecs="vp9"', 'webm'],
    ['video/webm;codecs="vp8"', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [mimeType, ext] of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, ext };
  }
  return { mimeType: '', ext: 'webm' };
}

const bitrateFor = (w, h, fps) =>
  Math.round(Math.min(14e6, Math.max(2.5e6, w * h * fps * 0.12)));

async function start(cfg) {
  if (dead) return;
  media = await acquireStream(cfg.audio, cfg.sourceId);
  if (dead) { releaseMedia(); return; }

  video.srcObject = media;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('screen stream produced no video')), 8000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
    });
  }
  if (dead) { releaseMedia(); return; }

  // map the selection (display CSS px) into stream pixels; encoders want even sizes
  const sw = video.videoWidth, sh = video.videoHeight;
  const sx = sw / cfg.displayBounds.width, sy = sh / cfg.displayBounds.height;
  let cx = Math.max(0, Math.min(Math.round(cfg.rect.x * sx), sw - 2));
  let cy = Math.max(0, Math.min(Math.round(cfg.rect.y * sy), sh - 2));
  const cw = Math.max(2, Math.min(Math.floor((cfg.rect.w * sx) / 2) * 2, Math.floor((sw - cx) / 2) * 2));
  const ch = Math.max(2, Math.min(Math.floor((cfg.rect.h * sy) / 2) * 2, Math.floor((sh - cy) / 2) * 2));

  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');

  let drawn = 0;
  const draw = () => {
    // decoded-frame count works even for a display:none video element
    try {
      const q = video.getVideoPlaybackQuality && video.getVideoPlaybackQuality();
      realFrames = q ? q.totalVideoFrames : (video.webkitDecodedFrameCount || 0);
    } catch {}
    ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);
    drawn++;
    if (!posterSent && drawn >= 3 && realFrames > 0) {
      posterSent = true;
      try { window.snippit.recPoster(canvas.toDataURL('image/jpeg', 0.82)); } catch {}
    }
  };
  draw();
  drawTimer = setInterval(draw, Math.max(16, Math.round(1000 / cfg.fps)));

  const out = canvas.captureStream(cfg.fps);
  for (const t of media.getAudioTracks()) out.addTrack(t);
  const { mimeType, ext } = pickMime(media.getAudioTracks().length > 0);

  recorder = new MediaRecorder(out, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: bitrateFor(cw, ch, cfg.fps),
    audioBitsPerSecond: 128000,
  });
  // chunks must reach main IN ORDER and BEFORE rec:done, so blob reads are
  // chained; onstop joins the chain instead of racing past it
  let chunkChain = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (!(e.data && e.data.size)) return;
    const blob = e.data;
    chunkChain = chunkChain.then(async () => {
      try { window.snippit.recChunk(new Uint8Array(await blob.arrayBuffer())); } catch {}
    });
  };
  recorder.onerror = (e) => fail((e.error && e.error.message) || 'video encoder error');
  recorder.onstop = () => { chunkChain = chunkChain.then(() => onRecorderStopped()); };
  // source revoked (display unplugged etc.) — save what we have
  const track = media.getVideoTracks()[0];
  if (track) track.addEventListener('ended', () => doStop(false));

  recorder.start(1000); // stream a chunk every second
  state.status = 'recording';
  state.lastResume = performance.now();
  window.snippit.recStarted({
    mimeType: recorder.mimeType || mimeType || 'video/webm',
    ext,
    width: cw,
    height: ch,
  });
  paint();
}

function onRecorderStopped() {
  releaseMedia();
  window.snippit.recDone({
    durationMs: Math.round(state.elapsed),
    discard: state.discard,
    videoFrames: realFrames,
  });
}

function doStop(discard) {
  if (dead || state.status === 'stopping') return;
  if (state.status === 'armed' || state.status === 'starting' || !recorder) {
    // nothing recorded yet — bail out entirely
    dead = true;
    releaseMedia();
    window.snippit.recDone({ durationMs: 0, discard: true, videoFrames: 0 });
    return;
  }
  state.discard = discard;
  if (state.status === 'recording') state.elapsed += performance.now() - state.lastResume;
  state.status = 'stopping';
  paint();
  try { recorder.stop(); } catch { onRecorderStopped(); }
}

function togglePause() {
  if (!recorder) return;
  if (state.status === 'recording') {
    state.elapsed += performance.now() - state.lastResume;
    state.status = 'paused';
    try { recorder.pause(); } catch {}
    window.snippit.recStatus('paused');
  } else if (state.status === 'paused') {
    state.lastResume = performance.now();
    state.status = 'recording';
    try { recorder.resume(); } catch {}
    window.snippit.recStatus('recording');
  }
  paint();
}

function fail(message) {
  if (dead) return;
  dead = true;
  releaseMedia();
  window.snippit.recError(message || 'recording failed');
}

recordBtn.addEventListener('click', () => {
  if (state.status === 'armed') window.snippit.recRecord();
});
pauseBtn.addEventListener('click', togglePause);
stopBtn.addEventListener('click', () => doStop(false));
cancelBtn.addEventListener('click', () => doStop(true));

window.snippit.onRecArm(() => {
  if (dead) return;
  state.status = 'armed';
  paint();
});
window.snippit.onRecInit((cfg) => {
  if (dead) return;
  state.status = 'starting';
  paint();
  start(cfg).catch((err) => fail((err && err.message) || String(err)));
});
window.snippit.onRecStop((p) => doStop(!!(p && p.discard)));
paint();
