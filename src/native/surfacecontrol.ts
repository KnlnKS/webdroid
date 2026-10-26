// ASurfaceControl and ASurfaceTransaction (libandroid, surface_control.h): references on SurfaceFlinger's
// layers showing AHardwareBuffers. A tree hangs from a window (ASurfaceControl_createFromWindow), which may be
// another process's, or is a Java SurfaceControl's layer, which the display composes with its children. A
// buffer shows its pixels as they are when the transaction setting it applies; applying a transaction that
// touched a window's tree composes that tree into the window's next buffer. A surface's buffer is free again
// once another replaces it. The transaction's callbacks run on a binder thread of the process's, the commit's
// at once and the completion's at the next vsync.

import { mem } from "./mem.ts";
import { hostLib, stp, ptr, PTR, type HostFn, type ArgReader } from "./host.ts";
import { deref } from "./jni.ts";
import { windowOf } from "./libandroid.ts";
import { closeFd } from "./fd.ts";
import { Handles } from "./handles.ts";
import { acquire, bufferAt, release, type HardwareBuffer } from "./hardwarebuffer.ts";
import { bufferHeight, bufferWidth, presentSurface, type GlSurface } from "../android/glsurface.ts";
import { applyOps, composeTree, javaLayer, latchBuffer, reparentLayer, Layer, type Transaction } from "../android/surfaceflinger.ts";
import { vsync } from "../android/vsync.ts";
import { uptimeNanos } from "../guest-clock.ts";
import { callbackThread } from "./thread.ts";
import type { JObj } from "../jvm/runtime.ts";

type Rect = [number, number, number, number];
const SHOW = 1;
/** a native reference count on a layer, the buffer it shows and when that was set, and for a tree's root the window it composes into */
class Control {
  handle = 0; refs = 1;
  readonly layer: Layer;
  /** the layer is a Java SurfaceControl's, whose lifetime Java owns */
  readonly java: boolean;
  readonly window: GlSurface | null;
  buffer: HardwareBuffer | null = null; acquired = 0n;
  constructor(layer: Layer, java: boolean, window: GlSurface | null) { this.layer = layer; this.java = java; this.window = window; }
}
const controls = new Handles<Control>("ASurfaceControl"), byLayer = new WeakMap<Layer, Control>();
function newControl(layer: Layer, java = false, window: GlSurface | null = null): number {
  const c = new Control(layer, java, window);
  c.handle = controls.alloc(c);
  if (c.handle) byLayer.set(layer, c);
  return c.handle;
}
/** a native layer no handle names and no parent holds: its buffer is free and its children float free */
function drop(c: Control): void {
  release(c.buffer ?? undefined); c.buffer = null;
  latchBuffer(c.layer, null);
  for (const child of c.layer.children.slice()) {
    child.reparent(null);
    const cc = byLayer.get(child);
    if (cc && !cc.refs) drop(cc);
  }
}
function unref(c: Control | undefined): void {
  if (!c || --c.refs > 0) return;
  controls.delete(c.handle);
  if (c.java) { release(c.buffer ?? undefined); c.buffer = null; byLayer.delete(c.layer); }
  else if (!c.layer.parent) drop(c);
}
function rootOf(layer: Layer): Layer {
  while (layer.parent) layer = layer.parent;
  return layer;
}

// ── transactions and their callbacks
type Callback = { fn: number; context: number | bigint };
interface NativeTransaction extends Transaction { named: Set<Control>; buffers: HardwareBuffer[]; fences: number[]; commit: Callback[]; complete: Callback[] }
const transactions = new Handles<NativeTransaction>("ASurfaceTransaction");
/** ASurfaceTransactionStats: the latch time, and the surfaces the transaction named with their buffers' acquire times */
interface Stats { latched: bigint; acquired: Map<Control, bigint> }
const stats = new Handles<Stats>("ASurfaceTransactionStats"), arrays = new Handles<Control[]>("ASurfaceControl array");
const binder = callbackThread("binder:surface");
function run(callbacks: Callback[], s: Stats): void {
  if (!callbacks.length) return;
  binder(async (cpu) => {
    const h = stats.alloc(s);
    try { for (const c of callbacks) await cpu.call(c.fn, [c.context, h], "ASurfaceTransaction callback"); }
    finally { stats.delete(h); }
  });
}
function apply(t: NativeTransaction): void {
  const named = new Set(t.named), commit = t.commit.splice(0), complete = t.complete.splice(0);
  t.named.clear(); t.buffers.length = 0;
  for (const fd of t.fences.splice(0)) void closeFd(fd);
  applyOps(t);
  const windows = new Set<Control>();
  for (const c of named) { const root = byLayer.get(rootOf(c.layer)); if (root?.window) windows.add(root); }
  for (const { layer, window } of windows) presentSurface(window!, composeTree(layer, bufferWidth(window!), bufferHeight(window!)));
  const s: Stats = { latched: uptimeNanos(), acquired: new Map([...named].map((n) => [n, n.acquired])) };
  run(commit, s);
  if (complete.length) void vsync().then(() => run(complete, s));
}
const C = (p: number) => controls.find(p);
const rect = (p: number): Rect => [mem.ld32(p), mem.ld32(p + 4), mem.ld32(p + 8), mem.ld32(p + 12)];
/** a transaction call on one surface: `fn` reads the call's other arguments now and returns what applying does */
const on = (fn: (c: Control, a: ArgReader, t: NativeTransaction) => (() => void) | void): HostFn => (_c, a) => {
  const t = transactions.find(a.p()), c = C(a.p());
  if (!t || !c) return;
  t.named.add(c);
  const op = fn(c, a, t);
  if (op) t.ops.push(op);
};
/** a transaction call setting layer state */
const set = (fn: (l: Layer, a: ArgReader) => () => void): HostFn => on((c, a) => fn(c.layer, a));
/** what the display may take as a hint and need not follow: damage, opacity a buffer's alpha already has, frame rate, color volume */
const hint = on(() => {});

export function surfaceControlInit(): void {
  const lib: Record<string, HostFn> = {
    ASurfaceControl_createFromWindow: (_c, a) => { const w = windowOf(a.p()); return w ? newControl(new Layer(a.str(), 0), false, w) : 0; },
    ASurfaceControl_create: (_c, a) => {
      const parent = C(a.p()), name = a.str();
      if (!parent) return 0;
      const layer = new Layer(name, 0);
      layer.reparent(parent.layer);
      return newControl(layer);
    },
    // the Java SurfaceControl's own layer, one reference more on it, as android_view_SurfaceControl hands out
    ASurfaceControl_fromJava: (cpu, a) => {
      a.p(); const layer = javaLayer(deref(a.p(), cpu) as JObj), c = layer && byLayer.get(layer);
      if (c) { c.refs++; return c.handle; }
      return layer ? newControl(layer, true) : 0;
    },
    ASurfaceControl_acquire: (_c, a) => { const c = C(a.p()); if (c) c.refs++; },
    ASurfaceControl_release: (_c, a) => unref(C(a.p())),

    ASurfaceTransaction_create: () => transactions.alloc({ ops: [], named: new Set(), buffers: [], fences: [], commit: [], complete: [] }),
    ASurfaceTransaction_delete: (_c, a) => {
      const t = transactions.delete(a.p());
      if (!t) return;
      t.buffers.forEach((b) => release(b));
      for (const fd of t.fences) void closeFd(fd);
    },
    ASurfaceTransaction_apply: (_c, a) => { const t = transactions.find(a.p()); if (t) apply(t); },
    ASurfaceTransaction_setOnComplete: (_c, a) => { const t = transactions.find(a.p()), context = ptr(a.p()), fn = a.p(); t?.complete.push({ fn, context }); },
    ASurfaceTransaction_setOnCommit: (_c, a) => { const t = transactions.find(a.p()), context = ptr(a.p()), fn = a.p(); t?.commit.push({ fn, context }); },
    ASurfaceTransaction_reparent: on((c, a) => {
      const parent = C(a.p()) ?? null;
      return () => { reparentLayer(c.layer, parent?.layer ?? null); if (!parent && !c.refs) drop(c); };
    }),
    ASurfaceTransaction_setVisibility: set((l, a) => { const hidden = a.i() !== SHOW; return () => { l.hidden = hidden; }; }),
    ASurfaceTransaction_setZOrder: set((l, a) => { const z = a.i(); return () => { l.z = z; }; }),
    // the transaction holds the buffer until applying hands it to the surface, whose previous one is then free
    ASurfaceTransaction_setBuffer: on((c, a, t) => {
      const b = bufferAt(a.p()) ?? null, fence = a.i();
      if (fence >= 0) t.fences.push(fence);
      if (b) { acquire(b); t.buffers.push(b); }
      return () => {
        release(c.buffer ?? undefined); c.buffer = b; c.acquired = uptimeNanos();
        latchBuffer(c.layer, b && b.snapshot());
      };
    }),
    // a source rect with no area shows the whole buffer
    ASurfaceTransaction_setGeometry: set((l, a) => {
      const source = rect(a.p()), dest = rect(a.p()), transform = a.i();
      source[0] = Math.max(source[0], 0); source[1] = Math.max(source[1], 0);
      const whole = source[2] <= source[0] || source[3] <= source[1];
      return () => { l.source = whole ? null : source; l.dest = dest; l.transform = transform; };
    }),
    ASurfaceTransaction_setCrop: set((l, a) => { const crop = rect(a.p()), none = crop[2] <= crop[0] || crop[3] <= crop[1]; return () => { l.crop = none ? null : crop; }; }),
    ASurfaceTransaction_setPosition: set((l, a) => { const x = a.i(), y = a.i(); return () => { l.x = x; l.y = y; }; }),
    ASurfaceTransaction_setScale: set((l, a) => { const sx = a.f(), sy = a.f(); return () => { l.matrix = [sx, 0, 0, sy]; }; }),
    ASurfaceTransaction_setBufferTransform: set((l, a) => { const transform = a.i(); return () => { l.transform = transform; }; }),
    ASurfaceTransaction_setBufferAlpha: set((l, a) => { const alpha = a.f(); return () => { l.alpha = alpha; }; }),
    ASurfaceTransaction_setDamageRegion: hint, ASurfaceTransaction_setBufferTransparency: hint, ASurfaceTransaction_setBufferDataSpace: hint,
    ASurfaceTransaction_setHdrMetadata_cta861_3: hint, ASurfaceTransaction_setHdrMetadata_smpte2086: hint,
    ASurfaceTransaction_setExtendedRangeBrightness: hint, ASurfaceTransaction_setDesiredHdrHeadroom: hint,
    ASurfaceTransaction_setFrameRate: hint, ASurfaceTransaction_setFrameRateWithChangeStrategy: hint, ASurfaceTransaction_clearFrameRate: hint,
    ASurfaceTransaction_setEnableBackPressure: hint,
    ASurfaceTransaction_setDesiredPresentTime: () => {}, ASurfaceTransaction_setFrameTimeline: () => {},

    ASurfaceTransactionStats_getLatchTime: (_c, a) => stats.find(a.p())?.latched ?? -1n,
    ASurfaceTransactionStats_getPresentFenceFd: () => -1,
    ASurfaceTransactionStats_getAcquireTime: (_c, a) => { const s = stats.find(a.p()), c = C(a.p()); return (c && s?.acquired.get(c)) ?? -1n; },
    ASurfaceTransactionStats_getPreviousReleaseFenceFd: () => -1,
    ASurfaceTransactionStats_getASurfaceControls: (_c, a) => {
      const s = stats.find(a.p()), out = a.p(), size = a.p();
      const named = s ? [...s.acquired.keys()].filter((c) => C(c.handle) === c) : [];
      const array = arrays.alloc(named, Math.max(1, named.length) * PTR);
      named.forEach((c, i) => { c.refs++; stp(array + i * PTR, c.handle); });
      stp(out, array); stp(size, named.length);
    },
    ASurfaceTransactionStats_releaseASurfaceControls: (_c, a) => arrays.delete(a.p())?.forEach(unref),
  };
  hostLib("libandroid.so", lib);
}
