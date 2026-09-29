// The native half of android.graphics.fonts (minikin's Font and FontFamily), and the Typeface
// builders over it. A font is the bytes of one face; a family becomes one CSS font family (each
// member a FontFace with its own weight/style, which is exactly how CSS selects within a family);
// a Typeface names that family (plus fallbacks) with a weight and slant.

import { rt, JObj, type NativeSpec, driven, declaredField, type Gen } from "../jvm/runtime";
import { vcall, scall, after } from "../jvm/natives/jlang";
import { parseAXML, attr } from "./axml";
import { pathOf, fdInt } from "../jvm/natives/jio";
import { vfs } from "../shell/vfs";
import { readFully } from "../shell/lazyfile";
import { javaFdSource } from "../native/stdio";
import { deref } from "./handles";
import { JTypeface, mkTypeface, typefaceFor, setFamilyMetrics, setTypefaceLoader, resourceTypefaces, tfDefault, SYSTEM_FONTS, SYSTEM_EMOJI_FONTS } from "./graphics";
import { type Resources, nativeAssets } from "./res";

const fileBytes = (path: string | null | undefined) => path ? vfs.readFile(path) : null;

/** Offsets of the sfnt tables we read, by tag, or null if `b` is not a font we understand. */
export function sfntTables(b: Uint8Array, ttcIndex: number): { dv: DataView; at: Map<number, number> } | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let base = 0;
  const tag = dv.getUint32(0);
  if (tag === 0x74746366) { // 'ttcf'
    const n = dv.getUint32(8);
    if (ttcIndex >= n || 12 + ttcIndex * 4 + 4 > b.length) return null;
    base = dv.getUint32(12 + ttcIndex * 4);
  } else if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null; // 1.0 / 'OTTO' / 'true'
  if (base + 12 > b.length) return null;
  const at = new Map<number, number>();
  const numTables = dv.getUint16(base + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > b.length) return null;
    at.set(dv.getUint32(rec), dv.getUint32(rec + 8));
  }
  return { dv, at };
}
const T_OS2 = 0x4f532f32, T_HHEA = 0x68686561, T_HEAD = 0x68656164, T_NAME = 0x6e616d65, T_CFF = 0x43464620, T_CFF2 = 0x43464632;
export const T_CMAP = 0x636d6170;

/** weight/italic from the face's OS/2 table (what AOSP's analyzeStyle reads), null if absent */
export function sfntStyle(b: Uint8Array, ttcIndex = 0): { weight: number; italic: boolean } | null {
  const t = sfntTables(b, ttcIndex);
  const off = t?.at.get(T_OS2);
  if (!t || off === undefined || off + 64 > b.length) return null;
  return { weight: t.dv.getUint16(off + 4), italic: (t.dv.getUint16(off + 62) & 1) !== 0 };
}

/** FreeType's scalable-face metrics as Skia reads them, in ems: hhea ascender/descender and line
 *  gap, and head's bounding box for top/bottom (all positive downwards from the baseline). */
interface FaceMetrics { ascent: number; descent: number; top: number; bottom: number; leading: number }
function sfntMetrics(b: Uint8Array, ttcIndex = 0): FaceMetrics | null {
  const t = sfntTables(b, ttcIndex);
  const head = t?.at.get(T_HEAD), hhea = t?.at.get(T_HHEA);
  if (!t || head === undefined || hhea === undefined || head + 44 > b.length || hhea + 10 > b.length) return null;
  const upem = t.dv.getUint16(head + 18);
  if (!upem) return null;
  const asc = t.dv.getInt16(hhea + 4) / upem, desc = -t.dv.getInt16(hhea + 6) / upem;
  return { ascent: asc, descent: desc, top: t.dv.getInt16(head + 42) / upem, bottom: -t.dv.getInt16(head + 38) / upem, leading: t.dv.getInt16(hhea + 8) / upem };
}

// minikin's FontFileParser, which FontFileUtil's natives answer from. An unreadable face has no
// tables: no revision (-1), no name (null), and it is not CFF.
export function fontRevision(b: Uint8Array, index: number): bigint {
  const t = sfntTables(b, index), head = t?.at.get(T_HEAD);
  return t && head !== undefined && head + 8 <= b.length ? BigInt(t.dv.getUint32(head + 4)) : -1n;
}
export function isPostScriptType1(b: Uint8Array, index: number): number {
  const t = sfntTables(b, index);
  return t && (t.at.has(T_CFF) || t.at.has(T_CFF2)) ? 1 : 0;
}
/** name ID 6, English, as HarfBuzz reads it into minikin's 64-byte buffer, and only if it is a
 *  valid PostScript name */
export function postScriptName(b: Uint8Array, index: number): string | null {
  const t = sfntTables(b, index), name = t?.at.get(T_NAME);
  if (!t || name === undefined || name + 6 > b.length) return null;
  const dv = t.dv, count = dv.getUint16(name + 2), strings = name + dv.getUint16(name + 4);
  let best: { rank: number; text: string } | null = null;
  for (let i = 0; i < count; i++) {
    const r = name + 6 + i * 12;
    if (r + 12 > b.length) break;
    const platform = dv.getUint16(r), encoding = dv.getUint16(r + 2), lang = dv.getUint16(r + 4);
    if (dv.getUint16(r + 6) !== 6) continue;
    const len = dv.getUint16(r + 8), at = strings + dv.getUint16(r + 10);
    if (at + len > b.length) continue;
    const unicode = platform === 0 || platform === 3 && (encoding === 1 || encoding === 10);
    const rank = unicode ? platform === 0 || (lang & 0x3ff) === 9 ? 0 : 2 : platform === 1 && encoding === 0 && lang === 0 ? 1 : -1;
    if (rank < 0 || best && best.rank <= rank) continue;
    let text = "";
    if (unicode) for (let j = 0; j + 1 < len; j += 2) text += String.fromCharCode(dv.getUint16(at + j));
    else for (let j = 0; j < len; j++) text += String.fromCharCode(b[at + j]);
    best = { rank, text };
  }
  const ps = best?.text.slice(0, 63);
  return ps && /^[!-~]*$/.test(ps) && !/[[\](){}<>/%]/.test(ps) ? ps : null;
}

/** minikin's FontVariation: an OpenType axis tag and its value */
export interface Axis { tag: number; value: number }
const tagName = (t: number) => String.fromCharCode(t >>> 24, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);

let sourceIds = 0;
/** minikin::Font over its MinikinFontSkia: one face of a font file, the style it is selected by,
 *  and the axes, path and locales it was built with. A clone shares the source id and bytes. */
export class NativeFont {
  private metrics?: FaceMetrics | null;
  constructor(readonly bytes: Uint8Array, readonly ttcIndex: number, readonly weight: number, readonly italic: boolean,
    readonly axes: readonly Axis[] = [], readonly path = "", readonly locales = "", readonly sourceId = sourceIds++) {}
  get faceMetrics(): FaceMetrics | null {
    return this.metrics === undefined ? (this.metrics = sfntMetrics(this.bytes, this.ttcIndex)) : this.metrics;
  }
}
const systemFaces = new Map<string, NativeFont>();
/** the system collection's fonts (Font.getAvailableFonts), as installed under /system/fonts */
export async function systemFonts(): Promise<NativeFont[]> {
  const faces = [...SYSTEM_FONTS.map(([, file, weight, style]) => [file, weight, style === "italic"] as const),
    ...SYSTEM_EMOJI_FONTS.map(([, file]) => [file, 400, false] as const)];
  const out: NativeFont[] = [];
  for (const [file, weight, italic] of faces) {
    const path = `/system/fonts/${file}`;
    let font = systemFaces.get(path);
    if (!font) {
      const bytes = await fileBytes(path);
      if (!bytes) continue;
      systemFaces.set(path, font = new NativeFont(bytes, 0, weight, italic, [], path));
    }
    out.push(font);
  }
  return out;
}
/** a font from bytes, its unset (-1) weight and italic resolved from the face as AOSP does */
function fontFrom(bytes: Uint8Array, weight: number, italic: number, ttcIndex = 0, axes: readonly Axis[] = []): NativeFont {
  const st = weight <= 0 || italic < 0 ? sfntStyle(bytes, ttcIndex) : null;
  return new NativeFont(bytes, ttcIndex, Math.max(1, Math.min(1000, weight > 0 ? weight : st?.weight || 400)),
    italic >= 0 ? italic === 1 : !!st?.italic, axes);
}

/** minikin's FontFamily: its fonts, registered under one CSS family */
export class NativeFamily {
  constructor(readonly fonts: readonly NativeFont[], readonly css: string, readonly langTags = "", readonly variant = 0) {}
  /** the member minikin selects for `weight`/`italic` (FontStyle's match score) */
  closest(weight: number, italic: boolean): NativeFont {
    const score = (f: NativeFont) => Math.abs((f.weight - weight) / 100) + (f.italic !== italic ? 2 : 0);
    let best = this.fonts[0];
    for (const f of this.fonts) if (score(f) < score(best)) best = f;
    return best;
  }
}

/** Register one face under a CSS family. The load is awaited so no text is ever measured against
 *  a face that later swaps in (every width memo in graphics.ts is keyed by font string alone). */
async function registerFace(f: NativeFont, family: string): Promise<void> {
  const vm = f.faceMetrics;
  if (vm) setFamilyMetrics(family, vm);
  if (typeof FontFace === "undefined") return;
  const b = f.bytes;
  const src = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer;
  const desc: FontFaceDescriptors & { variationSettings?: string } = { weight: String(f.weight), style: f.italic ? "italic" : "normal" };
  if (f.axes.length) desc.variationSettings = f.axes.map((a) => `"${tagName(a.tag)}" ${a.value}`).join(", ");
  // Keep browser line metrics aligned with Paint.ascent/descent.
  if (vm) {
    desc.ascentOverride = `${vm.ascent * 100}%`;
    desc.descentOverride = `${vm.descent * 100}%`;
  }
  try {
    const face = new FontFace(family, src as ArrayBuffer, desc);
    await face.load();
    document.fonts.add(face);
  } catch (e) {
    console.warn("[fonts] FontFace rejected", family, e);
  }
}
let familySeq = 0;
/** a family of these faces under a fresh CSS family name, every face loaded before it is used */
export async function mkFamily(fonts: readonly NativeFont[], langTags = "", variant = 0): Promise<NativeFamily> {
  const fam = new NativeFamily(fonts, "wd-font-" + (++familySeq), langTags, variant);
  for (const f of fonts) await registerFace(f, fam.css);
  return fam;
}

// ── the bridge from Java objects to native state, for the TS Typeface
let familyPtr = "", axisTag = "", axisValue = "", styleWeight = "", styleSlant = "";
/** the native family behind a Java FontFamily */
export const familyOf = (f: object): NativeFamily =>
  deref<NativeFamily>((f as Record<string, bigint>)[familyPtr ||= declaredField("android/graphics/fonts/FontFamily", "mNativePtr")]);
/** a Java FontVariationAxis[] as the axes minikin receives */
function axesOf(a: ArrayLike<object> | null): Axis[] {
  if (!a) return [];
  axisTag ||= declaredField("android/graphics/fonts/FontVariationAxis", "mTag");
  axisValue ||= declaredField("android/graphics/fonts/FontVariationAxis", "mStyleValue");
  return Array.from(a, (x) => ({ tag: (x as Record<string, number>)[axisTag], value: (x as Record<string, number>)[axisValue] }));
}
/** FontVariationAxis.fromFontVariationSettings, as axes */
const parseAxes = (s: string | null) =>
  after(scall("android/graphics/fonts/FontVariationAxis", "fromFontVariationSettings", "(Ljava/lang/String;)[Landroid/graphics/fonts/FontVariationAxis;", s), axesOf);
const styleOf = (s: object) => {
  styleWeight ||= declaredField("android/graphics/fonts/FontStyle", "mWeight");
  styleSlant ||= declaredField("android/graphics/fonts/FontStyle", "mSlant");
  return { weight: (s as Record<string, number>)[styleWeight], italic: (s as Record<string, number>)[styleSlant] === 1 };
};

/** minikin's Typeface over these families (Typeface.createFromFamilies, CustomFallbackBuilder):
 *  the families, then the fallback typeface's */
export function typefaceOver(families: readonly NativeFamily[], fallback: JTypeface, weight: number, italic: boolean): JTypeface {
  const css = families.map((f) => f.css).concat(fallback.family).join(", ");
  return mkTypeface(css, weight >= 600, italic, weight);
}

// ── Typeface.CustomFallbackBuilder / Typeface.Builder
const MAX_CUSTOM_FALLBACK = 64;
class JCustomFallbackBuilder extends JObj { families: object[] = []; style: object | null = null; sys: string | null = null; }
rt.register({
  name: "android/graphics/Typeface$CustomFallbackBuilder", ctor: JCustomFallbackBuilder,
  methods: {
    "<init>(Landroid/graphics/fonts/FontFamily;)V": function (this: JCustomFallbackBuilder, f: object) {
      if (!f) throw rt.mkThrowable("java/lang/NullPointerException", "family");
      this.families.push(f);
    },
    "addCustomFallback(Landroid/graphics/fonts/FontFamily;)Landroid/graphics/Typeface$CustomFallbackBuilder;": function (this: JCustomFallbackBuilder, f: object) {
      if (this.families.length >= MAX_CUSTOM_FALLBACK) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Custom fallback limit exceeded(" + MAX_CUSTOM_FALLBACK + ")");
      this.families.push(f);
      return this;
    },
    "setStyle(Landroid/graphics/fonts/FontStyle;)Landroid/graphics/Typeface$CustomFallbackBuilder;": function (this: JCustomFallbackBuilder, s: object) { this.style = s; return this; },
    "setSystemFallback(Ljava/lang/String;)Landroid/graphics/Typeface$CustomFallbackBuilder;": function (this: JCustomFallbackBuilder, s: string) { this.sys = s; return this; },
    // AOSP: no style is weight 400, upright
    "build()Landroid/graphics/Typeface;": function (this: JCustomFallbackBuilder) {
      const st = this.style ? styleOf(this.style) : { weight: 400, italic: false };
      return typefaceOver(this.families.map(familyOf), typefaceFor(this.sys ?? "sans-serif"), st.weight, st.italic);
    },
    "static getMaxCustomFallbackCount()I": () => MAX_CUSTOM_FALLBACK,
  },
});

class JTypefaceBuilder extends JObj {
  bytes: Uint8Array | null = null;
  weight = -1; italic = -1; ttcIndex = 0;
  axes: Axis[] = [];
  fallback: string | null = null;
}
function tfbFrom(this: JTypefaceBuilder, b: Uint8Array | null) { this.bytes = b; }
const tfbMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Ljava/io/File;)V": driven(function* (this: JTypefaceBuilder, f: JObj): Gen { tfbFrom.call(this, yield fileBytes(pathOf(f))); }),
  "<init>(Ljava/lang/String;)V": driven(function* (this: JTypefaceBuilder, p: string): Gen { tfbFrom.call(this, yield fileBytes(p)); }),
  "<init>(Ljava/io/FileDescriptor;)V": driven(function* (this: JTypefaceBuilder, fd: JObj | null): Gen {
    const source = javaFdSource(fdInt(fd));
    tfbFrom.call(this, source ? yield readFully(source) : null);
  }),
  "<init>(Landroid/content/res/AssetManager;Ljava/lang/String;)V": function (this: JTypefaceBuilder, am: unknown, p: string) { tfbFrom.call(this, assetFile(am, p)); },
  "<init>(Landroid/content/res/AssetManager;Ljava/lang/String;ZI)V": function (this: JTypefaceBuilder, am: unknown, p: string, isAsset: number) {
    tfbFrom.call(this, assetFile(am, p, !!isAsset));
  },
  "setWeight(I)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, w: number) { this.weight = w; return this; },
  "setItalic(Z)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, i: number) { this.italic = i ? 1 : 0; return this; },
  "setTtcIndex(I)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, i: number) { this.ttcIndex = i; return this; },
  "setFontVariationSettings(Ljava/lang/String;)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, s: string | null) {
    return after(parseAxes(s), (a: Axis[]) => { this.axes = a; return this; });
  },
  "setFontVariationSettings([Landroid/graphics/fonts/FontVariationAxis;)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, a: object[] | null) { this.axes = axesOf(a); return this; },
  "setFallback(Ljava/lang/String;)Landroid/graphics/Typeface$Builder;": function (this: JTypefaceBuilder, s: string | null) { this.fallback = s; return this; },
  // AOSP returns null when the font cannot be read (rather than throwing)
  "build()Landroid/graphics/Typeface;": function (this: JTypefaceBuilder) { return buildTypeface(this.bytes, this); },
};
/** font bytes → a registered Typeface, null when they are not a font this can read */
async function buildTypeface(bytes: Uint8Array | null, o: Partial<JTypefaceBuilder> = {}): Promise<JTypeface | null> {
  if (!bytes) return null;
  const { weight = -1, italic = -1, ttcIndex = 0, axes = [], fallback = null } = o;
  if (!sfntStyle(bytes, ttcIndex)) return null;
  const f = fontFrom(bytes, weight, italic, ttcIndex, axes);
  return typefaceOver([await mkFamily([f])], typefaceFor(fallback ?? "sans-serif"), f.weight, f.italic);
}
setTypefaceLoader(buildTypeface);
rt.register({ name: "android/graphics/Typeface$Builder", ctor: JTypefaceBuilder, methods: tfbMethods });

/** a file an AssetManager opens: under assets/, or a resource file of its packages (isAsset false) */
function assetFile(am: unknown, path: string, isAsset = true): Uint8Array | null {
  const res = nativeAssets(am);
  if (isAsset) return res.zip["assets/" + path] ?? null;
  return res.zip[path] ?? res.arsc?.files(path) ?? res.tbl(0x01000000)?.files(path) ?? null;
}

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

/** one family over these members, carrying its regular member's style */
async function familyTypeface(fonts: NativeFont[]): Promise<JTypeface> {
  const fam = await mkFamily(fonts);
  const regular = fonts.find((f) => f.weight === 400 && !f.italic) ?? fonts[0];
  return typefaceOver([fam], tfDefault, regular.weight, regular.italic);
}
// AOSP's ResourcesImpl.loadFont: Typeface.findFromCache, then createFromResources over
// FontResourcesParser's entry, remembered per AssetManager and file.
const byFile = new WeakMap<Resources, Map<string, JTypeface>>();
const fileCache = (am: unknown) => { const res = nativeAssets(am); let m = byFile.get(res); if (!m) byFile.set(res, m = new Map()); return m; };
resourceTypefaces.find = (am, path) => fileCache(am).get(path) ?? null;
resourceTypefaces.create = driven(function* createFromResources(entry: unknown, am: unknown, path: string): Gen<JTypeface> {
  if (rt.iof(entry, "android/content/res/FontResourcesParser$ProviderResourceEntry")) {
    const system: string | null = yield vcall(entry, "getSystemFontFamilyName", "()Ljava/lang/String;");
    // no font provider is installed, so FontsContract finds none and AOSP answers DEFAULT
    return system ? typefaceFor(system, 0) : tfDefault;
  }
  const cached = fileCache(am).get(path);
  if (cached) return cached;
  const E = "Landroid/content/res/FontResourcesParser$FontFileResourceEntry;";
  const fonts: NativeFont[] = [];
  for (const e of yield vcall(entry, "getEntries", `()[${E}`)) {
    const b = assetFile(am, yield vcall(e, "getFileName", "()Ljava/lang/String;"), false);
    const weight: number = yield vcall(e, "getWeight", "()I"), italic: number = yield vcall(e, "getItalic", "()I");
    const ttcIndex: number = yield vcall(e, "getTtcIndex", "()I");
    const axes: Axis[] = yield parseAxes(yield vcall(e, "getVariationSettings", "()Ljava/lang/String;"));
    if (b) fonts.push(fontFrom(b, weight, italic, ttcIndex, axes));
  }
  // a member that cannot be read fails the family, and AOSP caches DEFAULT for it
  const typeface = fonts.length ? yield familyTypeface(fonts) : tfDefault;
  fileCache(am).set(path, typeface);
  return typeface;
});

/** Resources.getFont(id): a font file resource, or a <font-family> XML whose members become one
 *  family; the Typeface carries the regular member's style. */
async function loadFontResource(res: Resources, id: number): Promise<JTypeface | null> {
  const path = res.value(id).s;
  if (!path) return null;
  const fonts: NativeFont[] = [];
  const add = (b: Uint8Array | null | undefined, weight: number, italic: number) => { if (b) fonts.push(fontFrom(b, weight, italic)); };
  if (path.endsWith(".xml")) {
    const root = parseAXML(res.zip[path]);
    if (root.name !== "font-family") return null;
    for (const c of root.children) {
      if (c.name !== "font") continue;
      const ref = attr(c, "font"), w = attr(c, "fontWeight"), it = attr(c, "fontStyle");
      if (!ref || !ref.data) continue;
      add(res.fileOf(ref.data)?.bytes, w?.data ?? 0, it ? it.data : -1);
    }
  } else add(res.zip[path], 0, -1);
  if (!fonts.length) return null;
  return familyTypeface(fonts);
}
