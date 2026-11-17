// Runs an export. Four combinations:
//
//              QUICK (stream copy)                 PRECISE (re-encode)
//   RIPPLE     one pass over the source with       each kept piece is encoded on its own,
//              in/out points on keyframes          then the pieces are joined
//   SLICE      one copy command per piece          one encode per piece
//
// Every output is written to disk (browser private storage), never held in
// memory, so a 2 GB result is fine.

import { Zip, ZipPassThrough } from 'fflate';
import * as engine from './engine.js';
import { createOutput, removeOutput, clearOutputs } from './outstore.js';
import {
  planQuick, baseName, sliceName, rippleName, concatListForRanges, concatListForFiles,
} from './cutlist.js';

const MAPS = ['-map', '0:v:0?', '-map', '0:a:0?'];
// THREAD CAPS -- do not remove. The multithreaded core has a fixed pool of 32
// worker threads. Left on "auto", the decoder and the x264 encoder together ask
// for more than that on a many-core PC and ffmpeg deadlocks (it just stops,
// with no error). Measured on a 20-thread machine: encoder 8 + decoder auto =
// hang; decoder 6-8 + encoder 8 = fine. The single-thread core ignores these.
const CORES = Math.max(1, navigator.hardwareConcurrency || 4);
const DECODE_THREADS = ['-threads', String(Math.min(6, CORES))];
const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', String(Math.min(8, CORES))];
const AAC = ['-c:a', 'aac', '-b:a', '160k'];
const HEAD = ['-hide_banner', '-nostdin'];
const ZIP_LIMIT = 3.9 * 1024 * 1024 * 1024; // plain zip files stop at 4 GB

export class ExportCancelled extends Error {
  constructor() { super('Export cancelled'); this.name = 'ExportCancelled'; }
}

const fmt = (t) => Math.max(0, t).toFixed(6);
const failure = (what, r) => new Error(`${what} failed: ${r.log.filter((l) => l && l !== 'Aborted()').slice(-2).join(' | ') || `code ${r.code}`}`);

/**
 * @param {object} o
 * @param {File} o.file the source video
 * @param {string} o.inputPath where it is mounted for ffmpeg
 * @param {number} o.duration
 * @param {{start:number,end:number}[]} o.keep exact keep segments
 * @param {number[]|null} o.keyframes needed for Quick
 * @param {'ripple'|'slice'} o.mode
 * @param {'quick'|'precise'} o.accuracy
 * @param {(p: {ratio:number, label:string, etaSec:number|null, piece:number, pieces:number}) => void} o.onProgress
 * @param {{cancelled: boolean}} o.token set token.cancelled = true (and call engine.cancelAll()) to stop
 * @returns {Promise<{outputs: {name:string, file:File, duration:number, start:number, end:number}[], segments: object[], ms:number, onDisk:boolean}>}
 */
export async function runExport(o) {
  const t0 = performance.now();
  const base = baseName(o.file.name);
  const quick = o.accuracy === 'quick';
  if (quick && !o.keyframes) throw new Error('Quick mode needs the keyframe list, which could not be read for this video. Use Precise.');
  const segments = quick ? planQuick(o.keep, o.keyframes, o.duration).segments : o.keep.map((s) => ({ ...s }));
  if (!segments.length) throw new Error('Nothing left to export: everything is marked as silence.');
  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

  await clearOutputs('out');
  o = { ...o, inputPath: await engine.useInput(o.file) };
  const check = () => { if (o.token?.cancelled) throw new ExportCancelled(); };
  const report = (doneSeconds, label, piece, sourceTime = null) => {
    const ratio = Math.min(1, Math.max(0, doneSeconds / total));
    const elapsed = (performance.now() - t0) / 1000;
    const etaSec = ratio > 0.03 && elapsed > 1.5 ? (elapsed * (1 - ratio)) / ratio : null;
    // sourceTime = where in the ORIGINAL video the work has reached (drives the blade)
    o.onProgress?.({ ratio, label, etaSec, piece, pieces: segments.length, sourceTime });
  };

  let outputs;
  try {
    if (o.mode === 'slice') {
      outputs = await exportPieces(o, segments, base, quick, { check, report, total, scale: 1, ext: 'mp4', finalAudio: true });
    } else if (quick) {
      outputs = [await rippleQuick(o, segments, base, { check, report, total })];
    } else {
      outputs = [await ripplePrecise(o, segments, base, { check, report, total })];
    }
  } catch (err) {
    if (o.token?.cancelled) throw new ExportCancelled();
    throw err;
  }
  report(total, 'Done', segments.length, o.duration);
  return { outputs, segments, ms: Math.round(performance.now() - t0), onDisk: engine.engineInfo().diskOutput === true };
}

/** One output file per kept segment (Slice mode, and the first half of Precise Ripple). */
async function exportPieces(o, segments, base, quick, ctx) {
  const outputs = [];
  let doneSeconds = 0;
  for (let i = 0; i < segments.length; i++) {
    ctx.check();
    const seg = segments[i];
    const len = seg.end - seg.start;
    const name = ctx.nameFor ? ctx.nameFor(i) : sliceName(base, i, ctx.ext);
    const label = `${ctx.verb || 'Slicing'} ${i + 1} of ${segments.length}`;
    ctx.report(doneSeconds * ctx.scale, label, i, seg.start);
    const off = engine.onProgress((e) => {
      const within = e.time > 0 ? Math.min(len, e.time / 1e6) : 0;
      ctx.report((doneSeconds + within) * ctx.scale, label, i, seg.start + within);
    });
    let r;
    try {
      r = await engine.writeOutput(name, (out) => [
        ...HEAD,
        ...(quick ? [] : DECODE_THREADS),
        // input seeking: for copy this lands on the keyframe we planned for;
        // for re-encode ffmpeg decodes from there and starts on the exact frame
        '-ss', fmt(seg.start + (quick && seg.start > 0 ? 0.001 : 0)), '-i', o.inputPath, '-t', fmt(len),
        ...MAPS,
        ...(quick
          ? ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
          : [...X264, ...(ctx.finalAudio ? AAC : ['-c:a', 'pcm_s16le'])]),
        '-y', out,
      ]);
    } finally {
      off();
    }
    ctx.check();
    if (r.code !== 0 || !r.file) throw failure(`Piece ${i + 1}`, r);
    outputs.push({ name, file: r.file, start: seg.start, end: seg.end, duration: len });
    doneSeconds += len;
  }
  return outputs;
}

/** Quick Ripple: a single stream-copy pass using keyframe-aligned in/out points. */
async function rippleQuick(o, segments, base, ctx) {
  const name = rippleName(base);
  await engine.writeText('/ripple.txt', concatListForRanges(o.inputPath, segments));
  ctx.report(0, 'Rippling', 0);
  const off = engine.onProgress((e) => {
    if (!(e.time > 0)) return;
    const done = e.time / 1e6;
    // which piece is the blade on? (for the progress read-out / animation)
    let before = 0;
    let piece = 0;
    for (; piece < segments.length - 1; piece++) {
      const len = segments[piece].end - segments[piece].start;
      if (before + len > done) break;
      before += len;
    }
    const seg = segments[piece];
    const sourceTime = Math.min(seg.end, seg.start + Math.max(0, done - before));
    ctx.report(done, `Rippling · cut ${Math.min(piece + 1, segments.length)} of ${segments.length}`, piece, sourceTime);
  });
  let r;
  try {
    r = await engine.writeOutput(name, (out) => [
      ...HEAD, '-f', 'concat', '-safe', '0', '-i', '/ripple.txt', ...MAPS, '-c', 'copy', '-y', out,
    ]);
  } finally {
    off();
    await engine.deleteFile('/ripple.txt');
  }
  ctx.check();
  if (r.code !== 0 || !r.file) throw failure('Ripple export', r);
  return { name, file: r.file, start: 0, end: o.duration, duration: ctx.total };
}

/**
 * Precise Ripple: encode every kept piece separately (frame-accurate), then
 * join them. The pieces carry uncompressed audio so the joins are
 * sample-exact; audio is compressed once, in the joining pass.
 */
async function ripplePrecise(o, segments, base, ctx) {
  const name = rippleName(base);
  const ENCODE_SHARE = 0.95; // joining is a fast copy
  const parts = await exportPieces(o, segments, base, false, {
    ...ctx, scale: ENCODE_SHARE, ext: 'mov', finalAudio: false, verb: 'Cutting',
    nameFor: (i) => `part_${String(i + 1).padStart(4, '0')}.mov`,
  });
  ctx.check();
  ctx.report(ctx.total * ENCODE_SHARE, 'Joining the pieces', segments.length - 1);
  await engine.mountBlobs('/parts', parts.map((p) => ({ name: p.name, data: p.file })));
  await engine.writeText('/join.txt', concatListForFiles(parts.map((p) => `/parts/${p.name}`)));
  let r;
  try {
    r = await engine.writeOutput(name, (out) => [
      ...HEAD, '-f', 'concat', '-safe', '0', '-i', '/join.txt', ...MAPS, '-c:v', 'copy', ...AAC, '-y', out,
    ]);
  } finally {
    await engine.unmountDir('/parts');
    await engine.deleteFile('/join.txt');
    for (const p of parts) await removeOutput(p.name);
  }
  ctx.check();
  if (r.code !== 0 || !r.file) throw failure('Joining', r);
  return { name, file: r.file, start: 0, end: o.duration, duration: ctx.total };
}

export const canZip = (outputs) => outputs.reduce((sum, x) => sum + x.file.size, 0) < ZIP_LIMIT;

/**
 * Bundle clips into one .zip without compressing (video does not shrink) and
 * without loading them into memory: each clip is streamed from disk, through
 * the zipper, back to disk.
 */
export async function zipOutputs(outputs, zipName, onProgress) {
  const total = outputs.reduce((sum, x) => sum + x.file.size, 0) || 1;
  let handle = null;
  let writable = null;
  const chunks = [];
  try {
    handle = await createOutput(zipName);
    writable = await handle.createWritable();
  } catch {
    handle = null; // no disk storage: build it in memory instead
  }
  let pending = Promise.resolve();
  let failed = null;
  const zip = new Zip((err, chunk) => {
    if (err) { failed = err; return; }
    if (writable) pending = pending.then(() => writable.write(chunk));
    else chunks.push(chunk);
  });
  let done = 0;
  for (const item of outputs) {
    const entry = new ZipPassThrough(item.name);
    zip.add(entry);
    const reader = item.file.stream().getReader();
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      entry.push(value);
      done += value.length;
      await pending; // don't read faster than the disk can write
      if (failed) throw failed;
      onProgress?.(done / total);
    }
    entry.push(new Uint8Array(0), true);
  }
  zip.end();
  await pending;
  if (failed) throw failed;
  if (writable) {
    await writable.close();
    return handle.getFile();
  }
  return new File(chunks, zipName, { type: 'application/zip' });
}
