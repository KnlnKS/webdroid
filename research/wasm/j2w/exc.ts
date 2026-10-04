// Exceptions the compiled code raises itself: the implicit throwers, their messages, stack traces and heap limits.
import type { Code } from "./code";
import { refNull } from "./wasmbin";
import type { Kind } from "./program";
import type { Compiler, FnTrace } from "./j2w";

/** ART's heap limit, as src/jvm/runtime.ts HEAP_LIMIT: the JS tier throws OutOfMemoryError past it too */
export const HEAP_LIMIT = 512 * 1024 * 1024;
export const MAX_ARRAY_BYTES = HEAP_LIMIT;
/** bytes allocated between two heap checks; allocation counts up to zero from -ALLOC_WINDOW */
export const ALLOC_WINDOW = 8 << 20;

/** Table slots that hold the throwers, bound once the runtime starts; each is a lazy-link stub until first used. */
export const SLOT = { npe: 1, aioobe: 2, arith: 3, cce: 4, nase: 5, oom: 6, ule: 7, soe: 8 } as const;
export type Thrower = keyof typeof SLOT;
export const FIRST_FREE_SLOT = 9;
const L = "java/lang/";
export const THROWERS: Record<Thrower, { cls: string; params: Kind[] }> = {
  npe: { cls: L + "NullPointerException", params: [] },
  aioobe: { cls: L + "ArrayIndexOutOfBoundsException", params: ["I", "I"] },     // index, length
  arith: { cls: L + "ArithmeticException", params: [] },
  cce: { cls: L + "ClassCastException", params: ["I", "I"] },                    // class id of the object, class id of the target
  nase: { cls: L + "NegativeArraySizeException", params: ["I"] },                // length
  oom: { cls: L + "OutOfMemoryError", params: ["J"] },                           // bytes requested
  ule: { cls: L + "UnsatisfiedLinkError", params: [] },                          // a construct the compiler has a gap for
  soe: { cls: L + "StackOverflowError", params: [] },
};

const dotted = (n: string) => n.replace(/\//g, ".");
/** The message ART and the JS tier give the exception (null: none). `a` and `b` are the thrower's arguments, a wide one split into halves. */
export function excMessage(kind: number, a: number, b: number, className: (id: number) => string): string | null {
  switch (kind) {
    case SLOT.aioobe: return `length=${b}; index=${a}`;
    case SLOT.arith: return "divide by zero";
    case SLOT.cce: return `${dotted(className(a))} cannot be cast to ${dotted(className(b))}`;
    case SLOT.nase: return String(a);
    case SLOT.oom: return `Failed to allocate a ${(BigInt(b) << 32n) | BigInt(a >>> 0)} byte allocation with ${HEAP_LIMIT} free bytes`;
    default: return null;
  }
}

/** The body of thrower `name`: allocate its exception, run the no-argument constructor, throw. The message is computed by the host
 *  (`excMessage`) but not stored: that needs the String representation, which this compiler does not have yet. */
export function throwerBody(cx: Compiler, c: Code, name: Thrower): void {
  const { cls, params } = THROWERS[name], n = params.length;
  cx.emitEnsure(c, cls);
  const exn = c.newLocal(refNull(cx.tObj));
  cx.emitNew(c, cls); c.lset(exn);
  const ctor = cx.prog.resolve(cls, "<init>", "()V");
  if (ctor?.codeOff) { c.lget(exn); cx.callMethod(c, ctor); }
  c.i32(SLOT[name]);
  if (params[0] === "J") c.lget(0).raw(0xa7).lget(0).i64(32n).raw(0x88, 0xa7);       // wrap(l), wrap(l >>> 32)
  else for (let i = 0; i < 2; i++) i < n ? c.lget(i) : c.i32(0);
  c.call(cx.imp.excMessage).drop().lget(exn).throw_(cx.tag);
}

export interface JavaFrame { cls: string; method: string; line: number; pc: number }
const FRAME = /at (?:(.+?) \()?wasm:\/\/wasm\/[0-9a-f]+:wasm-function\[\d+\]:0x([0-9a-f]+)\)?\s*$/;
/** The Java frames of a V8 `Error.stack`, innermost first: wasm frames are named by method id and carry a module offset */
export function javaFrames(stack: string, traces: Map<string, FnTrace>): JavaFrame[] {
  const out: JavaFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line);
    const t = m?.[1] ? traces.get(m[1]) : undefined;
    if (!t?.m) continue;                                  // host code, throwers and stubs are not Java frames
    const off = parseInt(m![2], 16);
    let lo = 0, hi = t.offsets.length - 1, at = -1;       // last mark at or before the frame's offset
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (t.offsets[mid] <= off) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    const pc = at < 0 ? 0 : t.pcs[at];
    out.push({ cls: dotted(t.m.cls), method: t.m.name, pc, line: t.m.dex.lineAt(t.m.codeOff, pc) });
  }
  return out;
}

export const isStackOverflow = (e: unknown): boolean => e instanceof RangeError && /call stack/i.test(e.message);

/** bytes in use on the JS heap, which holds the Wasm GC heap in V8 */
export function heapUsed(): number {
  const p = (globalThis as { performance?: { memory?: { usedJSHeapSize: number } } }).performance?.memory;
  if (p) return p.usedJSHeapSize;
  return typeof process !== "undefined" ? process.memoryUsage().heapUsed : 0;
}
