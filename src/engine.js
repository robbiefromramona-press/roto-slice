// The ffmpeg engine. One shared ffmpeg.wasm instance for the whole app
// (Roto-Slice and Pre-Slice both use it).
//
// Three rules this file exists to enforce:
//   1. Prefer the multithreaded core, fall back to single-thread automatically.
//   2. NEVER copy the user's video into ffmpeg's memory. It is mounted
//      read-only via WORKERFS so ffmpeg reads it straight off disk.
//   3. Outputs are written to disk (the browser's private storage) through
//      SINKFS, not into memory -- see scripts/copy-core.mjs for both patches.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { createOutput, newScratchFolder } from './outstore.js';

const IN_DIR = '/in';
const OUT_DIR = '/out';
const MT_LOAD_TIMEOUT_MS = 20000;
// WATCHDOG. The multithreaded core very occasionally freezes mid-command with
// no error (seen about once in a few hundred commands). While ffmpeg works it
// prints a status line twice a second, so 20 s of total silence means it is
// stuck: we kill the engine, reload it, and the command is tried again.
const STALL_MS = 20000;
// Every freeze seen so far happened before ffmpeg printed anything at all, and a
// healthy command prints within milliseconds -- so total silence from the very
// start is caught sooner.
const STALL_AT_START_MS = 8000;
const MAX_ATTEMPTS = 3;
export const stalls = []; // what froze and when, for the engine details panel

export class EngineStalled extends Error {
  constructor(tail) { super('ffmpeg stopped responding'); this.name = 'EngineStalled'; this.tail = tail; }
}

let ffmpeg = null;
let coreKind = null; // 'mt' | 'st'
let wantSingleThread = false;
let fallbackReason = null;
let currentFile = null; // re-mounted automatically after a cancel
let inputPath = null;
let diskOutput = null; // null = not tried yet, true/false once known
let queue = Promise.resolve(); // ffmpeg runs one command at a time
const logListeners = new Set();
const progressListeners = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const coreUrl = (kind, file) => new URL(`/ffmpeg/${kind}/${file}`, location.origin).href;

function makeInstance() {
  const ff = new FFmpeg();
  ff.on('log', (e) => logListeners.forEach((fn) => fn(e)));
  ff.on('progress', (e) => progressListeners.forEach((fn) => fn(e)));
  return ff;
}

// The ~31 MB wasm files come from jsDelivr (Cloudflare Pages refuses files over 25 MiB). The
// version is pinned EXACTLY (match package.json / package-lock.json) and every download is
// checked against a SHA-384 before use, so a tampered or wrong file is refused. The wasm is
// fetched with CORS (jsDelivr allows it), so cross-origin isolation (COEP) keeps working, then
// handed to ffmpeg as a same-origin blob: URL. The patched ffmpeg-core.js stays self-hosted.
const CORE_VERSION = '0.12.10';
const WASM = {
  st: {
    url: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm`,
    sha384: 'U1VDhkPYrM3wTCT4/vjSpSsKqG/UjljYrYCI4hBSJ02svbCkxuCi6U6u/peg5vpW',
  },
  mt: {
    url: `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm`,
    sha384: 'IXnr5PE2UFcQ5DvI5LyubPqmMF46EkyIMlbdn4CNQR1iQ8/2irEkyhDFnVDxv4f/',
  },
};
const wasmBlobs = {};
function wasmBlobUrl(kind) {
  if (!wasmBlobs[kind]) {
    wasmBlobs[kind] = (async () => {
      const { url, sha384 } = WASM[kind];
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`could not download the ffmpeg engine (HTTP ${res.status})`);
      const buf = await res.arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', buf));
      let bin = '';
      for (const b of digest) bin += String.fromCharCode(b);
      if (btoa(bin) !== sha384) throw new Error('the downloaded ffmpeg engine failed its integrity check');
      return URL.createObjectURL(new Blob([buf], { type: 'application/wasm' }));
    })();
    wasmBlobs[kind].catch(() => { delete wasmBlobs[kind]; }); // allow a retry after a failure
  }
  return wasmBlobs[kind];
}

async function loadKind(kind) {
  const ff = makeInstance();
  const config = {
    coreURL: coreUrl(kind, 'ffmpeg-core.js'),
    wasmURL: await wasmBlobUrl(kind),
  };
  if (kind === 'mt') config.workerURL = coreUrl(kind, 'ffmpeg-core.worker.js');

  if (kind === 'st') {
    await ff.load(config);
    return ff;
  }
  // The MT core can hang instead of failing, so race it against a timer.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('multithreaded core timed out while loading')), MT_LOAD_TIMEOUT_MS);
  });
  try {
    await Promise.race([ff.load(config), timeout]);
    return ff;
  } catch (err) {
    ff.terminate();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load ffmpeg. Safe to call more than once.
 * @param {{forceSingleThread?: boolean}} [opts]
 * @returns {Promise<{core: 'mt'|'st', isolated: boolean, fallbackReason: string|null, loadMs: number}>}
 */
export async function loadEngine(opts = {}) {
  const t0 = performance.now();
  if (opts.forceSingleThread) wantSingleThread = true;
  if (!ffmpeg) {
    const isolated = globalThis.crossOriginIsolated === true;
    if (wantSingleThread) {
      fallbackReason = 'single-thread was requested';
    } else if (!isolated) {
      fallbackReason = 'page is not cross-origin isolated (no SharedArrayBuffer)';
    } else {
      try {
        ffmpeg = await loadKind('mt');
        coreKind = 'mt';
      } catch (err) {
        fallbackReason = `multithreaded core failed: ${err.message || err}`;
      }
    }
    if (!ffmpeg) {
      ffmpeg = await loadKind('st');
      coreKind = 'st';
    }
  }
  return {
    core: coreKind,
    isolated: globalThis.crossOriginIsolated === true,
    fallbackReason,
    loadMs: Math.round(performance.now() - t0),
  };
}

/**
 * Stop whatever ffmpeg is doing, right now. The engine is thrown away; the
 * next command reloads it and re-mounts the current file automatically.
 */
export function cancelAll() {
  if (ffmpeg) ffmpeg.terminate();
  ffmpeg = null;
}

/** Make sure there is a live engine with the current file mounted. */
async function ensureReady() {
  if (ffmpeg) return;
  await loadEngine();
  if (currentFile) await doMount(currentFile);
}

export const engineInfo = () => ({ core: coreKind, fallbackReason, diskOutput });

export function onLog(fn) {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}
export function onProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

async function doMount(file) {
  // Mounted under a plain alias so odd characters in the real file name can
  // never break an ffmpeg command or a concat list.
  const ext = (file.name.match(/\.([A-Za-z0-9]{1,5})$/) || [, 'mp4'])[1].toLowerCase();
  const alias = `input.${ext}`;
  await ffmpeg.unmount(IN_DIR).catch(() => {});
  await ffmpeg.createDir(IN_DIR).catch(() => {});
  await ffmpeg.mount('WORKERFS', { blobs: [{ name: alias, data: file }] }, IN_DIR);
  inputPath = `${IN_DIR}/${alias}`;
  return inputPath;
}

/**
 * Mount the user's file read-only. Nothing is copied: ffmpeg reads byte
 * ranges from the File on demand. Returns the path ffmpeg should use.
 * @param {File} file
 */
export async function mountInput(file) {
  currentFile = file;
  if (!ffmpeg) await loadEngine();
  return doMount(file);
}

/**
 * Make `file` the mounted input if it is not already (Roto-Slice and
 * Pre-Slice share one engine but may each be holding a different video).
 */
export async function useInput(file) {
  if (currentFile === file && ffmpeg && inputPath) return inputPath;
  return mountInput(file);
}

/** Let go of the input file completely (needed before the original can be deleted). */
export async function releaseInput() {
  currentFile = null;
  inputPath = null;
  if (ffmpeg) await ffmpeg.unmount(IN_DIR).catch(() => {});
}

/** Mount a set of Blobs/Files read-only at `dir` (used to stitch clips together). */
export async function mountBlobs(dir, blobs) {
  await ensureReady();
  await ffmpeg.unmount(dir).catch(() => {});
  await ffmpeg.createDir(dir).catch(() => {});
  await ffmpeg.mount('WORKERFS', { blobs }, dir);
}
export async function unmountDir(dir) {
  if (ffmpeg) await ffmpeg.unmount(dir).catch(() => {});
}

/**
 * Run ffmpeg and collect its log lines. Commands are queued: only one runs at
 * a time, in the order they were asked for.
 * @param {string[]} args
 * @returns {Promise<{code: number, log: string[], ms: number}>}
 */
export function run(args) {
  const job = queue.then(() => withRetry(() => runNow(args)));
  queue = job.catch(() => {});
  return job;
}

async function runNow(args) {
  await ensureReady();
  const log = [];
  const t0 = performance.now();
  let last = t0;
  let stalled = false;
  const offLog = onLog((e) => { log.push(e.message); last = performance.now(); });
  const offProgress = onProgress(() => { last = performance.now(); });
  const watchdog = setInterval(() => {
    if (stalled || performance.now() - last < (log.length ? STALL_MS : STALL_AT_START_MS)) return;
    stalled = true;
    stalls.push({ at: new Date().toISOString(), afterMs: Math.round(last - t0), tail: log.slice(-2), args: args.join(' ').slice(0, 200) });
    cancelAll(); // makes the exec() below reject
  }, 1000);
  try {
    const code = await ffmpeg.exec(args);
    return { code, log, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    if (stalled) throw new EngineStalled(log.slice(-2));
    throw err;
  } finally {
    clearInterval(watchdog);
    offLog();
    offProgress();
  }
}

/** Run a job, retrying it on a fresh engine if ffmpeg freezes. */
async function withRetry(job) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await job(attempt);
    } catch (err) {
      if (!(err instanceof EngineStalled) || attempt >= MAX_ATTEMPTS) throw err;
      newScratchFolder('out'); // the frozen engine may still hold its output file locked
      newScratchFolder('parts');
    }
  }
}

export const readFile = (path) => ffmpeg.readFile(path);
export const deleteFile = (path) => (ffmpeg ? ffmpeg.deleteFile(path).catch(() => {}) : Promise.resolve());
export async function writeText(path, text) {
  await ensureReady();
  await ffmpeg.writeFile(path, new TextEncoder().encode(text));
}

/**
 * Run an ffmpeg command whose output is a (possibly huge) file.
 * `buildArgs(outPath)` gets the path to write to. The result comes back as a
 * File. Normally that File lives on disk in the browser's private storage; if
 * the browser can't do that, it falls back to memory (fine for small outputs).
 * @param {string} name output file name, e.g. "talk_roto.mp4"
 * @param {(outPath: string) => string[]} buildArgs
 */
export function writeOutput(name, buildArgs, area = 'out') {
  const job = queue.then(() => withRetry(() => writeOutputNow(name, buildArgs, area)));
  queue = job.catch(() => {});
  return job;
}

async function writeOutputNow(name, buildArgs, area) {
  await ensureReady();
  if (diskOutput !== false) {
    const handle = await openSink(name, area);
    if (handle) {
      let result;
      try {
        result = await runNow(buildArgs(`${OUT_DIR}/${name}`));
      } finally {
        // "delete" on SINKFS means flush + close; the file on disk stays.
        if (ffmpeg) {
          await ffmpeg.deleteFile(`${OUT_DIR}/${name}`).catch(() => {});
          await ffmpeg.unmount(OUT_DIR).catch(() => {});
        }
      }
      return { ...result, file: await handle.getFile(), onDisk: true };
    }
  }
  const path = `/mem_${name}`;
  const result = await runNow(buildArgs(path));
  let file = null;
  if (result.code === 0) {
    const data = await ffmpeg.readFile(path);
    file = new File([data], name, { type: name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4' });
  }
  await deleteFile(path);
  return { ...result, file, onDisk: false };
}

/** Create the disk file and wait for ffmpeg's side to have it open. */
async function openSink(name, area) {
  try {
    const handle = await createOutput(name, area);
    await ffmpeg.unmount(OUT_DIR).catch(() => {});
    await ffmpeg.createDir(OUT_DIR).catch(() => {});
    const ok = await ffmpeg.mount('SINKFS', { files: [{ name, handle }] }, OUT_DIR);
    if (ok === false) throw new Error('SINKFS is not available in this core');
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      const list = await ffmpeg.listDir(OUT_DIR);
      if (list.some((e) => e.name === name)) {
        diskOutput = true;
        return handle;
      }
      await sleep(10);
    }
    throw new Error('timed out opening the output file');
  } catch (err) {
    if (diskOutput === true) throw err; // it worked before, so this is a real error
    console.warn('Disk output unavailable, falling back to memory:', err);
    diskOutput = false;
    if (ffmpeg) await ffmpeg.unmount(OUT_DIR).catch(() => {});
    return null;
  }
}

/**
 * Read duration and stream info without decoding anything
 * (`ffmpeg -i file` prints the header and exits).
 * @param {string} path
 */
export async function probe(path) {
  const { log, ms } = await run(['-hide_banner', '-i', path]);
  const text = log.join('\n');
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : null;
  const v = text.match(/Stream #\d+:\d+.*Video:\s*([^\n]*)/);
  const a = text.match(/Stream #\d+:\d+.*Audio:\s*([^\n]*)/);
  const dims = v && v[1].match(/(\d{2,5})x(\d{2,5})/);
  const fps = v && v[1].match(/([\d.]+)\s*fps/);
  return {
    duration,
    video: v ? v[1].trim() : null,
    audio: a ? a[1].trim() : null,
    width: dims ? +dims[1] : null,
    height: dims ? +dims[2] : null,
    fps: fps ? +fps[1] : null,
    hasVideo: !!v,
    hasAudio: !!a,
    ms,
  };
}

/**
 * Pull the audio out as mono 16 kHz 16-bit PCM. A 20-minute clip is ~38 MB,
 * which is the only thing that ever lands in ffmpeg's memory during analysis.
 * @param {string} path
 * @returns {Promise<{samples: Int16Array, sampleRate: number, ms: number}>}
 */
export async function extractAnalysisAudio(path) {
  const out = '/analysis.wav';
  const { code, log, ms } = await run([
    '-hide_banner', '-nostdin', '-i', path,
    '-vn', '-sn', '-dn', '-map', '0:a:0',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', out,
  ]);
  if (code !== 0) {
    throw new Error(`audio extract failed (code ${code}): ${log.slice(-3).join(' | ')}`);
  }
  const bytes = await readFile(out);
  await deleteFile(out);
  return { samples: wavToInt16(bytes), sampleRate: 16000, ms };
}

/**
 * Where the video's keyframes are, in seconds. Stream-copy cuts can only
 * start on these. Nothing is decoded: ffmpeg is told to skip every
 * non-keyframe, and we just read the timestamps of what is left.
 * @param {string} path
 * @returns {Promise<{times: number[], ms: number}>}
 */
export async function readKeyframes(path) {
  const out = '/keyframes.txt';
  const { code, log, ms } = await run([
    '-hide_banner', '-nostdin', '-discard', 'nokey', '-i', path,
    '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-y', out,
  ]);
  if (code !== 0) throw new Error(`keyframe scan failed: ${log.slice(-2).join(' | ')}`);
  const text = new TextDecoder().decode(await readFile(out));
  await deleteFile(out);
  let tb = 1 / 90000;
  const times = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#tb 0:')) {
      const m = line.match(/(\d+)\/(\d+)/);
      if (m) tb = +m[1] / +m[2];
    } else if (line && line[0] !== '#') {
      const pts = +line.split(',')[2];
      if (Number.isFinite(pts)) times.push(pts * tb);
    }
  }
  times.sort((a, b) => a - b);
  return { times: times.filter((t, i) => i === 0 || t - times[i - 1] > 1e-4), ms };
}

/** Find the "data" chunk in a WAV and view it as 16-bit samples. */
function wavToInt16(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12; // skip RIFF....WAVE
  while (pos + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    let size = view.getUint32(pos + 4, true);
    const start = pos + 8;
    if (id === 'data') {
      // ffmpeg writes 0xFFFFFFFF here when it could not seek back to fix the header.
      if (size === 0xffffffff || start + size > bytes.byteLength) size = bytes.byteLength - start;
      const count = size >> 1;
      const aligned = (bytes.byteOffset + start) % 2 === 0;
      return aligned
        ? new Int16Array(bytes.buffer, bytes.byteOffset + start, count)
        : new Int16Array(bytes.slice(start, start + count * 2).buffer);
    }
    pos = start + size + (size & 1);
  }
  throw new Error('no audio data found in the extracted WAV');
}
