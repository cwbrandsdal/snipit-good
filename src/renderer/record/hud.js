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
const sysBtn = document.getElementById('btn-sys');
const micBtn = document.getElementById('btn-mic');
const video = document.getElementById('feed');
const canvas = document.getElementById('cv');

const state = {
  status: 'starting', // armed | starting | recording | paused | stopping
  elapsed: 0,         // ms of actual recording, accumulated across pauses
  lastResume: 0,
  discard: false,
  sysOn: true,        // system audio unmuted (initialised from settings)
  micOn: false,       // microphone live (initialised from settings)
};
let media = null;
let recorder = null;
let drawTimer = null;
let realFrames = 0;   // frames actually decoded from the screen stream
let posterSent = false;
let dead = false;     // cancelled before the stream came up
let audioFlagsSet = false; // armed state may set sysOn/micOn before rec:init arrives

/* audio mixer: system loopback + mic both feed one destination track, so
   either can be muted or (for the mic) acquired mid-recording */
let audioCtx = null;
let audioDest = null;
let sysTrack = null;
let micStream = null;
let micTrack = null;
let mixerLive = false; // an audio track is part of the recording

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
  if (micStream) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch {} }
    micStream = null;
    micTrack = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
    audioDest = null;
  }
}

let sysUnavailable = false; // loopback missing or audio-less encoder
let micUnavailable = false; // no mic / permission denied / audio-less encoder

function paintAudio() {
  document.body.dataset.sys = sysUnavailable ? 'none' : (state.sysOn ? 'on' : 'off');
  document.body.dataset.mic = micUnavailable ? 'none' : (state.micOn ? 'on' : 'off');
  sysBtn.title = sysUnavailable ? 'System audio unavailable'
    : state.sysOn ? 'Mute system audio' : 'Record system audio';
  micBtn.title = micUnavailable ? 'No microphone available'
    : state.micOn ? 'Mute microphone' : 'Record microphone';
}

async function enableMic() {
  if (micTrack) { micTrack.enabled = true; return true; }
  if (!audioCtx || !audioDest) return false;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micTrack = micStream.getAudioTracks()[0] || null;
    if (!micTrack) throw new Error('no microphone track');
    audioCtx.createMediaStreamSource(micStream).connect(audioDest);
    micTrack.enabled = true;
    return true;
  } catch {
    if (micStream) { for (const t of micStream.getTracks()) { try { t.stop(); } catch {} } }
    micStream = null;
    micTrack = null;
    return false;
  }
}

/* getDisplayMedia goes through main's display-media handler, which hands over
   the right screen and loopback audio. Audio is ALWAYS requested — the track
   is what makes live mute/unmute possible; settings only pick the start
   state. The legacy getUserMedia constraint stays as a video-only fallback. */
async function acquireStream(sourceId) {
  const attempts = [
    () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }),
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

function pickMime() {
  const withAudio = [
    ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'mp4'],
    ['video/mp4;codecs="avc1.42E01E,opus"', 'mp4'],
    ['video/webm;codecs="h264,opus"', 'webm'],
    ['video/webm;codecs="vp9,opus"', 'webm'],
    ['video/webm;codecs="vp8,opus"', 'webm'],
  ];
  const videoOnly = [
    ['video/mp4;codecs="avc1.42E01E"', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs="h264"', 'webm'],
    ['video/webm;codecs="vp9"', 'webm'],
    ['video/webm;codecs="vp8"', 'webm'],
  ];
  for (const [mimeType, ext] of withAudio) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, ext, audioCapable: true };
  }
  for (const [mimeType, ext] of videoOnly) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, ext, audioCapable: false };
  }
  return { mimeType: '', ext: 'webm', audioCapable: true }; // default webm muxer takes opus
}

const bitrateFor = (w, h, fps) =>
  Math.round(Math.min(14e6, Math.max(2.5e6, w * h * fps * 0.12)));

async function start(cfg) {
  if (dead) return;
  if (!audioFlagsSet) {
    state.sysOn = !!cfg.audio;
    state.micOn = !!cfg.mic;
    audioFlagsSet = true;
  }
  media = await acquireStream(cfg.sourceId);
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
  const { mimeType, ext, audioCapable } = pickMime();

  if (audioCapable) {
    // one mixed track carries system loopback and (optionally) the mic; both
    // stay independently mutable, and the mic can even join mid-recording
    audioCtx = new AudioContext();
    try { audioCtx.resume(); } catch {}
    audioDest = audioCtx.createMediaStreamDestination();
    sysTrack = media.getAudioTracks()[0] || null;
    if (sysTrack) {
      audioCtx.createMediaStreamSource(new MediaStream([sysTrack])).connect(audioDest);
      sysTrack.enabled = state.sysOn;
    } else {
      sysUnavailable = true;
      state.sysOn = false;
    }
    if (state.micOn && !(await enableMic())) {
      micUnavailable = true;
      state.micOn = false;
    }
    if (dead) { releaseMedia(); return; }
    out.addTrack(audioDest.stream.getAudioTracks()[0]);
    mixerLive = true;
  } else {
    sysUnavailable = true;
    micUnavailable = true;
    state.sysOn = false;
    state.micOn = false;
  }
  paintAudio();

  recorder = new MediaRecorder(out, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: bitrateFor(cw, ch, cfg.fps),
    audioBitsPerSecond: cfg.audioBitrate || 128000,
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

/* audio toggles: before the recorder starts they set the initial states;
   while recording they act on the live tracks */
sysBtn.addEventListener('click', () => {
  if (dead || sysUnavailable || state.status === 'stopping') return;
  state.sysOn = !state.sysOn;
  if (sysTrack) sysTrack.enabled = state.sysOn;
  paintAudio();
});

micBtn.addEventListener('click', async () => {
  if (dead || micUnavailable || state.status === 'stopping') return;
  if (!state.micOn) {
    if (mixerLive && !(await enableMic())) {
      micUnavailable = true;
      paintAudio();
      return;
    }
    state.micOn = true;
    if (micTrack) micTrack.enabled = true;
  } else {
    state.micOn = false;
    if (micTrack) micTrack.enabled = false;
  }
  paintAudio();
});

window.snippit.onRecArm((p) => {
  if (dead) return;
  if (!audioFlagsSet) {
    state.sysOn = !!(p && p.audio);
    state.micOn = !!(p && p.mic);
    audioFlagsSet = true;
  }
  state.status = 'armed';
  paint();
  paintAudio();
});
window.snippit.onRecInit((cfg) => {
  if (dead) return;
  state.status = 'starting';
  paint();
  start(cfg).catch((err) => fail((err && err.message) || String(err)));
});
window.snippit.onRecStop((p) => doStop(!!(p && p.discard)));
paint();
paintAudio();
