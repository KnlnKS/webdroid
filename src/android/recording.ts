import type { JCanvas } from "./graphics";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Operation = (ctx: Ctx2D) => void;
const recordings = new WeakMap<Ctx2D, Operation[]>();
const replayCanvases = new WeakMap<Ctx2D, JCanvas>();

export function isRecording(ctx: Ctx2D): boolean { return recordings.has(ctx); }

export function recordOrRun(ctx: Ctx2D, operation: Operation): void {
  const ops = recordings.get(ctx);
  if (ops) ops.push(operation);
  else operation(ctx);
}

export function replayCanvas(ctx: Ctx2D): JCanvas | undefined { return replayCanvases.get(ctx); }
export function replayWithSemantics(canvas: JCanvas, draw: () => void): void {
  const previous = replayCanvases.get(canvas.ctx);
  replayCanvases.set(canvas.ctx, canvas);
  try { draw(); }
  finally { if (previous) replayCanvases.set(canvas.ctx, previous); else replayCanvases.delete(canvas.ctx); }
}

/** Mirror native operations for measurement while retaining them for display-list replay. */
export function recordingContext(mirror: Ctx2D, ops: Operation[]): Ctx2D {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const context = new Proxy(mirror, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      let method = methods.get(key);
      if (!method) methods.set(key, method = (...args: unknown[]) => {
        ops.push(ctx => { Reflect.apply(Reflect.get(ctx, key, ctx), ctx, args); });
        return Reflect.apply(value, target, args);
      });
      return method;
    },
    set(target, key, value) {
      ops.push(ctx => { Reflect.set(ctx, key, value, ctx); });
      return Reflect.set(target, key, value, target);
    },
  });
  recordings.set(context, ops);
  return context;
}
