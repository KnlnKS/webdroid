// SurfaceFlinger: the layer tree windows and surfaces compose into, and the client natives that
// build it — SurfaceSession, SurfaceControl and its Transaction, BLASTBufferQueue and Surface. A
// BLAST surface's buffer is an OffscreenCanvas the renderer or a locked Canvas draws into, or the
// frame an EGL swap or a decoder produced; queueing it latches the buffer on its layer, and the
// display composes every visible layer of layer stack 0 into the page's frame at the end of the JS
// turn that changed one.
import { rt, type JObj, declaredField } from "../jvm/runtime.ts";
import { after, newObj, vcall } from "../jvm/natives/jentry.ts";
import { asSystem } from "./binder.ts";
import { handle, deref, release, FINALIZER } from "./handles.ts";
import { nativeParcel, readLocalObject, writeLocalObject } from "./parcel.ts";
import { canvasOf } from "./canvas.ts";
import { cssColor } from "./graphics.ts";
import { perf } from "../perf.ts";
import { uptimeMillis } from "../guest-clock.ts";
import { frameDrawn } from "./vsync.ts";
import { note, Ev } from "../timeline.ts";
import { bufferHeight, bufferWidth, presentSurface, type GlSurface } from "./glsurface.ts";
import { drawnOn, deviceRect, intersect, placeFunctors, type Rect } from "./webfunctor.ts";
import { detached } from "../jvm/natives/jthrowable.ts";

// SurfaceControl.Builder's creation flags
const HIDDEN = 0x4, FX_SURFACE_EFFECT = 0x20000, FX_SURFACE_MASK = 0xf0000;
// Transaction.setFlags's layer state flags
const LAYER_HIDDEN = 0x1;

let nextLayerId = 1;
export class Layer {
  readonly name: string;
  readonly id = nextLayerId++;
  parent: Layer | null = null;
  readonly children: Layer[] = [];
  z = 0; layerStack = -1;
  x = 0; y = 0;
  /** dsdx, dtdx, dtdy, dsdy */
  matrix: [number, number, number, number] | null = null;
  alpha = 1; hidden: boolean;
  crop: { l: number; t: number; r: number; b: number } | null = null;
  cornerRadius = 0;
  /** an effect layer's solid color, r g b in 0..1 */
  color: [number, number, number] | null = null;
  /** the latched buffer, and the rect it scales into (BLASTBufferQueue's destination frame) */
  buffer: Frame | null = null;
  dest: { l: number; t: number; r: number; b: number } | null = null;
  /** setRelativeLayer: the layer this one is Z-ordered among, and those Z-ordered among this one */
  relativeOf: Layer | null = null;
  readonly relatives: Layer[] = [];
  removed = false;
  constructor(name: string, flags: number) {
    this.name = name;
    this.hidden = !!(flags & HIDDEN);
    if ((flags & FX_SURFACE_MASK) === FX_SURFACE_EFFECT) this.color = [0, 0, 0];
  }
  reparent(parent: Layer | null): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = parent;
    parent?.children.push(this);
  }
  relativeTo(to: Layer | null): void {
    if (this.relativeOf) this.relativeOf.relatives.splice(this.relativeOf.relatives.indexOf(this), 1);
    this.relativeOf = to;
    to?.relatives.push(this);
  }
  /** Layer::onRemovedFromCurrentState: the subtree, now offscreen, drops its Z order relative to layers outside it */
  dropOutsideRelatives(): void {
    const tree = new Set<Layer>(), add = (l: Layer) => { tree.add(l); l.children.forEach(add); };
    add(this);
    for (const l of tree) if (l.relativeOf && !tree.has(l.relativeOf)) l.relativeTo(null);
  }
}
/** a buffer: a canvas the queue reuses, or a frame its producer hands over and the layer releases */
type Frame = OffscreenCanvas | ImageBitmap | VideoFrame;
const releaseFrame = (f: Frame | null) => { if (f && !(f instanceof OffscreenCanvas)) f.close(); };
const roots = new Set<Layer>();

// ── composition
type Present = (content: boolean) => void;
let target: { ctx: OffscreenCanvasRenderingContext2D; present: Present; transparent: boolean } | null = null;
/** where the display composes: the realm's frame, and what shows it, told whether a producer's buffer composed */
export function setDisplayTarget(ctx: OffscreenCanvasRenderingContext2D, present: Present, transparent = target?.transparent ?? false): void { target = { ctx, present, transparent }; }
let composing = false;
/** compose the display once the current turn's transactions and draws are done */
export function scheduleComposite(): void {
  if (composing) return;
  composing = true;
  queueMicrotask(composite);
}
let queuedAt: number | null = null;
function composite(): void {
  composing = false;
  if (!target) return;
  const { ctx } = target, t0 = performance.now();
  note(Ev.CompositeBegin);
  if (queuedAt !== null) { perf.presentLagMs += t0 - queuedAt; queuedAt = null; }
  ctx.save();
  // the system windows stack over the processes' canvases (processes.ts), which show through
  // wherever they draw nothing; an app's display shows black there, as a display does
  if (target.transparent) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
  placed.clear();
  content = false;
  for (const layer of [...roots].filter((l) => l.layerStack === 0 && !l.relativeOf).sort(byZ)) drawTree(ctx, layer);
  ctx.restore();
  placeFunctors(placed);
  perf.drawMs += performance.now() - t0;
  note(Ev.CompositeEnd);
  target.present(content);
}
const byZ = (a: Layer, b: Layer) => a.z - b.z;
/** Layer::traverseInZOrder: the children and the layers relative to this one, by Z, those below
 *  zero under the layer's own content */
function drawTree(ctx: OffscreenCanvasRenderingContext2D, layer: Layer): void {
  if (layer.removed) return;
  const zs = layer.relatives.length ? [...layer.children.filter((c) => !c.relativeOf), ...layer.relatives].sort(byZ)
    : layer.children.length > 1 ? layer.children.slice().sort(byZ) : layer.children;
  let i = 0;
  for (; i < zs.length && zs[i].z < 0; i++) if (zs[i].relativeOf === null || zs[i].relativeOf === layer) drawTree(ctx, zs[i]);
  if (layer.buffer || layer.color) drawContent(ctx, layer);
  for (; i < zs.length; i++) if (zs[i].relativeOf === null || zs[i].relativeOf === layer) drawTree(ctx, zs[i]);
}
/** a layer's buffer or color under its parents' position, matrix, alpha and crop, which apply
 *  wherever relative Z placed it */
function drawContent(ctx: OffscreenCanvasRenderingContext2D, layer: Layer): void {
  const chain: Layer[] = [];
  for (let l: Layer | null = layer; l; l = l.parent) {
    if (l.hidden || l.alpha <= 0 || l.removed) return;
    chain.push(l);
  }
  ctx.save();
  let screen: Rect = [0, 0, ctx.canvas.width, ctx.canvas.height];
  for (let i = chain.length - 1; i >= 0; i--) {
    const l = chain[i], crop = l.crop;
    ctx.translate(l.x, l.y);
    if (l.matrix) { const [a, b, c, d] = l.matrix; ctx.transform(a, b, c, d, 0, 0); }
    ctx.globalAlpha *= l.alpha;
    if (crop) {
      ctx.beginPath(); ctx.roundRect(crop.l, crop.t, crop.r - crop.l, crop.b - crop.t, l.cornerRadius); ctx.clip();
      screen = intersect(screen, deviceRect(ctx.getTransform(), crop.l, crop.t, crop.r, crop.b));
    }
  }
  placeWebContent(ctx.getTransform(), layer, screen);
  if (layer.color) {
    const [r, g, b] = layer.color;
    ctx.fillStyle = cssColor(0xff000000 | Math.round(r * 255) << 16 | Math.round(g * 255) << 8 | Math.round(b * 255));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  } else {
    const buffer = layer.buffer!, dest = layer.dest;
    content = true;
    if (dest) ctx.drawImage(buffer, dest.l, dest.t, dest.r - dest.l, dest.b - dest.t);
    else ctx.drawImage(buffer, 0, 0);
  }
  ctx.restore();
}

/** whether this composition drew a buffer, not only window colors */
let content = false;
/** WebView functors shown this composition, at their display rects */
const placed = new Map<number, Rect>();
/** web content is DOM over the display, so content composed over a functor hides it; the functors
 *  this layer's buffer drew show where the buffer composes */
function placeWebContent(m: DOMMatrix, layer: Layer, screen: Rect): void {
  const buffer = layer.buffer, dest = layer.dest;
  const [bw, bh] = !buffer ? [0, 0] : "displayWidth" in buffer ? [buffer.displayWidth, buffer.displayHeight] : [buffer.width, buffer.height];
  const bounds = intersect(screen, layer.color ? screen : dest ? deviceRect(m, dest.l, dest.t, dest.r, dest.b) : deviceRect(m, 0, 0, bw, bh));
  for (const [id, r] of placed) if (r[0] < bounds[2] && bounds[0] < r[2] && r[1] < bounds[3] && bounds[1] < r[3]) placed.delete(id);
  const functors = buffer && drawnOn(buffer);
  if (!functors?.size) return;
  const at = dest ? m.translate(dest.l, dest.t).scale((dest.r - dest.l) / bw, (dest.b - dest.t) / bh) : m;
  for (const [id, [l, t, r, b]] of functors) {
    const rect = intersect(deviceRect(at, l, t, r, b), bounds);
    if (rect[2] > rect[0] && rect[3] > rect[1]) placed.set(id, rect);
  }
}

// ── SurfaceControl and its Transaction
/** a client's reference to a layer: copies share the layer, each with its own native object */
interface Control { layer: Layer }
const control = (h: bigint) => deref<Control>(h);
const layerOf = (h: bigint) => control(h).layer;
type Op = () => void;
interface Transaction { ops: Op[] }
const tx = (h: bigint) => deref<Transaction>(h);
const op = (fn: (layer: Layer, ...a: never[]) => void) => (t: bigint, sc: bigint, ...a: never[]) => {
  const layer = layerOf(sc);
  tx(t).ops.push(() => fn(layer, ...a));
};
function applyOps(t: Transaction): void {
  const ops = t.ops.splice(0);
  for (const fn of ops) fn();
  if (ops.length) scheduleComposite();
}
/** a Java SurfaceControl over `layer` */
export const javaSurfaceControl = (layer: Layer, callsite: string): JObj | Promise<JObj> => after(newObj("android/view/SurfaceControl"),
  (sc) => after(vcall(sc, "assignNativeObject", "(JLjava/lang/String;)V", handle({ layer } satisfies Control), callsite), () => sc));
/** a root layer on the display: what a window's surface hangs from */
export function displayLayer(name: string, z: number): Layer {
  const layer = new Layer(name, 0);
  layer.layerStack = 0; layer.z = z;
  roots.add(layer);
  return layer;
}
export function removeLayer(layer: Layer): void {
  layer.removed = true;
  layer.reparent(null);
  layer.dropOutsideRelatives();
  roots.delete(layer);
  scheduleComposite();
}

rt.registerJnis("android/view/SurfaceSession", {
  "nativeCreate()J": () => handle({}),
  "nativeDestroy(J)V": (h: bigint) => release(h),
});
rt.registerJnis("android/view/SurfaceControl", {
  "nativeCreate(Landroid/view/SurfaceSession;Ljava/lang/String;IIIIJLandroid/os/Parcel;)J":
    (_session: JObj, name: string, _w: number, _h: number, _format: number, flags: number, parent: bigint) => {
      const layer = new Layer(name, flags);
      if (parent) layer.reparent(layerOf(parent)); else roots.add(layer);
      return handle({ layer } satisfies Control);
    },
  "nativeGetNativeSurfaceControlFinalizer()J": () => FINALIZER,
  "nativeGetNativeTransactionFinalizer()J": () => FINALIZER,
  "nativeDisconnect(J)V": () => {},
  "nativeCopyFromSurfaceControl(J)J": (h: bigint) => handle({ layer: layerOf(h) } satisfies Control),
  "nativeGetHandle(J)J": (h: bigint) => BigInt(layerOf(h).id),
  // a released control (mNativeObject 0) writes nothing: its reader sees the 0 SurfaceControl wrote before it
  "nativeWriteToParcel(JLandroid/os/Parcel;)V": (h: bigint, parcel: JObj) => { if (h) writeLocalObject(nativeParcel(parcel), layerOf(h)); },
  "nativeReadFromParcel(Landroid/os/Parcel;)J": (parcel: JObj) => {
    const layer = readLocalObject<Layer>(nativeParcel(parcel));
    return layer ? handle({ layer } satisfies Control) : 0n;
  },
  // the transaction's state is copied out, and the copy read back is a transaction of its own
  "nativeWriteTransactionToParcel(JLandroid/os/Parcel;)V": (t: bigint, parcel: JObj) => writeLocalObject(nativeParcel(parcel), tx(t).ops.slice()),
  "nativeReadTransactionFromParcel(Landroid/os/Parcel;)J": (parcel: JObj) =>
    handle({ ops: readLocalObject<Transaction["ops"]>(nativeParcel(parcel))?.slice() ?? [] } satisfies Transaction),
  "nativeGetLayerId(J)I": (h: bigint) => layerOf(h).id,
  "nativeGetTransformHint(J)I": () => 0,
  "nativeSetTransformHint(JI)V": () => {},
  // a layer composes at its buffer's size, so its default buffer size is not kept
  "nativeUpdateDefaultBufferSize(JII)V": () => {},
  "nativeMirrorSurface(J)J": (h: bigint) => handle({ layer: new Layer(layerOf(h).name + " mirror", 0) } satisfies Control),
  "nativeCreateTransaction()J": () => handle({ ops: [] } satisfies Transaction),
  "nativeApplyTransaction(JZZ)V": (t: bigint) => applyOps(tx(t)),
  "nativeMergeTransaction(JJ)V": (t: bigint, other: bigint) => { tx(t).ops.push(...tx(other).ops.splice(0)); },
  "nativeClearTransaction(J)V": (t: bigint) => { tx(t).ops.length = 0; },
  "nativeGetTransactionId(J)J": (t: bigint) => t,
  "nativeSetAnimationTransaction(J)V": () => {},
  "nativeSetEarlyWakeupStart(J)V": () => {}, "nativeSetEarlyWakeupEnd(J)V": () => {},
  "nativeSetFrameTimelineVsync(JJ)V": () => {},
  "nativeSetLayer(JJI)V": op((l, z: number) => { l.z = z; l.relativeTo(null); }),
  "nativeSetRelativeLayer(JJJI)V": (t: bigint, sc: bigint, relativeTo: bigint, z: number) => {
    const layer = layerOf(sc), to = layerOf(relativeTo);
    tx(t).ops.push(() => { layer.z = z; layer.relativeTo(to); });
  },
  "nativeSetPosition(JJFF)V": op((l, x: number, y: number) => { l.x = x; l.y = y; }),
  "nativeSetScale(JJFF)V": op((l, sx: number, sy: number) => { l.matrix = [sx, 0, 0, sy]; }),
  "nativeSetMatrix(JJFFFF)V": op((l, dsdx: number, dtdx: number, dtdy: number, dsdy: number) => { l.matrix = [dsdx, dtdx, dtdy, dsdy]; }),
  "nativeSetAlpha(JJF)V": op((l, a: number) => { l.alpha = a; }),
  "nativeSetColor(JJ[F)V": op((l, c: Float32Array) => { l.color = [c[0], c[1], c[2]]; }),
  "nativeSetWindowCrop(JJIIII)V": op((l, left: number, top: number, right: number, bottom: number) => {
    l.crop = right > left && bottom > top ? { l: left, t: top, r: right, b: bottom } : null;
  }),
  "nativeSetDestinationFrame(JJIIII)V": op((l, left: number, top: number, right: number, bottom: number) => {
    l.dest = right > left && bottom > top ? { l: left, t: top, r: right, b: bottom } : null;
  }),
  "nativeSetCornerRadius(JJF)V": op((l, r: number) => { l.cornerRadius = r; }),
  // an opaque layer composes as any other
  "nativeSetFlags(JJII)V": op((l, flags: number, mask: number) => { if (mask & LAYER_HIDDEN) l.hidden = !!(flags & LAYER_HIDDEN); }),
  "nativeSetLayerStack(JJI)V": op((l, stack: number) => { l.layerStack = stack; }),
  "nativeReparent(JJJ)V": (t: bigint, sc: bigint, parent: bigint) => {
    const layer = layerOf(sc), to = parent ? layerOf(parent) : null;
    // a layer reparented to null is offscreen, not a display root, and goes once its controls are released
    tx(t).ops.push(() => {
      layer.reparent(to);
      roots.delete(layer);
      if (!to) layer.dropOutsideRelatives();
    });
  },
  // properties the display composes without: the browser canvas has one color space, no HDR,
  // no frame-rate voting, no blur or shadows on layers, and input routing is the window manager's
  ...Object.fromEntries([
    "nativeSetBufferTransform(JJI)V", "nativeSetDataSpace(JJI)V", "nativeSetColorSpaceAgnostic(JJZ)V", "nativeSetFrameRate(JJFII)V",
    "nativeSetFrameRateCategory(JJIZ)V", "nativeSetFrameRateSelectionPriority(JJI)V", "nativeSetFrameRateSelectionStrategy(JJI)V",
    "nativeSetDefaultFrameRateCompatibility(JJI)V", "nativeSetFixedTransformHint(JJI)V", "nativeSetInputWindowInfo(JJLandroid/view/InputWindowHandle;)V",
    "nativeSetTrustedOverlay(JJI)V", "nativeSetDropInputMode(JJI)V", "nativeSetDamageRegion(JJLandroid/graphics/Region;)V",
    "nativeSetTransparentRegionHint(JJLandroid/graphics/Region;)V", "nativeSetMetadata(JJILandroid/os/Parcel;)V", "nativeSetCachingHint(JJI)V",
    "nativeSetDimmingEnabled(JJZ)V", "nativeSetCanOccludePresentation(JJZ)V", "nativeSetDesiredPresentTimeNanos(JJ)V", "nativeSetFrameTimeline(JJ)V",
    "nativeSanitize(JII)V", "nativeSetShadowRadius(JJF)V", "nativeSetBackgroundBlurRadius(JJI)V", "nativeSetExtendedRangeBrightness(JJFF)V",
    "nativeSetDesiredHdrHeadroom(JJF)V",
  ].map((sig) => [sig, () => {}])),
  "nativeAddTransactionCommittedListener(JLandroid/view/SurfaceControl$TransactionCommittedListener;)V": (t: bigint, listener: JObj) => {
    tx(t).ops.push(() => queueMicrotask(() => detached(() => asSystem(() => vcall(listener, "onTransactionCommitted", "()V")))));
  },
  // composition is synchronous, so the present fence has signaled by the time the stats arrive
  "nativeAddTransactionCompletedListener(JLjava/util/function/Consumer;)V": (t: bigint, consumer: JObj) => {
    tx(t).ops.push(() => queueMicrotask(() => detached(() => asSystem(() => {
      const now = BigInt(Math.round(uptimeMillis() * 1e6));
      return after(newObj("android/view/SurfaceControl$TransactionStats", "(JJ)V", now, handle({ signaled: now, refs: 1 })),
        (stats) => vcall(consumer, "accept", "(Ljava/lang/Object;)V", stats));
    }))));
  },
});

// SyncFence over a fence that has signaled: a reference count and its signal time
interface Fence { signaled: bigint; refs: number }
const fence = (h: bigint) => deref<Fence>(h);
const FENCE_RELEASE = handle((h: bigint) => { if (--fence(h).refs === 0) release(h); });
rt.registerJnis("android/hardware/SyncFence", {
  "nGetDestructor()J": () => FENCE_RELEASE,
  "nIncRef(J)V": (h: bigint) => { fence(h).refs++; },
  "nIsValid(J)Z": (h: bigint) => +!!h,
  "nWait(JJ)Z": () => 1,
  "nGetSignalTime(J)J": (h: bigint) => fence(h).signaled,
});

// ── BLASTBufferQueue and Surface: a window's buffers
interface Queue { name: string; control: Control | null; width: number; height: number; canvas: OffscreenCanvas | null; frame: bigint;
  sync: JObj | null; acquireSingle: boolean; pending: Transaction[]; gl: GlSurface | null }
/** a producer's handle: on a BLAST queue, on a layer, or on a SurfaceTexture's GL surface */
export interface Surface { queue: Queue | null; layer: Layer | null; producer?: GlSurface }
const queue = (h: bigint) => deref<Queue>(h);
/** the buffer a surface's next frame draws into, sized to its queue or to its SurfaceTexture's buffers */
export function surfaceBuffer(s: Surface): OffscreenCanvas | null {
  const q = s.queue, p = s.producer, owner = q ?? p;
  if (!owner) return null;
  const width = q ? q.width : bufferWidth(p!), height = q ? q.height : bufferHeight(p!);
  if (width <= 0 || height <= 0) return null;
  if (!owner.canvas) owner.canvas = new OffscreenCanvas(width, height);
  else if (owner.canvas.width !== width || owner.canvas.height !== height) { owner.canvas.width = width; owner.canvas.height = height; }
  return owner.canvas;
}
/** BLASTBufferQueue's onFrameAvailable: the drawn buffer latches on the queue's layer, through the
 *  transaction a sync asked for if one is waiting, else at once. Latching releases the frame the
 *  layer held, as acquiring the next buffer releases the last. A SurfaceTexture's consumer takes
 *  the drawn buffer as a frame of its own. */
export function queueBuffer(s: Surface, buffer: Frame | null = s.queue?.canvas ?? null): unknown {
  if (s.producer) { if (s.producer.canvas) presentSurface(s.producer, s.producer.canvas.transferToImageBitmap()); return; }
  const q = s.queue, layer = q?.control?.layer;
  if (!q || !layer) { if (buffer !== q?.canvas) releaseFrame(buffer); return; }
  q.frame++;
  note(Ev.Queue);
  queuedAt ??= performance.now();
  const latch: Transaction = { ops: q.pending.flatMap((t) => t.ops.splice(0)) };
  q.pending.length = 0;
  latch.ops.push(() => {
    if (layer.buffer !== buffer) releaseFrame(layer.buffer);
    layer.buffer = buffer;
  });
  const sync = q.sync;
  if (sync) {
    if (q.acquireSingle) q.sync = null;
    return after(newObj("android/view/SurfaceControl$Transaction"), (t) => {
      tx((t as Record<string, bigint>)[transactionField()]).ops.push(...latch.ops);
      return vcall(sync, "accept", "(Ljava/lang/Object;)V", t);
    });
  }
  applyOps(latch);
}
let txField: string | null = null;
const transactionField = () => txField ??= declaredField("android/view/SurfaceControl$Transaction", "mNativeObject");
let sfField = "";
const surfaceField = () => sfField ||= declaredField("android/view/Surface", "mNativeObject");
export const nativeSurface = (javaSurface: JObj | null): Surface | null => {
  const h = javaSurface ? (javaSurface as Record<string, bigint>)[surfaceField()] : 0n;
  return h ? deref<Surface>(h) : null;
};
/** the surface EGL and media producers draw: on a queue, sized by it, each frame queued as its next
 *  buffer, and released once the layer latches the one after */
export function glSurfaceOf(s: Surface): GlSurface | null {
  if (s.producer) return s.producer;
  const q = s.queue;
  if (!q) return null;
  return q.gl ??= {
    present: null, frames: 0,
    get width() { return q.width; }, get height() { return q.height; },
    post: (frame) => detached(() => queueBuffer(s, frame)),
  };
}

rt.registerJnis("android/graphics/BLASTBufferQueue", {
  "nativeCreate(Ljava/lang/String;Z)J": (name: string) =>
    handle({ name, control: null, width: 0, height: 0, canvas: null, frame: 0n, sync: null, acquireSingle: true, pending: [], gl: null } satisfies Queue),
  "nativeDestroy(J)V": (h: bigint) => release(h),
  "nativeUpdate(JJJJI)V": (h: bigint, sc: bigint, w: bigint, ht: bigint) => {
    const q = queue(h);
    q.control = control(sc); q.width = Number(w); q.height = Number(ht);
  },
  "nativeGetSurface(JZ)Landroid/view/Surface;": (h: bigint) =>
    newObj("android/view/Surface", "(J)V", handle({ queue: queue(h), layer: null } satisfies Surface)),
  "nativeSyncNextTransaction(JLjava/util/function/Consumer;Z)Z": (h: bigint, callback: JObj, acquireSingle: number) => {
    const q = queue(h);
    q.sync = callback; q.acquireSingle = !!acquireSingle;
    return 1;
  },
  "nativeStopContinuousSyncTransaction(J)V": (h: bigint) => { queue(h).sync = null; },
  "nativeClearSyncTransaction(J)V": (h: bigint) => { queue(h).sync = null; },
  "nativeMergeWithNextTransaction(JJJ)V": (h: bigint, t: bigint) => { queue(h).pending.push({ ops: tx(t).ops.splice(0) }); },
  "nativeApplyPendingTransactions(JJ)V": (h: bigint) => {
    for (const t of queue(h).pending.splice(0)) applyOps(t);
  },
  "nativeGatherPendingTransactions(JJ)Landroid/view/SurfaceControl$Transaction;": async (h: bigint) => {
    const t = await newObj("android/view/SurfaceControl$Transaction", "()V");
    tx((t as Record<string, bigint>)[transactionField()]).ops.push(...queue(h).pending.splice(0).flatMap((p) => p.ops));
    return t;
  },
  "nativeGetLastAcquiredFrameNum(J)J": (h: bigint) => queue(h).frame,
  "nativeIsSameSurfaceControl(JJ)Z": (h: bigint, sc: bigint) => +(queue(h).control?.layer === layerOf(sc)),
  "nativeSetTransactionHangCallback(JLandroid/graphics/BLASTBufferQueue$TransactionHangCallback;)V": () => {},
});

const surface = (h: bigint) => deref<Surface>(h);
rt.registerJnis("android/view/Surface", {
  "nativeCreateFromSurfaceControl(J)J": (sc: bigint) => handle({ queue: null, layer: layerOf(sc) } satisfies Surface),
  "nativeGetFromSurfaceControl(JJ)J": (_h: bigint, sc: bigint) => handle({ queue: null, layer: layerOf(sc) } satisfies Surface),
  "nativeGetFromBlastBufferQueue(JJ)J": (h: bigint, q: bigint) => h && surface(h).queue === queue(q) ? h : handle({ queue: queue(q), layer: null } satisfies Surface),
  "nativeRelease(J)V": (h: bigint) => release(h),
  // Surface.destroy disconnects the producer, then release() frees the native object: freeing it
  // here would free a handle another surface took in between
  "nativeDestroy(J)V": () => {},
  "nativeIsValid(J)Z": (h: bigint) => +!!(h && (surface(h).queue || surface(h).layer || surface(h).producer)),
  "nativeGetWidth(J)I": (h: bigint) => (surface(h).queue ?? surface(h).producer)?.width ?? 0,
  "nativeGetHeight(J)I": (h: bigint) => (surface(h).queue ?? surface(h).producer)?.height ?? 0,
  "nativeGetNextFrameNumber(J)J": (h: bigint) => (surface(h).queue?.frame ?? 0n) + 1n,
  "nativeIsConsumerRunningBehind(J)Z": () => 0,
  "nativeAllocateBuffers(J)V": () => {},
  "nativeSetScalingMode(JI)I": () => 0,
  "nativeSetFrameRate(JFII)I": () => 0,
  "nativeForceScopedDisconnect(J)I": () => 0,
  "nativeSetAutoRefreshEnabled(JZ)I": () => 0,
  "nativeSetSharedBufferModeEnabled(JZ)I": () => 0,
  // the software path: a Canvas over the next buffer, posted on unlock
  "nativeLockCanvas(JLandroid/graphics/Canvas;Landroid/graphics/Rect;)J": (h: bigint, canvas: JObj) => {
    const s = surface(h), buffer = surfaceBuffer(s);
    if (!buffer) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Surface has no buffer to lock");
    canvasOf(canvas).setTarget(buffer.getContext("2d")!, buffer.width, buffer.height, null);
    // the locked object is a reference of its own, which unlockCanvasAndPost releases
    return handle({ ...s } satisfies Surface);
  },
  "nativeUnlockCanvasAndPost(JLandroid/graphics/Canvas;)V": (h: bigint) => { perf.draws++; frameDrawn(); return queueBuffer(surface(h)); },
});
