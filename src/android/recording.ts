import type { NativeCanvas } from "./canvas";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Operation = (ctx: Ctx2D) => void;
/** A display list: flat (kind, key, payload) triples — a call with its arguments, a property
 *  write, or a deferred operation that needs the replay target itself. */
export type DisplayList = unknown[];
const CALL = 0, SET = 1, DEFER = 2;

type Recording = { ops: DisplayList };
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

/** Mirror native operations for measurement while retaining them for display-list replay. */
function recordInto(mirror: Ctx2D, rec: Recording): Ctx2D {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const context = new Proxy(mirror, {
    get(target, key) {
      let method = methods.get(key);
      if (method) return method;
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      const read = READS.has(key as string), draw = DRAWS.has(key as string);
      methods.set(key, method = read ? (...args) => fn.apply(target, args)
        : draw ? (...args) => { rec.ops.push(CALL, key, args); }
        : (...args) => { rec.ops.push(CALL, key, args); return fn.apply(target, args); });
      return method;
    },
    set(target, key, value) {
      rec.ops.push(SET, key, value);
      return Reflect.set(target, key, value, target);
    },
  });
  recordings.set(context, rec);
  mirrors.set(context, mirror);
  return context;
}
/** A recording context reused for one display list after another (SkPictureRecorder): `take`
 *  hands over what was recorded and starts a fresh list over a reset canvas state. The mirror
 *  answers reads made while recording (the matrix, text metrics); replay never reads it, so one
 *  pixel is enough. */
export class Recorder implements Recording {
  ops: DisplayList = [];
  private readonly mirror = new OffscreenCanvas(1, 1).getContext("2d")!;
  readonly ctx = recordInto(this.mirror, this);
  take(): DisplayList {
    const ops = this.ops;
    this.ops = [];
    this.mirror.reset();
    return ops;
  }
}
/** A recording that shares `ctx`'s mirror, so its state stays continuous, but keeps its
 *  operations in `ops`: the content of a layer, replayed into the layer's own raster. */
export function nestedRecording(ctx: Ctx2D, ops: DisplayList): Ctx2D {
  return recordInto(mirrors.get(ctx)!, { ops });
}
