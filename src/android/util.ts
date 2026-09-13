// android.util.* natives: Log, the sparse arrays, StateSet, Property, DisplayMetrics, LruCache,
// TypedValue, Size, FloatMath and JsonReader.

import { rt, JObj, type NativeSpec, stubs, noops } from "../jvm/runtime";
import { intBitsToFloat, mangleStaticField } from "../jvm/abi";
import { device } from "../shell/config";
import { vcall, JEnum, linkInit } from "../jvm/natives/jlang";
import { PATTERNS } from "./pattern-data";

rt.register({
  name: "android/util/Patterns", ctor: class extends JObj {},
  statics: Object.fromEntries(Object.keys(PATTERNS).map((name) => [name, null])),
  clinit: async () => {
    const cls = rt.link("android/util/Patterns").ctor;
    const pattern = (await linkInit("java/util/regex/Pattern")).ctor;
    for (const [name, source] of Object.entries(PATTERNS)) {
      Reflect.set(cls, mangleStaticField(name), await vcall(pattern, "compile", "(Ljava/lang/String;)Ljava/util/regex/Pattern;", source));
    }
  },
});

class JLog extends JObj {}
const logFn = (lvl: string) => (tag: string, msg: string, tr?: unknown) => {
  const t = tr as { msg?: string; jsStack?: string; stack?: string } | undefined;
  console.log(`[${lvl}/${tag}]`, msg, tr ? `(${t?.msg ?? tr})` : "", t?.jsStack ?? t?.stack ?? "");
  return 0;
};
rt.register({
  name: "android/util/Log", ctor: JLog,
  statics: { VERBOSE: 2, DEBUG: 3, INFO: 4, WARN: 5, ERROR: 6, ASSERT: 7 },
  methods: {
    ...Object.fromEntries(["v", "d", "i", "w", "e"].flatMap((l) => [
      [`static ${l}(Ljava/lang/String;Ljava/lang/String;)I`, logFn(l.toUpperCase())],
      [`static ${l}(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I`, logFn(l.toUpperCase())],
    ])),
    "static w(Ljava/lang/String;Ljava/lang/Throwable;)I": (tag: string, tr: unknown) => logFn("W")(tag, String((tr as any)?.msg ?? tr)),
    "static wtf(Ljava/lang/String;Ljava/lang/String;)I": logFn("WTF"),
    "static isLoggable(Ljava/lang/String;I)Z": () => 0,
    "static getStackTraceString(Ljava/lang/Throwable;)Ljava/lang/String;": (t: unknown) => String((t as any)?.msg ?? t ?? ""),
    "static println(ILjava/lang/String;Ljava/lang/String;)I": (p: number, tag: string, msg: string) => logFn("P")(tag, msg),
  },
});

class JSparseArray extends JObj {
  m = new Map<number | bigint, unknown>();
  sorted: (number | bigint)[] | null = null;
  /** keys in index order (Android keeps them sorted ascending) */
  keys(): (number | bigint)[] { return this.sorted ??= [...this.m.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0); }
  set(k: number | bigint, v: unknown) { if (!this.m.has(k)) this.sorted = null; this.m.set(k, v); }
  del(k: number | bigint) { if (this.m.delete(k)) this.sorted = null; }
  reset() { this.m.clear(); this.sorted = null; }
}
const sparseMethods = (valDesc: string, dflt: unknown, cls = "android/util/SparseArray", key = "I"): NativeSpec["methods"] => ({
  "<init>()V": function () {},
  [`clone()L${cls};`]: function (this: JSparseArray) { const c = new (this.constructor as new () => JSparseArray)(); for (const [k, v] of this.m) c.set(k, v); return c; },
  "<init>(I)V": function () {},
  [`get(${key})${valDesc}`]: function (this: JSparseArray, k: number | bigint) { return this.m.get(k) ?? dflt; },
  [`get(${key}${valDesc})${valDesc}`]: function (this: JSparseArray, k: number | bigint, d: unknown) { return this.m.has(k) ? this.m.get(k) : d; },
  [`put(${key}${valDesc})V`]: function (this: JSparseArray, k: number | bigint, v: unknown) { this.set(k, v); },
  [`append(${key}${valDesc})V`]: function (this: JSparseArray, k: number | bigint, v: unknown) { this.set(k, v); },
  "size()I": function (this: JSparseArray) { return this.m.size; },
  [`keyAt(I)${key}`]: function (this: JSparseArray, i: number) { return this.keys()[i]; },
  [`valueAt(I)${valDesc}`]: function (this: JSparseArray, i: number) { return this.m.get(this.keys()[i]) ?? dflt; },
  [`delete(${key})V`]: function (this: JSparseArray, k: number | bigint) { this.del(k); },
  [`remove(${key})V`]: function (this: JSparseArray, k: number | bigint) { this.del(k); },
  "removeAt(I)V": function (this: JSparseArray, i: number) { this.del(this.keys()[i]); },
  "clear()V": function (this: JSparseArray) { this.reset(); },
  [`indexOfKey(${key})I`]: function (this: JSparseArray, k: number | bigint) { const keys = this.keys(); let lo = 0, hi = keys.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (keys[mid] < k) lo = mid + 1; else hi = mid; } return keys[lo] === k ? lo : ~lo; },
  [`indexOfValue(${valDesc})I`]: function (this: JSparseArray, v: unknown) { return this.keys().findIndex(k => this.m.get(k) === v); },
});
rt.register({ name: "android/util/SparseArray", ctor: JSparseArray, methods: sparseMethods("Ljava/lang/Object;", null) });
rt.register({ name: "android/util/SparseIntArray", ctor: class extends JSparseArray {}, methods: sparseMethods("I", 0, "android/util/SparseIntArray") });
rt.register({ name: "android/util/SparseBooleanArray", ctor: class extends JSparseArray {}, methods: sparseMethods("Z", 0, "android/util/SparseBooleanArray") });
rt.register({ name: "android/util/SparseLongArray", ctor: class extends JSparseArray {}, methods: sparseMethods("J", 0n, "android/util/SparseLongArray") });
rt.register({ name: "android/util/LongSparseArray", ctor: class extends JSparseArray {},
  methods: sparseMethods("Ljava/lang/Object;", null, "android/util/LongSparseArray", "J") });

// android.util.StateSet: a spec lists the state ids a drawable/color entry needs (negative =
// must be absent), 0 terminates either array; both wildcards are answered by the constants.
const isWild = (s: Int32Array) => s.length === 0 || s[0] === 0;
export function stateSetMatches(spec: Int32Array | null, set: ArrayLike<number> | null): boolean {
  if (set === null) return spec === null || isWild(spec);
  for (let i = 0; i < spec!.length; i++) {
    let want = spec![i];
    if (want === 0) return true;
    const must = want > 0;
    if (!must) want = -want;
    let found = false;
    for (let j = 0; j < set.length; j++) {
      const st = set[j];
      if (st === 0) { if (must) return false; break; }
      if (st === want) { if (!must) return false; found = true; break; }
    }
    if (must && !found) return false;
  }
  return true;
}
rt.register({
  name: "android/util/StateSet", ctor: class extends JObj {},
  statics: { WILD_CARD: new Int32Array(0), NOTHING: Int32Array.of(0) },
  methods: {
    "static isWildCard([I)Z": (s: Int32Array) => isWild(s) ? 1 : 0,
    "static stateSetMatches([I[I)Z": (spec: Int32Array, set: Int32Array | null) => stateSetMatches(spec, set) ? 1 : 0,
    "static stateSetMatches([II)Z": (spec: Int32Array, state: number) => {
      for (let i = 0; i < spec.length; i++) {
        const want = spec[i];
        if (want === 0) return 1;
        if (want > 0 ? state !== want : state === -want) return 0;
      }
      return 1;
    },
    "static trimStateSet([II)[I": (s: Int32Array, n: number) => s.length === n ? s : s.slice(0, n),
    "static dump([I)Ljava/lang/String;": (s: Int32Array) => Array.from(s, (v) => v.toString(16)).join(" "),
  },
});

class JPair extends JObj { first: unknown = null; second: unknown = null; }
rt.register({
  name: "android/util/Pair", ctor: JPair,
  fields: ["first", "second"],
  methods: {
    "<init>(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JPair, a: unknown, b: unknown) { this.first = a; this.second = b; },
    "static create(Ljava/lang/Object;Ljava/lang/Object;)Landroid/util/Pair;": (a: unknown, b: unknown) => {
      const p = new JPair(); p.first = a; p.second = b; return p;
    },
  },
});

// ── android.util.Property / IntProperty / FloatProperty: abstract get/set handles that
// ObjectAnimator drives. The primitive subclasses unbox into the app's setValue override.
class JProperty extends JObj { type: unknown = null; name = ""; }
rt.register({
  name: "android/util/Property", ctor: JProperty,
  methods: {
    "<init>(Ljava/lang/Class;Ljava/lang/String;)V": function (this: JProperty, t: unknown, n: string) { this.type = t; this.name = n; },
    "getName()Ljava/lang/String;": function (this: JProperty) { return this.name; },
    "getType()Ljava/lang/Class;": function (this: JProperty) { return this.type; },
    "isReadOnly()Z": () => 0,
    "set(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JProperty) {
      throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Property " + this.name + " is read-only");
    },
  },
});
for (const [name, desc, cls, unbox] of [
  ["android/util/IntProperty", "(Ljava/lang/Object;I)V", "java/lang/Integer", (v: any) => v?.v | 0],
  ["android/util/FloatProperty", "(Ljava/lang/Object;F)V", "java/lang/Float", (v: any) => Math.fround(v?.v ?? 0)],
] as const) {
  rt.register({
    name, ctor: class extends JProperty {}, sup: "android/util/Property",
    methods: {
      "<init>(Ljava/lang/String;)V": function (this: JProperty, n: string) { this.type = rt.classFor(cls); this.name = n; },
      "set(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JProperty, o: unknown, v: unknown) { return vcall(this, "setValue", desc, o, unbox(v)); },
    },
  });
}

export class JDisplayMetrics extends JObj {
  density = device.density; densityDpi = device.densityDpi; scaledDensity = device.density;
  widthPixels = device.width; heightPixels = device.height;
  xdpi = device.densityDpi; ydpi = device.densityDpi;
}
rt.register({
  name: "android/util/DisplayMetrics", ctor: JDisplayMetrics,
  statics: { DENSITY_DEFAULT: 160 },
  fields: ["density", "densityDpi", "scaledDensity", "widthPixels", "heightPixels", "xdpi", "ydpi"],
  methods: { "<init>()V": function () {}, "setTo(Landroid/util/DisplayMetrics;)V": function (this: JDisplayMetrics, o: JDisplayMetrics) { Object.assign(this, o); } },
});

class JLruCache extends JObj {
  max = 16; m = new Map<unknown, unknown>();
}
rt.register({
  name: "android/util/LruCache", ctor: JLruCache,
  methods: {
    "<init>(I)V": function (this: JLruCache, n: number) { this.max = Math.max(1, n); },
    "get(Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JLruCache, k: unknown) {
      if (this.m.has(k)) {
        const v = this.m.get(k);
        this.m.delete(k); this.m.set(k, v);   // re-insert: Map order is the recency order
        return v;
      }
      const created = await vcall(this, "create", "(Ljava/lang/Object;)Ljava/lang/Object;", k);
      if (created !== null) this.m.set(k, created);
      return created;
    },
    "create(Ljava/lang/Object;)Ljava/lang/Object;": () => null,
    "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function (this: JLruCache, k: unknown, v: unknown) {
      const old = this.m.get(k) ?? null;
      this.m.set(k, v);
      if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
      return old;
    },
    "remove(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JLruCache, k: unknown) {
      const old = this.m.get(k) ?? null;
      this.m.delete(k);
      return old;
    },
    "evictAll()V": function (this: JLruCache) { this.m.clear(); },
    "size()I": function (this: JLruCache) { return this.m.size; },
    "maxSize()I": function (this: JLruCache) { return this.max; },
  },
});

// android.util.TypedValue — real impl lives with res.ts; register constants here
export class JTypedValue extends JObj {
  type = 0; data = 0; resourceId = 0; string: string | null = null; density = 0;
  assetCookie = 0;            // set to 1 by fillTypedValue: the app apk is our only asset path
  changingConfigurations = 0; // resources resolve against one fixed config, so nothing varies
}
rt.register({
  name: "android/util/TypedValue", ctor: JTypedValue,
  statics: {
    TYPE_NULL: 0, TYPE_REFERENCE: 1, TYPE_ATTRIBUTE: 2, TYPE_STRING: 3, TYPE_FLOAT: 4,
    TYPE_DIMENSION: 5, TYPE_FRACTION: 6, TYPE_FIRST_INT: 16, TYPE_INT_DEC: 16, TYPE_INT_HEX: 17,
    TYPE_INT_BOOLEAN: 18, TYPE_FIRST_COLOR_INT: 28, TYPE_INT_COLOR_ARGB8: 28, TYPE_INT_COLOR_RGB8: 29,
    TYPE_INT_COLOR_ARGB4: 30, TYPE_INT_COLOR_RGB4: 31, TYPE_LAST_COLOR_INT: 31, TYPE_LAST_INT: 31,
    COMPLEX_UNIT_PX: 0, COMPLEX_UNIT_DIP: 1, COMPLEX_UNIT_SP: 2, COMPLEX_UNIT_PT: 3,
    COMPLEX_UNIT_IN: 4, COMPLEX_UNIT_MM: 5,
  },
  fields: ["type", "data", "resourceId", "string", "density", "assetCookie", "changingConfigurations"],
  methods: {
    "<init>()V": function () {},
    "static complexToDimensionPixelSize(ILandroid/util/DisplayMetrics;)I": (data: number, dm: JDisplayMetrics) => {
      return Math.round(complexToPx(data, dm));
    },
    "getComplexUnit()I": function (this: JTypedValue) { return this.data & 15; },
    "static complexToDimension(ILandroid/util/DisplayMetrics;)F": (data: number, dm: JDisplayMetrics) => complexToPx(data, dm),
    "static complexToDimensionPixelOffset(ILandroid/util/DisplayMetrics;)I": (data: number, dm: JDisplayMetrics) => rt.f2i(complexToPx(data, dm)),
    "static applyDimension(IFLandroid/util/DisplayMetrics;)F": (unit: number, v: number, dm: JDisplayMetrics) => {
      switch (unit) {
        case 1: return v * dm.density;
        case 2: return v * dm.scaledDensity;
        default: return v;
      }
    },
    "getDimension(Landroid/util/DisplayMetrics;)F": function (this: JTypedValue, dm: JDisplayMetrics) {
      return complexToPx(this.data, dm);
    },
    "getFloat()F": function (this: JTypedValue) { return intBitsToFloat(this.data); },
    // COMPLEX_UNIT_FRACTION scales the base, FRACTION_PARENT the parent's base
    "getFraction(FF)F": function (this: JTypedValue, base: number, pbase: number) {
      return complexToFraction(this.data, base, pbase);
    },
    "static complexToFraction(IFF)F": (data: number, base: number, pbase: number) =>
      complexToFraction(data, base, pbase),
    "static complexToFloat(I)F": (data: number) => complexToPx(data & ~0xf, NO_DM),
  },
});
export function complexToFraction(data: number, base: number, pbase: number): number {
  const unit = data & 0xf;
  return unit > 1 ? 0 : complexToPx(data & ~0xf, NO_DM) * (unit === 0 ? base : pbase);
}
const NO_DM = { density: 1, scaledDensity: 1 };
const RADIX_MULT = [2 ** -8, 2 ** -15, 2 ** -23, 2 ** -31];
export function complexToPx(data: number, dm: { density: number; scaledDensity: number }): number {
  const unit = data & 0xf;
  const mantissa = (data & 0xffffff00) | 0; // signed
  const mult = RADIX_MULT[(data >> 4) & 3];
  const v = mantissa * mult;
  switch (unit) {
    case 0: return v;                      // px
    case 1: return v * dm.density;         // dip
    case 2: return v * dm.scaledDensity;   // sp
    case 3: return v * dm.density * 160 / 72; // pt
    case 4: return v * dm.density * 160;   // in
    case 5: return v * dm.density * 160 / 25.4; // mm
    default: return v;
  }
}

// ── android.util.Size / SizeF — immutable value types (Bundle.putSize/getSize reference them)
for (const [n, num] of [["Size", (v: number) => v | 0], ["SizeF", (v: number) => v]] as const) {
  class JSize extends JObj { w = 0; h = 0; }
  const desc = n === "Size" ? "II" : "FF";
  rt.register({
    name: "android/util/" + n, ctor: JSize, ifaces: ["java/io/Serializable"],
    methods: {
      [`<init>(${desc})V`]: function (this: JSize, w: number, h: number) { this.w = num(w); this.h = num(h); },
      [`getWidth()${desc[0]}`]: function (this: JSize) { return this.w; },
      [`getHeight()${desc[0]}`]: function (this: JSize) { return this.h; },
      "toString()Ljava/lang/String;": function (this: JSize) { return `${this.w}x${this.h}`; },
      "equals(Ljava/lang/Object;)Z": function (this: JSize, o: JSize) {
        return o instanceof JSize && o.w === this.w && o.h === this.h ? 1 : 0;
      },
      "hashCode()I": function (this: JSize) { return (this.w * 31 + this.h) | 0; },
      [`static parse${n}(Ljava/lang/String;)Landroid/util/${n};`]: (s: string) => {
        const m = /^(-?[\d.]+)\s*[*x]\s*(-?[\d.]+)$/.exec(s ?? "");
        if (!m) throw rt.mkThrowable("java/lang/NumberFormatException", "Invalid " + n + ": " + s);
        const o = rt.make("android/util/" + n) as JSize;
        o.w = num(parseFloat(m[1])); o.h = num(parseFloat(m[2]));
        return o;
      },
    },
  });
}

// ── android.util.FloatMath — deprecated, but older game loops still link it
const fm1 = (fn: (x: number) => number) => (x: number) => Math.fround(fn(x));
const fm2 = (fn: (a: number, b: number) => number) => (a: number, b: number) => Math.fround(fn(a, b));
rt.register({
  name: "android/util/FloatMath", ctor: class extends JObj {},
  methods: {
    "static sin(F)F": fm1(Math.sin), "static cos(F)F": fm1(Math.cos), "static sqrt(F)F": fm1(Math.sqrt),
    "static floor(F)F": fm1(Math.floor), "static ceil(F)F": fm1(Math.ceil), "static exp(F)F": fm1(Math.exp),
    "static pow(FF)F": fm2(Math.pow), "static hypot(FF)F": fm2(Math.hypot),
  },
});

// ── android.util.JsonReader: the streaming pull parser Android ships. Reading the document
// through and walking the parsed value as a token stream is the same contract a strict reader
// offers, without a second hand-written JSON scanner in the tree.
class JJsonToken extends JEnum {}
const JSON_TOKENS = ["BEGIN_ARRAY", "END_ARRAY", "BEGIN_OBJECT", "END_OBJECT", "NAME",
  "STRING", "NUMBER", "BOOLEAN", "NULL", "END_DOCUMENT"];
const jsonToken: Record<string, JJsonToken> = {};
JSON_TOKENS.forEach((n, i) => { const t = new JJsonToken(); t.ename = n; t.ord = i; jsonToken[n] = t; });
rt.register({
  name: "android/util/JsonToken", ctor: JJsonToken, sup: "java/lang/Enum",
  statics: jsonToken,
  methods: {
    "static values()[Landroid/util/JsonToken;": () => JSON_TOKENS.map((n) => jsonToken[n]),
    "static valueOf(Ljava/lang/String;)Landroid/util/JsonToken;": (n: string) => jsonToken[n],
  },
});
type JsonEv = { t: string; v?: unknown };
function flattenJson(v: unknown, out: JsonEv[]) {
  if (v === null) out.push({ t: "NULL" });
  else if (Array.isArray(v)) {
    out.push({ t: "BEGIN_ARRAY" });
    for (const x of v) flattenJson(x, out);
    out.push({ t: "END_ARRAY" });
  } else if (typeof v === "object") {
    out.push({ t: "BEGIN_OBJECT" });
    for (const k of Object.keys(v as object)) { out.push({ t: "NAME", v: k }); flattenJson((v as Record<string, unknown>)[k], out); }
    out.push({ t: "END_OBJECT" });
  } else out.push({ t: typeof v === "string" ? "STRING" : typeof v === "number" ? "NUMBER" : "BOOLEAN", v });
}
class JJsonReader extends JObj {
  src: unknown = null;
  ev: JsonEv[] | null = null;
  i = 0;
}
/** the document is drained through the VIRTUAL read, so an app's own Reader subclass works */
async function jsonEvents(r: JJsonReader): Promise<JsonEv[]> {
  if (r.ev) return r.ev;
  const buf = new Uint16Array(8192);
  let s = "";
  for (;;) {
    const n = (await vcall(r.src, "read", "([CII)I", buf, 0, buf.length)) as number;
    if (n <= 0) break;
    s += String.fromCharCode(...buf.subarray(0, n));
  }
  const out: JsonEv[] = [];
  if (s.trim()) flattenJson(JSON.parse(s), out);
  out.push({ t: "END_DOCUMENT" });
  return (r.ev = out);
}
const jsonNext = async (r: JJsonReader, want?: string) => {
  const ev = await jsonEvents(r);
  const e = ev[r.i] ?? { t: "END_DOCUMENT" };
  if (want && e.t !== want) throw rt.mkThrowable("java/lang/IllegalStateException", `Expected ${want} but was ${e.t}`);
  r.i++;
  return e;
};
const jsonNum = async (r: JJsonReader) => Number((await jsonNext(r)).v);
rt.register({
  name: "android/util/JsonReader", ctor: JJsonReader, ifaces: ["java/io/Closeable"],
  methods: {
    "<init>(Ljava/io/Reader;)V": function (this: JJsonReader, r: unknown) { this.src = r; },
    "setLenient(Z)V": () => {},
    "close()V": function (this: JJsonReader) { this.ev = null; },
    "beginArray()V": function (this: JJsonReader) { return jsonNext(this, "BEGIN_ARRAY").then(() => {}); },
    "endArray()V": function (this: JJsonReader) { return jsonNext(this, "END_ARRAY").then(() => {}); },
    "beginObject()V": function (this: JJsonReader) { return jsonNext(this, "BEGIN_OBJECT").then(() => {}); },
    "endObject()V": function (this: JJsonReader) { return jsonNext(this, "END_OBJECT").then(() => {}); },
    "nextName()Ljava/lang/String;": async function (this: JJsonReader) { return (await jsonNext(this, "NAME")).v as string; },
    // AOSP coerces between the scalar types, so a number read as a string is legal and common
    "nextString()Ljava/lang/String;": async function (this: JJsonReader) { return String((await jsonNext(this)).v); },
    "nextInt()I": async function (this: JJsonReader) { return await jsonNum(this) | 0; },
    "nextLong()J": async function (this: JJsonReader) { return BigInt(Math.trunc(await jsonNum(this))); },
    "nextDouble()D": function (this: JJsonReader) { return jsonNum(this); },
    "nextBoolean()Z": async function (this: JJsonReader) { return (await jsonNext(this)).v ? 1 : 0; },
    "nextNull()V": function (this: JJsonReader) { return jsonNext(this, "NULL").then(() => {}); },
    "peek()Landroid/util/JsonToken;": async function (this: JJsonReader) {
      const ev = await jsonEvents(this);
      return jsonToken[(ev[this.i] ?? { t: "END_DOCUMENT" }).t];
    },
    "hasNext()Z": async function (this: JJsonReader) {
      const t = (await jsonEvents(this))[this.i]?.t;
      return t && t !== "END_OBJECT" && t !== "END_ARRAY" && t !== "END_DOCUMENT" ? 1 : 0;
    },
    "skipValue()V": async function (this: JJsonReader) {
      const ev = await jsonEvents(this);
      if (ev[this.i]?.t === "NAME") this.i++;
      let depth = 0;
      do {
        const t = ev[this.i++]?.t;
        if (t === "BEGIN_ARRAY" || t === "BEGIN_OBJECT") depth++;
        else if (t === "END_ARRAY" || t === "END_OBJECT") depth--;
        else if (t === undefined) break;
      } while (depth > 0);
    },
  },
});

// ── android.util.JsonWriter: the streaming writer paired with JsonReader. Text reaches the
// Writer through its VIRTUAL write so an app's own subclass sees it.
class JJsonWriter extends JObj { out: unknown = null; scopes: { array: boolean; n: number; named: boolean }[] = []; }
const JW = "Landroid/util/JsonWriter;";
/** a value or a name: separated from its predecessor by a comma, except a value after its name */
async function jsonEmit(w: JJsonWriter, s: string) {
  const top = w.scopes[w.scopes.length - 1];
  if (top && !top.named && top.n++) s = "," + s;
  if (top) top.named = false;
  await vcall(w.out, "write", "(Ljava/lang/String;)V", s);
  return w;
}
const jsonOpen = (array: boolean) => async function (this: JJsonWriter) {
  await jsonEmit(this, array ? "[" : "{");
  this.scopes.push({ array, n: 0, named: false });
  return this;
};
const jsonClose = (c: string) => async function (this: JJsonWriter) {
  this.scopes.pop();
  await vcall(this.out, "write", "(Ljava/lang/String;)V", c);
  return this;
};
const jsonValue = (f: (v: any) => string) => function (this: JJsonWriter, v: unknown) { return jsonEmit(this, f(v)); };
rt.register({
  name: "android/util/JsonWriter", ctor: JJsonWriter, ifaces: ["java/io/Closeable", "java/io/Flushable"],
  methods: {
    "<init>(Ljava/io/Writer;)V": function (this: JJsonWriter, out: unknown) { this.out = out; },
    ...noops("setIndent(Ljava/lang/String;)V", "setLenient(Z)V"),
    ...stubs(0, "isLenient()Z"),
    [`beginArray()${JW}`]: jsonOpen(true),
    [`endArray()${JW}`]: jsonClose("]"),
    [`beginObject()${JW}`]: jsonOpen(false),
    [`endObject()${JW}`]: jsonClose("}"),
    [`name(Ljava/lang/String;)${JW}`]: async function (this: JJsonWriter, n: string) {
      await jsonEmit(this, JSON.stringify(n) + ":");
      this.scopes[this.scopes.length - 1].named = true;
      return this;
    },
    [`nullValue()${JW}`]: function (this: JJsonWriter) { return jsonEmit(this, "null"); },
    [`value(Ljava/lang/String;)${JW}`]: jsonValue((v) => v === null ? "null" : JSON.stringify(v)),
    [`value(Z)${JW}`]: jsonValue((v) => v ? "true" : "false"),
    [`value(Ljava/lang/Boolean;)${JW}`]: jsonValue((v) => v === null ? "null" : v.v ? "true" : "false"),
    [`value(D)${JW}`]: jsonValue((v) => String(v)),
    [`value(J)${JW}`]: jsonValue((v) => String(v)),
    [`value(Ljava/lang/Number;)${JW}`]: jsonValue((v) => v === null ? "null" : String(v.v ?? v)),
    "flush()V": function (this: JJsonWriter) { return vcall(this.out, "flush", "()V"); },
    "close()V": function (this: JJsonWriter) { return vcall(this.out, "close", "()V"); },
  },
});
