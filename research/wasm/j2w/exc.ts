// Exceptions the compiled code raises itself: the implicit throwers, their messages, stack traces and heap limits.
import { ModuleBuilder, T } from "./wasmbin";
import { Code } from "./code";
import type { Kind } from "./program";
import type { Compiler, FnTrace } from "./j2w";

/** ART's heap limit, as src/jvm/runtime.ts HEAP_LIMIT: the JS tier throws OutOfMemoryError past it too */
export const HEAP_LIMIT = 512 * 1024 * 1024;
export const MAX_ARRAY_BYTES = HEAP_LIMIT;
/** calls and loop iterations a method runs as first-tier code before it is recompiled (World.upgrade) */
export const HOT_BUDGET = 5000;
/** bytes allocated between two heap checks; allocation counts up to zero from -ALLOC_WINDOW */
export const ALLOC_WINDOW = 8 << 20;

/** Table slots that hold the throwers, bound once the runtime starts; each is a lazy-link stub until first used. */
export const SLOT = { npe: 1, aioobe: 2, arith: 3, cce: 4, nase: 5, oom: 6, ule: 7, soe: 8, sioobe: 9, copy: 10, ase: 11, ame: 12, asx: 13, inste: 14, nsfe: 15, ncdfe: 16, recv: 17, iacc: 18, ftm: 19, fin: 20, ncdfr: 21, nsme: 22, nsfer: 23, icce: 24 } as const;
export type Thrower = keyof typeof SLOT;
export const FIRST_FREE_SLOT = 25;
/** a class's init word: 0 not started, (thread << 2 | 1) running on that thread, then done or failed (JLS 12.4.2) */
export const INIT_DONE = 2, INIT_FAILED = 3;
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
  sioobe: { cls: L + "StringIndexOutOfBoundsException", params: ["I", "I", "I"] }, // offset, count, length of a char range
  copy: { cls: L + "ArrayIndexOutOfBoundsException", params: ["I", "I", "I", "I", "I"] }, // System.arraycopy: src length, srcPos, dst length, dstPos, length
  ase: { cls: L + "ArrayStoreException", params: [] },
  ame: { cls: L + "AbstractMethodError", params: [] },                           // a call of a method the class does not implement
  asx: { cls: L + "ArrayStoreException", params: ["I", "I"] },                   // class id of the value, class id of the array
  inste: { cls: L + "InstantiationException", params: [] },
  nsfe: { cls: L + "NoSuchFieldException", params: [] },
  ncdfe: { cls: L + "NoClassDefFoundError", params: ["I"] },                        // a class whose initialization failed earlier
  recv: { cls: L + "IllegalArgumentException", params: ["I", "I"] },             // Field: class id the receiver must be an instance of, class id of the receiver
  iacc: { cls: L + "IllegalAccessException", params: ["I", "I"] },               // Field: class id of the caller, class id of the field's class
  ftm: { cls: L + "IllegalArgumentException", params: ["I", "I"] },              // Field: class id of the field's type, class id of the value
  fin: { cls: L + "IllegalAccessException", params: ["I"] },                     // Field: class id of the final field's class
  ncdfr: { cls: L + "NoClassDefFoundError", params: ["I"] },                     // a class the program names and the loaded dexes lack (linkage.ts): index of the message
  nsme: { cls: L + "NoSuchMethodError", params: ["I"] },
  nsfer: { cls: L + "NoSuchFieldError", params: ["I"] },
  icce: { cls: L + "IncompatibleClassChangeError", params: ["I"] },
};

const dotted = (n: string) => n.replace(/\//g, ".");
const PRETTY: Record<string, string> = { Z: "boolean", B: "byte", C: "char", S: "short", I: "int", J: "long", F: "float", D: "double" };
/** a class name as java.lang.Class.getTypeName prints it */
const pretty = (n: string): string => n[0] === "#" ? PRETTY[n[1]] : n[0] !== "[" ? dotted(n) : pretty(n[1] === "[" ? n.slice(1) : n[1] === "L" ? n.slice(2, -1) : PRETTY[n[1]]) + "[]";
/** The message ART and the JS tier give the exception (null: none). `a` and `b` are the thrower's arguments, a wide one split into halves. */
export function excMessage(kind: number, a: number, b: number, c: number, d: number, e: number, className: (id: number) => string, linkMessage: (id: number) => string): string | null {
  switch (kind) {
    case SLOT.aioobe: return `length=${b}; index=${a}`;
    case SLOT.arith: return "divide by zero";
    case SLOT.cce: return `${dotted(className(a))} cannot be cast to ${dotted(className(b))}`;
    case SLOT.nase: return String(a);
    case SLOT.recv: return `Expected receiver of type ${dotted(className(a))}, but got ${dotted(className(b))}`;
    case SLOT.iacc: return `Class ${dotted(className(a))} cannot access a member of class ${dotted(className(b))}`;
    case SLOT.ftm: return `Can not set ${pretty(className(a))} field to ${pretty(className(b))}`;
    case SLOT.fin: return `Cannot set a final field of class ${dotted(className(a))}`;
    case SLOT.ncdfe: return `Could not initialize class ${dotted(className(a))}`;
    case SLOT.ncdfr: case SLOT.nsme: case SLOT.nsfer: case SLOT.icce: return linkMessage(a);
    case SLOT.sioobe: return `offset ${a}, count ${b}, length ${c}`;
    case SLOT.copy: return `src.length=${a} srcPos=${b} dst.length=${c} dstPos=${d} length=${e}`;
    case SLOT.asx: return `${pretty(className(a))} cannot be stored in an array of type ${pretty(className(b))}`;
    case SLOT.oom: return `Failed to allocate a ${(BigInt(b) << 32n) | BigInt(a >>> 0)} byte allocation with ${HEAP_LIMIT} free bytes`;
    default: return null;
  }
}

/** The body of thrower `name`: allocate its exception, run the no-argument constructor, store the message the host computes
 *  (`excMessage`) in Throwable.detailMessage, throw. */
export function throwerBody(cx: Compiler, c: Code, name: Thrower): void {
  const { cls, params } = THROWERS[name], n = params.length;
  cx.emitEnsure(c, cls);
  const exn = c.newLocal(T.anyref), msg = c.newLocal(T.externref);
  cx.emitNew(c, cls); c.lset(exn);
  const ctor = cx.prog.resolve(cls, "<init>", "()V");
  if (ctor?.codeOff) { c.lget(exn); cx.callMethod(c, ctor); }
  c.i32(SLOT[name]);
  if (params[0] === "J") c.lget(0).raw(0xa7).lget(0).i64(32n).raw(0x88, 0xa7).i32(0).i32(0).i32(0);       // wrap(l), wrap(l >>> 32)
  else for (let i = 0; i < 5; i++) i < n ? c.lget(i) : c.i32(0);
  c.call(cx.imp.excMessage).lset(msg);
  const detail = cx.prog.resolveField("java/lang/Throwable", "detailMessage", "Ljava/lang/String;"), st = cx.structFor("java/lang/Throwable");
  if (detail && !detail.isStatic) c.lget(exn).refCast(st).lget(msg).anyConvertExtern().structSet(st, cx.fieldIndex("java/lang/Throwable", detail));
  c.lget(exn).throw_(cx.tag);
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
    out.push({ cls: dotted(t.m.cls), method: t.m.name, pc, line: t.m.codeOff ? t.m.dex.lineAt(t.m.codeOff, pc) : -1 });
  }
  return out;
}

let named: boolean | undefined;
/** whether the engine's `Error.stack` has a line for each Wasm frame (V8's does; JavaScriptCore's frames carry no name or offset) */
export function namesWasmFrames(): boolean {
  if (named === undefined) {
    const mb = new ModuleBuilder(), f = mb.importFunc("h", "f", mb.addFuncType([], [])), g = mb.addFunc(mb.addFuncType([], []), new Code(0).call(f).finish(), "probe");
    mb.export("g", "func", g);
    named = false;
    (new WebAssembly.Instance(new WebAssembly.Module(mb.build() as BufferSource), { h: { f: () => { named = /wasm-function\[\d+\]/.test(new Error().stack ?? ""); } } }).exports.g as () => void)();
  }
  return named;
}

export const isStackOverflow = (e: unknown): boolean => e instanceof RangeError && /call stack/i.test(e.message);

/** bytes in use on the JS heap, which holds the Wasm GC heap in V8 */
export function heapUsed(): number {
  const p = (globalThis as { performance?: { memory?: { usedJSHeapSize: number } } }).performance?.memory;
  if (p) return p.usedJSHeapSize;
  return typeof process !== "undefined" ? process.memoryUsage().heapUsed : 0;
}
