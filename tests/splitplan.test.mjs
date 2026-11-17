import assert from 'node:assert/strict';
import * as P from '../src/splitplan.js';

const kf = Array.from({ length: 2500 }, (_, i) => i * 2); // keyframe every 2 s
assert.equal(P.nearestKeyframe(kf, 10.9), 10);
assert.equal(P.nearestKeyframe(kf, 11.1), 12);
assert.equal(P.nearestKeyframe([], 5), null);

// loudness: speech at -15 dB everywhere, with one quiet second at 883-884 s
const duration = 1200;
const db = new Float32Array(duration * 100).fill(-15);
db.fill(-60, 88300, 88400);
assert.ok(Math.abs(P.quietestMoment(db, 850, 890) - 883.5) < 0.4);

// 20 minutes -> 2 pieces; ideal mark is 600 s; no quiet spot near it -> stays near 600, on a keyframe
const even = P.autoSlicePoints(duration, db, kf);
assert.equal(even.length, 1);
assert.ok(Math.abs(even[0] - 600) <= 21 && even[0] % 2 === 0, String(even[0]));

// with the quiet spot inside the +/-20 s window of the ideal mark, the cut lands in it
const db2 = new Float32Array(duration * 100).fill(-15);
db2.fill(-60, 61000, 61100); // 610-611 s
const quiet = P.autoSlicePoints(duration, db2, kf);
assert.ok(Math.abs(quiet[0] - 610.5) <= 1.5, String(quiet[0]));

// 50 minutes: every piece is 15:00 or less, with and without audio/keyframes
for (const [d, k] of [[db, kf], [null, kf], [null, null]]) {
  const pts = P.autoSlicePoints(3000, d && new Float32Array(300000).fill(-20), k);
  const pieces = P.piecesFromMarkers(pts, 3000);
  assert.equal(pieces.length, 4);
  assert.ok(pieces.every((p) => !p.tooLong && p.duration <= 900), JSON.stringify(pieces.map((p) => p.duration)));
}
assert.deepEqual(P.autoSlicePoints(800, null, kf), []); // already short enough

const pieces = P.piecesFromMarkers([1000, 300], 2000);
assert.deepEqual(pieces.map((p) => [p.start, p.end, p.tooLong]), [[0, 300, false], [300, 1000, false], [1000, 2000, true]]);
assert.equal(P.piecesFromMarkers([], 100).length, 1);

assert.equal(P.partName('My Talk.MOV', 0), 'My Talk_part1.mov');
assert.equal(P.partName('clip.mkv', 2), 'clip_part3.mp4');
console.log('splitplan tests passed');
