// PRE-SLICE: chop a long video into pieces Roto-Slice can eat (15:00 or less).
// Lives at /split. Shares the ffmpeg engine with Roto-Slice.
//
// Flow: load (any length) -> scrub the filmstrip -> drop slice markers (they
// snap to keyframes, because the split is a lossless stream copy) -> split ->
// save each part -> optionally send a part straight into Roto-Slice.

import * as engine from './engine.js';
import { computeRmsDb, clock, MAX_ROTO_SECONDS } from './analysis.js';
import { nearestKeyframe, autoSlicePoints, piecesFromMarkers, partName } from './splitplan.js';
import { clearOutputs, download, freeSpace } from './outstore.js';
import { showKofiNudge, hideKofiNudge } from './kofi.js';

const $ = (id) => document.getElementById(id);
const THUMB_H = 64; // CSS px
const RULER_H = 20;
const MIN_SPAN = 4; // seconds: furthest zoom-in
const MIN_MARKER_GAP = 1; // seconds between two markers
const CORES = Math.max(1, navigator.hardwareConcurrency || 4);
const mb = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${(b / 1048576).toFixed(b > 104857600 ? 0 : 1)} MB`);
const fine = (t) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};

const P = {
  file: null,
  handle: null, // FileSystemFileHandle when the browser gave us one (needed to delete the original)
  info: null,
  duration: 0,
  fps: 30,
  keyframes: null, // null = reading, false = unavailable, else sorted seconds
  markers: [], // { id, t }
  db: null,
  videoUrl: null,
  videoOk: false,
  time: 0,
  view: { start: 0, end: 1 },
  busy: false,
  token: null,
  parts: null,
  aspect: 16 / 9,
};
let nextId = 1;
let hooks = { onSendToRoto: () => {} };
let video;
let canvas;
let thumbVideo = null;
const thumbs = new Map(); // "bucket|index" -> canvas
let thumbWanted = [];
let thumbBusy = false;

// ------------------------------------------------------------- helpers --
function notice(text, bad) {
  const el = $('split-notice');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}
function runNote(text, bad) {
  const el = $('sp-note');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}
function busy(text, ratio) {
  $('split-busy').hidden = text == null;
  if (text == null) return;
  $('split-busy-text').textContent = text;
  $('split-busy-bar').style.width = `${Math.round(Math.min(1, Math.max(0, ratio || 0)) * 100)}%`;
}
function progress(text, ratio) {
  $('sp-progress').hidden = text == null;
  if (text == null) return;
  $('sp-progress-text').textContent = text;
  $('sp-progress-bar').style.width = `${Math.round(Math.min(1, Math.max(0, ratio || 0)) * 100)}%`;
}
const preciseOn = () => $('sp-precise').checked;
const canSnap = () => !preciseOn() && Array.isArray(P.keyframes);
const snap = (t) => (canSnap() ? nearestKeyframe(P.keyframes, t) ?? t : t);
const pieces = () => piecesFromMarkers(P.markers.map((m) => m.t), P.duration);

// ------------------------------------------------------------ timeline --
const xOf = (t) => ((t - P.view.start) / (P.view.end - P.view.start)) * canvas.clientWidth;
function timeAt(clientX) {
  const r = canvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return P.view.start + ratio * (P.view.end - P.view.start);
}
function setView(start, end) {
  let span = Math.min(P.duration, Math.max(Math.min(MIN_SPAN, P.duration), end - start));
  start = Math.min(Math.max(0, start), P.duration - span);
  P.view = { start, end: start + span };
  draw();
}
function zoom(factor, anchor = P.time) {
  const { start, end } = P.view;
  if (anchor < start || anchor > end) anchor = (start + end) / 2;
  const span = (end - start) * factor;
  const ratio = (anchor - start) / (end - start);
  setView(anchor - span * ratio, anchor - span * ratio + span);
}

function resizeCanvas() {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  draw();
}

function draw() {
  if (!canvas || !P.file) return;
  const dpr = canvas.width / Math.max(1, canvas.clientWidth);
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const stripH = Math.round(THUMB_H * dpr);
  const { start, end } = P.view;
  const span = end - start;
  ctx.fillStyle = '#0b0814';
  ctx.fillRect(0, 0, W, H);

  // filmstrip: thumbnails on a power-of-two time grid, so zooming reuses them
  const thumbWcss = Math.max(24, THUMB_H * P.aspect);
  const bucket = 2 ** Math.round(Math.log2((span * thumbWcss) / canvas.clientWidth));
  const wanted = [];
  for (let k = Math.floor(start / bucket); k * bucket < end; k++) {
    const x = ((k * bucket - start) / span) * W;
    const w = (bucket / span) * W;
    const key = `${bucket}|${k}`;
    const img = thumbs.get(key);
    if (img) {
      // centre-crop the thumbnail to fill its slot
      const scale = Math.max(w / img.width, stripH / img.height);
      const sw = w / scale;
      const sh = stripH / scale;
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, 0, w + 1, stripH);
    } else {
      ctx.fillStyle = k % 2 ? '#191830' : '#141326';
      ctx.fillRect(x, 0, w + 1, stripH);
      const t = Math.min(P.duration - 0.05, (k + 0.5) * bucket);
      if (t >= 0) wanted.push({ key, t });
    }
  }
  requestThumbs(wanted);

  // pieces: tint the ones that are still too long
  for (const p of pieces()) {
    if (!p.tooLong || p.end < start || p.start > end) continue;
    const x0 = Math.max(0, ((p.start - start) / span) * W);
    const x1 = Math.min(W, ((p.end - start) / span) * W);
    ctx.fillStyle = 'rgba(255,138,0,0.28)';
    ctx.fillRect(x0, 0, x1 - x0, stripH);
    ctx.fillStyle = '#ff8a00';
    ctx.fillRect(x0, stripH - 3 * dpr, x1 - x0, 3 * dpr);
  }

  // keyframe ticks -- only when zoomed in enough to tell them apart
  if (Array.isArray(P.keyframes) && P.keyframes.length > 1) {
    const per = (P.duration / P.keyframes.length / span) * W;
    if (per >= 5 * dpr) {
      ctx.fillStyle = canSnap() ? '#00e6ff' : 'rgba(0,230,255,0.35)';
      for (const k of P.keyframes) {
        if (k < start) continue;
        if (k > end) break;
        ctx.fillRect(Math.round(((k - start) / span) * W), stripH, dpr, 6 * dpr);
      }
    }
  }

  // ruler
  const steps = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
  const step = steps.find((s) => (s / span) * canvas.clientWidth >= 80) || 7200;
  ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
    const x = Math.round(((t - start) / span) * W);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(x, stripH, dpr, H - stripH);
    ctx.fillStyle = '#9a9bb5';
    ctx.fillText(step < 1 ? fine(t) : clock(t), x + 4 * dpr, stripH + (H - stripH) / 2 + 3 * dpr);
  }
  placeOverlays();
}

/** Position the DOM bits that sit on top of the canvas: markers and playhead. */
function placeOverlays() {
  const wrap = $('sp-markers');
  for (const el of wrap.children) {
    const m = P.markers.find((x) => String(x.id) === el.dataset.id);
    const x = m ? xOf(m.t) : -1;
    el.hidden = !m || m.t < P.view.start || m.t > P.view.end;
    if (!el.hidden) el.style.left = `${x}px`;
  }
  const ph = $('sp-playhead');
  ph.hidden = P.time < P.view.start || P.time > P.view.end;
  if (!ph.hidden) ph.style.left = `${xOf(P.time)}px`;
  $('sp-time').textContent = `${fine(P.time)} / ${clock(P.duration)}`;
}

// ---------------------------------------------------------- thumbnails --
// A second, hidden <video> is seeked to each spot and painted onto a small
// canvas. The browser's own decoder does the work, so this is fast and uses
// no ffmpeg. If the browser can't play the file there are simply no pictures.
function requestThumbs(wanted) {
  thumbWanted = wanted;
  if (!thumbBusy) pumpThumbs();
}
async function pumpThumbs() {
  if (!thumbVideo || !P.videoOk) return;
  thumbBusy = true;
  try {
    while (thumbWanted.length) {
      // closest to the playhead first
      thumbWanted.sort((a, b) => Math.abs(a.t - P.time) - Math.abs(b.t - P.time));
      const job = thumbWanted.shift();
      if (thumbs.has(job.key)) continue;
      const v = thumbVideo;
      const ok = await new Promise((resolve) => {
        const done = (value) => { v.removeEventListener('seeked', yes); v.removeEventListener('error', no); clearTimeout(timer); resolve(value); };
        const yes = () => done(true);
        const no = () => done(false);
        const timer = setTimeout(no, 4000);
        v.addEventListener('seeked', yes);
        v.addEventListener('error', no);
        v.currentTime = job.t;
      });
      if (v !== thumbVideo) return; // a different video was loaded meanwhile
      if (!ok || !v.videoWidth) continue;
      const c = document.createElement('canvas');
      c.height = THUMB_H * 2;
      c.width = Math.max(2, Math.round((c.height * v.videoWidth) / v.videoHeight));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      thumbs.set(job.key, c);
      if (thumbs.size > 400) thumbs.delete(thumbs.keys().next().value);
      draw();
    }
  } finally {
    thumbBusy = false;
  }
}

// -------------------------------------------------------------- markers --
function renderMarkers(newId) {
  const wrap = $('sp-markers');
  wrap.textContent = '';
  for (const m of P.markers) {
    const el = document.createElement('div');
    el.className = `sp-marker${m.id === newId ? ' thunk' : ''}`;
    el.dataset.id = m.id;
    el.title = 'Drag to move';
    el.innerHTML =
      '<svg class="blade" viewBox="0 0 24 30" aria-hidden="true"><path d="M3 1h18l-3 12-6 16-6-16z"/><circle cx="12" cy="7" r="2.2"/></svg>' +
      '<span class="line"></span>';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Remove this slice';
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => { e.stopPropagation(); removeMarker(m.id); });
    el.append(del);
    bindMarkerDrag(el, m);
    wrap.append(el);
  }
  renderPieces();
  draw();
}

function bindMarkerDrag(el, m) {
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (P.busy) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const t = clampMarker(snap(timeAt(e.clientX)), m.id);
    if (t == null) return;
    m.t = t;
    seek(t);
    renderPieces();
    draw();
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    P.markers.sort((a, b) => a.t - b.t);
    renderPieces();
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

/** Keep a marker inside the video and off the top of its neighbours. */
function clampMarker(t, selfId) {
  if (t < MIN_MARKER_GAP || t > P.duration - MIN_MARKER_GAP) return null;
  for (const o of P.markers) {
    if (o.id !== selfId && Math.abs(o.t - t) < MIN_MARKER_GAP) return null;
  }
  return t;
}

function addMarker(at = P.time, quiet = false) {
  if (!P.file || P.busy) return null;
  const t = clampMarker(snap(at), null);
  if (t == null) {
    if (!quiet) hint('No room for a slice there (too close to the start, the end, or another slice).');
    return null;
  }
  const m = { id: nextId++, t };
  P.markers.push(m);
  P.markers.sort((a, b) => a.t - b.t);
  renderMarkers(m.id);
  if (!quiet) {
    const moved = Math.abs(t - at);
    hint(moved > 0.02 ? `Slice dropped at ${fine(t)} — snapped ${moved.toFixed(2)} s to the nearest keyframe.` : `Slice dropped at ${fine(t)}.`);
  }
  return m;
}
function removeMarker(id) {
  if (P.busy) return;
  P.markers = P.markers.filter((m) => m.id !== id);
  renderMarkers();
}
function resnapAll() {
  if (!canSnap()) return;
  const seen = [];
  for (const m of P.markers) {
    const t = nearestKeyframe(P.keyframes, m.t) ?? m.t;
    if (t >= MIN_MARKER_GAP && t <= P.duration - MIN_MARKER_GAP && !seen.some((s) => Math.abs(s - t) < MIN_MARKER_GAP)) {
      m.t = t;
      seen.push(t);
    }
  }
  P.markers = P.markers.filter((m) => seen.includes(m.t));
  renderMarkers();
}
function hint(text) { $('sp-hint-live').textContent = text || ''; }

function renderPieces() {
  const list = $('sp-pieces');
  list.textContent = '';
  const all = pieces();
  for (const p of all) {
    const li = document.createElement('li');
    if (p.tooLong) li.className = 'too-long';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `Part ${p.index + 1}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${clock(p.start)} → ${clock(p.end)} · ${clock(p.duration)} long`;
    li.append(name, meta);
    if (p.tooLong) {
      const warn = document.createElement('span');
      warn.className = 'warn-tag';
      warn.textContent = 'still too long for Roto-Slice';
      li.append(warn);
    }
    li.addEventListener('click', () => seek(p.start));
    list.append(li);
  }
  const tooLong = all.filter((p) => p.tooLong).length;
  $('sp-pieces-note').textContent = all.length < 2
    ? 'No slices yet. Press Add Slice at the playhead, or let Auto-Slice place them.'
    : tooLong ? `${all.length} parts · ${tooLong} still over 15:00` : `${all.length} parts · all 15:00 or less`;
  const none = all.length < 2;
  $('sp-run-folder').disabled = none || P.busy;
  $('sp-run-dl').disabled = none || P.busy;
}

// --------------------------------------------------------------- player --
function seek(t) {
  P.time = Math.min(Math.max(0, t), Math.max(0, P.duration - 0.01));
  if (P.videoOk) video.currentTime = P.time;
  if (P.time < P.view.start || P.time > P.view.end) {
    const span = P.view.end - P.view.start;
    setView(P.time - span / 2, P.time + span / 2);
  } else {
    placeOverlays();
  }
}
const stepBy = (dt) => { if (P.videoOk) video.pause(); seek(P.time + dt); };
function togglePlay() {
  if (!P.videoOk) return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
function tick() {
  requestAnimationFrame(tick);
  if (!P.file || !P.videoOk || video.paused || video.seeking) return;
  P.time = video.currentTime;
  if (P.time > P.view.end || P.time < P.view.start) {
    const span = P.view.end - P.view.start;
    setView(P.time - span * 0.1, P.time + span * 0.9);
  } else {
    placeOverlays();
  }
}

// ----------------------------------------------------------------- load --
function reset() {
  if (P.busy && P.token) { P.token.cancelled = true; engine.cancelAll(); }
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  if (thumbVideo) { thumbVideo.removeAttribute('src'); thumbVideo.load(); thumbVideo = null; }
  if (P.videoUrl) URL.revokeObjectURL(P.videoUrl);
  thumbs.clear();
  thumbWanted = [];
  Object.assign(P, { file: null, handle: null, info: null, duration: 0, keyframes: null, markers: [], db: null, videoUrl: null, videoOk: false, time: 0, busy: false, token: null, parts: null });
  $('split-work').hidden = true;
  $('split-drop').hidden = false;
  $('sp-results').textContent = '';
  hideKofiNudge('kofi-nudge-split');
  $('sp-markers').textContent = '';
  notice('');
  runNote('');
  busy(null);
  progress(null);
}

/** Load a video into Pre-Slice. `handle` is optional (enables delete-original). */
export async function loadIntoSplit(file, handle = null) {
  reset();
  P.file = file;
  P.handle = handle && handle.kind === 'file' ? handle : null;
  $('split-drop').hidden = true;
  const result = { name: file.name, bytes: file.size, ok: false };
  try {
    busy('Reading the video…', 0.3);
    const path = await engine.mountInput(file);
    const info = await engine.probe(path);
    if (P.file !== file) return result;
    if (info.duration == null) throw new Error("Couldn't read this file. Is it a video?");
    P.info = info;
    P.duration = info.duration;
    P.fps = info.fps || 30;
    P.aspect = info.width && info.height ? info.width / info.height : 16 / 9;
    P.view = { start: 0, end: P.duration };
    busy(null);
    $('split-work').hidden = false;
    $('sp-precise').checked = false;
    $('sp-delete').checked = false;
    updateDeleteOption();
    renderMarkers();
    resizeCanvas();
    if (info.duration <= MAX_ROTO_SECONDS) {
      notice(`This video is ${clock(info.duration)}, already short enough for Roto-Slice. You can still split it if you want.`);
    }

    P.videoUrl = URL.createObjectURL(file);
    video.src = P.videoUrl;
    thumbVideo = document.createElement('video');
    thumbVideo.muted = true;
    thumbVideo.preload = 'auto';
    thumbVideo.playsInline = true;
    thumbVideo.src = P.videoUrl;

    // keyframes in the background: markers snap to them once they arrive
    $('sp-kf-note').textContent = info.hasVideo ? 'Reading keyframes…' : '';
    P.keyframes = info.hasVideo ? null : false;
    if (info.hasVideo) {
      engine.readKeyframes(path)
        .then((k) => { if (P.file === file) P.keyframes = k.times.length ? k.times : false; })
        .catch(() => { if (P.file === file) P.keyframes = false; })
        .finally(() => { if (P.file === file) { keyframeNote(); resnapAll(); draw(); } });
    } else {
      keyframeNote();
    }
    result.ok = true;
    result.duration = info.duration;
  } catch (err) {
    busy(null);
    $('split-drop').hidden = false;
    result.error = String(err.message || err);
    notice(result.error, true);
  }
  return result;
}

function keyframeNote() {
  const el = $('sp-kf-note');
  if (P.keyframes === null) { el.textContent = 'Reading keyframes…'; return; }
  if (P.keyframes === false) {
    el.textContent = 'Keyframes could not be read: slices will not snap, and parts may overlap by a moment. Precise split avoids that.';
    return;
  }
  const every = P.duration / P.keyframes.length;
  el.textContent = preciseOn()
    ? 'Precise split: slices land exactly where you put them (the video is re-encoded).'
    : `Slices snap to keyframes (one about every ${every.toFixed(every < 10 ? 1 : 0)} s). Zoom in to see the ticks.`;
}

// Deleting the user's file is only possible where the browser hands us a real
// file handle with a remove() method: Chrome and Edge on desktop.
const canDeleteHere = () => typeof window.showDirectoryPicker === 'function' && typeof FileSystemFileHandle !== 'undefined' && 'remove' in FileSystemFileHandle.prototype;
function updateDeleteOption() {
  const box = $('sp-delete');
  const wrap = $('sp-delete-wrap');
  const why = $('sp-delete-why');
  $('sp-run-folder').hidden = typeof window.showDirectoryPicker !== 'function';
  if (!canDeleteHere()) {
    box.disabled = true;
    box.checked = false;
    wrap.title = "Your browser won't let web apps delete files. Delete the original yourself once you've checked the parts.";
    why.textContent = "Not available: your browser won't let web apps delete files. Delete the original yourself once you've checked the parts.";
  } else if (!P.handle) {
    box.disabled = true;
    box.checked = false;
    wrap.title = 'Load the video with the Pre-Slice file picker (or drag it in) to allow this.';
    why.textContent = 'Not available for this load: open the video with the picker on this page (or drag it in) so the browser can grant delete permission.';
  } else {
    box.disabled = false;
    wrap.title = '';
    why.textContent = 'Off by default. Only happens after every part has been saved to your folder and checked. Needs "Split & save to a folder".';
  }
}

// ----------------------------------------------------------- Auto-Slice --
async function autoSlice() {
  if (!P.file || P.busy) return null;
  if (P.duration <= MAX_ROTO_SECONDS) { hint('Already 15:00 or less: nothing to auto-slice.'); return []; }
  P.busy = true;
  renderPieces();
  try {
    if (!P.db && P.info.hasAudio) {
      const file = P.file;
      const off = engine.onProgress((e) => {
        if (e.time > 0) progress(`Listening for quiet moments · ${Math.round(Math.min(1, e.time / 1e6 / P.duration) * 100)}%`, e.time / 1e6 / P.duration);
      });
      progress('Listening for quiet moments…', 0);
      try {
        const audio = await engine.extractAnalysisAudio(await engine.useInput(file));
        if (P.file !== file) return null;
        P.db = computeRmsDb(audio.samples, audio.sampleRate);
      } finally {
        off();
        progress(null);
      }
    }
    const points = autoSlicePoints(P.duration, P.db, canSnap() ? P.keyframes : null);
    P.markers = points.map((t) => ({ id: nextId++, t }));
    renderMarkers(P.markers[0]?.id);
    for (const el of $('sp-markers').children) el.classList.add('thunk');
    hint(`Auto-Slice placed ${points.length} slice${points.length === 1 ? '' : 's'}${P.db ? ' at the quietest moments nearby' : ''}.`);
    return points;
  } catch (err) {
    runNote(`Auto-Slice failed: ${err.message || err}`, true);
    return null;
  } finally {
    P.busy = false;
    renderPieces();
  }
}

// ---------------------------------------------------------------- split --
function confirmDelete(name, count) {
  const dlg = $('sp-confirm');
  $('sp-confirm-text').textContent =
    `After all ${count} parts are saved and checked, permanently delete the original file "${name}" from your computer? This cannot be undone.`;
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
    dlg.showModal();
  });
}

/**
 * @param {'folder'|'download'} mode
 * @param {{dir?: FileSystemDirectoryHandle, skipConfirm?: boolean}} [test] hooks for automated checks
 */
async function runSplit(mode, test = {}) {
  if (!P.file || P.busy) return null;
  const list = pieces();
  if (list.length < 2) return null;
  const file = P.file;
  const precise = preciseOn();
  let wantDelete = $('sp-delete').checked && !!P.handle;
  let dir = null;
  runNote('');
  $('sp-results').textContent = '';
  hideKofiNudge('kofi-nudge-split');

  try {
    if (mode === 'folder') {
      dir = test.dir || await window.showDirectoryPicker({ mode: 'readwrite', id: 'roto-slice-parts' });
    }
  } catch (err) {
    if (err.name !== 'AbortError') runNote(`Couldn't open that folder: ${err.message || err}`, true);
    return null;
  }
  if (wantDelete && mode !== 'folder') {
    wantDelete = false;
    runNote('The original will NOT be deleted: that needs "Split & save to a folder", so each part can be checked first.');
  }
  if (wantDelete) {
    if (!test.skipConfirm && !(await confirmDelete(file.name, list.length))) return null;
    try {
      const perm = await P.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('permission was not granted');
    } catch (err) {
      wantDelete = false;
      runNote(`The original will NOT be deleted (${err.message || err}). Splitting anyway.`);
    }
  }

  const token = { cancelled: false };
  P.busy = true;
  P.token = token;
  P.parts = null;
  if (P.videoOk) video.pause();
  $('sp-cancel').hidden = false;
  renderPieces();
  const t0 = performance.now();
  const total = P.duration;
  const parts = [];
  let failed = null;

  const free = await freeSpace();
  if (free != null && free < file.size * 1.1) {
    runNote(`Low on disk space: splitting needs about ${mb(file.size * 1.1)} of scratch space and the browser reports ${mb(free)} free. It may fail part-way.`);
  }

  try {
    await clearOutputs('parts');
    const input = await engine.useInput(file);
    let doneSeconds = 0;
    for (const p of list) {
      if (token.cancelled) throw new Error('cancelled');
      const name = partName(file.name, p.index);
      const label = `${precise ? 'Re-encoding' : 'Slicing'} part ${p.index + 1} of ${list.length}`;
      const report = (within) => {
        const ratio = Math.min(1, (doneSeconds + within) / total);
        const elapsed = (performance.now() - t0) / 1000;
        const eta = ratio > 0.03 && elapsed > 1.5 ? ` · about ${clock(Math.max(1, (elapsed * (1 - ratio)) / ratio))} left` : '';
        progress(`${label} · ${Math.round(ratio * 100)}%${eta}`, ratio);
      };
      report(0);
      const off = engine.onProgress((e) => { if (e.time > 0) report(Math.min(p.duration, e.time / 1e6)); });
      let r;
      try {
        r = await engine.writeOutput(name, (out) => [
          '-hide_banner', '-nostdin',
          ...(precise ? ['-threads', String(Math.min(6, CORES))] : []),
          '-ss', (p.start + (!precise && p.start > 0 ? 0.001 : 0)).toFixed(6), '-i', input, '-t', p.duration.toFixed(6),
          '-map', '0:v:0?', '-map', '0:a:0?',
          ...(precise
            ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', String(Math.min(8, CORES)), '-c:a', 'aac', '-b:a', '160k']
            : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']),
          '-y', out,
        ], 'parts');
      } finally {
        off();
      }
      if (token.cancelled) throw new Error('cancelled');
      if (r.code !== 0 || !r.file || !r.file.size) {
        throw new Error(`part ${p.index + 1} failed: ${r.log.filter((l) => l && l !== 'Aborted()').slice(-2).join(' | ') || `code ${r.code}`}`);
      }
      const part = { ...p, name, file: r.file, saved: false };
      parts.push(part);
      doneSeconds += p.duration;

      // hand each part over as soon as it is cut
      if (mode === 'folder') {
        progress(`Saving ${name} to your folder…`, doneSeconds / total);
        const fh = await dir.getFileHandle(name, { create: true });
        const writable = await fh.createWritable();
        await r.file.stream().pipeTo(writable);
        const written = await fh.getFile();
        part.saved = written.size === r.file.size; // checked, not assumed
        if (!part.saved) throw new Error(`${name} did not save correctly (size mismatch)`);
      } else if (!test.noDownload) {
        download(r.file, name);
        await new Promise((res) => setTimeout(res, 400)); // let the browser start each download
      }
      renderResults(parts, mode);
    }
  } catch (err) {
    failed = token.cancelled ? 'cancelled' : String(err.message || err);
  }

  P.busy = false;
  P.token = null;
  P.parts = parts;
  $('sp-cancel').hidden = true;
  const took = ((performance.now() - t0) / 1000).toFixed(1);
  const outcome = { ok: !failed, error: failed, parts, mode, ms: Math.round(performance.now() - t0), deleted: false };

  if (failed) {
    progress(null);
    runNote(failed === 'cancelled'
      ? 'Split cancelled. The original was not touched.'
      : `Split failed: ${failed}. The original was not touched.`, failed !== 'cancelled');
  } else {
    progress(`Done · ${parts.length} parts · took ${took} s`, 1);
    if (wantDelete) {
      // every part exists in the folder and its size was checked above
      if (parts.length === list.length && parts.every((x) => x.saved)) {
        try {
          const handle = P.handle;
          releaseOriginal();
          await engine.releaseInput();
          await handle.remove();
          outcome.deleted = true;
          runNote(`All ${parts.length} parts are saved and checked. The original "${file.name}" has been deleted.`);
        } catch (err) {
          runNote(`All parts are saved, but the original could not be deleted (${err.message || err}). Delete it yourself.`, true);
        }
      } else {
        runNote('Not every part could be confirmed, so the original was NOT deleted.', true);
      }
    } else if (mode === 'folder') {
      runNote(`All ${parts.length} parts are saved in the folder you chose.`);
    }
  }
  renderResults(parts, mode);
  renderPieces();
  return outcome;
}

/** Stop using the original file (player, thumbnails) so it can be removed. */
function releaseOriginal() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (thumbVideo) { thumbVideo.removeAttribute('src'); thumbVideo.load(); thumbVideo = null; }
  if (P.videoUrl) URL.revokeObjectURL(P.videoUrl);
  P.videoUrl = null;
  P.videoOk = false;
  P.handle = null;
  $('sp-editor').hidden = true;
}

function renderResults(parts, mode) {
  const list = $('sp-results');
  list.textContent = '';
  for (const part of parts) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = part.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${clock(part.duration)} · ${mb(part.file.size)}${mode === 'folder' ? (part.saved ? ' · saved ✓' : ' · saving…') : ''}`;
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.textContent = mode === 'folder' ? 'Download a copy' : 'Download again';
    dl.addEventListener('click', () => download(part.file, part.name));
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'primary';
    send.textContent = 'Send to Roto-Slice';
    if (part.tooLong) {
      send.disabled = true;
      send.title = 'Still over 15:00: too long for Roto-Slice';
    }
    send.addEventListener('click', () => hooks.onSendToRoto(part.file));
    li.append(name, meta, dl, send);
    list.append(li);
  }
  if (parts.length) showKofiNudge('kofi-nudge-split');
}

// ----------------------------------------------------------------- init --
export function initSplit(options) {
  hooks = { ...hooks, ...options };
  video = $('split-video');
  canvas = $('sp-canvas');

  video.addEventListener('loadedmetadata', () => {
    P.videoOk = true;
    $('split-video-note').hidden = true;
    if (video.videoWidth && video.videoHeight) P.aspect = video.videoWidth / video.videoHeight;
    draw();
  });
  video.addEventListener('error', () => {
    if (!P.file || !P.videoUrl) return;
    P.videoOk = false;
    const note = $('split-video-note');
    note.hidden = false;
    note.textContent = "This browser can't play this video format, so there is no picture or filmstrip. You can still place slices by time and split.";
  });
  const label = () => { $('sp-play').textContent = video.paused ? 'Play' : 'Pause'; };
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) video.addEventListener(ev, label);
  video.addEventListener('click', togglePlay);

  $('sp-play').addEventListener('click', togglePlay);
  $('sp-back-s').addEventListener('click', () => stepBy(-1));
  $('sp-fwd-s').addEventListener('click', () => stepBy(1));
  $('sp-back-f').addEventListener('click', () => stepBy(-1 / P.fps));
  $('sp-fwd-f').addEventListener('click', () => stepBy(1 / P.fps));
  $('sp-zoom-in').addEventListener('click', () => zoom(0.5));
  $('sp-zoom-out').addEventListener('click', () => zoom(2));
  $('sp-zoom-fit').addEventListener('click', () => setView(0, P.duration));
  $('sp-add').addEventListener('click', () => addMarker());
  $('sp-auto').addEventListener('click', autoSlice);
  $('sp-clear').addEventListener('click', () => { if (!P.busy) { P.markers = []; renderMarkers(); hint(''); } });
  $('sp-precise').addEventListener('change', () => { keyframeNote(); resnapAll(); draw(); });
  $('sp-run-folder').addEventListener('click', () => runSplit('folder'));
  $('sp-run-dl').addEventListener('click', () => runSplit('download'));
  $('sp-cancel').addEventListener('click', () => { if (P.token) { P.token.cancelled = true; engine.cancelAll(); } });
  $('sp-new').addEventListener('click', reset);

  // the whole timeline is one big scrub handle
  const tl = $('sp-timeline');
  let scrubbing = false;
  tl.addEventListener('pointerdown', (e) => {
    if (!P.file) return;
    scrubbing = true;
    try { tl.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (P.videoOk) video.pause();
    seek(timeAt(e.clientX));
  });
  tl.addEventListener('pointermove', (e) => { if (scrubbing) seek(timeAt(e.clientX)); });
  const stop = () => { scrubbing = false; };
  tl.addEventListener('pointerup', stop);
  tl.addEventListener('pointercancel', stop);
  tl.addEventListener('wheel', (e) => {
    if (!P.file) return;
    e.preventDefault();
    const span = P.view.end - P.view.start;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = ((e.deltaX || e.deltaY) / canvas.clientWidth) * span;
      setView(P.view.start + d, P.view.end + d);
    } else {
      zoom(Math.exp(e.deltaY * 0.0015), timeAt(e.clientX));
    }
  }, { passive: false });
  new ResizeObserver(resizeCanvas).observe(tl);
  requestAnimationFrame(tick);
  clearOutputs('parts'); // leftovers from a previous visit

  window.__split = { P, load: loadIntoSplit, addMarker, removeMarker, autoSlice, runSplit, seek, setView, zoom, pieces };
}

/** Keyboard handling while the Pre-Slice view is showing. Returns true if it used the key. */
export function splitKey(e) {
  if (!P.file || e.target.closest('input, button, summary, dialog')) return false;
  const frame = 1 / P.fps;
  if (e.code === 'Space') togglePlay();
  else if (e.code === 'ArrowLeft') stepBy(e.shiftKey ? -1 : -frame);
  else if (e.code === 'ArrowRight') stepBy(e.shiftKey ? 1 : frame);
  else if (e.code === 'KeyS') addMarker();
  else return false;
  return true;
}

/** Re-measure after the view becomes visible (canvases have no size while hidden). */
export function splitShown() { resizeCanvas(); }
export const splitHasFile = () => !!P.file;
