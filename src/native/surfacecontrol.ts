// ASurfaceControl and ASurfaceTransaction (libandroid, surface_control.h): trees of surfaces showing
// AHardwareBuffers. A tree hangs from a window (ASurfaceControl_createFromWindow), which may be another
// process's, or from a Java SurfaceControl's layer. Applying a transaction composes each tree it touched
// from its buffers as they are then and queues the result as the window's next buffer, or the layer's;
// a surface's buffer is free again once another replaces it. The transaction's callbacks run on a
// binder thread of the process's, the commit's at once and the completion's at the next vsync.

import { mem } from "./mem.ts";
import { hostLib, stp, ptr, PTR, type HostFn, type ArgReader } from "./host.ts";
import { deref } from "./jni.ts";
import { windowOf } from "./libandroid.ts";
import { closeFd } from "./fd.ts";
import { acquire, bufferAt, bufferFrame, release, type HardwareBuffer } from "./hardwarebuffer.ts";
import { bufferHeight, bufferWidth, presentSurface, type GlSurface } from "../android/glsurface.ts";
import { javaLayer, showFrame, Layer } from "../android/surfaceflinger.ts";
import { vsync } from "../android/vsync.ts";
import { uptimeNanos } from "../guest-clock.ts";
import { callbackThread } from "./thread.ts";
import type { JObj } from "../jvm/runtime.ts";

type Rect = [number, number, number, number];
const SHOW = 1, ROT_90 = 4, FLIP_H = 1, FLIP_V = 2;
class Surface {
  readonly handle: number; readonly name: string;
  refs = 1;
  /** a root's target: a window, or a Java SurfaceControl's layer */
  readonly target: GlSurface | Layer | null;
  parent: Surface | null = null;
  readonly children: Surface[] = [];
  visible = true; z = 0;
  buffer: HardwareBuffer | null = null; acquired = 0n;
  /** setGeometry's buffer crop, destination frame and transform; the layer's crop, position, scale and alpha */
  source: Rect | null = null; dest: Rect | null = null; transform = 0;
  crop: Rect | null = null; x = 0; y = 0; sx = 1; sy = 1; alpha = 1;
  constructor(handle: number, name: string, target: GlSurface | Layer | null) { this.handle = handle; this.name = name; this.target = target; }
  reparent(parent: Surface | null): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = parent;
    parent?.children.push(this);
    if (!parent && !this.refs) drop(this);
  }
  get root(): Surface { let s: Surface = this; while (s.parent) s = s.parent; return s; }
}
const surfaces = new Map<number, Surface>();
function newSurface(name: string, target: GlSurface | Layer | null): number {
  const handle = mem.malloc(PTR);
  if (handle) surfaces.set(handle, new Surface(handle, name, target));
  return handle;
}
/** a surface no handle names and no parent holds: its buffer is free and its children float free */
function drop(s: Surface): void {
  release(s.buffer ?? undefined); s.buffer = null;
  for (const c of s.children.slice()) c.reparent(null);
}
function unref(s: Surface | undefined): void {
  if (!s || --s.refs > 0) return;
  surfaces.delete(s.handle); mem.free(s.handle);
  if (!s.parent) drop(s);
}

// ── composition
const drawn = (s: Surface): boolean => s.visible && s.alpha > 0;
/** the surfaces with buffers under `s`, bottom first: each one's children by Z, those below zero under its own buffer */
function layers(s: Surface, out: Surface[][] = [], chain: Surface[] = []): Surface[][] {
  if (!drawn(s)) return out;
  const path = [...chain, s], kids = s.children.slice().sort((a, b) => a.z - b.z);
  let i = 0;
  for (; i < kids.length && kids[i].z < 0; i++) layers(kids[i], out, path);
  if (s.buffer) out.push(path);
  for (; i < kids.length; i++) layers(kids[i], out, path);
  return out;
}
const sameRect = (a: Rect, b: Rect) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
/** a buffer shown as it is: unmoved, uncropped, unscaled and whole over the target */
function plain(path: Surface[], width: number, height: number): boolean {
  const s = path[path.length - 1], b = s.buffer!, whole: Rect = [0, 0, width, height];
  return b.width === width && b.height === height && !s.transform && (!s.source || sameRect(s.source, whole)) && (!s.dest || sameRect(s.dest, whole))
    && path.every((p, i) => !i || p.x === 0 && p.y === 0 && p.sx === 1 && p.sy === 1 && p.alpha === 1 && !p.crop);
}
let canvas: OffscreenCanvasRenderingContext2D | null = null;
/** the tree's frame: its one buffer as it is, or its buffers placed on a canvas of the target's size */
function compose(root: Surface, width: number, height: number): ImageBitmap | null {
  const paths = layers(root);
  if (paths.length === 1 && plain(paths[0], width, height) && !paths[0][paths[0].length - 1].buffer!.frame) return bufferFrame(paths[0][paths[0].length - 1].buffer!);
  const ctx = canvas ??= new OffscreenCanvas(1, 1).getContext("2d")!;
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) { ctx.canvas.width = width; ctx.canvas.height = height; }
  ctx.clearRect(0, 0, width, height);
  for (const path of paths) {
    // a decoder's frame no GL has taken is drawn as it is, and stays the buffer's
    const s = path[path.length - 1], buffer = s.buffer!, frame = buffer.frame ?? bufferFrame(buffer);
    if (!frame) continue;
    ctx.save();
    let alpha = 1;
    for (const p of path.slice(1)) {
      ctx.translate(p.x, p.y); ctx.scale(p.sx, p.sy);
      if (p.crop) { ctx.beginPath(); ctx.rect(p.crop[0], p.crop[1], p.crop[2] - p.crop[0], p.crop[3] - p.crop[1]); ctx.clip(); }
      alpha *= p.alpha;
    }
    ctx.globalAlpha = alpha;
    const [l, t, r, b] = s.source ?? [0, 0, buffer.width, buffer.height], w = Math.min(r, buffer.width) - l, h = Math.min(b, buffer.height) - t;
    const turned = s.transform & ROT_90, [dl, dt, dr, db] = s.dest ?? [0, 0, turned ? h : w, turned ? w : h];
    ctx.translate(dl, dt); ctx.scale(dr - dl, db - dt);
    // the buffer's flips, then its quarter turn clockwise, in the unit square the destination scales
    if (turned) ctx.transform(0, 1, -1, 0, 1, 0);
    if (s.transform & FLIP_H) ctx.transform(-1, 0, 0, 1, 1, 0);
    if (s.transform & FLIP_V) ctx.transform(1, 0, 0, -1, 0, 1);
    if (w > 0 && h > 0) ctx.drawImage(frame, l, t, w, h, 0, 0, 1, 1);
    ctx.restore();
    if (frame !== buffer.frame) frame.close();
  }
  return ctx.canvas.transferToImageBitmap();
}
/** a Java layer's tree takes the extent its buffers reach */
function extent(root: Surface): [number, number] {
  let width = 1, height = 1;
  for (const path of layers(root)) {
    const s = path[path.length - 1], [, , r, b] = s.dest ?? [0, 0, s.buffer!.width, s.buffer!.height];
    const x = path.reduce((v, p) => v + p.x, 0), y = path.reduce((v, p) => v + p.y, 0);
    width = Math.max(width, Math.ceil(x + r)); height = Math.max(height, Math.ceil(y + b));
  }
  return [width, height];
}
function present(root: Surface): void {
  const target = root.target;
  if (!target) return;
  if (target instanceof Layer) {
    const frame = compose(root, ...extent(root));
    if (frame) showFrame(target, frame);
  } else {
    const frame = compose(root, bufferWidth(target), bufferHeight(target));
    if (frame) presentSurface(target, frame);
  }
}

// ── transactions and their callbacks
type Callback = { fn: number; context: number | bigint };
interface Transaction { ops: (() => void)[]; surfaces: Set<Surface>; buffers: HardwareBuffer[]; fences: number[]; commit: Callback[]; complete: Callback[] }
const transactions = new Map<number, Transaction>();
const blank = (): Transaction => ({ ops: [], surfaces: new Set(), buffers: [], fences: [], commit: [], complete: [] });
/** ASurfaceTransactionStats: the latch time, and the surfaces the transaction named with their buffers' acquire times */
interface Stats { latched: bigint; acquired: Map<Surface, bigint> }
const stats = new Map<number, Stats>(), arrays = new Map<number, Surface[]>();
const binder = callbackThread("binder:surface");
function run(callbacks: Callback[], s: Stats): void {
  if (!callbacks.length) return;
  binder(async (cpu) => {
    const h = mem.malloc(PTR);
    stats.set(h, s);
    try { for (const c of callbacks) await cpu.call(c.fn, [c.context, h], "ASurfaceTransaction callback"); }
    finally { stats.delete(h); mem.free(h); }
  });
}
function apply(t: Transaction): void {
  const ops = t.ops.splice(0), named = new Set(t.surfaces), commit = t.commit.splice(0), complete = t.complete.splice(0);
  t.surfaces.clear(); t.buffers.length = 0;
  for (const fd of t.fences.splice(0)) void closeFd(fd);
  for (const op of ops) op();
  const roots = new Set<Surface>();
  for (const s of named) roots.add(s.root);
  for (const root of roots) present(root);
  const s: Stats = { latched: uptimeNanos(), acquired: new Map([...named].map((n) => [n, n.acquired])) };
  run(commit, s);
  if (complete.length) void vsync().then(() => run(complete, s));
}
const S = (p: number) => surfaces.get(p);
const T = (p: number) => transactions.get(p);
const rect = (p: number): Rect => [mem.ld32(p), mem.ld32(p + 4), mem.ld32(p + 8), mem.ld32(p + 12)];
/** a transaction call on one surface: `fn` reads the call's other arguments now and returns what applying does */
const on = (fn: (s: Surface, a: ArgReader, t: Transaction) => (() => void) | void): HostFn => (_c, a) => {
  const t = T(a.p()), s = S(a.p());
  if (!t || !s) return;
  t.surfaces.add(s);
  const op = fn(s, a, t);
  if (op) t.ops.push(op);
};
/** what the display may take as a hint and need not follow: damage, opacity a buffer's alpha already has, frame rate, color volume */
const hint = on(() => {});

export function surfaceControlInit(): void {
  const lib: Record<string, HostFn> = {
    ASurfaceControl_createFromWindow: (_c, a) => { const w = windowOf(a.p()); return w ? newSurface(a.str(), w) : 0; },
    ASurfaceControl_create: (_c, a) => {
      const parent = S(a.p()), name = a.str();
      if (!parent) return 0;
      const h = newSurface(name, null);
      S(h)?.reparent(parent);
      return h;
    },
    ASurfaceControl_fromJava: (cpu, a) => {
      a.p(); const layer = javaLayer(deref(a.p(), cpu) as JObj);
      return layer ? newSurface(layer.name, layer) : 0;
    },
    ASurfaceControl_acquire: (_c, a) => { const s = S(a.p()); if (s) s.refs++; },
    ASurfaceControl_release: (_c, a) => unref(S(a.p())),

    ASurfaceTransaction_create: () => {
      const h = mem.malloc(PTR);
      if (h) transactions.set(h, blank());
      return h;
    },
    ASurfaceTransaction_delete: (_c, a) => {
      const h = a.p(), t = T(h);
      if (!t) return;
      transactions.delete(h); mem.free(h);
      t.buffers.forEach((b) => release(b));
      for (const fd of t.fences) void closeFd(fd);
    },
    ASurfaceTransaction_apply: (_c, a) => { const t = T(a.p()); if (t) apply(t); },
    ASurfaceTransaction_setOnComplete: (_c, a) => { const t = T(a.p()), context = ptr(a.p()), fn = a.p(); t?.complete.push({ fn, context }); },
    ASurfaceTransaction_setOnCommit: (_c, a) => { const t = T(a.p()), context = ptr(a.p()), fn = a.p(); t?.commit.push({ fn, context }); },
    ASurfaceTransaction_reparent: on((s, a) => { const parent = a.p(); return () => s.reparent(parent ? S(parent) ?? null : null); }),
    ASurfaceTransaction_setVisibility: on((s, a) => { const visible = a.i() === SHOW; return () => { s.visible = visible; }; }),
    ASurfaceTransaction_setZOrder: on((s, a) => { const z = a.i(); return () => { s.z = z; }; }),
    // the transaction holds the buffer until applying hands it to the surface, whose previous one is then free
    ASurfaceTransaction_setBuffer: on((s, a, t) => {
      const b = bufferAt(a.p()) ?? null, fence = a.i();
      if (fence >= 0) t.fences.push(fence);
      if (b) { acquire(b); t.buffers.push(b); }
      return () => { release(s.buffer ?? undefined); s.buffer = b; s.acquired = uptimeNanos(); };
    }),
    // a source rect with no area shows the whole buffer
    ASurfaceTransaction_setGeometry: on((s, a) => {
      const source = rect(a.p()), dest = rect(a.p()), transform = a.i();
      source[0] = Math.max(source[0], 0); source[1] = Math.max(source[1], 0);
      const whole = source[2] <= source[0] || source[3] <= source[1];
      return () => { s.source = whole ? null : source; s.dest = dest; s.transform = transform; };
    }),
    ASurfaceTransaction_setCrop: on((s, a) => { const crop = rect(a.p()), none = crop[2] <= crop[0] || crop[3] <= crop[1]; return () => { s.crop = none ? null : crop; }; }),
    ASurfaceTransaction_setPosition: on((s, a) => { const x = a.i(), y = a.i(); return () => { s.x = x; s.y = y; }; }),
    ASurfaceTransaction_setScale: on((s, a) => { const sx = a.f(), sy = a.f(); return () => { s.sx = sx; s.sy = sy; }; }),
    ASurfaceTransaction_setBufferTransform: on((s, a) => { const transform = a.i(); return () => { s.transform = transform; }; }),
    ASurfaceTransaction_setBufferAlpha: on((s, a) => { const alpha = a.f(); return () => { s.alpha = alpha; }; }),
    ASurfaceTransaction_setDamageRegion: hint, ASurfaceTransaction_setBufferTransparency: hint, ASurfaceTransaction_setBufferDataSpace: hint,
    ASurfaceTransaction_setHdrMetadata_cta861_3: hint, ASurfaceTransaction_setHdrMetadata_smpte2086: hint,
    ASurfaceTransaction_setExtendedRangeBrightness: hint, ASurfaceTransaction_setDesiredHdrHeadroom: hint,
    ASurfaceTransaction_setFrameRate: hint, ASurfaceTransaction_setFrameRateWithChangeStrategy: hint, ASurfaceTransaction_clearFrameRate: hint,
    ASurfaceTransaction_setEnableBackPressure: hint,
    ASurfaceTransaction_setDesiredPresentTime: () => {}, ASurfaceTransaction_setFrameTimeline: () => {},

    ASurfaceTransactionStats_getLatchTime: (_c, a) => stats.get(a.p())?.latched ?? -1n,
    ASurfaceTransactionStats_getPresentFenceFd: () => -1,
    ASurfaceTransactionStats_getAcquireTime: (_c, a) => { const s = stats.get(a.p()), surface = S(a.p()); return (surface && s?.acquired.get(surface)) ?? -1n; },
    ASurfaceTransactionStats_getPreviousReleaseFenceFd: () => -1,
    ASurfaceTransactionStats_getASurfaceControls: (_c, a) => {
      const s = stats.get(a.p()), out = a.p(), size = a.p();
      const named = s ? [...s.acquired.keys()].filter((n) => surfaces.get(n.handle) === n) : [];
      const array = mem.malloc(Math.max(1, named.length) * PTR);
      named.forEach((n, i) => { n.refs++; stp(array + i * PTR, n.handle); });
      arrays.set(array, named);
      stp(out, array); stp(size, named.length);
    },
    ASurfaceTransactionStats_releaseASurfaceControls: (_c, a) => {
      const array = a.p(), named = arrays.get(array);
      if (!named) return;
      arrays.delete(array);
      named.forEach(unref);
      mem.free(array);
    },
  };
  hostLib("libandroid.so", lib);
}
