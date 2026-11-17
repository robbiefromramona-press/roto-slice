// Roto-Slice page wiring (Phase 1: analyze + tune + preview. No export yet.)
//
// Flow: file -> mount in place -> read duration -> (15-min gate) -> pull out a
// small mono WAV -> loudness array (cached) -> waveform. After that, every
// slider move is plain maths on the cached array; ffmpeg is not involved.

import { loadEngine, mountInput, probe, extractAnalysisAudio, readKeyframes, cancelAll, onProgress } from './engine.js';
import {
  computeRmsDb, detectSilences, autoThreshold, applyOverrides, buildMask, summarize,
  findGapAt, keepSegments, clock, WINDOW_SEC, MAX_ROTO_SECONDS, SOFT_SIZE_BYTES,
} from './analysis.js';
import { Waveform } from './waveform.js';
import { runExport, zipOutputs, canZip, ExportCancelled } from './exporter.js';
import { planQuick, keyframeInterval, buildCutlistJson, buildEdl, baseName } from './cutlist.js';
import { clearOutputs, download, freeSpace } from './outstore.js';
import { initSplit, loadIntoSplit, splitKey, splitShown } from './split.js';
import { BladeFx } from './blade.js';
// Brand fonts, self-hosted (a font CDN would be blocked by the isolation headers).
import '@fontsource/bebas-neue/400.css';
import '@fontsource-variable/inter';
import '@fontsource/orbitron/600.css';
import '@fontsource/orbitron/700.css';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { thresholdDb: -40, minSilenceMs: 600, padMs: 120 };

const S = {
  file: null,
  handle: null, // file handle, when the browser gave us one (passed on to Pre-Slice)
  info: null,
  db: null,
  duration: 0,
  params: { ...DEFAULTS },
  overrides: [], // times (s) inside gaps the user chose to keep
  gaps: [],
  videoUrl: null,
  videoOk: false,
  path: null,
  keyframes: null, // null = still reading, false = unavailable, else sorted times
  exporting: false,
  token: null,
  results: null,
  perf: { detectMs: 0, drawMs: 0, worstMs: 0 },
};
window.__roto = S;

const video = $('video');
const mb = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB';
const secs = (ms) => (ms / 1000).toFixed(1) + ' s';

function set(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = cls || '';
}
function notice(text, bad) {
  const el = $('notice');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}
function busy(text, ratio) {
  $('busy').hidden = text == null;
  if (text == null) return;
  $('busy-text').textContent = text;
  $('busy-bar').style.width = `${Math.round(Math.min(1, Math.max(0, ratio || 0)) * 100)}%`;
}

// ---------------------------------------------------------------- engine --
const params = new URLSearchParams(location.search);
const enginePromise = (async () => {
  set('st-isolated', String(globalThis.crossOriginIsolated === true), globalThis.crossOriginIsolated ? 'ok' : 'warn');
  try {
    const info = await loadEngine({ forceSingleThread: params.get('core') === 'st' });
    set(
      'st-core',
      info.core === 'mt' ? 'multithreaded' : `single-thread (${info.fallbackReason})`,
      info.core === 'mt' ? 'ok' : 'warn',
    );
    set('st-load', secs(info.loadMs));
    return info;
  } catch (err) {
    set('st-core', `FAILED: ${err.message || err}`, 'bad');
    throw err;
  }
})();
enginePromise.catch(() => notice('The video engine failed to load. Try reloading the page.', true));

// -------------------------------------------------------------- waveform --
const wave = new Waveform($('wave'), $('mini'), {
  onSeek: (t) => seek(t),
  onGapClick: (t) => toggleGapAt(t),
  onView: () => updatePlayhead(),
});

/** Re-run detection from the cached loudness array and redraw. Must be fast. */
function recompute() {
  if (!S.db) return;
  const t0 = performance.now();
  S.gaps = applyOverrides(detectSilences(S.db, S.params), S.overrides);
  const mask = buildMask(S.gaps, S.db.length);
  const t1 = performance.now();
  wave.setCuts(mask, S.params.thresholdDb);
  const t2 = performance.now();
  S.perf.detectMs = t1 - t0;
  S.perf.drawMs = t2 - t1;
  S.perf.worstMs = Math.max(S.perf.worstMs, t2 - t0);
  renderStats();
  renderQuickNote();
  set(
    'st-perf',
    `${(t2 - t0).toFixed(1)} ms last (detect ${(t1 - t0).toFixed(1)} + draw ${(t2 - t1).toFixed(1)}), worst ${S.perf.worstMs.toFixed(1)} ms`,
    t2 - t0 < 50 ? 'ok' : 'warn',
  );
}

function renderStats() {
  const s = summarize(S.gaps, S.duration);
  const keptGaps = S.gaps.filter((g) => g.kept).length;
  $('stats').innerHTML =
    `<div class="stat cut"><small>Removing</small><b>${clock(s.removed)}</b><i>${Math.round(s.percent)}% of ${clock(s.duration)}</i></div>` +
    `<div class="stat cuts"><small>Cut${s.cuts === 1 ? '' : 's'}</small><b>${s.cuts}</b></div>` +
    `<div class="stat keep"><small>New length</small><b>${clock(s.newLength)}</b></div>`;
  $('overrides-note').textContent = keptGaps ? ` ${keptGaps} gap${keptGaps === 1 ? '' : 's'} kept by hand.` : '';
  $('clear-overrides').hidden = S.overrides.length === 0;
}

function toggleGapAt(t) {
  const gap = findGapAt(S.gaps, t);
  if (!gap) return false;
  if (gap.kept) S.overrides = S.overrides.filter((o) => o < gap.start || o > gap.end);
  else S.overrides.push((gap.start + gap.end) / 2);
  recompute();
  return true;
}

// --------------------------------------------------------------- sliders --
const sliders = [
  ['threshold', 'thresholdDb', (v) => `${v} dB`],
  ['min-silence', 'minSilenceMs', (v) => `${v} ms`],
  ['padding', 'padMs', (v) => `${v} ms`],
];
/** The lit part of a fader's track follows its handle. */
function paintFader(el) {
  el.style.setProperty('--fill', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
}
function syncSliders() {
  for (const [id, key, fmt] of sliders) {
    $(id).value = S.params[key];
    paintFader($(id));
    $(`${id}-out`).textContent = fmt(S.params[key]);
  }
}
for (const [id, key, fmt] of sliders) {
  $(id).addEventListener('input', (e) => {
    paintFader(e.target);
    S.params[key] = +e.target.value;
    $(`${id}-out`).textContent = fmt(S.params[key]);
    recompute();
  });
}
$('auto').addEventListener('click', () => {
  if (!S.db) return;
  S.params.thresholdDb = autoThreshold(S.db);
  syncSliders();
  recompute();
});
$('reset').addEventListener('click', () => {
  S.params = { ...DEFAULTS };
  syncSliders();
  recompute();
});
$('clear-overrides').addEventListener('click', () => {
  S.overrides = [];
  recompute();
});
$('zoom-in').addEventListener('click', () => wave.zoom(0.5, playTime()));
$('zoom-out').addEventListener('click', () => wave.zoom(2, playTime()));
$('zoom-fit').addEventListener('click', () => wave.fit());

// ---------------------------------------------------------------- player --
// The <video> plays the user's original file. "Preview cuts" fakes the edit
// by jumping the playhead over every cut as it reaches one.
let virtualTime = 0; // used when the browser cannot play this file
const playTime = () => (S.videoOk ? video.currentTime : virtualTime);

function seek(t) {
  t = Math.min(Math.max(0, t), Math.max(0, S.duration - 0.01));
  virtualTime = t;
  if (S.videoOk) video.currentTime = t;
  updatePlayhead();
}

function updatePlayhead() {
  const t = playTime();
  const x = S.db ? wave.xOf(t) : null;
  const ph = $('playhead');
  ph.hidden = x == null;
  if (x != null) ph.style.left = `${x}px`;
  $('timecode').textContent = `${clock(t)} / ${clock(S.duration)}`;
}

function tick() {
  requestAnimationFrame(tick);
  if (!S.db || !S.videoOk) return;
  if (!video.paused && !video.seeking) {
    const t = video.currentTime;
    if ($('preview-cuts').checked) {
      const gap = findGapAt(S.gaps, t + 0.02);
      if (gap && !gap.kept) {
        if (gap.end >= S.duration - 0.05) video.pause();
        else video.currentTime = gap.end;
      }
    }
    // keep the playhead on screen while playing
    if (t < wave.view.start || t > wave.view.end) {
      const span = wave.view.end - wave.view.start;
      wave.setView(t - span * 0.1, t + span * 0.9);
    }
  }
  updatePlayhead();
}
requestAnimationFrame(tick);

function togglePlay() {
  if (!S.videoOk) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
$('play').addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);
const syncPlayLabel = () => { $('play-label').textContent = video.paused ? 'Play' : 'Pause'; };
for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata']) video.addEventListener(ev, syncPlayLabel);
video.addEventListener('loadedmetadata', () => {
  S.videoOk = true;
  $('play').disabled = false;
  $('video-note').hidden = true;
});
video.addEventListener('error', () => {
  if (!S.file) return;
  S.videoOk = false;
  $('play').disabled = true;
  const note = $('video-note');
  note.hidden = false;
  note.textContent =
    "This browser can't play this video format, so there's no picture preview. " +
    'The waveform and the cuts still work.';
});
document.addEventListener('keydown', (e) => {
  if (currentView === 'split') { if (splitKey(e)) e.preventDefault(); return; }
  if (e.code !== 'Space' || !S.db) return;
  if (e.target.closest('button, input[type="checkbox"], summary')) return;
  e.preventDefault();
  togglePlay();
});

// The blade that sweeps the waveform while an export runs (see blade.js).
const blade = new BladeFx({
  blade: $('blade'),
  sparks: $('sparks'),
  xOf: (t) => wave.xOf(t),
  inCut: (t) => { const g = findGapAt(S.gaps, t); return !!g && !g.kept; },
  onMove: (t) => wave.setBlade(t),
});

// ---------------------------------------------------------------- export --
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
const setRadio = (name, value) => { document.querySelector(`input[name="${name}"][value="${value}"]`).checked = true; };
const size = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : mb(bytes));

/** Keyframes are read in the background right after analysis (Quick mode needs them). */
function loadKeyframes(file, path, info) {
  S.keyframes = info.hasVideo ? null : false;
  renderQuickNote();
  if (!info.hasVideo) return;
  readKeyframes(path)
    .then((k) => { if (S.file === file) S.keyframes = k.times.length ? k.times : false; })
    .catch(() => { if (S.file === file) S.keyframes = false; })
    .finally(() => { if (S.file === file) renderQuickNote(); });
}

function renderQuickNote() {
  const note = $('quick-note');
  const quick = document.querySelector('input[name="accuracy"][value="quick"]');
  if (!S.db) { note.textContent = ''; return; }
  if (S.keyframes === null) { note.textContent = 'Checking this video’s keyframes…'; return; }
  if (S.keyframes === false) {
    note.textContent = 'Not available for this file — use Precise.';
    quick.disabled = true;
    setRadio('accuracy', 'precise');
    return;
  }
  quick.disabled = false;
  const plan = planQuick(keepSegments(S.gaps, S.duration), S.keyframes, S.duration);
  const every = keyframeInterval(S.keyframes);
  note.textContent =
    `On this video: ${plan.cutsMade} of ${plan.cutsWanted} cuts, removing ${clock(plan.removed)} of the ${clock(plan.removedWanted)}` +
    (every ? ` (keyframe every ${every.toFixed(every < 10 ? 1 : 0)} s).` : '.');
}

function exportNote(text, bad) {
  const el = $('export-note');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}
function clearResults() {
  $('results').hidden = true;
  $('result-list').textContent = '';
  $('export-progress').hidden = true;
  exportNote('');
}
function exportProgress(text, ratio) {
  $('export-progress').hidden = false;
  $('export-text').textContent = text;
  $('export-pct').textContent = String(Math.round(Math.min(1, Math.max(0, ratio)) * 100));
  $('export-bar').style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

function cutlistInputs() {
  return {
    fileName: S.file.name,
    title: `${baseName(S.file.name)}_roto`,
    duration: S.duration,
    fps: S.info?.fps || null,
    settings: { ...S.params, keptByHand: S.overrides.length },
    keep: keepSegments(S.gaps, S.duration),
  };
}
const cutlistFiles = () => {
  const input = cutlistInputs();
  return [
    new File([buildCutlistJson(input)], 'cutlist.json', { type: 'application/json' }),
    new File([buildEdl(input)], 'cutlist.edl', { type: 'text/plain' }),
  ];
};
$('dl-json').addEventListener('click', () => S.db && download(cutlistFiles()[0], `${baseName(S.file.name)}_cutlist.json`));
$('dl-edl').addEventListener('click', () => S.db && download(cutlistFiles()[1], `${baseName(S.file.name)}_cutlist.edl`));

async function startExport(modeArg, accuracyArg) {
  if (S.exporting || !S.db) return null;
  if (typeof modeArg === 'string') setRadio('mode', modeArg);
  if (typeof accuracyArg === 'string') setRadio('accuracy', accuracyArg);
  const mode = radio('mode');
  const accuracy = radio('accuracy');
  const keep = keepSegments(S.gaps, S.duration);
  const token = { cancelled: false };
  S.exporting = true;
  S.token = token;
  S.results = null;
  S.lastExportError = null;
  clearResults();
  video.pause();
  $('export-btn').disabled = true;
  $('cancel-btn').hidden = false;
  exportProgress('Sharpening the blade…', 0);
  wave.fit(); // the blade sweeps the whole video
  wave.locked = true;
  blade.start(S.duration);

  // Outputs are written to disk in the browser's private storage: check there is room.
  const keptRatio = keep.reduce((sum, s) => sum + (s.end - s.start), 0) / (S.duration || 1);
  const need = S.file.size * keptRatio * (mode === 'ripple' && accuracy === 'precise' ? 2.2 : 1.1);
  const free = await freeSpace();
  if (free != null && free < need) {
    exportNote(`Low on disk space: this export needs about ${size(need)} of scratch space and the browser reports ${size(free)} free. It may fail part-way.`);
  }

  let result = null;
  try {
    result = await runExport({
      file: S.file, inputPath: S.path, duration: S.duration, keep,
      keyframes: Array.isArray(S.keyframes) ? S.keyframes : null,
      mode, accuracy, token,
      onProgress: (p) => {
        const eta = p.etaSec != null && p.ratio < 1 ? ` · about ${clock(Math.max(1, p.etaSec))} left` : '';
        exportProgress(`${p.label}${eta}`, p.ratio);
        blade.setTarget(p.sourceTime);
      },
    });
    await blade.finish(); // let the blade complete its run before the pieces land
    result.mode = mode;
    result.accuracy = accuracy;
    S.results = result;
    renderResults(result);
  } catch (err) {
    $('export-progress').hidden = true;
    if (err instanceof ExportCancelled) exportNote('Export cancelled.');
    else exportNote(String(err.message || err), true);
    S.lastExportError = String(err.message || err);
  } finally {
    blade.stop();
    wave.locked = false;
    if (S.token === token) {
      S.exporting = false;
      $('export-btn').disabled = false;
      $('cancel-btn').hidden = true;
    }
  }
  return result;
}

function cancelExport() {
  if (!S.exporting) return;
  S.token.cancelled = true;
  cancelAll(); // stops ffmpeg mid-command; the engine reloads itself on next use
}

function renderResults(result) {
  const list = $('result-list');
  list.textContent = '';
  list.classList.toggle('single', result.outputs.length === 1);
  let bytes = 0;
  const thumbJobs = [];
  result.outputs.forEach((item, i) => {
    bytes += item.file.size;
    const li = document.createElement('li');
    li.className = 'piece';
    // pieces sit slightly askew, like cut stock dropped on a bench
    li.style.setProperty('--tilt', `${(((i * 37) % 7) - 3) * 0.45}deg`);
    li.style.animationDelay = `${Math.min(i, 30) * 28}ms`;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const canvas = document.createElement('canvas');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = result.mode === 'slice' ? String(i + 1).padStart(3, '0') : 'ROTO';
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = clock(item.duration);
    thumb.append(canvas, num, dur);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = size(item.file.size);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => download(item.file, item.name));
    li.append(thumb, name, meta, btn);
    list.append(li);
    const seg = result.mode === 'slice' ? item : result.segments[0];
    thumbJobs.push({ canvas, t: seg.start + Math.min(1, (seg.end - seg.start) / 2) });
  });
  const n = result.outputs.length;
  $('results-summary').textContent =
    `${n} file${n === 1 ? '' : 's'} · ${size(bytes)} · took ${secs(result.ms)}` +
    (result.onDisk ? '' : ' · held in memory (this browser has no disk scratch space)');
  const all = $('dl-all');
  all.hidden = n < 2;
  all.textContent = canZip(result.outputs) ? 'Download all (.zip)' : 'Download all (one by one)';
  $('results').hidden = false;
  exportProgress('Done', 1);
  paintThumbs(thumbJobs);
}

/**
 * Pictures for the bench. One hidden <video> of the source is seeked to each
 * piece's start and painted onto that piece's card.
 */
async function paintThumbs(jobs) {
  if (!S.videoOk || !S.videoUrl || !jobs.length) return;
  const file = S.file;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = S.videoUrl;
  const once = (ev, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    v.addEventListener(ev, () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
  await once('loadeddata', 5000);
  for (const job of jobs) {
    if (S.file !== file || !job.canvas.isConnected) break;
    const seeked = once('seeked', 3000);
    v.currentTime = job.t;
    if (!(await seeked) || !v.videoWidth) continue;
    job.canvas.width = 320;
    job.canvas.height = Math.round((320 * v.videoHeight) / v.videoWidth);
    job.canvas.getContext('2d').drawImage(v, 0, 0, job.canvas.width, job.canvas.height);
  }
  v.removeAttribute('src');
  v.load();
}

async function zipAll() {
  const result = S.results;
  if (!result) return null;
  const all = $('dl-all');
  all.disabled = true;
  try {
    if (!canZip(result.outputs)) {
      // too big for a plain zip: hand the clips over one at a time
      for (const item of result.outputs) {
        download(item.file, item.name);
        await new Promise((r) => setTimeout(r, 600));
      }
      return null;
    }
    const zipName = `${baseName(S.file.name)}_slices.zip`;
    const extras = cutlistFiles().map((file) => ({ name: file.name, file }));
    const zip = await zipOutputs([...result.outputs, ...extras], zipName, (r) => exportProgress(`Zipping · ${Math.round(r * 100)}%`, r));
    exportProgress('Done', 1);
    S.lastZip = zip;
    if (!window.__rotoNoDownload) download(zip, zipName);
    return zip;
  } catch (err) {
    exportNote(`Zip failed: ${err.message || err}`, true);
    return null;
  } finally {
    all.disabled = false;
  }
}
$('export-btn').addEventListener('click', () => startExport());
$('cancel-btn').addEventListener('click', cancelExport);
$('dl-all').addEventListener('click', zipAll);
clearOutputs(); // leftovers from a previous visit

// ------------------------------------------------------------- file load --
function resetWorkspace() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
  if (S.exporting) cancelExport();
  Object.assign(S, { file: null, info: null, db: null, duration: 0, overrides: [], gaps: [], videoUrl: null, videoOk: false, path: null, keyframes: null, results: null });
  clearResults();
  clearOutputs();
  S.perf.worstMs = 0;
  $('work').hidden = true;
  $('gate').hidden = true;
  $('drop').hidden = false;
  notice('');
  busy(null);
}

async function handleFile(file, handle = null) {
  resetWorkspace();
  S.file = file;
  S.handle = handle;
  $('drop').hidden = true;
  const result = { name: file.name, bytes: file.size, ok: false };
  window.__rotoLast = null;
  let offProgress = () => {};
  try {
    busy('Warming up the blade…', 0.05);
    result.engine = (await enginePromise).core;

    busy('Reading the video…', 0.1);
    const path = await mountInput(file);
    S.path = path;
    const info = await probe(path);
    S.info = info;
    Object.assign(result, { duration: info.duration, probeMs: info.ms });
    set('st-file', `${file.name} · ${mb(file.size)}`);
    set('st-video', info.video || 'none');
    set('st-audio', info.audio || 'none');
    if (info.duration == null) throw new Error("Couldn't read this file. Is it a video?");

    if (info.duration > MAX_ROTO_SECONDS) {
      busy(null);
      $('gate-msg').textContent =
        `Whoa, ${Math.round(info.duration / 60)} minutes? The blade maxes out at 15. Pre-Slice it first.`;
      $('gate').hidden = false;
      $('drop').hidden = false;
      result.gated = true;
      window.__rotoLast = result;
      return result;
    }
    if (!info.hasAudio) throw new Error('This video has no audio track, so there is no silence to find.');
    if (file.size > SOFT_SIZE_BYTES) {
      notice(`Heads up: this file is ${(file.size / 1073741824).toFixed(1)} GB. It should work, but big files are slower and can run the browser out of memory on export.`);
    }

    offProgress = onProgress((e) => {
      const done = e.time > 0 ? e.time / 1e6 / info.duration : e.progress;
      busy('Listening for silence…', 0.15 + 0.8 * Math.min(1, Math.max(0, done || 0)));
    });
    busy('Listening for silence…', 0.15);
    const audio = await extractAnalysisAudio(path);
    offProgress();
    result.extractMs = audio.ms;
    set('st-extract', `${secs(audio.ms)} (${Math.round(info.duration / (audio.ms / 1000))}x realtime), ${mb(audio.samples.byteLength)} of samples`);

    let t0 = performance.now();
    S.db = computeRmsDb(audio.samples, audio.sampleRate);
    result.rmsMs = Math.round(performance.now() - t0);
    S.duration = Math.max(info.duration, S.db.length * WINDOW_SEC);

    S.params = { ...DEFAULTS };
    syncSliders();
    busy(null);
    $('work').hidden = false;
    $('play').disabled = true;
    wave.setData(S.db, S.duration);
    recompute();
    updatePlayhead();

    S.videoUrl = URL.createObjectURL(file);
    video.src = S.videoUrl;
    loadKeyframes(file, path, info);

    result.ok = true;
    result.windows = S.db.length;
    result.stats = summarize(S.gaps, S.duration);
  } catch (err) {
    offProgress();
    busy(null);
    $('drop').hidden = false;
    result.error = String(err.message || err);
    notice(result.error, true);
  }
  window.__rotoLast = result;
  return result;
}

// ----------------------------------------------------- views + file input --
// Two tools share this page: Roto-Slice at "/" and Pre-Slice at "/split".
let currentView = 'roto';
function showView(view, push = true) {
  currentView = view === 'split' ? 'split' : 'roto';
  $('view-roto').hidden = currentView !== 'roto';
  $('view-split').hidden = currentView !== 'split';
  $('nav-roto').classList.toggle('on', currentView === 'roto');
  $('nav-split').classList.toggle('on', currentView === 'split');
  if (currentView === 'roto' && !video.paused) { /* keep playing */ } else if (!video.paused) video.pause();
  const path = currentView === 'split' ? '/split' : '/';
  if (push && location.pathname !== path) history.pushState({}, '', path + location.search);
  document.title = currentView === 'split' ? 'Pre-Slice · Roto-Slice' : 'Roto-Slice';
  $('tagline').textContent = currentView === 'split'
    ? 'Pre-Slice: chop a long video into pieces of 15 minutes or less. Lossless.'
    : 'Cut the dead air out of talking-head video.';
  if (currentView === 'split') splitShown(); else wave.resize();
}
$('nav-roto').addEventListener('click', (e) => { e.preventDefault(); showView('roto'); });
$('nav-split').addEventListener('click', (e) => { e.preventDefault(); showView('split'); });
window.addEventListener('popstate', () => showView(location.pathname.startsWith('/split') ? 'split' : 'roto', false));

const loadFile = (file, handle) => (currentView === 'split' ? loadIntoSplit(file, handle) : handleFile(file, handle));

/**
 * Click-to-browse. In Chrome/Edge we use the newer picker because it also
 * gives a "file handle", which is what lets Pre-Slice offer to delete the
 * original afterwards. Everywhere else the plain file input does the job.
 */
function wireDropZone(labelId, inputId) {
  const input = $(inputId);
  input.addEventListener('change', () => {
    if (input.files[0]) loadFile(input.files[0], null);
    input.value = '';
  });
  $(labelId).addEventListener('click', async (e) => {
    if (typeof window.showOpenFilePicker !== 'function') return; // the <input> handles it
    e.preventDefault();
    try {
      const [handle] = await window.showOpenFilePicker({
        id: 'roto-slice-video',
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'] } }],
      });
      loadFile(await handle.getFile(), handle);
    } catch (err) {
      if (err.name !== 'AbortError') input.click(); // picker blocked: fall back to the plain one
    }
  });
}
wireDropZone('drop', 'file');
wireDropZone('split-drop', 'split-file');

const dropTarget = () => (currentView === 'split' ? $('split-drop') : $('drop'));
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); dropTarget().classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); dropTarget().classList.remove('over'); });
}
document.addEventListener('drop', async (e) => {
  const file = e.dataTransfer?.files[0];
  // must be asked for during the drop event itself
  const pending = e.dataTransfer?.items?.[0]?.getAsFileSystemHandle?.();
  if (!file) return;
  const handle = pending ? await pending.catch(() => null) : null;
  loadFile(file, handle && handle.kind === 'file' ? handle : null);
});

// Too long for Roto-Slice -> jump into Pre-Slice with the same video.
$('gate-btn').addEventListener('click', () => {
  const file = S.file;
  const handle = S.handle;
  if (!file) return;
  showView('split');
  loadIntoSplit(file, handle);
});

initSplit({
  onSendToRoto: (file) => { showView('roto'); handleFile(file, null); window.scrollTo(0, 0); },
});
showView(location.pathname.startsWith('/split') ? 'split' : 'roto', false);

$('new-file').addEventListener('click', resetWorkspace);

// Hooks for automated checks (and handy in the console).
window.__rotoLoadUrl = async (url, name) => {
  const blob = await (await fetch(url)).blob();
  return handleFile(new File([blob], name || url.split('/').pop(), { type: blob.type || 'video/mp4' }));
};
window.__rotoApi = { recompute, toggleGapAt, seek, wave, startExport, cancelExport, zipAll, keepSegments: () => keepSegments(S.gaps, S.duration) };
if (import.meta.env.DEV) import('./engine.js').then((m) => { window.__engine = m; });
