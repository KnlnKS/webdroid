// android.util.* natives: Log, the sparse arrays, StateSet, Property, DisplayMetrics and TypedValue.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { intBitsToFloat, mangleStaticField } from "../jvm/abi";
import { device } from "../shell/config";
import { vcall, linkInit } from "../jvm/natives/jlang";
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
const logAt = (priority: number) => logFn(["", "", "V", "D", "I", "W", "E", "A"][priority] ?? "P");
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
    "static isLoggable(Ljava/lang/String;I)Z": (_tag: string, level: number) => level >= 4 ? 1 : 0,
    "static getStackTraceString(Ljava/lang/Throwable;)Ljava/lang/String;": (t: unknown) => String((t as any)?.msg ?? t ?? ""),
    "static println(ILjava/lang/String;Ljava/lang/String;)I": (p: number, tag: string, msg: string) => logAt(p)(tag, msg),
    // Slog and the other buffers write through this; there is one log here
    "static println_native(IILjava/lang/String;Ljava/lang/String;)I": (_buffer: number, p: number, tag: string, msg: string) => logAt(p)(tag, msg),
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
  // only the object-valued arrays name remove(key) besides delete(key)
  ...valDesc === "Ljava/lang/Object;" ? { [`remove(${key})V`]: function (this: JSparseArray, k: number | bigint) { this.del(k); } } : {},
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

// ── android.util.Property / IntProperty / FloatProperty: abstract get/set handles that
// ObjectAnimator drives. The primitive subclasses unbox into the app's setValue override.
export class JProperty extends JObj { type: unknown = null; name = ""; }
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
  // AOSP's own fields, so its bodies (setToDefaults, setTo, equals) run on this object
  noncompatWidthPixels = this.widthPixels; noncompatHeightPixels = this.heightPixels;
  noncompatDensity = this.density; noncompatDensityDpi = this.densityDpi; noncompatScaledDensity = this.scaledDensity;
  noncompatXdpi = this.xdpi; noncompatYdpi = this.ydpi;
  fontScaleConverter: unknown = null;
}
rt.register({
  name: "android/util/DisplayMetrics", ctor: JDisplayMetrics,
  statics: { DENSITY_DEFAULT: 160, DENSITY_DEVICE: device.densityDpi, DENSITY_DEVICE_STABLE: device.densityDpi, DENSITY_LOW: 120, DENSITY_MEDIUM: 160, DENSITY_TV: 213,
    DENSITY_HIGH: 240, DENSITY_XHIGH: 320, DENSITY_XXHIGH: 480, DENSITY_XXXHIGH: 640 },
  fields: ["density", "densityDpi", "scaledDensity", "widthPixels", "heightPixels", "xdpi", "ydpi", "noncompatWidthPixels",
    "noncompatHeightPixels", "noncompatDensity", "noncompatDensityDpi", "noncompatScaledDensity", "noncompatXdpi", "noncompatYdpi", "fontScaleConverter"],
  methods: { "<init>()V": function () {} },
});

// android.util.TypedValue: the complex-unit math is here
export class JTypedValue extends JObj {
  type = 0; data = 0; resourceId = 0; string: string | null = null; density = 0;
  assetCookie = 0;
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
