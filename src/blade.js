// The export animation: a spinning circular blade sweeps across the waveform,
// throwing sparks while it is inside a cut. Purely for show -- the real work
// is ffmpeg's -- but it is driven by real progress: the blade never gets ahead
// of where the export actually is.
//
// Exports of short videos finish in a fraction of a second, so the blade has a
// top speed (a full sweep takes at least MIN_SWEEP_S). When the export is done
// the blade finishes its run before the results appear.

const MIN_SWEEP_S = 1.3;
const SPARK_COLORS = ['#ebff00', '#ffffff', '#ff00b8', '#ffd400'];

export class BladeFx {
  /**
   * @param {object} o
   * @param {HTMLElement} o.blade the blade element (positioned by `left`)
   * @param {HTMLCanvasElement} o.sparks overlay canvas for the sparks
   * @param {(t:number)=>number|null} o.xOf seconds -> CSS px from the left of the waveform
   * @param {(t:number)=>boolean} o.inCut is this moment inside a cut?
   * @param {(t:number|null)=>void} o.onMove called with the blade's time as it moves (null when it leaves)
   */
  constructor(o) {
    Object.assign(this, o);
    this.active = false;
    this.particles = [];
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  start(duration) {
    this.duration = duration;
    this.t = 0;
    this.target = 0;
    this.finishing = null;
    this.particles = [];
    this.active = true;
    this.last = performance.now();
    this.blade.hidden = false;
    this.sparks.hidden = this.reduced;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.sparks.width = Math.max(1, Math.round(this.sparks.clientWidth * dpr));
    this.sparks.height = Math.max(1, Math.round(this.sparks.clientHeight * dpr));
    requestAnimationFrame((now) => this._frame(now));
  }

  /** Tell the blade how far the real export has got (seconds of source video). */
  setTarget(t) {
    if (this.active && t != null && t > this.target) this.target = Math.min(this.duration, t);
  }

  /** Export is done: run the blade to the end, then resolve. */
  finish() {
    if (!this.active) return Promise.resolve();
    this.target = this.duration;
    return new Promise((resolve) => {
      this.finishing = resolve;
      // animation frames stop when the tab is in the background; never let
      // the results wait on an animation nobody can see
      setTimeout(() => { if (this.finishing === resolve) this.stop(); }, 2600);
    });
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.blade.hidden = true;
    this.sparks.hidden = true;
    this.particles = [];
    this.onMove(null);
    if (this.finishing) { this.finishing(); this.finishing = null; }
  }

  _frame(now) {
    if (!this.active) return;
    // timers are throttled in background tabs; never take a huge step
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    const speed = (this.duration / MIN_SWEEP_S) * (this.finishing ? 1.6 : 1);
    this.t = Math.min(this.target, this.t + speed * dt);
    this.onMove(this.t);

    const x = this.xOf(this.t);
    if (x != null) this.blade.style.left = `${x}px`;
    if (!this.reduced && x != null) this._sparks(x, dt);

    if (this.finishing && this.t >= this.duration - 1e-6) {
      const done = this.finishing;
      this.finishing = null;
      // let the last sparks fall before the blade leaves
      setTimeout(() => { this.stop(); done(); }, this.reduced ? 0 : 260);
    }
    requestAnimationFrame((n) => this._frame(n));
  }

  _sparks(x, dt) {
    const c = this.sparks;
    const ctx = c.getContext('2d');
    const d = this.dpr;
    const cx = x * d;
    const cy = (c.height - 18 * d) / 2;
    const cutting = this.inCut(this.t) && this.t < this.duration;
    const emit = cutting ? 9 : this.t < this.duration ? 1 : 0;
    for (let i = 0; i < emit; i++) {
      const up = Math.random() < 0.5 ? -1 : 1;
      const angle = Math.PI + (Math.random() - 0.5) * 1.5; // sprayed back the way it came
      const v = (cutting ? 240 : 110) * (0.4 + Math.random()) * d;
      this.particles.push({
        x: cx, y: cy + up * Math.random() * 30 * d,
        vx: Math.cos(angle) * v, vy: Math.sin(angle) * v * 0.8 + up * 60 * d,
        life: 0.25 + Math.random() * 0.45, age: 0,
        color: SPARK_COLORS[(Math.random() * SPARK_COLORS.length) | 0],
        w: (1 + Math.random() * 1.6) * d,
      });
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const alive = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy += 900 * d * dt; // gravity
      const px = p.x;
      const py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(px - p.vx * 0.012, py - p.vy * 0.012);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      alive.push(p);
    }
    ctx.globalAlpha = 1;
    this.particles = alive.length > 700 ? alive.slice(-700) : alive;
  }
}
