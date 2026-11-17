// Silence maths. Pure functions, no ffmpeg and no DOM -- everything here runs
// on the cached loudness array, which is why the sliders can be instant.

export const WINDOW_SEC = 0.01; // loudness is measured in 10 ms windows
export const DB_FLOOR = -100; // what we call "digital silence"
export const MAX_ROTO_SECONDS = 15 * 60; // hard cap for Roto-Slice
export const SOFT_SIZE_BYTES = 1.8 * 1024 * 1024 * 1024;

/**
 * Loudness (RMS, in dBFS) of every 10 ms window. Computed once per file.
 * @param {Int16Array} samples mono PCM
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
export function computeRmsDb(samples, sampleRate = 16000) {
  const win = Math.round(sampleRate * WINDOW_SEC);
  const n = Math.floor(samples.length / win);
  const db = new Float32Array(n);
  const scale = 1 / (32768 * 32768 * win);
  let i = 0;
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (const end = i + win; i < end; i++) {
      const s = samples[i];
      sum += s * s;
    }
    const meanSquare = sum * scale;
    db[w] = meanSquare > 1e-10 ? 10 * Math.log10(meanSquare) : DB_FLOOR;
  }
  return db;
}

/**
 * Find the stretches to cut.
 *  - a "silence" is a run of windows quieter than the threshold
 *  - runs shorter than minSilenceMs are natural pauses and are left alone
 *  - padMs of the silence is kept next to speech on each side, so words are
 *    not clipped (no padding against the very start/end of the file)
 * @param {Float32Array} db
 * @param {{thresholdDb: number, minSilenceMs: number, padMs: number}} p
 * @returns {{start: number, end: number, kept: boolean}[]} seconds, in order
 */
export function detectSilences(db, { thresholdDb, minSilenceMs, padMs }) {
  const n = db.length;
  const minWindows = Math.max(1, Math.round(minSilenceMs / (WINDOW_SEC * 1000)));
  const pad = padMs / 1000;
  const gaps = [];
  let i = 0;
  while (i < n) {
    if (db[i] >= thresholdDb) { i++; continue; }
    let j = i + 1;
    while (j < n && db[j] < thresholdDb) j++;
    if (j - i >= minWindows) {
      let start = i * WINDOW_SEC;
      let end = j * WINDOW_SEC;
      if (i > 0) start += pad;
      if (j < n) end -= pad;
      if (end - start >= 0.05) gaps.push({ start, end, kept: false });
    }
    i = j;
  }
  return gaps;
}

/**
 * Guess a threshold: find the noise floor (the level the quietest 10% of the
 * recording sits under) and go 6 dB above it.
 */
export function autoThreshold(db, min = -60, max = -20) {
  if (!db.length) return -40;
  const bins = new Uint32Array(101); // 1 dB bins: index 0 = -100 dB, 100 = 0 dB
  for (let i = 0; i < db.length; i++) {
    const b = Math.round(db[i]) + 100;
    bins[b < 0 ? 0 : b > 100 ? 100 : b]++;
  }
  const percentile = (fraction) => {
    const target = db.length * fraction;
    let seen = 0;
    for (let b = 0; b <= 100; b++) {
      seen += bins[b];
      if (seen >= target) return b - 100;
    }
    return 0;
  };
  // "Speech level" is roughly the loud end. If the quietest 10% is not clearly
  // below it, the recording has very little silence and the 10% mark landed in
  // speech -- so look at a smaller slice of the quietest audio instead.
  const speech = percentile(0.95);
  for (const fraction of [0.1, 0.05, 0.02]) {
    const floorDb = percentile(fraction);
    if (speech - floorDb >= 15) {
      return Math.min(max, Math.max(min, Math.min(Math.round(floorDb + 6), speech - 10)));
    }
  }
  return -40; // nothing that looks like a noise floor; stay on the default
}

/**
 * Manual overrides are remembered as points in time ("the user said keep the
 * gap that covers 12.3 s"), so they survive the sliders reshaping the gaps.
 */
export function applyOverrides(gaps, overrides) {
  for (const g of gaps) {
    g.kept = false;
    for (const t of overrides) {
      if (t >= g.start && t <= g.end) { g.kept = true; break; }
    }
  }
  return gaps;
}

/** Per-window flags for drawing: 0 = keep, 1 = cut, 2 = silence the user chose to keep. */
export function buildMask(gaps, windowCount) {
  const mask = new Uint8Array(windowCount);
  for (const g of gaps) {
    const a = Math.max(0, Math.round(g.start / WINDOW_SEC));
    const b = Math.min(windowCount, Math.round(g.end / WINDOW_SEC));
    mask.fill(g.kept ? 2 : 1, a, b);
  }
  return mask;
}

export function summarize(gaps, duration) {
  let removed = 0;
  let cuts = 0;
  for (const g of gaps) {
    if (g.kept) continue;
    removed += g.end - g.start;
    cuts++;
  }
  return { removed, cuts, duration, newLength: Math.max(0, duration - removed), percent: duration ? (removed / duration) * 100 : 0 };
}

/** The gap covering time t (binary search), or null. */
export function findGapAt(gaps, t) {
  let lo = 0;
  let hi = gaps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = gaps[mid];
    if (t < g.start) hi = mid - 1;
    else if (t >= g.end) lo = mid + 1;
    else return g;
  }
  return null;
}

/** The parts that survive, as [start, end] pairs in seconds. Used by export. */
export function keepSegments(gaps, duration) {
  const out = [];
  let pos = 0;
  for (const g of gaps) {
    if (g.kept) continue;
    if (g.start - pos > 0.001) out.push({ start: pos, end: g.start });
    pos = g.end;
  }
  if (duration - pos > 0.001) out.push({ start: pos, end: duration });
  return out;
}

export function clock(t) {
  t = Math.max(0, Math.round(t));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
