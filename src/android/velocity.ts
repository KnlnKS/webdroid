// libinput's VelocityTracker (VelocityTracker.cpp) behind android.view.VelocityTracker's mPtr, with
// android_view_VelocityTracker.cpp's natives: the planar axes take least squares of degree 2 and
// AXIS_SCROLL the impulse strategy, unless an explicit strategy overrides the planar ones.

import { rt } from "../jvm/runtime.ts";
import { ownedHandle, deref } from "./handles.ts";
import { motionOf, type NativeMotionEvent } from "./motionevent.ts";
import { ACTION_CANCEL, ACTION_DOWN, ACTION_HOVER_ENTER, ACTION_HOVER_MOVE, ACTION_MOVE, ACTION_POINTER_DOWN, ACTION_POINTER_UP, ACTION_SCROLL,
  ACTION_UP, AXIS_SCROLL, AXIS_X, AXIS_Y, FLAG_CANCELED } from "./input-codes.ts";

const S = { DEFAULT: -1, IMPULSE: 0, LSQ1: 1, LSQ2: 2, LSQ3: 3, WLSQ2_DELTA: 4, WLSQ2_CENTRAL: 5, WLSQ2_RECENT: 6, INT1: 7, INT2: 8, LEGACY: 9 } as const;
const W = { NONE: 0, DELTA: 1, CENTRAL: 2, RECENT: 3 } as const;
type W = (typeof W)[keyof typeof W];
const DEFAULT_BY_AXIS = new Map([[AXIS_X, S.LSQ2], [AXIS_Y, S.LSQ2], [AXIS_SCROLL, S.IMPULSE]]);
const PLANAR = [AXIS_X, AXIS_Y], DIFFERENTIAL = new Set([AXIS_SCROLL]);
/** pointers that sent no movement for this long are assumed to have stopped */
const ASSUME_STOPPED = 40_000_000n;
const HISTORY_SIZE = 20;
const f32 = Math.fround;
const SECONDS_PER_NANO = f32(1e-9);

interface Movement { t: bigint; x: number }
interface Strategy {
  add(t: bigint, id: number, position: number): void;
  clearPointer(id: number): void;
  velocity(id: number): number | null;
}

/** AccumulatingVelocityTrackerStrategy: a ring of the last HISTORY_SIZE movements per pointer */
abstract class Accumulating implements Strategy {
  readonly horizon: bigint; readonly maintainHorizon: boolean;
  movements = new Map<number, Movement[]>();
  constructor(horizon: bigint, maintainHorizon: boolean) { this.horizon = horizon; this.maintainHorizon = maintainHorizon; }
  clearPointer(id: number) { this.movements.delete(id); }
  add(t: bigint, id: number, x: number) {
    let ring = this.movements.get(id);
    if (!ring) this.movements.set(id, ring = []);
    // a POINTER_DOWN at a MOVE's time restates that time's positions
    if (ring.length && ring[ring.length - 1].t === t) ring.pop();
    ring.push({ t, x });
    if (ring.length > HISTORY_SIZE) ring.shift();
    if (this.maintainHorizon) while (t - ring[0].t > this.horizon) ring.shift();
  }
  velocity(id: number): number | null {
    const ring = this.movements.get(id);
    return ring?.length ? this.fromRing(ring) : null;
  }
  /** the velocity over a pointer's non-empty ring */
  abstract fromRing(ring: Movement[]): number | null;
}

const dot = (a: Float32Array, b: Float32Array, m: number) => { let r = 0; for (let i = 0; i < m; i++) r = f32(r + f32(a[i] * b[i])); return r; };
/** solveLeastSquares: B[1] of the degree n-1 polynomial fitting y(x) with weights w, by Gram-Schmidt QR */
function solveLeastSquares(x: number[], y: number[], w: number[], n: number): number | null {
  const m = x.length;
  const a = Array.from({ length: n }, () => new Float32Array(m)), q = Array.from({ length: n }, () => new Float32Array(m));
  const r = Array.from({ length: n }, () => new Float32Array(n));
  for (let h = 0; h < m; h++) { a[0][h] = w[h]; for (let i = 1; i < n; i++) a[i][h] = f32(a[i - 1][h] * x[h]); }
  for (let j = 0; j < n; j++) {
    q[j].set(a[j]);
    for (let i = 0; i < j; i++) {
      const d = dot(q[j], q[i], m);
      for (let h = 0; h < m; h++) q[j][h] = f32(q[j][h] - f32(d * q[i][h]));
    }
    const norm = f32(Math.sqrt(dot(q[j], q[j], m)));
    if (norm < 0.000001) return null;
    const inv = f32(1 / norm);
    for (let h = 0; h < m; h++) q[j][h] = f32(q[j][h] * inv);
    for (let i = 0; i < n; i++) r[j][i] = i < j ? 0 : dot(q[j], a[i], m);
  }
  const wy = Float32Array.from(y, (v, h) => f32(v * w[h])), b = new Float32Array(n);
  for (let i = n; i !== 0;) {
    i--;
    b[i] = dot(q[i], wy, m);
    for (let j = n - 1; j > i; j--) b[i] = f32(b[i] - f32(r[i][j] * b[j]));
    b[i] = f32(b[i] / r[i][i]);
  }
  return b[1];
}

class LeastSquares extends Accumulating {
  readonly degree: number; readonly weighting: W;
  constructor(degree: number, weighting: W = W.NONE) { super(100_000_000n, true); this.degree = degree; this.weighting = weighting; }
  fromRing(ring: Movement[]): number | null {
    const degree = Math.min(this.degree, ring.length - 1);
    if (degree <= 0) return null;
    const newest = ring[ring.length - 1].t;
    if (degree === 2 && this.weighting === W.NONE) return this.unweightedDeg2(ring, newest);
    const x: number[] = [], y: number[] = [], w: number[] = [];
    for (let i = ring.length - 1; i >= 0; i--) {
      y.push(ring[i].x); w.push(this.weight(ring, i)); x.push(f32(f32(-Number(newest - ring[i].t)) * SECONDS_PER_NANO));
    }
    return solveLeastSquares(x, y, w, degree + 1);
  }
  /** solveUnweightedLeastSquaresDeg2: y = a·x² + b·x + c over the samples' ages, b being the velocity */
  unweightedDeg2(ring: Movement[], newest: bigint): number | null {
    let sxi = 0, sxiyi = 0, syi = 0, sxi2 = 0, sxi3 = 0, sxi2yi = 0, sxi4 = 0;
    const count = ring.length;
    for (const { t, x: yi } of ring) {
      const xi = f32(f32(-Number(newest - t)) * SECONDS_PER_NANO);
      const xi2 = f32(xi * xi), xi3 = f32(xi2 * xi), xi4 = f32(xi3 * xi);
      sxi = f32(sxi + xi); sxi2 = f32(sxi2 + xi2); sxiyi = f32(sxiyi + f32(xi * yi)); sxi2yi = f32(sxi2yi + f32(xi2 * yi));
      syi = f32(syi + yi); sxi3 = f32(sxi3 + xi3); sxi4 = f32(sxi4 + xi4);
    }
    const sxx = f32(sxi2 - f32(f32(sxi * sxi) / count)), sxy = f32(sxiyi - f32(f32(sxi * syi) / count));
    const sxx2 = f32(sxi3 - f32(f32(sxi * sxi2) / count)), sx2y = f32(sxi2yi - f32(f32(sxi2 * syi) / count));
    const sx2x2 = f32(sxi4 - f32(f32(sxi2 * sxi2) / count));
    const denominator = f32(f32(sxx * sx2x2) - f32(sxx2 * sxx2));
    if (denominator === 0) return null;
    return f32(f32(f32(sxy * sx2x2) - f32(sx2y * sxx2)) / denominator);
  }
  weight(ring: Movement[], index: number): number {
    const size = ring.length, ms = (d: bigint) => f32(Number(d) * f32(0.000001));
    switch (this.weighting) {
      case W.DELTA: {
        if (index === size - 1) return 1;
        const delta = ms(ring[index + 1].t - ring[index].t);
        return delta < 0 ? 0.5 : delta < 10 ? f32(0.5 + delta * 0.05) : 1;
      }
      case W.CENTRAL: {
        const age = ms(ring[size - 1].t - ring[index].t);
        return age < 0 ? 0.5 : age < 10 ? f32(0.5 + age * 0.05) : age < 50 ? 1 : age < 60 ? f32(0.5 + (60 - age) * 0.05) : 0.5;
      }
      case W.RECENT: {
        const age = ms(ring[size - 1].t - ring[index].t);
        return age < 50 ? 1 : age < 100 ? f32(0.5 + f32(f32(100 - age) * f32(0.01))) : 0.5;
      }
      default: return 1;
    }
  }
}

const kineticEnergyToVelocity = (work: number) => f32((work < 0 ? -1 : 1) * f32(Math.sqrt(Math.abs(work))) * f32(Math.SQRT2));
class Impulse extends Accumulating {
  readonly deltaValues: boolean;
  constructor(deltaValues: boolean) { super(100_000_000n, false); this.deltaValues = deltaValues; }
  fromRing(ring: Movement[]): number | null {
    const t: bigint[] = [], x: number[] = [], newest = ring[ring.length - 1].t;
    for (let i = ring.length - 1; i >= 0; i--) {
      if (newest - ring[i].t > this.horizon) break;
      t.push(ring[i].t); x.push(ring[i].x);
    }
    return this.impulse(t, x);
  }
  /** calculateImpulseVelocity, samples newest first */
  impulse(t: bigint[], x: number[]): number {
    const count = t.length, dt = (i: number, j: number) => f32(SECONDS_PER_NANO * f32(Number(t[i] - t[j])));
    if (count < 2) return 0;
    if (count === 2) {
      if (t[1] === t[0]) return 0;
      return f32((this.deltaValues ? -x[0] : f32(x[1] - x[0])) / dt(1, 0));
    }
    let work = 0;
    for (let i = count - 1; i > 0; i--) {
      if (t[i] === t[i - 1]) continue;
      const prev = kineticEnergyToVelocity(work);
      const current = f32((this.deltaValues ? -x[i - 1] : f32(x[i] - x[i - 1])) / dt(i, i - 1));
      work = f32(work + f32(f32(current - prev) * Math.abs(current)));
      if (i === count - 1) work = f32(work * 0.5);
    }
    return kineticEnergyToVelocity(work);
  }
}

class Legacy extends Accumulating {
  constructor() { super(200_000_000n, false); }
  fromRing(ring: Movement[]): number | null {
    const newest = ring[ring.length - 1], min = newest.t - this.horizon;
    let oldestIndex = ring.length - 1;
    for (let i = ring.length - 1; i >= 0 && ring[i].t >= min; i--) oldestIndex = i;
    const oldest = ring[oldestIndex];
    let accum = 0, used = 0, last = 0n;
    for (let i = oldestIndex; i < ring.length; i++) {
      const duration = ring[i].t - oldest.t;
      if (duration < 10_000_000n) continue;
      const v = f32(f32(ring[i].x - oldest.x) * f32(1e9 / Number(duration)));
      accum = f32(f32(f32(accum * Number(last)) + f32(v * Number(duration))) / Number(duration + last));
      last = duration; used++;
    }
    return used ? accum : null;
  }
}

interface IntegratingState { t: bigint; degree: number; pos: number; vel: number; accel: number }
class Integrating implements Strategy {
  readonly degree: number;
  states = new Map<number, IntegratingState>();
  constructor(degree: number) { this.degree = degree; }
  clearPointer(id: number) { this.states.delete(id); }
  velocity(id: number) { return this.states.get(id)?.vel ?? null; }
  add(t: bigint, id: number, pos: number) {
    const s = this.states.get(id);
    if (!s) { this.states.set(id, { t, degree: 0, pos, vel: 0, accel: 0 }); return; }
    if (t <= s.t + 2_000_000n) return;
    const dt = f32(Number(t - s.t) * f32(0.000000001));
    s.t = t;
    const vel = f32(f32(pos - s.pos) / dt);
    if (s.degree === 0) { s.vel = vel; s.degree = 1; }
    else {
      const alpha = f32(dt / f32(0.010 + dt));
      if (this.degree === 1) s.vel = f32(s.vel + f32(f32(vel - s.vel) * alpha));
      else {
        const accel = f32(f32(vel - s.vel) / dt);
        if (s.degree === 1) { s.accel = accel; s.degree = 2; } else s.accel = f32(s.accel + f32(f32(accel - s.accel) * alpha));
        s.vel = f32(s.vel + f32(f32(s.accel * dt) * alpha));
      }
    }
    s.pos = pos;
  }
}

function createStrategy(strategy: number, deltaValues: boolean): Strategy {
  switch (strategy) {
    case S.IMPULSE: return new Impulse(deltaValues);
    case S.LSQ1: return new LeastSquares(1);
    case S.LSQ2: return new LeastSquares(2);
    case S.LSQ3: return new LeastSquares(3);
    case S.WLSQ2_DELTA: return new LeastSquares(2, W.DELTA);
    case S.WLSQ2_CENTRAL: return new LeastSquares(2, W.CENTRAL);
    case S.WLSQ2_RECENT: return new LeastSquares(2, W.RECENT);
    case S.INT1: return new Integrating(1);
    case S.INT2: return new Integrating(2);
    case S.LEGACY: return new Legacy();
  }
  throw rt.mkThrowable("java/lang/IllegalArgumentException", `Unknown velocity tracker strategy ${strategy}`);
}

/** VelocityTrackerState: the tracker and the velocities its last computeCurrentVelocity left */
class Tracker {
  readonly override: number;
  lastEventTime = 0n;
  ids = 0;
  active: number | null = null;
  strategies = new Map<number, Strategy>();
  computed = new Map<number, Map<number, number>>();
  constructor(override: number) { this.override = override; }
  clear() { this.ids = 0; this.active = null; this.strategies.clear(); }
  clearPointer(id: number) {
    this.ids &= ~(1 << id);
    if (this.active === id) this.active = this.ids ? 31 - Math.clz32(this.ids & -this.ids) : null;
    for (const s of this.strategies.values()) s.clearPointer(id);
  }
  addMovement(t: bigint, id: number, axis: number, position: number) {
    if (this.ids >>> id & 1 && t - this.lastEventTime > ASSUME_STOPPED) this.strategies.clear();
    this.lastEventTime = t;
    this.ids |= 1 << id;
    this.active ??= id;
    let s = this.strategies.get(axis);
    if (!s) {
      const differential = DIFFERENTIAL.has(axis);
      s = createStrategy(differential || this.override === S.DEFAULT ? DEFAULT_BY_AXIS.get(axis)! : this.override, differential);
      this.strategies.set(axis, s);
    }
    s.add(t, id, position);
  }
  addEvent(e: NativeMotionEvent) {
    let axes: number[];
    switch (e.action & 0xff) {
      case ACTION_DOWN: case ACTION_HOVER_ENTER: this.clear(); axes = PLANAR; break;
      case ACTION_POINTER_DOWN: this.clearPointer(e.pointers[e.action >> 8 & 0xff].id); axes = PLANAR; break;
      case ACTION_MOVE: case ACTION_HOVER_MOVE: axes = PLANAR; break;
      case ACTION_POINTER_UP:
        if (e.flags & FLAG_CANCELED) { this.clearPointer(e.pointers[e.action >> 8 & 0xff].id); return; }
      // fall through: an up ends the trace, after the stopped-pointer check
      case ACTION_UP:
        if (e.eventTime - this.lastEventTime > ASSUME_STOPPED) for (const axis of PLANAR) this.strategies.delete(axis);
        return;
      case ACTION_CANCEL: this.clear(); return;
      case ACTION_SCROLL: axes = [AXIS_SCROLL]; break;
      default: return;
    }
    for (let h = 0; h <= e.historySize; h++) {
      const t = e.samples[h].time;
      for (let i = 0; i < e.pointerCount; i++) {
        if (e.rawCoords(i, h).resampled) continue;
        for (const axis of axes) this.addMovement(t, e.pointers[i].id, axis, e.axis(axis, i, h));
      }
    }
  }
  compute(units: number, max: number) {
    this.computed.clear();
    for (const [axis, s] of this.strategies) {
      const out = new Map<number, number>();
      for (let id = 0; id < 32; id++) {
        if (!(this.ids >>> id & 1)) continue;
        const v = s.velocity(id);
        if (v !== null) out.set(id, Math.min(Math.max(f32(f32(v * units) / 1000), -max), max));
      }
      this.computed.set(axis, out);
    }
  }
  velocity(axis: number, id: number): number {
    if (id === -1) id = this.active ?? -1;
    return this.computed.get(axis)?.get(id) ?? 0;
  }
}

rt.registerJnis("android/view/VelocityTracker", {
  "nativeInitialize(I)J": (strategy: number) => ownedHandle(new Tracker(strategy)),
  "nativeDispose(J)V": () => {},
  "nativeClear(J)V": (ptr: bigint) => deref<Tracker>(ptr).clear(),
  // an event without a native (one initialize refused) is logged and skipped
  "nativeAddMovement(JLandroid/view/MotionEvent;)V": (ptr: bigint, ev: object) => {
    const event = motionOf(ev);
    if (event) deref<Tracker>(ptr).addEvent(event);
    else console.error("[VelocityTracker] Invalid MotionEvent");
  },
  "nativeComputeCurrentVelocity(JIF)V": (ptr: bigint, units: number, max: number) => deref<Tracker>(ptr).compute(units, max),
  "nativeGetVelocity(JII)F": (ptr: bigint, axis: number, id: number) => deref<Tracker>(ptr).velocity(axis, id),
  "nativeIsAxisSupported(I)Z": (axis: number) => +DEFAULT_BY_AXIS.has(axis),
});
