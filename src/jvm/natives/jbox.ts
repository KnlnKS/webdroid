// java.lang's boxes run from libcore. TS makes and reads them through these helpers, over each
// class's own `value` field; §4.7 intrinsics box and unbox, and format and parse integers.
import { mangleField, mangleStaticField, doubleToLongBits, floatToIntBits, intBitsToFloat, longBitsToDouble } from "../abi";
import { rt, type ClassInfo, type Intrinsic } from "../runtime";

type Obj = Record<string, any>;
export type BoxDesc = "I" | "J" | "F" | "D" | "Z" | "C" | "B" | "S";
const CLASS: Record<BoxDesc, string> = {
  I: "java/lang/Integer", J: "java/lang/Long", F: "java/lang/Float", D: "java/lang/Double",
  Z: "java/lang/Boolean", C: "java/lang/Character", B: "java/lang/Byte", S: "java/lang/Short",
};
const DESC = new Map(Object.entries(CLASS).map(([d, c]) => [c, d as BoxDesc]));
const VALUE = Object.fromEntries(Object.entries(CLASS).map(([d, c]) => [d, mangleField(c, "value")])) as Record<BoxDesc, string>;

/** the primitive descriptor of a box, null for anything else */
export function boxDesc(o: unknown): BoxDesc | null {
  if (typeof o !== "object" || o === null) return null;
  return DESC.get((o.constructor as { $i?: ClassInfo }).$i?.name ?? "") ?? null;
}
/** a box's primitive value (a Boolean's as 0/1), undefined for anything else */
export function unbox(o: unknown): number | bigint | undefined {
  const d = boxDesc(o);
  return d === null ? undefined : (o as Obj)[VALUE[d]];
}
/** a box's primitive value if it is a `desc` box, else `fallback` */
export function unboxAs<T>(o: unknown, desc: BoxDesc, fallback: T): number | bigint | T {
  return boxDesc(o) === desc ? (o as Obj)[VALUE[desc]] : fallback;
}

// The small values valueOf shares, from each class's cache once it has initialized (AOSP's
// valueOf initializes it; before that a box is made fresh, as `new Integer(v)` would make it).
const CACHE: Partial<Record<BoxDesc, [cls: string, lo: number, hi: number]>> = {
  I: ["java/lang/Integer$IntegerCache", -128, 127], J: ["java/lang/Long$LongCache", -128, 127],
  S: ["java/lang/Short$ShortCache", -128, 127], B: ["java/lang/Byte$ByteCache", -128, 127],
  C: ["java/lang/Character$CharacterCache", 0, 127],
};
const CACHE_FIELD = mangleStaticField("cache");
const caches: Partial<Record<BoxDesc, Obj[]>> = {};
function cacheOf(desc: BoxDesc): Obj[] | undefined {
  const known = caches[desc];
  if (known) return known;
  const info = rt.link(CACHE[desc]![0]);
  if (info.state === 2) return caches[desc] = info.ctor[CACHE_FIELD];
  return undefined;
}
const ctors: Partial<Record<BoxDesc, new () => Obj>> = {};
function ctorOf(desc: BoxDesc): new () => Obj {
  const known = ctors[desc];
  if (known) return known;
  const info = rt.link(CLASS[desc]);
  rt.ensureCompiled(info);
  return ctors[desc] = info.ctor;
}
let booleans: [Obj, Obj] | null = null;
/** Boolean.FALSE and TRUE: Boolean's initializer only makes them */
function booleanValues(): [Obj, Obj] {
  if (booleans) return booleans;
  const info = rt.link(CLASS.Z);
  if (rt.initClass(info)) throw new Error("java.lang.Boolean did not initialize synchronously");
  return booleans = [info.ctor[mangleStaticField("FALSE")], info.ctor[mangleStaticField("TRUE")]];
}

/** the box `valueOf(v)` of the `desc` class gives */
export function box(desc: BoxDesc, v: number | bigint | boolean): Obj {
  if (desc === "Z") return booleanValues()[v ? 1 : 0];
  const range = CACHE[desc];
  if (range && Number(v) >= range[1] && Number(v) <= range[2]) {
    const cache = cacheOf(desc);
    if (cache) return cache[Number(v) - range[1]];
  }
  const o = new (ctorOf(desc))();
  o[VALUE[desc]] = v;
  return o;
}
export const boxInt = (v: number) => box("I", v);
export const boxLong = (v: bigint) => box("J", v);
export const boxFloat = (v: number) => box("F", v);
export const boxDouble = (v: number) => box("D", v);
export const boxBool = (v: number | boolean) => box("Z", v);
export const boxChar = (v: number) => box("C", v);
/** A primitive read out of an Object-typed slot. A bare JS number has no toString()/hashCode()
 *  for the caller, and the slot lost the declared width, so the value's own shape names it. */
export function boxObject(v: unknown): unknown {
  if (typeof v === "number") return Number.isInteger(v) ? boxInt(v) : boxDouble(v);
  if (typeof v === "bigint") return boxLong(v);
  return v;
}

// §4.7 intrinsics, each compiled with its fields' own names ($I is Integer.value, ...): a named
// load stays monomorphic where a keyed one would not.
const compile = (params: string, body: string, env: Record<string, unknown> = {}): Intrinsic => (base) =>
  new Function("base", ...Object.keys(env), `return function(${params}){${body.replace(/\$([IJFDZCBS])\b/g, (_, d: BoxDesc) => VALUE[d])}}`)(base, ...Object.values(env));

/** valueOf: the cache's box, else a new one; a cache not initialized yet is AOSP's to initialize.
 *  The constructor is bound when the class compiles: one looked up lazily is not a constant to
 *  V8, which then allocates every box instead of eliding the short-lived ones. */
const valueOf = (desc: BoxDesc): Intrinsic => (base) => {
  const range = CACHE[desc], C = rt.link(CLASS[desc]).ctor, make = `const o = new C(); o.$${desc} = v; return o;`;
  if (!range) return compile("v", make, { C })(base);
  const [, lo, hi] = range, suffix = desc === "J" ? "n" : "";
  let cache: Obj[] | undefined;
  const cached = (v: number | bigint) => (cache ??= cacheOf(desc)) === undefined ? base(v) : cache[Number(v) - lo];
  return compile("v", `if (v >= ${lo}${suffix} && v <= ${hi}${suffix}) return cached(v); ${make}`, { C, cached })(base);
};
const getter = (desc: BoxDesc) => compile("", `return this.$${desc};`);
/** equals of a final class: the same class and value (a null or other object is not equal) */
const equals = (desc: BoxDesc): Intrinsic => (base) =>
  compile("o", `return o instanceof C && o.$${desc} === this.$${desc} ? 1 : 0;`, { C: rt.link(CLASS[desc]).ctor })(base);

/** Character.digit's ASCII part: 0-35, or -1 for anything else */
const ASCII_DIGIT = new Int8Array(128).fill(-1);
for (let c = 0; c < 128; c++) {
  if (c >= 48 && c <= 57) ASCII_DIGIT[c] = c - 48;
  else if (c >= 97 && c <= 122) ASCII_DIGIT[c] = c - 87;
  else if (c >= 65 && c <= 90) ASCII_DIGIT[c] = c - 55;
}
/** the most digits of `radix` a double holds exactly */
const EXACT_DIGITS = Array.from({ length: 37 }, (_, r) => (r < 2 ? 0 : Math.floor(53 / Math.log2(r))));
/** An ASCII number in `radix` whose magnitude a double holds exactly, as a number; undefined for
 *  anything else (null, a bad radix or digit, a lone sign, too many digits), which AOSP answers. */
function asciiNumber(s: string | null, radix: number): number | undefined {
  if (s === null || radix < 2 || radix > 36) return undefined;
  const n = s.length;
  let i = 0, neg = false;
  if (n > 0) { const c = s.charCodeAt(0); if (c === 45 || c === 43) { neg = c === 45; i = 1; } }
  if (i === n || n - i > EXACT_DIGITS[radix]) return undefined;
  let r = 0;
  for (; i < n; i++) {
    const c = s.charCodeAt(i), d = c < 128 ? ASCII_DIGIT[c] : -1;
    if (d < 0 || d >= radix) return undefined;
    r = r * radix + d;
  }
  return neg ? -r || 0 : r;
}
const radixOr10 = (r: number) => (r >= 2 && r <= 36 ? r : 10);

rt.intrinsic(CLASS.I, {
  "static valueOf(I)Ljava/lang/Integer;": valueOf("I"),
  "intValue()I": getter("I"),
  "hashCode()I": getter("I"),
  "equals(Ljava/lang/Object;)Z": equals("I"),
  "compareTo(Ljava/lang/Integer;)I": compile("o", "const a = this.$I, b = o.$I; return a < b ? -1 : a > b ? 1 : 0;"),
  "static toString(I)Ljava/lang/String;": () => (i: number) => "" + i,
  "static toString(II)Ljava/lang/String;": () => (i: number, radix: number) => i.toString(radixOr10(radix)),
  "static toHexString(I)Ljava/lang/String;": () => (i: number) => (i >>> 0).toString(16),
  "static toOctalString(I)Ljava/lang/String;": () => (i: number) => (i >>> 0).toString(8),
  "static toBinaryString(I)Ljava/lang/String;": () => (i: number) => (i >>> 0).toString(2),
  "static parseInt(Ljava/lang/String;I)I": (base) => (s: string | null, radix: number) => {
    const v = asciiNumber(s, radix);
    return v !== undefined && v >= -2147483648 && v <= 2147483647 ? v : base(s, radix);
  },
});
rt.intrinsic(CLASS.J, {
  "static valueOf(J)Ljava/lang/Long;": valueOf("J"),
  "longValue()J": getter("J"),
  "equals(Ljava/lang/Object;)Z": equals("J"),
  "static toString(J)Ljava/lang/String;": () => (v: bigint) => "" + v,
  "static toString(JI)Ljava/lang/String;": () => (v: bigint, radix: number) => v.toString(radixOr10(radix)),
  "static toHexString(J)Ljava/lang/String;": () => (v: bigint) => BigInt.asUintN(64, v).toString(16),
  "static parseLong(Ljava/lang/String;I)J": (base) => (s: string | null, radix: number) => {
    const v = asciiNumber(s, radix);
    return v !== undefined ? BigInt(v) : base(s, radix);
  },
});
rt.intrinsic(CLASS.Z, {
  "static valueOf(Z)Ljava/lang/Boolean;": () => (v: number) => booleanValues()[v],
  "booleanValue()Z": getter("Z"),
});
rt.intrinsic(CLASS.S, { "static valueOf(S)Ljava/lang/Short;": valueOf("S") });
rt.intrinsic(CLASS.B, { "static valueOf(B)Ljava/lang/Byte;": valueOf("B") });
rt.intrinsic(CLASS.C, { "static valueOf(C)Ljava/lang/Character;": valueOf("C"), "charValue()C": getter("C"), "equals(Ljava/lang/Object;)Z": equals("C") });
rt.intrinsic(CLASS.F, { "static valueOf(F)Ljava/lang/Float;": valueOf("F"), "floatValue()F": getter("F") });
rt.intrinsic(CLASS.D, { "static valueOf(D)Ljava/lang/Double;": valueOf("D"), "doubleValue()D": getter("D") });

// the raw bit conversions ART implements natively
rt.registerJnis(CLASS.F, { "floatToRawIntBits(F)I": floatToIntBits, "intBitsToFloat(I)F": intBitsToFloat });
rt.registerJnis(CLASS.D, { "doubleToRawLongBits(D)J": doubleToLongBits, "longBitsToDouble(J)D": longBitsToDouble });
