// android.graphics.fonts (Font, FontFamily, FontStyle, FontVariationAxis) and the Typeface
// builders over them. A Font is the bytes of one face; a FontFamily becomes one CSS font family
// (each member a FontFace with its own weight/style, which is exactly how CSS selects within a
// family); a Typeface names that family (plus fallbacks) with a weight and slant.

import { rt, JObj, type NativeSpec, fieldGetters } from "../jvm/runtime";
import { jarray, i8 } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { parseAXML, attr } from "./axml";
import { vfs, type JFile } from "../jvm/natives/jio";
import { JBuffer, bufferView } from "../jvm/natives/jnio";
import { JTypeface, mkTypeface, typefaceFor, setFamilyMetrics, setTypefaceLoader } from "./graphics";
import type { Resources } from "./res";
import type { JResources, JAssetManager } from "./resnative";

const UPRIGHT = 0, ITALIC = 1;

/** Offsets of the sfnt tables we read, by tag, or null if `b` is not a font we understand. */
function sfntTables(b: Uint8Array, ttcIndex: number): { dv: DataView; at: Map<number, number> } | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let base = 0;
  const tag = dv.getUint32(0);
  if (tag === 0x74746366) { // 'ttcf'
    const n = dv.getUint32(8);
    if (ttcIndex >= n) return null;
    base = dv.getUint32(12 + ttcIndex * 4);
  } else if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null; // 1.0 / 'OTTO' / 'true'
  const at = new Map<number, number>();
  const numTables = dv.getUint16(base + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > b.length) return null;
    at.set(dv.getUint32(rec), dv.getUint32(rec + 8));
  }
  return { dv, at };
}
const T_OS2 = 0x4f532f32, T_HHEA = 0x68686561, T_HEAD = 0x68656164;

/** weight/italic from the face's OS/2 table (what AOSP's analyzeStyle reads), null if absent */
function sfntStyle(b: Uint8Array, ttcIndex = 0): { weight: number; italic: boolean } | null {
  const t = sfntTables(b, ttcIndex);
  const off = t?.at.get(T_OS2);
  if (!t || off === undefined || off + 64 > b.length) return null;
  return { weight: t.dv.getUint16(off + 4), italic: (t.dv.getUint16(off + 62) & 1) !== 0 };
}

/** AOSP uses face ascenders for line spacing and glyph bounds for font padding. */
function sfntMetrics(b: Uint8Array, ttcIndex = 0): { ascent: number; descent: number; top: number; bottom: number } | null {
  const t = sfntTables(b, ttcIndex);
  const head = t?.at.get(T_HEAD), hhea = t?.at.get(T_HHEA);
  if (!t || head === undefined || hhea === undefined || head + 44 > b.length || hhea + 8 > b.length) return null;
  const upem = t.dv.getUint16(head + 18);
  if (!upem) return null;
  const asc = t.dv.getInt16(hhea + 4) / upem, desc = -t.dv.getInt16(hhea + 6) / upem;
  return { ascent: asc, descent: desc, top: t.dv.getInt16(head + 42) / upem, bottom: -t.dv.getInt16(head + 38) / upem };
}

class JFontStyle extends JObj { weight = 400; slant = UPRIGHT; }
function mkFontStyle(weight: number, slant: number): JFontStyle {
  const s = new JFontStyle(); s.weight = weight; s.slant = slant; return s;
}
rt.register({
  name: "android/graphics/fonts/FontStyle", ctor: JFontStyle,
  statics: {
    FONT_WEIGHT_MIN: 1, FONT_WEIGHT_THIN: 100, FONT_WEIGHT_EXTRA_LIGHT: 200, FONT_WEIGHT_LIGHT: 300,
    FONT_WEIGHT_NORMAL: 400, FONT_WEIGHT_MEDIUM: 500, FONT_WEIGHT_SEMI_BOLD: 600, FONT_WEIGHT_BOLD: 700,
    FONT_WEIGHT_EXTRA_BOLD: 800, FONT_WEIGHT_BLACK: 900, FONT_WEIGHT_MAX: 1000,
    FONT_SLANT_UPRIGHT: UPRIGHT, FONT_SLANT_ITALIC: ITALIC,
  },
  methods: {
    "<init>()V": function () {},
    "<init>(II)V": function (this: JFontStyle, w: number, s: number) {
      if (w < 1 || w > 1000) throw rt.mkThrowable("java/lang/IllegalArgumentException", "weight value must be [1, 1000]");
      if (s !== UPRIGHT && s !== ITALIC) throw rt.mkThrowable("java/lang/IllegalArgumentException", "slant value must be FONT_SLANT_UPRIGHT or FONT_SLANT_ITALIC");
      this.weight = w; this.slant = s;
    },
    ...fieldGetters({ "getWeight()I": "weight", "getSlant()I": "slant" }),
    "equals(Ljava/lang/Object;)Z": function (this: JFontStyle, o: unknown) { return o instanceof JFontStyle && o.weight === this.weight && o.slant === this.slant ? 1 : 0; },
    "hashCode()I": function (this: JFontStyle) { return this.weight * 31 + this.slant; },
    "toString()Ljava/lang/String;": function (this: JFontStyle) { return `FontStyle { weight=${this.weight}, slant=${this.slant} }`; },
  },
});

class JFontVariationAxis extends JObj { tag = ""; value = 0; }
function mkAxis(tag: string, value: number): JFontVariationAxis {
  if (!/^[\x20-\x7E]{4}$/.test(tag)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Illegal tag pattern: " + tag);
  const a = new JFontVariationAxis(); a.tag = tag; a.value = Math.fround(value); return a;
}
/** AOSP's grammar: `'tag' value` pairs, comma separated, tags in single or double quotes */
function parseVariationSettings(s: string | null): JFontVariationAxis[] | null {
  if (!s || !s.trim()) return null;
  const out: JFontVariationAxis[] = [];
  for (const part of s.split(",")) {
    const m = /^\s*(?:'([^']{4})'|"([^"]{4})")\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*$/.exec(part);
    if (!m) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid font variation settings: " + s);
    out.push(mkAxis(m[1] ?? m[2], parseFloat(m[3])));
  }
  return out;
}
const axisArray = (a: JFontVariationAxis[] | null) => a ? jarray(a.slice(), "Landroid/graphics/fonts/FontVariationAxis;") : null;
rt.register({
  name: "android/graphics/fonts/FontVariationAxis", ctor: JFontVariationAxis,
  methods: {
    "<init>(Ljava/lang/String;F)V": function (this: JFontVariationAxis, tag: string, v: number) { const a = mkAxis(tag, v); this.tag = a.tag; this.value = a.value; },
    ...fieldGetters({ "getTag()Ljava/lang/String;": "tag", "getStyleValue()F": "value" }),
    "getOpenTypeTagValue()I": function (this: JFontVariationAxis) {
      return ((this.tag.charCodeAt(0) << 24) | (this.tag.charCodeAt(1) << 16) | (this.tag.charCodeAt(2) << 8) | this.tag.charCodeAt(3)) | 0;
    },
    "toString()Ljava/lang/String;": function (this: JFontVariationAxis) { return `'${this.tag}' ${this.value}`; },
    "static fromFontVariationSettings(Ljava/lang/String;)[Landroid/graphics/fonts/FontVariationAxis;": (s: string | null) => axisArray(parseVariationSettings(s)),
    "static toFontVariationSettings([Landroid/graphics/fonts/FontVariationAxis;)Ljava/lang/String;": (a: JFontVariationAxis[] | null) =>
      a ? a.map((x) => `'${x.tag}' ${x.value}`).join(", ") : "",
    "equals(Ljava/lang/Object;)Z": function (this: JFontVariationAxis, o: unknown) { return o instanceof JFontVariationAxis && o.tag === this.tag && o.value === this.value ? 1 : 0; },
    "hashCode()I": function (this: JFontVariationAxis) { let h = 0; for (let i = 0; i < 4; i++) h = (h * 31 + this.tag.charCodeAt(i)) | 0; return (h * 31 + Math.round(this.value * 1000)) | 0; },
  },
});

class JFont extends JObj {
  bytes: Uint8Array | null = null;
  ttcIndex = 0;
  style: JFontStyle = mkFontStyle(400, UPRIGHT);
  axes: JFontVariationAxis[] | null = null;
  file: JFile | null = null;
  srcId = 0;
  /** the CSS family this face was registered under (set when its FontFamily is built) */
  css = "";
  face: FontFace | null = null;
}
let fontSeq = 0;
/** Register one face under a CSS family. The load is awaited so no text is ever measured against
 *  a face that later swaps in (every width memo in graphics.ts is keyed by font string alone). */
async function registerFace(f: JFont, family: string): Promise<void> {
  if (f.face && f.css === family) return;
  f.css = family;
  if (typeof FontFace === "undefined" || !f.bytes) return;
  const b = f.bytes;
  const src = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer;
  const desc: FontFaceDescriptors & { variationSettings?: string } = { weight: String(f.style.weight), style: f.style.slant === ITALIC ? "italic" : "normal" };
  if (f.axes?.length) desc.variationSettings = f.axes.map((a) => `"${a.tag}" ${a.value}`).join(", ");
  // Keep browser line metrics aligned with Paint.ascent/descent.
  const vm = sfntMetrics(b, f.ttcIndex);
  if (vm) {
    desc.ascentOverride = `${vm.ascent * 100}%`;
    desc.descentOverride = `${vm.descent * 100}%`;
    setFamilyMetrics(family, vm);
  }
  try {
    const face = new FontFace(family, src as ArrayBuffer, desc);
    await face.load();
    document.fonts.add(face);
    f.face = face;
  } catch (e) {
    console.warn("[fonts] FontFace rejected", family, e);
  }
}

class JFontBuilder extends JObj {
  bytes: Uint8Array | null = null;
  err: string | null = null;
  weight = -1; slant = -1; ttcIndex = 0;
  axes: JFontVariationAxis[] | null = null;
  file: JFile | null = null;
  srcId = 0;
}
function fromBytes(this: JFontBuilder, b: Uint8Array | null, what: string) {
  if (b) this.bytes = b; else this.err = what;
}
function fromAsset(this: JFontBuilder, am: JAssetManager, p: string) {
  fromBytes.call(this, am.host.zip["assets/" + p] ?? null, "Failed to read asset " + p);
}
function resourceBytes(res: Resources, id: number): Uint8Array | null {
  return res.fileOf(id)?.bytes ?? null;
}
rt.register({
  name: "android/graphics/fonts/Font$Builder", ctor: JFontBuilder,
  methods: {
    "<init>(Landroid/content/res/Resources;I)V": function (this: JFontBuilder, r: JResources, id: number) {
      this.srcId = id;
      fromBytes.call(this, resourceBytes(r.host, id), "Failed to read font resource 0x" + (id >>> 0).toString(16));
    },
    "<init>(Landroid/graphics/fonts/Font;)V": function (this: JFontBuilder, f: JFont) {
      this.bytes = f.bytes; this.weight = f.style.weight; this.slant = f.style.slant; this.ttcIndex = f.ttcIndex; this.axes = f.axes; this.file = f.file; this.srcId = f.srcId;
    },
    "<init>(Ljava/io/File;)V": function (this: JFontBuilder, f: JFile) {
      this.file = f;
      fromBytes.call(this, vfs.read(f.path), "Failed to read " + f.path);
    },
    "<init>(Ljava/io/FileDescriptor;)V": function (this: JFontBuilder, fd: any) {
      fromBytes.call(this, fd?.path ? vfs.read(fd.path) : null, "Failed to read file descriptor");
    },
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JFontBuilder, pfd: any) {
      const p = pfd?.path ?? pfd?.fd?.path;
      fromBytes.call(this, p ? vfs.read(p) : null, "Failed to read file descriptor");
    },
    "<init>(Landroid/content/res/AssetManager;Ljava/lang/String;)V": fromAsset,
    "<init>(Landroid/content/res/AssetManager;Ljava/lang/String;ZI)V": fromAsset,
    "<init>(Ljava/nio/ByteBuffer;)V": function (this: JFontBuilder, bb: JBuffer) {
      const v = bufferView(bb);
      this.bytes = new Uint8Array(v.ab, v.byteOffset, bb.lim);
    },
    "setWeight(I)Landroid/graphics/fonts/Font$Builder;": function (this: JFontBuilder, w: number) {
      if (w < 1 || w > 1000) throw rt.mkThrowable("java/lang/IllegalArgumentException", "weight value must be [1, 1000]");
      this.weight = w; return this;
    },
    "setSlant(I)Landroid/graphics/fonts/Font$Builder;": function (this: JFontBuilder, s: number) { this.slant = s; return this; },
    "setTtcIndex(I)Landroid/graphics/fonts/Font$Builder;": function (this: JFontBuilder, i: number) { this.ttcIndex = i; return this; },
    "setFontVariationSettings(Ljava/lang/String;)Landroid/graphics/fonts/Font$Builder;": function (this: JFontBuilder, s: string | null) {
      this.axes = parseVariationSettings(s); return this;
    },
    "setFontVariationSettings([Landroid/graphics/fonts/FontVariationAxis;)Landroid/graphics/fonts/Font$Builder;": function (this: JFontBuilder, a: JFontVariationAxis[] | null) {
      this.axes = a ? [...a] : null; return this;
    },
    "build()Landroid/graphics/fonts/Font;": function (this: JFontBuilder) {
      if (this.err || !this.bytes) throw rt.mkThrowable("java/io/IOException", this.err ?? "Failed to read font");
      const f = new JFont();
      f.bytes = this.bytes; f.ttcIndex = this.ttcIndex; f.axes = this.axes; f.file = this.file; f.srcId = this.srcId;
      // AOSP resolves an unset weight/slant from the face itself (analyzeStyle over OS/2)
      const st = this.weight === -1 || this.slant === -1 ? sfntStyle(this.bytes, this.ttcIndex) : null;
      const w = this.weight !== -1 ? this.weight : st?.weight || 400;
      const s = this.slant !== -1 ? this.slant : st?.italic ? ITALIC : UPRIGHT;
      f.style = mkFontStyle(Math.max(1, Math.min(1000, w)), s);
      return f;
    },
  },
});
rt.register({
  name: "android/graphics/fonts/Font", ctor: JFont,
  methods: {
    "getAxes()[Landroid/graphics/fonts/FontVariationAxis;": function (this: JFont) { return axisArray(this.axes); },
    ...fieldGetters({ "getStyle()Landroid/graphics/fonts/FontStyle;": "style", "getTtcIndex()I": "ttcIndex",
      "getFile()Ljava/io/File;": "file", "getSourceIdentifier()I": "srcId" }),
    "getBuffer()Ljava/nio/ByteBuffer;": function (this: JFont) {
      const b = this.bytes ?? new Uint8Array(0);
      return vcall(rt.link("java/nio/ByteBuffer").ctor, "wrap", "([B)Ljava/nio/ByteBuffer;", i8(b));
    },
    "getLocaleList()Landroid/os/LocaleList;": () => vcall(rt.link("android/os/LocaleList").ctor, "getDefault", "()Landroid/os/LocaleList;"),
    "equals(Ljava/lang/Object;)Z": function (this: JFont, o: unknown) {
      return o instanceof JFont && o.bytes === this.bytes && o.ttcIndex === this.ttcIndex && o.style.weight === this.style.weight && o.style.slant === this.style.slant ? 1 : 0;
    },
    "hashCode()I": function (this: JFont) { return ((this.bytes?.length ?? 0) * 31 + this.style.weight * 3 + this.style.slant + this.ttcIndex) | 0; },
    "toString()Ljava/lang/String;": function (this: JFont) { return `Font {style=${this.style.weight}/${this.style.slant}, ttcIndex=${this.ttcIndex}}`; },
  },
});

class JFontFamily extends JObj { fonts: JFont[] = []; css = ""; }
/** a family of these faces under a fresh CSS family name, every face loaded before it is used */
async function mkFamily(fonts: JFont[]): Promise<JFontFamily> {
  const fam = new JFontFamily();
  fam.fonts = fonts;
  fam.css = "wd-font-" + (++fontSeq);
  for (const f of fonts) await registerFace(f, fam.css);
  return fam;
}
class JFontFamilyBuilder extends JObj { fonts: JFont[] = []; }
rt.register({
  name: "android/graphics/fonts/FontFamily$Builder", ctor: JFontFamilyBuilder,
  methods: {
    "<init>(Landroid/graphics/fonts/Font;)V": function (this: JFontFamilyBuilder, f: JFont) {
      if (!f) throw rt.mkThrowable("java/lang/NullPointerException", "font");
      this.fonts.push(f);
    },
    "addFont(Landroid/graphics/fonts/Font;)Landroid/graphics/fonts/FontFamily$Builder;": function (this: JFontFamilyBuilder, f: JFont) {
      if (!f) throw rt.mkThrowable("java/lang/NullPointerException", "font");
      // AOSP: one face per (weight, slant) in a family
      if (this.fonts.some((o) => o.style.weight === f.style.weight && o.style.slant === f.style.slant)) {
        throw rt.mkThrowable("java/lang/IllegalArgumentException", "Font with same style is already added");
      }
      this.fonts.push(f);
      return this;
    },
    "build()Landroid/graphics/fonts/FontFamily;": function (this: JFontFamilyBuilder) { return mkFamily(this.fonts.slice()); },
  },
});
rt.register({
  name: "android/graphics/fonts/FontFamily", ctor: JFontFamily,
  methods: {
    "getFont(I)Landroid/graphics/fonts/Font;": function (this: JFontFamily, i: number) {
      if (i < 0 || i >= this.fonts.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(i));
      return this.fonts[i];
    },
    "getSize()I": function (this: JFontFamily) { return this.fonts.length; },
  },
});

// ── Typeface.CustomFallbackBuilder / Typeface.Builder
const MAX_CUSTOM_FALLBACK = 64;
/** the CSS stack for a family list: the custom families, then the named system fallback */
function typefaceOver(families: JFontFamily[], sysFallback: string | null, style: JFontStyle | null): JTypeface {
  const fb = typefaceFor(sysFallback ?? "sans-serif");
  const st = style ?? families[0]?.fonts[0]?.style ?? mkFontStyle(400, UPRIGHT);
  const css = families.map((f) => f.css).filter(Boolean).concat(fb.family).join(", ");
  return mkTypeface(css, st.weight >= 600, st.slant === ITALIC, st.weight);
}
class JCustomFallbackBuilder extends JObj { families: JFontFamily[] = []; style: JFontStyle | null = null; sys: string | null = null; }
rt.register({
  name: "android/graphics/Typeface$CustomFallbackBuilder", ctor: JCustomFallbackBuilder,
  methods: {
    "<init>(Landroid/graphics/fonts/FontFamily;)V": function (this: JCustomFallbackBuilder, f: JFontFamily) {
      if (!f) throw rt.mkThrowable("java/lang/NullPointerException", "family");
      this.families.push(f);
    },
    "addCustomFallback(Landroid/graphics/fonts/FontFamily;)Landroid/graphics/Typeface$CustomFallbackBuilder;": function (this: JCustomFallbackBuilder, f: JFontFamily) {
      if (this.families.length >= MAX_CUSTOM_FALLBACK) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Custom fallback limit exceeded(" + MAX_CUSTOM_FALLBACK + ")");
      this.families.push(f);
      return this;
    },
    "setStyle(Landroid/graphics/fonts/FontStyle;)Landroid/graphics/Typeface$CustomFallbackBuilder;": function (this: JCustomFallbackBuilder, s: JFontStyle) { this.style = s; return this; },
    "setSystemFallback(Ljava/lang/String;)Landroid/graphics/Typeface$CustomFallbackBuilder;": function (this: JCustomFallbackBuilder, s: string) { this.sys = s; return this; },
    "build()Landroid/graphics/Typeface;": function (this: JCustomFallbackBuilder) { return typefaceOver(this.families, this.sys, this.style); },
    "static getMaxCustomFallbackCount()I": () => MAX_CUSTOM_FALLBACK,
  },
});

class JTypefaceBuilder extends JObj {
  bytes: Uint8Array | null = null;
  weight = -1; italic = -1; ttcIndex = 0;
  axes: JFontVariationAxis[] | null = null;
  fallback: string | null = null;
}
function tfbFrom(this: JTypefaceBuilder, b: Uint8Array | null) { this.bytes = b; }
const tfbMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Ljava/io/File;)V": function (this: JTypefaceBuilder, f: JFile) { tfbFrom.call(this, vfs.read(f.path)); },
  "<init>(Ljava/lang/String;)V": function (this: JTypefaceBuilder, p: string) { tfbFrom.call(this, vfs.read(p)); },
  "<init>(Ljava/io/FileDescriptor;)V": function (this: JTypefaceBuilder, fd: any) { tfbFrom.call(this, fd?.path ? vfs.read(fd.path) : null); },
  "<init>(Landroid/content/res/AssetManager;Ljava/lang/String;)V": function (this: JTypefaceBuilder, am: JAssetManager, p: string) { tfbFrom.call(this, am.host.zip["assets/" + p] ?? null); },
  "setWeight(I)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, w: number) { this.weight = w; return this; },
  "setItalic(Z)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, i: number) { this.italic = i ? 1 : 0; return this; },
  "setTtcIndex(I)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, i: number) { this.ttcIndex = i; return this; },
  "setFontVariationSettings(Ljava/lang/String;)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, s: string | null) { this.axes = parseVariationSettings(s); return this; },
  "setFontVariationSettings([Landroid/graphics/fonts/FontVariationAxis;)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, a: JFontVariationAxis[] | null) { this.axes = a ? [...a] : null; return this; },
  "setFallback(Ljava/lang/String;)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, s: string | null) { this.fallback = s; return this; },
  // AOSP returns null when the font cannot be read (rather than throwing)
  "build()Landroid/graphics/Typeface;": function (this: JTypefaceBuilder) { return buildTypeface(this.bytes, this); },
};
/** font bytes → a registered Typeface, null when they are not a font this can read */
async function buildTypeface(bytes: Uint8Array | null, o: Partial<JTypefaceBuilder> = {}): Promise<JTypeface | null> {
  if (!bytes) return null;
  const { weight = -1, italic = -1, ttcIndex = 0, axes = null, fallback = null } = o;
  const st = sfntStyle(bytes, ttcIndex);
  if (!st) return null;
  const f = new JFont();
  f.bytes = bytes; f.ttcIndex = ttcIndex; f.axes = axes;
  f.style = mkFontStyle(weight !== -1 ? weight : st.weight || 400, italic !== -1 ? italic : st.italic ? ITALIC : UPRIGHT);
  return typefaceOver([await mkFamily([f])], fallback, f.style);
}
setTypefaceLoader(buildTypeface);
rt.register({ name: "android/graphics/Typeface$Builder", ctor: JTypefaceBuilder, methods: tfbMethods });

const fontMemo = new WeakMap<Resources, Map<number, Promise<JTypeface | null>>>();
/**
 * Resources.getFont(id), parsed and registered once per (Resources, id). A style is applied per
 * view, so an app whose theme names a @font/ family would otherwise re-parse it and load a new
 * FontFace for every TextView — and graphics.ts memoises text widths on the font string alone,
 * so a face that swaps in late poisons them.
 */
export function fontResource(res: Resources, id: number): Promise<JTypeface | null> {
  let m = fontMemo.get(res);
  if (!m) fontMemo.set(res, (m = new Map()));
  let p = m.get(id);
  if (!p) m.set(id, (p = loadFontResource(res, id)));
  return p;
}

/** Resources.getFont(id): a font file resource, or a <font-family> XML whose members become one
 *  family; the Typeface carries the regular member's style. */
async function loadFontResource(res: Resources, id: number): Promise<JTypeface | null> {
  const path = res.value(id).s;
  if (!path) return null;
  const fonts: JFont[] = [];
  const add = (b: Uint8Array | null, weight: number, italic: number, srcId: number) => {
    if (!b) return;
    const f = new JFont();
    f.bytes = b; f.srcId = srcId;
    const st = sfntStyle(b);
    f.style = mkFontStyle(weight > 0 ? weight : st?.weight || 400, italic >= 0 ? italic : st?.italic ? ITALIC : UPRIGHT);
    fonts.push(f);
  };
  if (path.endsWith(".xml")) {
    const root = parseAXML(res.zip[path]);
    if (root.name !== "font-family") return null;
    for (const c of root.children) {
      if (c.name !== "font") continue;
      const ref = attr(c, "font"), w = attr(c, "fontWeight"), it = attr(c, "fontStyle");
      if (!ref || !ref.data) continue;
      add(resourceBytes(res, ref.data), w?.data ?? 0, it ? it.data : -1, ref.data);
    }
  } else add(res.zip[path] ?? null, 0, -1, id);
  if (!fonts.length) return null;
  const fam = await mkFamily(fonts);
  const regular = fonts.find((f) => f.style.weight === 400 && f.style.slant === UPRIGHT) ?? fonts[0];
  return typefaceOver([fam], null, regular.style);
}
