// Run with: npm test
import assert from 'node:assert/strict';
import * as A from '../src/analysis.js';

// 60 s at 16 kHz: tone, silent from 10-12 s (2 s), 20-20.3 s (0.3 s) and 58-60 s.
const sr = 16000;
const x = new Int16Array(sr * 60);
for (let i = 0; i < x.length; i++) {
  const t = i / sr;
  const silent = (t >= 10 && t < 12) || (t >= 20 && t < 20.3) || t >= 58;
  x[i] = silent ? Math.round(20 * Math.sin(t * 377)) : Math.round(9000 * Math.sin(t * 1382));
}
const db = A.computeRmsDb(x, sr);
assert.equal(db.length, 6000);
assert.ok(Math.abs(db[100] - 20 * Math.log10(9000 / 32768 / Math.SQRT2)) < 0.5, 'tone level');

const p = { thresholdDb: -40, minSilenceMs: 600, padMs: 120 };
let gaps = A.detectSilences(db, p);
assert.equal(gaps.length, 2, 'short pause is left alone');
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.011, `${a} vs ${b}`);
near(gaps[0].start, 10.12); near(gaps[0].end, 11.88);
near(gaps[1].start, 58.12); near(gaps[1].end, 60); // no padding at the file end

assert.equal(A.detectSilences(db, { ...p, minSilenceMs: 200 }).length, 3);
assert.equal(A.detectSilences(db, { ...p, thresholdDb: -70 }).length, 0);

const s = A.summarize(gaps, 60);
assert.equal(s.cuts, 2); near(s.removed, 1.76 + 1.88);

A.applyOverrides(gaps, [11]);
assert.equal(gaps[0].kept, true); assert.equal(gaps[1].kept, false);
assert.equal(A.summarize(gaps, 60).cuts, 1);
const mask = A.buildMask(gaps, db.length);
assert.equal(mask[1100], 2); assert.equal(mask[5900], 1); assert.equal(mask[500], 0);
assert.equal(A.findGapAt(gaps, 59), gaps[1]); assert.equal(A.findGapAt(gaps, 30), null);
const keep = A.keepSegments(gaps, 60);
assert.equal(keep.length, 1); near(keep[0].end, 58.12);

const auto = A.autoThreshold(db);
assert.ok(auto >= -60 && auto < -20, `auto threshold ${auto}`);
assert.equal(A.detectSilences(db, { ...p, thresholdDb: auto }).length, 2);
assert.equal(A.clock(628), '10:28');

// Speed: 15 minutes of windows must re-detect far inside the 50 ms budget.
const big = new Float32Array(90000).map((_, i) => (i % 700 < 500 ? -15 : -55));
const t0 = performance.now();
for (let k = 0; k < 20; k++) A.buildMask(A.applyOverrides(A.detectSilences(big, p), [5]), big.length);
const per = (performance.now() - t0) / 20;
assert.ok(per < 10, `detect too slow: ${per} ms`);
console.log(`analysis tests passed (15-min re-detect: ${per.toFixed(2)} ms)`);
