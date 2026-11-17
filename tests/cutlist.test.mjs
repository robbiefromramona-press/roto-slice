import assert from 'node:assert/strict';
import * as C from '../src/cutlist.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

// keyframes every 1 s over a 30 s clip
const kf = Array.from({ length: 30 }, (_, i) => i);
assert.equal(C.keyframeAtOrBefore(kf, 4.5), 4);
assert.equal(C.keyframeAtOrBefore(kf, 4), 4);
assert.equal(C.keyframeAtOrBefore([2, 3], 1), null);
near(C.keyframeInterval(kf), 1);

// Three kept segments. Gap 1 (3.85-6.65) contains keyframes 4,5,6 -> cut, start snaps 6.65 -> 6.
// Gap 2 (10.2-10.7) contains no keyframe -> cannot cut, segments join.
const keep = [{ start: 0, end: 3.85 }, { start: 6.65, end: 10.2 }, { start: 10.7, end: 30 }];
const plan = C.planQuick(keep, kf, 30);
assert.equal(plan.segments.length, 2);
near(plan.segments[1].start, 6); near(plan.segments[1].end, 30);
assert.equal(plan.cutsWanted, 2); assert.equal(plan.cutsMade, 1);
near(plan.removed, 6 - 3.85); near(plan.removedWanted, 2.8 + 0.5);

// Leading silence: first segment snaps back to a keyframe; trailing silence is an exact cut.
const p2 = C.planQuick([{ start: 2.4, end: 20.5 }], kf, 30);
near(p2.segments[0].start, 2); near(p2.segments[0].end, 20.5);
assert.equal(p2.cutsMade, 2);

// A keyframe exactly at the end of the previous segment saves nothing -> no cut.
const p3 = C.planQuick([{ start: 0, end: 5 }, { start: 5.6, end: 9 }], kf, 30);
assert.equal(p3.segments.length, 1);

// Segments never overlap or go backwards.
const dense = Array.from({ length: 40 }, (_, i) => ({ start: i * 0.7, end: i * 0.7 + 0.3 }));
const p4 = C.planQuick(dense, kf, 30);
for (let i = 1; i < p4.segments.length; i++) assert.ok(p4.segments[i].start >= p4.segments[i - 1].end);

assert.equal(C.baseName('My Talk: part 1?.MOV'), 'My Talk_ part 1_');
assert.equal(C.sliceName('talk', 0), 'talk_slice_001.mp4');
assert.equal(C.rippleName('talk'), 'talk_roto.mp4');

const json = JSON.parse(C.buildCutlistJson({ fileName: 'a.mp4', duration: 30, fps: 30, settings: { thresholdDb: -40 }, keep }));
assert.equal(json.keep.length, 3); assert.equal(json.cuts.length, 2);
assert.deepEqual(json.cuts[0], { start: 3.85, end: 6.65 });
near(json.totals.removed, 3.3);

const edl = C.buildEdl({ title: 'a_roto', fileName: 'a.mp4', fps: 30, keep }).split('\r\n');
assert.equal(edl[0], 'TITLE: a_roto');
assert.equal(edl[1], 'FCM: NON-DROP FRAME');
assert.equal(edl[3], '001  AX       AA/V  C        00:00:00:00 00:00:03:26 00:00:00:00 00:00:03:26');
assert.equal(edl[4], '* FROM CLIP NAME: a.mp4');
// second event: source 6.65 s = frame 200 (00:00:06:20), record continues from 00:00:03:26
assert.equal(edl[6], '002  AX       AA/V  C        00:00:06:20 00:00:10:06 00:00:03:26 00:00:07:12');
// 29.97 fps footage counts real frames against a 30-frame timecode
const ntsc = C.buildEdl({ title: 't', fileName: 'a.mp4', fps: 29.97, keep: [{ start: 0, end: 60 }] }).split('\r\n');
assert.ok(ntsc[3].includes('00:00:00:00 00:00:59:28'));

assert.equal(
  C.concatListForRanges("/in/it's.mp4", [{ start: 1, end: 2.5 }]),
  "ffconcat version 1.0\nfile '/in/it'\\''s.mp4'\ninpoint 1.000000\noutpoint 2.500000\n",
);
console.log('cutlist tests passed');
