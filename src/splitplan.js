// Pre-Slice planning. Pure functions (no ffmpeg, no DOM).

import { WINDOW_SEC, MAX_ROTO_SECONDS } from './analysis.js';
import { baseName } from './cutlist.js';

/** The keyframe closest to t (either side); null if there are none. */
export function nearestKeyframe(keyframes, t) {
  if (!keyframes || !keyframes.length) return null;
  let lo = 0;
  let hi = keyframes.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid] <= t) lo = mid; else hi = mid;
  }
  return Math.abs(keyframes[lo] - t) <= Math.abs(keyframes[hi] - t) ? keyframes[lo] : keyframes[hi];
}

/**
 * The quietest moment between `from` and `to` seconds: the centre of the
 * 300 ms stretch with the lowest average loudness.
 */
export function quietestMoment(db, from, to) {
  const span = 30; // windows = 300 ms
  const a = Math.max(0, Math.floor(from / WINDOW_SEC));
  const b = Math.min(db.length, Math.ceil(to / WINDOW_SEC));
  if (b - a <= span) return (from + to) / 2;
  let sum = 0;
  for (let i = a; i < a + span; i++) sum += db[i];
  let best = sum;
  let bestStart = a;
  for (let i = a + span; i < b; i++) {
    sum += db[i] - db[i - span];
    if (sum < best) { best = sum; bestStart = i - span + 1; }
  }
  return (bestStart + span / 2) * WINDOW_SEC;
}

/**
 * Auto-Slice: evenly spaced marks no more than `target` apart (14:30), each
 * nudged to the quietest moment within +/- `nudge` seconds so the cut lands
 * between sentences, then snapped to a keyframe. No piece ends up over 15:00.
 * @param {number} duration
 * @param {Float32Array|null} db loudness per 10 ms window (null = no audio)
 * @param {number[]|null} keyframes
 */
export function autoSlicePoints(duration, db, keyframes, { target = 870, nudge = 20, max = MAX_ROTO_SECONDS } = {}) {
  const pieces = Math.ceil(duration / target);
  if (pieces <= 1) return [];
  const spacing = duration / pieces;
  const points = [];
  let prev = 0;
  for (let i = 1; i < pieces; i++) {
    const ideal = i * spacing;
    const hi = Math.min(ideal + nudge, prev + max - 5, duration - 1);
    const lo = Math.max(ideal - nudge, prev + 1);
    let t = db && hi > lo ? quietestMoment(db, lo, hi) : Math.min(ideal, hi);
    if (keyframes && keyframes.length) {
      let k = nearestKeyframe(keyframes, t);
      if (k - prev > max) k = lastAtOrBefore(keyframes, prev + max) ?? k;
      if (k > prev + 1 && k < duration - 1) t = k;
    }
    points.push(t);
    prev = t;
  }
  return points;
}

function lastAtOrBefore(sorted, t) {
  let found = null;
  for (const k of sorted) { if (k <= t) found = k; else break; }
  return found;
}

/** Turn sorted marker times into the pieces between them. */
export function piecesFromMarkers(markerTimes, duration) {
  const cuts = [...markerTimes].filter((t) => t > 0.05 && t < duration - 0.05).sort((a, b) => a - b);
  const edges = [0, ...cuts, duration];
  const pieces = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    pieces.push({ index: i, start, end, duration: end - start, tooLong: end - start > MAX_ROTO_SECONDS + 0.001 });
  }
  return pieces;
}

export function partName(fileName, index) {
  const ext = /\.mov$/i.test(fileName) ? 'mov' : 'mp4';
  return `${baseName(fileName)}_part${index + 1}.${ext}`;
}
