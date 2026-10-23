import { PRIMS } from "../../jvm/abi.ts";

export const H = { ID: 0, DEPTH: 1, DISPLAY: 2, MAXD: 12, EXTRA: 14, IMT: 15, IMT_N: 16, VTAB: 47 };
/** an array class's display holds only Object and itself, so the words after them describe its elements: the component class id, and how a
 *  value is tested against it: depth + 1 for a class within the display, ELEM_IFACE for an interface or a class beyond it, ELEM_OTHER otherwise */
export const ELEM = H.DISPLAY + 2, ELEM_KIND = H.DISPLAY + 3, ELEM_IFACE = -2, ELEM_OTHER = -1;
export type ElemKind = "i8" | "i16" | "i32" | "i64" | "ref";
/** every element kind, in the order a runtime type test tries an array against them */
export const ELEM_KINDS: readonly ElemKind[] = ["i32", "ref", "i8", "i16", "i64"];
const OF_SIZE: Record<number, ElemKind> = { 1: "i8", 2: "i16", 4: "i32", 8: "i64" };
/** element storage kind of an array descriptor like "[I" */
export const elemKindOf = (desc: string): ElemKind => { const p = PRIMS[desc[1]]; return p ? OF_SIZE[p.size] : "ref"; };
export function f32bits(x: number): number { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return b.getInt32(0, true); }
export function f64bits(x: number): bigint { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigInt64(0, true); }
/** java.lang.Math's transcendental natives, by arity: the host's Math, imported as they are rather than wrapped as natives */
export const MATH_ARITY = { acos: 1, asin: 1, atan: 1, cbrt: 1, cos: 1, cosh: 1, exp: 1, expm1: 1, log: 1, log10: 1, log1p: 1, sin: 1, sinh: 1, tan: 1, tanh: 1,
  atan2: 2, hypot: 2, pow: 2 } as const;

// the runtime's budgets and the layout of the scratch memory, shared by compiled code and the host
/** calls and loop iterations a method runs as first-tier code before it is recompiled (Tiering.upgrade) */
export const HOT_BUDGET = 5000;
/** The counters of first-tier methods are words of the scratch memory, one per table slot from COUNT_BASE; slots beyond COUNT_SLOTS are not counted. */
export const COUNT_BASE = 8, COUNT_SLOTS = 1 << 20;
/** The call-site sketch (profile.ts) follows the counters; a first-tier activation records its call targets when its count is 1 modulo SAMPLE_EVERY. */
export const PROFILE_BASE = COUNT_BASE + 4 * COUNT_SLOTS, PROFILE_ROWS = 1 << 14, PROFILE_WORDS = 6, SAMPLE_EVERY = 64;
/** A fixed window the host bridge copies arrays through: growing memory during a native would detach its argument views. Native scratch follows. */
export const TRANSFER_BASE = PROFILE_BASE + 4 * PROFILE_ROWS * PROFILE_WORDS, TRANSFER_BYTES = 1 << 18, SCRATCH_BASE = TRANSFER_BASE + TRANSFER_BYTES;
/** A word of the scratch memory that, while set, makes a first-tier method return zero as it is entered: the warm Worker calls methods to have the engine compile them (warmshim.ts) and the burner
 *  to have it optimize them (burn.ts). */
export const WARM_AT = 0;
/** The weight of the frames a stack may hold, counted by the methods that call something (compiler/method.ts): a frame weighs 4 plus its Wasm locals, which is
 *  its size in the engine's baseline code to within 10% (8,700 frames of 1 parameter (weight 11) or 2,030 of 10 parameters and 20 locals (weight 53) fill node's 984 KB stack: about 100,000).
 *  V8 does not let Wasm catch its own stack overflow, so a Java handler for StackOverflowError sees only the one this limit throws; the limit is half of what
 *  the stack holds, and an overflow it still hits is turned into the error at the edge of the Java world (World.boundary) */
export const MAX_DEPTH = 56000, SOE_HEADROOM = 2000;
/** the weight of the frames a method may leave out of the depth when it calls only methods that leave theirs out (method.ts) */
export const MAX_UNCOUNTED = 512;
/** bytes allocated between two heap checks; allocation counts up to zero from -ALLOC_WINDOW */
export const ALLOC_WINDOW = 8 << 20;
/** a class's init word: 0 not started, (strand << 2 | 1) running on that strand, then done or failed (JLS 12.4.2) */
export const INIT_DONE = 2, INIT_FAILED = 3;
/** loop iterations of one activation between two chances for another strand to run (a power of two) */
export const FUEL = 4096;
