// Exceptions the compiled code raises itself: the implicit throwers, their messages, stack traces and heap limits.
import { ModuleBuilder, T } from "../compiler/wasmbin.ts";
import { Code, OP } from "../compiler/code.ts";
import type { Kind } from "../compiler/program.ts";
import type { Compiler, FnTrace } from "../compiler/j2w.ts";
import { oomMessage } from "../../jvm/abi.ts";
import { prettyType } from "../compiler/linkage.ts";

/** a capture deep enough for Java stack traces; other JS errors keep the engine's default depth */
export function deepStack(limit = 128): Error {
  const prior = Error.stackTraceLimit; Error.stackTraceLimit = limit;
  try { return new Error(); } finally { Error.stackTraceLimit = prior; }
}
/** calls and loop iterations a method runs as first-tier code before it is recompiled (World.upgrade) */
export const HOT_BUDGET = 5000;
/** The counters of first-tier methods are words of the scratch memory, one per table slot from COUNT_BASE; slots beyond COUNT_SLOTS are not counted. Scratch for natives starts after them. */
export const COUNT_BASE = 8, COUNT_SLOTS = 1 << 20;
/** A word of the scratch memory that, while set, makes a first-tier method trap as it is entered: World.warm calls methods to have the engine compile them. */
export const WARM_AT = 0;
/** The weight of the frames a stack may hold, counted by the methods that call something (compiler/method.ts): a frame weighs 4 plus its Wasm locals, which is
 *  its size in the engine's baseline code to within 10% (8,700 frames of 1 parameter (weight 11) or 2,030 of 10 parameters and 20 locals (weight 53) fill node's 984 KB stack: about 100,000).
 *  V8 does not let Wasm catch its own stack overflow, so a Java handler for StackOverflowError sees only the one this limit throws; the limit is half of what
 *  the stack holds, and an overflow it still hits is turned into the error at the edge of the Java world (World.boundary) */
export const MAX_DEPTH = 56000, SOE_HEADROOM = 2000;
/** the weight of the frames a method may leave out of the depth when it calls only methods that leave theirs out (method.ts) */
export const MAX_UNCOUNTED = 512;
/** the weight a thrower adds to the depth, which the handler that catches the exception restores: the frames it builds the exception with may be uncounted */
const THROWER_WEIGHT = MAX_UNCOUNTED;
/** bytes allocated between two heap checks; allocation counts up to zero from -ALLOC_WINDOW */
export const ALLOC_WINDOW = 8 << 20;

/** Table slots that hold the throwers, bound once the runtime starts; each is a lazy-link stub until first used. */
export const SLOT = { npe: 1, aioobe: 2, arith: 3, cce: 4, nase: 5, oom: 6, ule: 7, soe: 8, sioobe: 9, copy: 10, ase: 11, ame: 12, asx: 13, inste: 14, nsfe: 15, ncdfe: 16, recv: 17, iacc: 18, ftm: 19, fin: 20, ncdfr: 21, nsme: 22, nsfer: 23, icce: 24, ie: 25, imse: 26, nbs: 27, iaet: 28, iarg: 29, iarity: 30 } as const;
export type Thrower = keyof typeof SLOT;
export const FIRST_FREE_SLOT = 31;
/** a class's init word: 0 not started, (strand << 2 | 1) running on that strand, then done or failed (JLS 12.4.2) */
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
  ie: { cls: L + "InterruptedException", params: [] },
  imse: { cls: L + "IllegalMonitorStateException", params: [] },
  nbs: { cls: L + "IllegalStateException", params: [] },                         // a blocking operation on a stack that cannot suspend (a plain entry from the host)
  iaet: { cls: L + "IllegalArgumentException", params: ["I"] },                  // a timeout: 0 negative, 1 nanoseconds out of range
  iarg: { cls: L + "IllegalArgumentException", params: ["I", "I", "I"] },        // Method.invoke: argument index, class id of the parameter type, class id of the value (-1: null)
  iarity: { cls: L + "IllegalArgumentException", params: ["I", "I"] },           // Method.invoke: parameters expected, arguments given
};

const dotted = (n: string) => n.replace(/\//g, ".");
/** a class name as java.lang.Class.getTypeName prints it */
const pretty = (n: string): string => prettyType(n[0] === "#" ? n[1] : n[0] === "[" ? n : `L${n};`);
/** The message ART gives the exception (null: none). `a` and `b` are the thrower's arguments, a wide one split into halves. */
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
    case SLOT.ule: return linkMessage(-1);
    case SLOT.nbs: return "blocking operation on a stack that cannot suspend";
    case SLOT.iarg: return `argument ${a + 1} should have type ${pretty(className(b))}, got ${c < 0 ? "null" : pretty(className(c))}`;
    case SLOT.iarity: return `Wrong number of arguments; expected ${a}, got ${b}`;
    case SLOT.iaet: return a ? "nanosecond timeout value out of range" : "timeout value is negative";
    case SLOT.sioobe: return `offset ${a}, count ${b}, length ${c}`;
    case SLOT.copy: return `src.length=${a} srcPos=${b} dst.length=${c} dstPos=${d} length=${e}`;
    case SLOT.asx: return `${pretty(className(a))} cannot be stored in an array of type ${pretty(className(b))}`;
    case SLOT.oom: return oomMessage((BigInt(b) << 32n) | BigInt(a >>> 0));
    default: return null;
  }
}

/** The body of thrower `name`: allocate its exception, run the no-argument constructor, store the message the host computes
 *  (`excMessage`) in Throwable.detailMessage, throw. */
export function throwerBody(cx: Compiler, c: Code, name: Thrower): void {
  const { cls, params } = THROWERS[name], n = params.length;
  // the error is made by Java code, which needs frames of its own
  const depth = cx.global("rt", "depth", T.i32, true);
  if (name === "soe") c.i32(MAX_DEPTH - SOE_HEADROOM).gset(depth);
  else {
    // methods that call nothing but others like them do not count their frames, so what constructs an exception does, or an exception whose construction throws would recurse unbounded
    c.gget(depth).i32(MAX_DEPTH).raw(OP.i32_ge_s).if_(); cx.callThrower(c, "soe"); c.end();
    c.gget(depth).i32(THROWER_WEIGHT).raw(OP.i32_add).gset(depth);
  }
  cx.emitEnsure(c, cls);
  const exn = c.newLocal(T.anyref), msg = c.newLocal(T.externref);
  cx.emitNew(c, cls); c.lset(exn);
  const ctor = cx.prog.resolve(cls, "<init>", "()V");
  if (ctor?.codeOff) { c.lget(exn); cx.callMethod(c, ctor); }
  c.i32(SLOT[name]);
  if (params[0] === "J") c.lget(0).raw(OP.i32_wrap_i64).lget(0).i64(32n).raw(OP.i64_shr_u, OP.i32_wrap_i64).i32(0).i32(0).i32(0);
  else for (let i = 0; i < 5; i++) i < n ? c.lget(i) : c.i32(0);
  c.call(cx.imp.excMessage).lset(msg);
  const detail = cx.prog.resolveField("java/lang/Throwable", "detailMessage", "Ljava/lang/String;"), st = cx.structFor("java/lang/Throwable");
  if (detail && !detail.isStatic) { c.lget(exn).refCast(st).lget(msg); cx.str.fromHost(c); c.structSet(st, cx.fieldIndex("java/lang/Throwable", detail)); }
  c.lget(exn).throw_(cx.tag);
}

export interface JavaFrame { cls: string; method: string; line: number; pc: number }
/** a Wasm frame: a module made from bytes is wasm://wasm/<hash>, one compiled from a streamed response is named by the response's URL */
const FRAME = /at (?:(.+?) \()?(?:wasm:\/\/wasm\/[0-9a-f]+|\S+?):wasm-function\[\d+\]:0x([0-9a-f]+)\)?\s*$/;
const WEBKIT_FRAME = /^(.*?)@wasm-function\[\d+\]$/;
const wasmFrame = (line: string) => FRAME.exec(line) ?? WEBKIT_FRAME.exec(line);
/** the names of the Wasm functions on an engine stack, innermost first */
export const wasmFrameNames = (stack: string): string[] => stack.split("\n").flatMap((line) => { const name = wasmFrame(line)?.[1]; return name ? [name] : []; });
/** Java frames, innermost first. WebKit names functions but does not report module offsets. */
export function javaFrames(stack: string, traces: Pick<Map<string, FnTrace>, "get">, count = Infinity, lines = true): JavaFrame[] {
  const out: JavaFrame[] = [];
  let chunk: string | undefined;
  for (const line of stack.split("\n")) {
    if (out.length >= count) break;
    const m = wasmFrame(line);
    const name = m?.[1], exact = name ? traces.get(name) : undefined;
    const loop = exact ? -1 : name?.lastIndexOf("#loop") ?? -1;
    const t = exact ?? (name && loop >= 0 ? traces.get(name.slice(0, loop)) : undefined);
    if (!t?.m) continue;                                  // host code, throwers and stubs are not Java frames
    const id = t.m.cls + "." + t.m.key;
    // An outlined loop and its callers are one Java activation; keep the innermost PC.
    if (chunk === id) { chunk = loop >= 0 ? id : undefined; continue; }
    chunk = loop >= 0 ? id : undefined;
    const off = m![2] === undefined ? undefined : parseInt(m![2], 16);
    let lo = 0, hi = t.offsets.length - 1, at = -1;       // last mark at or before the frame's offset
    if (off !== undefined) while (lo <= hi) { const mid = (lo + hi) >> 1; if (t.offsets[mid] <= off) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    const pc = off === undefined ? -1 : at < 0 ? 0 : t.pcs[at];
    out.push({ cls: dotted(t.m.cls), method: t.m.name, pc, line: lines && t.m.codeOff && pc >= 0 ? t.m.dex.lineAt(t.m.codeOff, pc) : -1 });
  }
  return out;
}

let named: boolean | undefined;
/** whether the engine's `Error.stack` identifies Wasm frames */
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
