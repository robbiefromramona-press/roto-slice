// The waveform, drawn by hand on <canvas> (no library) so we own the look.
//
// Two canvases: the big zoomable one, and a thin "minimap" of the whole file
// with a box showing which part the big one is looking at.
//
// Heights are on a dB scale (-70 dB at the centre line, 0 dB at the edge) so
// quiet speech is still visible and the threshold is an honest straight line.
//
// Look: kept audio is glowing cyan; silences that will be cut are dimmed and
// covered with pink hazard stripes; during an export, everything the blade
// has already passed is drawn as "sliced" (the cut closes up to a dark seam).

import { WINDOW_SEC } from './analysis.js';

const DB_BOTTOM = -70;
const COLORS = {
  bg: '#07060f',
  grid: 'rgba(255,255,255,0.06)',
  keepTop: '#9ff7ff',
  keep: '#00e6ff',
  keepDeep: '#0077c8',
  cut: '#ff00b8',
  cutBar: 'rgba(255,0,184,0.55)',
  cutBand: 'rgba(60,0,44,0.55)',
  seam: '#12050f',
  keptGapBand: 'rgba(0,230,255,0.10)',
  threshold: 'rgba(232,255,0,0.85)',
  text: '#a3a4c2',
};
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_SPAN = 2; // seconds; the furthest you can zoom in

const level = (db) => (db <= DB_BOTTOM ? 0 : db >= 0 ? 1 : (db - DB_BOTTOM) / -DB_BOTTOM);

/** A small tile of diagonal stripes, used to fill the cut regions. */
function makeStripes(ctx, dpr) {
  const size = Math.round(14 * dpr);
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const t = tile.getContext('2d');
  t.strokeStyle = 'rgba(255,0,184,0.5)';
  t.lineWidth = size * 0.26;
  t.beginPath();
  for (const o of [-size, 0, size]) {
    t.moveTo(o, size);
    t.lineTo(o + size, 0);
  }
  t.stroke();
  return ctx.createPattern(tile, 'repeat');
}

export class Waveform {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLCanvasElement} mini
   * @param {{onSeek: (t:number)=>void, onGapClick: (t:number)=>boolean, onView?: ()=>void}} handlers
   *   onGapClick returns true if t was inside a gap (and was toggled).
   */
  constructor(canvas, mini, handlers) {
    this.canvas = canvas;
    this.mini = mini;
    this.handlers = handlers;
    this.db = null;
    this.mask = null;
    this.duration = 0;
    this.thresholdDb = -40;
    this.view = { start: 0, end: 1 };
    this.bladeT = null; // seconds the export blade has reached, or null
    this.locked = false; // no zoom/pan/clicks while exporting
    this.lastDrawMs = 0;
    this._stripes = null;
    this._stripesDpr = 0;
    this._bindMain();
    this._bindMini();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  setData(db, duration) {
    this.db = db;
    this.duration = Math.max(duration, db.length * WINDOW_SEC);
    this.mask = new Uint8Array(db.length);
    this.view = { start: 0, end: this.duration };
    this.bladeT = null;
    this.resize();
  }

  setCuts(mask, thresholdDb) {
    this.mask = mask;
    this.thresholdDb = thresholdDb;
    this.draw();
  }

  /** Where the export blade is (seconds), or null when no export is running. */
  setBlade(t) {
    this.bladeT = t;
    this.draw();
  }

  setView(start, end) {
    let span = Math.min(this.duration, Math.max(MIN_SPAN, end - start));
    if (this.duration < MIN_SPAN) span = this.duration;
    start = Math.min(Math.max(0, start), this.duration - span);
    this.view = { start, end: start + span };
    this.draw();
    this.handlers.onView?.();
  }

  zoom(factor, anchorTime) {
    const { start, end } = this.view;
    const anchor = anchorTime ?? (start + end) / 2;
    const span = (end - start) * factor;
    const ratio = (anchor - start) / (end - start);
    this.setView(anchor - span * ratio, anchor - span * ratio + span);
  }

  fit() { this.setView(0, this.duration); }

  /** Where time t sits, in CSS pixels from the left; null when off-screen. */
  xOf(t) {
    const { start, end } = this.view;
    if (t < start || t > end) return null;
    return ((t - start) / (end - start)) * this.canvas.clientWidth;
  }

  timeAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return this.view.start + ratio * (this.view.end - this.view.start);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.canvas, this.mini]) {
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    this.dpr = dpr;
    this.draw();
  }

  draw() {
    if (!this.db || !this.canvas.clientWidth) return;
    const t0 = performance.now();
    this._drawMain();
    this._drawMini();
    this.lastDrawMs = performance.now() - t0;
  }

  /** Per pixel column: loudest window, and how much of it is cut / kept-gap. */
  _columns(width, start, end) {
    const { db, mask } = this;
    const n = db.length;
    const peak = new Float32Array(width);
    const cut = new Float32Array(width);
    const kept = new Float32Array(width);
    const perPx = (end - start) / width / WINDOW_SEC;
    const first = start / WINDOW_SEC;
    for (let x = 0; x < width; x++) {
      let a = Math.floor(first + x * perPx);
      let b = Math.ceil(first + (x + 1) * perPx);
      if (b <= a) b = a + 1;
      if (a < 0) a = 0;
      if (b > n) b = n;
      if (a >= b) { peak[x] = -200; continue; }
      let max = -200;
      let c = 0;
      let k = 0;
      for (let i = a; i < b; i++) {
        if (db[i] > max) max = db[i];
        const m = mask[i];
        if (m === 1) c++;
        else if (m === 2) k++;
      }
      peak[x] = max;
      cut[x] = c / (b - a);
      kept[x] = k / (b - a);
    }
    return { peak, cut, kept };
  }

  _drawMain() {
    const { canvas, dpr } = this;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const rulerH = Math.round(18 * dpr);
    const waveH = H - rulerH;
    const mid = waveH / 2;
    const { start, end } = this.view;
    const span = end - start;
    const cols = this._columns(W, start, end);
    // columns the export blade has already passed
    const bladeX = this.bladeT == null ? -1 : ((this.bladeT - start) / span) * W;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,230,255,0.07)';
    ctx.fillRect(0, mid - dpr / 2, W, dpr);

    // 1. kept audio: a cyan gradient, then a soft copy of itself for the glow
    const grad = ctx.createLinearGradient(0, 0, 0, waveH);
    grad.addColorStop(0, COLORS.keepDeep);
    grad.addColorStop(0.3, COLORS.keep);
    grad.addColorStop(0.5, COLORS.keepTop);
    grad.addColorStop(0.7, COLORS.keep);
    grad.addColorStop(1, COLORS.keepDeep);
    ctx.fillStyle = grad;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      if (cols.cut[x] > 0.5) continue;
      const h = Math.max(1, level(cols.peak[x]) * (mid - 3));
      ctx.rect(x, mid - h, 1, h * 2);
    }
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.filter = `blur(${Math.round(5 * dpr)}px)`;
    ctx.drawImage(canvas, 0, 0, W, waveH, 0, 0, W, waveH);
    ctx.restore();

    // 2. silences: dark band + hazard stripes, with the quiet audio dimmed pink
    if (!this._stripes || this._stripesDpr !== dpr) {
      this._stripes = makeStripes(ctx, dpr);
      this._stripesDpr = dpr;
    }
    const runs = []; // [x0, x1) stretches that are (mostly) cut
    for (let x = 0; x < W; x++) {
      if (cols.cut[x] > 0.5) {
        const x0 = x;
        while (x < W && cols.cut[x] > 0.5) x++;
        runs.push([x0, x]);
      } else if (cols.cut[x] > 0) {
        // a cut thinner than a pixel: still mark it so it is not invisible
        ctx.fillStyle = `rgba(255,0,184,${0.25 + cols.cut[x] * 0.5})`;
        ctx.fillRect(x, 0, 1, waveH);
      } else if (cols.kept[x] > 0.5) {
        ctx.fillStyle = COLORS.keptGapBand;
        ctx.fillRect(x, 0, 1, waveH);
      }
    }
    for (const [x0, x1] of runs) {
      const sliced = bladeX >= 0 && x1 <= bladeX;
      if (sliced) {
        // the blade has been through: the gap is closed to a dark seam
        ctx.fillStyle = COLORS.seam;
        ctx.fillRect(x0, 0, x1 - x0, waveH);
        ctx.fillStyle = COLORS.cut;
        ctx.fillRect(x0, 0, dpr, waveH);
        ctx.fillRect(x1 - dpr, 0, dpr, waveH);
        continue;
      }
      ctx.fillStyle = COLORS.cutBand;
      ctx.fillRect(x0, 0, x1 - x0, waveH);
      ctx.fillStyle = COLORS.cutBar;
      ctx.beginPath();
      for (let x = x0; x < x1; x++) {
        const h = Math.max(1, level(cols.peak[x]) * (mid - 3));
        ctx.rect(x, mid - h, 1, h * 2);
      }
      ctx.fill();
      ctx.fillStyle = this._stripes;
      ctx.fillRect(x0, 0, x1 - x0, waveH);
      ctx.fillStyle = 'rgba(255,0,184,0.9)';
      ctx.fillRect(x0, 0, dpr, waveH);
      ctx.fillRect(x1 - dpr, 0, dpr, waveH);
    }

    // 3. threshold line, mirrored
    const th = level(this.thresholdDb) * (mid - 3);
    ctx.strokeStyle = COLORS.threshold;
    ctx.lineWidth = dpr;
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, mid - th); ctx.lineTo(W, mid - th);
    ctx.moveTo(0, mid + th); ctx.lineTo(W, mid + th);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. time ruler
    ctx.fillStyle = '#0d0b1c';
    ctx.fillRect(0, waveH, W, rulerH);
    const step = TICK_STEPS.find((s) => (s / span) * W >= 70 * dpr) || 1200;
    ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
      const x = Math.round(((t - start) / span) * W);
      ctx.fillStyle = COLORS.grid;
      ctx.fillRect(x, 0, dpr, waveH);
      ctx.fillStyle = COLORS.text;
      const m = Math.floor(t / 60);
      const s = t % 60;
      const label = step < 1 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
      ctx.fillText(label, x + 3 * dpr, waveH + rulerH / 2);
    }
  }

  _drawMini() {
    const { mini } = this;
    const ctx = mini.getContext('2d');
    const W = mini.width;
    const H = mini.height;
    const cols = this._columns(W, 0, this.duration);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x++) {
      const h = Math.max(1, level(cols.peak[x]) * H);
      const isCut = cols.cut[x] > 0.5;
      ctx.fillStyle = isCut ? COLORS.cut : COLORS.keep;
      ctx.globalAlpha = isCut ? 0.85 : 0.7;
      ctx.fillRect(x, H - h, 1, h);
    }
    ctx.globalAlpha = 1;
    const x0 = (this.view.start / this.duration) * W;
    const x1 = (this.view.end / this.duration) * W;
    ctx.fillStyle = 'rgba(232,255,0,0.12)';
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), H);
    ctx.strokeStyle = 'rgba(232,255,0,0.9)';
    ctx.lineWidth = this.dpr;
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, H - 1);
  }

  _bindMain() {
    const c = this.canvas;
    let down = null;
    c.addEventListener('pointerdown', (e) => {
      if (!this.db || this.locked) return;
      c.setPointerCapture(e.pointerId);
      down = { x: e.clientX, start: this.view.start, end: this.view.end, dragged: false };
    });
    c.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (!down.dragged && Math.abs(dx) < 5) return;
      down.dragged = true;
      c.classList.add('panning');
      const secPerPx = (down.end - down.start) / c.clientWidth;
      this.setView(down.start - dx * secPerPx, down.end - dx * secPerPx);
    });
    const finish = (e) => {
      if (!down) return;
      const wasClick = !down.dragged;
      down = null;
      c.classList.remove('panning');
      if (!wasClick || e.type === 'pointercancel') return;
      const t = this.timeAt(e.clientX);
      this.handlers.onGapClick(t);
      this.handlers.onSeek(t);
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
    c.addEventListener('wheel', (e) => {
      if (!this.db || this.locked) return;
      e.preventDefault();
      const span = this.view.end - this.view.start;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.deltaX || e.deltaY) / c.clientWidth) * span;
        this.setView(this.view.start + d, this.view.end + d);
      } else {
        this.zoom(Math.exp(e.deltaY * 0.0015), this.timeAt(e.clientX));
      }
    }, { passive: false });
  }

  _bindMini() {
    const m = this.mini;
    let active = false;
    const move = (e) => {
      const r = m.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.duration;
      const span = this.view.end - this.view.start;
      this.setView(t - span / 2, t + span / 2);
    };
    m.addEventListener('pointerdown', (e) => {
      if (!this.db || this.locked) return;
      active = true;
      m.setPointerCapture(e.pointerId);
      move(e);
    });
    m.addEventListener('pointermove', (e) => active && move(e));
    m.addEventListener('pointerup', () => { active = false; });
    m.addEventListener('pointercancel', () => { active = false; });
  }
}
