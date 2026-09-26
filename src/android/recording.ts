import type { JCanvas } from "./graphics";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Operation = (ctx: Ctx2D) => void;
/** A display list: flat (kind, key, payload) triples — a call with its arguments, a property
 *  write, or a deferred operation that needs the replay target itself. */
export type DisplayList = unknown[];
const CALL = 0, SET = 1, DEFER = 2;

const recordings = new WeakMap<Ctx2D, DisplayList>();
const replayCanvases = new WeakMap<Ctx2D, JCanvas>();

export function isRecording(ctx: Ctx2D): boolean { return recordings.has(ctx); }

export function recordOrRun(ctx: Ctx2D, operation: Operation): void {
  const ops = recordings.get(ctx);
  if (ops) ops.push(DEFER, null, operation);
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

export function replayCanvas(ctx: Ctx2D): JCanvas | undefined { return replayCanvases.get(ctx); }
export function replayWithSemantics(canvas: JCanvas, draw: () => void): void {
  const previous = replayCanvases.get(canvas.ctx);
  replayCanvases.set(canvas.ctx, canvas);
  try { draw(); }
  finally { if (previous) replayCanvases.set(canvas.ctx, previous); else replayCanvases.delete(canvas.ctx); }
}

/** Queries: answered by the mirror, never replayed. */
const READS = new Set(["getTransform", "measureText", "getLineDash", "isPointInPath", "isPointInStroke", "getImageData",
  "getContextAttributes", "isContextLost", "createLinearGradient", "createRadialGradient", "createConicGradient",
  "createPattern", "createImageData"]);
/** Pixel output: replayed, but the mirror only has to track state that later queries read. */
const DRAWS = new Set(["fillRect", "strokeRect", "clearRect", "fillText", "strokeText", "drawImage", "fill", "stroke",
  "putImageData", "clip", "drawFocusIfNeeded"]);

/** Mirror native operations for measurement while retaining them for display-list replay. */
export function recordingContext(mirror: Ctx2D, ops: DisplayList): Ctx2D {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const context = new Proxy(mirror, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      let method = methods.get(key);
      if (!method) {
        const fn = value as (...args: unknown[]) => unknown;
        const read = READS.has(key as string), draw = DRAWS.has(key as string);
        methods.set(key, method = read ? (...args) => fn.apply(target, args)
          : draw ? (...args) => { ops.push(CALL, key, args); }
          : (...args) => { ops.push(CALL, key, args); return fn.apply(target, args); });
      }
      return method;
    },
    set(target, key, value) {
      ops.push(SET, key, value);
      return Reflect.set(target, key, value, target);
    },
  });
  recordings.set(context, ops);
  return context;
}
