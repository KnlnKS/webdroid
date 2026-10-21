import type { NativeCanvas } from "./canvas.ts";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Operation = (ctx: Ctx2D) => void;
/** A display list: flat (kind, key, payload) triples — a call with its arguments, a property
 *  write, or a deferred operation that needs the replay target itself. */
export type DisplayList = unknown[];
const CALL = 0, SET = 1, DEFER = 2;

/** A context's transform: its six values */
export type Mat2D = { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number };
/** whether a 2D context can invert the transform, as it asks before every operation but setTransform:
 *  a finite, non-zero determinant */
export const isInvertible = (m: Mat2D): boolean => { const det = m.a * m.d - m.b * m.c; return det !== 0 && Number.isFinite(det); };
let rotator: OffscreenCanvasRenderingContext2D | null = null;
/** A transform and save stack kept as Canvas2D keeps them, so a recorder answers the matrix without
 *  a DOMMatrix. Canvas2D ignores a non-finite argument, and every operation but setTransform under
 *  a singular matrix; so does this. */
export class Transform implements Mat2D {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  private readonly stack: number[] = [];
  reset(): void { this.resetTransform(); this.stack.length = 0; }
  save(): void { this.stack.push(this.a, this.b, this.c, this.d, this.e, this.f); }
  restore(): void {
    const s = this.stack;
    if (s.length) { this.f = s.pop()!; this.e = s.pop()!; this.d = s.pop()!; this.c = s.pop()!; this.b = s.pop()!; this.a = s.pop()!; }
  }
  /** Canvas2D rounds the numbers it is given to float */
  translate(x: number, y: number): void {
    if (!isInvertible(this) || !Number.isFinite(x + y)) return;
    x = Math.fround(x); y = Math.fround(y);
    this.e += x * this.a + y * this.c; this.f += x * this.b + y * this.d;
  }
  scale(x: number, y: number): void {
    if (!isInvertible(this) || !Number.isFinite(x + y)) return;
    x = Math.fround(x); y = Math.fround(y);
    this.a *= x; this.b *= x; this.c *= y; this.d *= y;
  }
  /** the browser's own sine and cosine, which differ from V8's in the last bit */
  rotate(radians: number): void {
    const scratch = rotator ??= new OffscreenCanvas(1, 1).getContext("2d")!;
    scratch.setTransform(this.matrix());
    scratch.rotate(radians);
    const m = scratch.getTransform();
    this.a = m.a; this.b = m.b; this.c = m.c; this.d = m.d; this.e = m.e; this.f = m.f;
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (!isInvertible(this) || !Number.isFinite(a + b + c + d + e + f)) return;
    a = Math.fround(a); b = Math.fround(b); c = Math.fround(c); d = Math.fround(d); e = Math.fround(e); f = Math.fround(f);
    const A = this.a, B = this.b, C = this.c, D = this.d;
    this.a = A * a + C * b; this.b = B * a + D * b; this.c = A * c + C * d; this.d = B * c + D * d;
    this.e += A * e + C * f; this.f += B * e + D * f;
  }
  /** setTransform(a, b, c, d, e, f), which rounds to float, or setTransform(matrix), which does not */
  setTransform(a: number | Mat2D, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    if (typeof a === "object") { this.take(a.a, a.b, a.c, a.d, a.e, a.f); return; }
    const r = Math.fround;
    this.take(r(a), r(b!), r(c!), r(d!), r(e!), r(f!));
  }
  private take(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (Number.isFinite(a + b + c + d + e + f)) { this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; }
  }
  resetTransform(): void { this.a = this.d = 1; this.b = this.c = this.e = this.f = 0; }
  matrix(): DOMMatrix { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]); }
}
type Recording = { ops: DisplayList; t: Transform };
const recordings = new WeakMap<Ctx2D, Recording>();
const mirrors = new WeakMap<Ctx2D, Ctx2D>();

export function isRecording(ctx: Ctx2D): boolean { return recordings.has(ctx); }

export function recordOrRun(ctx: Ctx2D, operation: Operation): void {
  const rec = recordings.get(ctx);
  if (rec) rec.ops.push(DEFER, null, operation);
  else operation(ctx);
}

export function replay(ctx: Ctx2D, ops: DisplayList): void {
  const target = ctx as unknown as Record<string, unknown>;
  for (let i = 0; i < ops.length; i += 3) {
    const kind = ops[i], key = ops[i + 1] as string, payload = ops[i + 2];
    if (kind === CALL) (target[key] as (...a: unknown[]) => unknown).apply(ctx, payload as unknown[]);
    else if (kind === SET) target[key] = payload;
    else (payload as Operation)(ctx);
  }
}
export const displayListLength = (ops: DisplayList): number => ops.length / 3;

/** The canvas the display lists being replayed draw for, whose clip a replayed functor takes.
 *  Replay is synchronous and nests (a node in a node, a layer's content, an effect's input), so one
 *  variable scoped by replayFor names it for every target a replay reaches. */
let replaying: NativeCanvas | null = null;
export function replayingCanvas(): NativeCanvas | null { return replaying; }
export function replayFor(canvas: NativeCanvas, draw: () => void): void {
  const previous = replaying;
  replaying = canvas;
  try { draw(); }
  finally { replaying = previous; }
}

/** Queries: answered by the mirror, never replayed. */
const READS = new Set(["getTransform", "measureText", "getLineDash", "isPointInPath", "isPointInStroke", "getImageData",
  "getContextAttributes", "isContextLost", "createLinearGradient", "createRadialGradient", "createConicGradient",
  "createPattern", "createImageData"]);
/** Pixel output: replayed, but the mirror only has to track state that later queries read. */
const DRAWS = new Set(["fillRect", "strokeRect", "clearRect", "fillText", "strokeText", "drawImage", "fill", "stroke",
  "putImageData", "clip", "drawFocusIfNeeded"]);

/** Operations `Transform` carries instead of the mirror; the mirror keeps only the style state a
 *  save, restore or reset brackets */
const TRANSFORMS = new Set(["translate", "scale", "rotate", "transform", "setTransform", "resetTransform", "save", "restore", "reset"]);
const STYLE_BRACKETS = new Set(["save", "restore", "reset"]);
/** Path construction: replayed, and never read back, since the mirror answers no point-in-path query */
const PATHS = new Set(["beginPath", "closePath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo", "arc", "arcTo",
  "ellipse", "rect", "roundRect"]);
type Context = { readonly mirror: Ctx2D; readonly rec: Recording };
type Method = (this: Context, ...args: unknown[]) => unknown;
type Members = Record<string, unknown>;
/** What a recording context is: the mirror's members, each answered by the mirror, recorded, or both */
function contextClass(mirror: Ctx2D): new (mirror: Ctx2D, rec: Recording) => Ctx2D {
  class Recording2D { readonly mirror: Ctx2D; readonly rec: Recording; constructor(mirror: Ctx2D, rec: Recording) { this.mirror = mirror; this.rec = rec; } }
  const proto = Object.getPrototypeOf(mirror) as object;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name)!;
    if (name === "constructor") continue;
    if (typeof d.value !== "function") {
      Object.defineProperty(Recording2D.prototype, name, {
        get(this: Context) { return (this.mirror as unknown as Members)[name]; },
        ...(d.set ? { set(this: Context, value: unknown) { this.rec.ops.push(SET, name, value); (this.mirror as unknown as Members)[name] = value; } } : {}),
      });
      continue;
    }
    const fn = d.value as (...args: unknown[]) => unknown;
    let method: Method;
    if (name === "getTransform") method = function () { return this.rec.t.matrix(); };
    else if (READS.has(name)) method = function (...args) { return fn.apply(this.mirror, args); };
    else if (DRAWS.has(name) || PATHS.has(name)) method = function (...args) { this.rec.ops.push(CALL, name, args); };
    else if (TRANSFORMS.has(name)) {
      const apply = Transform.prototype[name as keyof Transform] as (this: Transform, ...a: unknown[]) => void;
      const mirrored = STYLE_BRACKETS.has(name);
      method = function (...args) { this.rec.ops.push(CALL, name, args); apply.apply(this.rec.t, args); if (mirrored) fn.apply(this.mirror, args); };
    } else method = function (...args) { this.rec.ops.push(CALL, name, args); return fn.apply(this.mirror, args); };
    Object.defineProperty(Recording2D.prototype, name, { value: method, writable: true, configurable: true });
  }
  return Recording2D as unknown as new (mirror: Ctx2D, rec: Recording) => Ctx2D;
}
let RecordingContext: ReturnType<typeof contextClass> | undefined;
/** Mirror native operations for measurement while retaining them for display-list replay. */
function recordInto(mirror: Ctx2D, rec: Recording): Ctx2D {
  const context = new (RecordingContext ??= contextClass(mirror))(mirror, rec);
  recordings.set(context, rec);
  mirrors.set(context, mirror);
  return context;
}
/** A recording context reused for one display list after another (SkPictureRecorder): `take`
 *  hands over what was recorded and starts a fresh list over a reset canvas state. The mirror
 *  answers reads made while recording (text metrics, style values); replay never reads it, so one
 *  pixel is enough. */
export class Recorder implements Recording {
  ops: DisplayList = [];
  readonly t = new Transform();
  private readonly mirror = new OffscreenCanvas(1, 1).getContext("2d")!;
  readonly ctx = recordInto(this.mirror, this);
  take(): DisplayList {
    const ops = this.ops;
    this.ops = [];
    this.mirror.reset();
    this.t.reset();
    return ops;
  }
}
/** The transform `ctx` has now: a recording's live state (copy it to keep it across a change),
 *  else a snapshot of the context's. */
export function transformOf(ctx: Ctx2D): Mat2D { return recordings.get(ctx)?.t ?? ctx.getTransform(); }
/** A recording that shares `ctx`'s mirror, so its state stays continuous, but keeps its
 *  operations in `ops`: the content of a layer, replayed into the layer's own raster. */
export function nestedRecording(ctx: Ctx2D, ops: DisplayList): Ctx2D {
  return recordInto(mirrors.get(ctx)!, { ops, t: recordings.get(ctx)!.t });
}
