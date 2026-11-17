// Export planning and cut-list files. Pure functions (no ffmpeg, no DOM).

const round3 = (t) => Math.round(t * 1000) / 1000;

/** Last keyframe at or before t (binary search); null if there is none. */
export function keyframeAtOrBefore(keyframes, t) {
  let lo = 0;
  let hi = keyframes.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid] <= t) { found = keyframes[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * Work out what Quick mode (stream copy, no re-encode) can actually do.
 *
 * A copied piece of video can only START on a keyframe. So each kept segment's
 * start is pulled back to the keyframe before it (a little extra silence gets
 * kept -- that is the "slop"). If there is no keyframe inside a silence at
 * all, that cut cannot be made without repeating footage, so the two
 * neighbouring segments are joined and the silence stays in.
 *
 * @param {{start:number,end:number}[]} keep exact keep segments
 * @param {number[]} keyframes sorted keyframe times in seconds
 * @param {number} duration
 */
export function planQuick(keep, keyframes, duration) {
  const MIN_SAVING = 0.1; // not worth a cut that removes less than this
  const segments = [];
  for (const k of keep) {
    let start = k.start;
    if (start > 0) start = keyframeAtOrBefore(keyframes, start + 0.002) ?? 0;
    const prev = segments[segments.length - 1];
    if (prev && start < prev.end + MIN_SAVING) prev.end = k.end;
    else segments.push({ start, end: k.end });
  }
  const kept = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const wantedKept = keep.reduce((sum, s) => sum + (s.end - s.start), 0);
  const lead = (list) => (list.length && list[0].start > 0.001 ? 1 : 0);
  const tail = (list) => (list.length && duration - list[list.length - 1].end > 0.001 ? 1 : 0);
  const cutCount = (list) => (list.length ? list.length - 1 + lead(list) + tail(list) : 0);
  return {
    segments,
    cutsMade: cutCount(segments),
    cutsWanted: cutCount(keep),
    removed: Math.max(0, duration - kept),
    removedWanted: Math.max(0, duration - wantedKept),
  };
}

/** Typical gap between keyframes, in seconds (median). */
export function keyframeInterval(keyframes) {
  if (keyframes.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < keyframes.length; i++) gaps.push(keyframes[i] - keyframes[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

export function baseName(fileName) {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  // keep it friendly to every OS and to zip files
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'video';
}

export const sliceName = (base, index, ext = 'mp4') => `${base}_slice_${String(index + 1).padStart(3, '0')}.${ext}`;
export const rippleName = (base, ext = 'mp4') => `${base}_roto.${ext}`;

/** cutlist.json: the keep segments (and the cuts) in plain seconds. */
export function buildCutlistJson({ fileName, duration, fps, settings, keep }) {
  const cuts = [];
  let pos = 0;
  for (const k of keep) {
    if (k.start - pos > 0.0005) cuts.push({ start: round3(pos), end: round3(k.start) });
    pos = k.end;
  }
  if (duration - pos > 0.0005) cuts.push({ start: round3(pos), end: round3(duration) });
  const keptTotal = keep.reduce((sum, s) => sum + (s.end - s.start), 0);
  return JSON.stringify({
    tool: 'Roto-Slice',
    version: 1,
    units: 'seconds',
    source: { name: fileName, duration: round3(duration), fps: fps || null },
    settings,
    totals: { kept: round3(keptTotal), removed: round3(duration - keptTotal), cuts: cuts.length },
    keep: keep.map((s) => ({ start: round3(s.start), end: round3(s.end) })),
    cuts,
  }, null, 2) + '\n';
}

/**
 * cutlist.edl in CMX3600, the plain-text edit list DaVinci Resolve and
 * Premiere can import. One event per kept segment; source timecode assumes
 * the clip starts at 00:00:00:00. Non-drop-frame.
 */
export function buildEdl({ title, fileName, fps, keep }) {
  const rate = fps && fps > 0 ? fps : 30;
  const base = Math.max(1, Math.round(rate));
  const pad = (n) => String(n).padStart(2, '0');
  const tc = (frames) => {
    const ff = frames % base;
    const s = Math.floor(frames / base);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(ff)}`;
  };
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 0;
  let n = 0;
  for (const k of keep) {
    const srcIn = Math.round(k.start * rate);
    const srcOut = Math.round(k.end * rate);
    if (srcOut <= srcIn) continue;
    n++;
    const recOut = rec + (srcOut - srcIn);
    lines.push(`${String(n).padStart(3, '0')}  AX       AA/V  C        ${tc(srcIn)} ${tc(srcOut)} ${tc(rec)} ${tc(recOut)}`);
    lines.push(`* FROM CLIP NAME: ${fileName}`);
    lines.push('');
    rec = recOut;
  }
  return lines.join('\r\n');
}

/** The text file ffmpeg's concat demuxer reads: one file, many in/out points. */
export function concatListForRanges(path, segments) {
  const quoted = path.replace(/'/g, "'\\''");
  const lines = ['ffconcat version 1.0'];
  for (const s of segments) {
    lines.push(`file '${quoted}'`, `inpoint ${s.start.toFixed(6)}`, `outpoint ${s.end.toFixed(6)}`);
  }
  return lines.join('\n') + '\n';
}

/** Concat list for separate clip files played back to back. */
export function concatListForFiles(paths) {
  return ['ffconcat version 1.0', ...paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`)].join('\n') + '\n';
}
