// The native half of android.graphics.fonts and Typeface: minikin's Font, FontFamily and
// FontCollection, and hwui's Typeface. A font is one face of a font file: an app's bytes, or one of
// the reference build's /system/fonts, whose glyphs load when first shaped or drawn. A collection is
// families in fallback order, and a typeface draws from one with a weight and slant.

import { declaredField } from "../jvm/runtime";
import { scall, vcall, after } from "../jvm/natives/jlang";
import { PLATFORM_DATA } from "../jvm/bootclasspath";
import { vfs } from "../shell/vfs";
import { pageShared } from "../shell/pageshared";
import { deref, handle } from "./handles";
import { harfBuzz } from "./harfbuzz";
import { type FaceMetrics, type FaceInfo, type FvarAxis, faceInfo, faceCount } from "./sfnt";

/** minikin's FontVariation: an OpenType axis tag and its value */
export interface Axis { tag: number; value: number }
// ── font files
/** A font whose bytes are not in memory yet. Text natives run synchronously over loaded fonts and
 *  throw this to wait for one, then run again (withFonts). */
export class FontPending { constructor(readonly wait: Promise<unknown>) {} }
/** `f()`, again once any font it reached has loaded; `f` must have no effect before it reads fonts */
export function withFonts<T>(f: () => T): T | Promise<T> {
  try { return f(); } catch (e) {
    if (e instanceof FontPending) return e.wait.then(() => withFonts(f));
    throw e;
  }
}
/** natives that read fonts, each run again once a font it reached has loaded */
export function fontNatives<T extends Record<string, (...args: never[]) => unknown>>(natives: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(natives)) out[name] = function (this: unknown, ...args: never[]) { return withFonts(() => f.apply(this, args)); };
  return out as T;
}
/** one font file: its bytes in memory, or a reference-build file under /system/fonts read whole on
 *  first use. A platform file is the tab's: its realms share its bytes, and so HarfBuzz's face of it. */
class FontFile {
  private loading?: Promise<void>;
  constructor(private data: Uint8Array | null, readonly path = "") {}
  get bytes(): Uint8Array { return this.data ?? pending(this.load()); }
  load(): Promise<void> {
    return this.loading ??= this.data ? Promise.resolve() : Promise.resolve(vfs.readFile(this.path)).then((b) => {
      if (!b) throw new Error(`font ${this.path} is not mounted`);
      this.data = b;
    });
  }
}
/** throws FontPending for `wait` */
export const pending = (wait: Promise<unknown>): never => { throw new FontPending(wait); };
/** whether `path` is a reference-build font file, which loads lazily */
export const isPlatformFont = (path: string) => path.startsWith("/system/fonts/") && path in PLATFORM_DATA;
declare global { interface Window { __wdFontFiles?: Map<string, FontFile> } }
function platformFile(path: string): FontFile {
  const files = pageShared("__wdFontFiles", () => new Map<string, FontFile>());
  let file = files.get(path);
  if (!file) files.set(path, file = new FontFile(null, path));
  return file;
}
/** Typeface's nativeWarmUpCache: a system font read ahead, as the device pages its file in */
export const warmUpCache = (path: string): Promise<void> | void => isPlatformFont(path) ? platformFile(path).load() : undefined;

// The device's system server hands apps a serialized font map holding each font's style and
// coverage, so a process finds a family for a character without reading its fonts. The page's
// equivalent is /font-index.json, built from the same files (platformFontIndex).
type IndexedFace = Omit<FaceInfo, "coverage"> & { coverage: number[] };
declare global { interface Window { __wdFontIndex?: Promise<Record<string, IndexedFace>> } }
let fontIndex: Record<string, IndexedFace> | null = null;
/** every reference-build face's FaceInfo by "path#ttcIndex", its coverage pairs delta-encoded */
export async function platformFontIndex(): Promise<Record<string, IndexedFace>> {
  const index: Record<string, IndexedFace> = {};
  for (const path of Object.keys(PLATFORM_DATA).filter(isPlatformFont)) {
    const file = platformFile(path);
    await file.load();
    for (let i = 0, n = faceCount(file.bytes); i < n; i++) {
      const info = faceInfo(file.bytes, i);
      const c = info.coverage;
      index[`${path}#${i}`] = { ...info, coverage: Array.from(c, (v, k) => k ? v - c[k - 1] : v) };
    }
  }
  return index;
}
async function fetchFontIndex(): Promise<Record<string, IndexedFace>> {
  if (typeof location === "undefined" || !location.protocol.startsWith("http")) return platformFontIndex();
  const res = await fetch("/font-index.json");
  if (!res.ok) throw new Error(`font-index.json: ${res.status}`);
  return res.json();
}
function indexedFace(path: string, ttcIndex: number): FaceInfo {
  const f = fontIndex?.[`${path}#${ttcIndex}`];
  if (!f) throw new Error(`${path} #${ttcIndex} is not in the platform font index`);
  const coverage = new Uint32Array(f.coverage.length);
  for (let i = 0, at = 0; i < coverage.length; i++) coverage[i] = at += f.coverage[i];
  return { ...f, coverage };
}

let sourceIds = 0;
/** minikin::Font over its MinikinFontSkia: one face of a font file, the style it is selected by,
 *  and the axes, path and locales it was built with. A clone shares the source id and file. */
export class NativeFont {
  private face?: FaceInfo;
  constructor(readonly file: FontFile, readonly ttcIndex: number, readonly weight: number, readonly italic: boolean,
    readonly axes: readonly Axis[] = [], readonly locales = "", readonly sourceId = sourceIds++) {}
  /** a font over bytes in memory */
  static of(bytes: Uint8Array, ttcIndex: number, weight: number, italic: boolean, axes: readonly Axis[] = [], path = "", locales = ""): NativeFont {
    return new NativeFont(new FontFile(bytes, path), ttcIndex, weight, italic, axes, locales);
  }
  /** a reference-build font, its glyphs read when first shaped or drawn */
  static platform(path: string, ttcIndex: number, weight: number, italic: boolean, axes: readonly Axis[] = [], locales = ""): NativeFont {
    return new NativeFont(platformFile(path), ttcIndex, weight, italic, axes, locales);
  }
  get path(): string { return this.file.path; }
  get bytes(): Uint8Array { return this.file.bytes; }
  private get info(): FaceInfo {
    return this.face ??= isPlatformFont(this.path) ? indexedFace(this.path, this.ttcIndex) : faceInfo(this.bytes, this.ttcIndex);
  }
  /** OS/2's weight and italic bit */
  get style() { return this.info.style; }
  get faceMetrics(): FaceMetrics | null { return this.info.metrics; }
  get fvarAxes(): readonly FvarAxis[] { return this.info.axes; }
  get supportedAxes(): readonly number[] { return this.info.axes.map((a) => a.tag); }
  /** whether the face has outlines, which FreeType hints: a bitmap-only face has linear advances */
  get scalable(): boolean { return this.info.scalable; }
  /** whether its cmap maps `c` */
  covers(c: number): boolean {
    const r = this.info.coverage;
    let lo = 0, hi = (r.length >> 1) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c < r[mid * 2]) hi = mid - 1; else if (c > r[mid * 2 + 1]) lo = mid + 1; else return true;
    }
    return false;
  }
  /** Skia's makeClone over the same file: another face, style or axes */
  clone(ttcIndex: number, weight: number, italic: boolean, axes: readonly Axis[]): NativeFont {
    return new NativeFont(this.file, ttcIndex, weight, italic, axes, this.locales, this.sourceId);
  }
}
// A Java Font's pointer is a FontWrapper: every Java Font (FontFamily.getFont, a buffer's clone, a
// shaped glyph's font) owns its own reference, which its registry releases, to a font others share.
class FontWrapper { constructor(readonly font: NativeFont) {} }
export const fontOf = (h: bigint) => deref<FontWrapper>(h).font;
export const wrapFont = (f: NativeFont) => handle(new FontWrapper(f));
/** minikin's FontFakery bits */
export const FAKE_BOLD = 1, FAKE_ITALIC = 2;
export const WGHT = 0x77676874, ITAL = 0x6974616c;
/** minikin's FakedFont: a font, its fakery bits, and the wght/ital values a variable font is set
 *  to in place of faking (-1 where the font has no such axis) */
export class FakedFont {
  constructor(readonly font: NativeFont, readonly fakery: number, readonly weight: number, readonly italic: number) {}
}

/** minikin's FontFamily: its fonts, their language tags and variant */
export class NativeFamily {
  private axisTags?: readonly number[];
  constructor(readonly fonts: readonly NativeFont[], readonly langTags = "", readonly variant = 0) {}
  /** getClosestMatch: the first member scoring lowest, a point per grade of weight and two for the slant */
  closest(weight: number, italic: boolean): NativeFont {
    const grade = Math.trunc(weight / 100);
    const score = (f: NativeFont) => Math.abs(grade - Math.trunc(f.weight / 100)) + (f.italic !== italic ? 2 : 0);
    let best = this.fonts[0];
    for (const f of this.fonts) if (score(f) < score(best)) best = f;
    return best;
  }
  /** the closest member as minikin draws it at a wanted style: a variable face set to the style on
   *  its wght and ital axes, and what it has no axis for faked: bold two grades short of a semi-bold
   *  or heavier weight, italic on an upright face */
  match(weight: number, italic: boolean): FakedFont {
    const font = this.closest(weight, italic), axes = font.supportedAxes, wght = axes.includes(WGHT), ital = axes.includes(ITAL);
    const fakery = (!wght && weight >= 600 && weight - font.weight >= 200 ? FAKE_BOLD : 0) | (!ital && italic && !font.italic ? FAKE_ITALIC : 0);
    return new FakedFont(font, fakery, wght ? weight : -1, ital ? +italic : -1);
  }
  /** the family's coverage, its regular face's (FontFamily::computeCoverage) */
  covers(c: number): boolean { return this.closest(400, false).covers(c); }
  get supportedAxes(): readonly number[] { return this.axisTags ??= [...new Set(this.fonts.flatMap((f) => f.supportedAxes))]; }
}

let familyPtr = "", axisTag = "", axisValue = "";
/** the native family behind a Java FontFamily */
export const familyOf = (f: object): NativeFamily =>
  deref<NativeFamily>((f as Record<string, bigint>)[familyPtr ||= declaredField("android/graphics/fonts/FontFamily", "mNativePtr")]);
/** Java FontVariationAxis objects as the axes minikin receives */
function axesOf(a: ArrayLike<object>): Axis[] {
  axisTag ||= declaredField("android/graphics/fonts/FontVariationAxis", "mTag");
  axisValue ||= declaredField("android/graphics/fonts/FontVariationAxis", "mStyleValue");
  return Array.from(a, (x) => ({ tag: (x as Record<string, number>)[axisTag], value: (x as Record<string, number>)[axisValue] }));
}

// ── hwui's Typeface
/** minikin's FontCollection: families in fallback order */
export class FontCollection {
  private axisTags?: readonly number[];
  constructor(readonly families: readonly NativeFamily[]) {}
  /** getSupportedAxes, sorted */
  get supportedAxes(): readonly number[] {
    return this.axisTags ??= [...new Set(this.families.flatMap((f) => f.supportedAxes))].sort((a, b) => a - b);
  }
}
/** hwui's Typeface: a collection, the style the API reports (Typeface.BOLD and ITALIC bits), the
 *  base weight relative styles derive from, and the style its text is drawn in */
export class NativeTypeface {
  constructor(readonly collection: FontCollection, readonly baseWeight: number, readonly apiStyle: number,
    readonly weight: number, readonly italic: boolean) {}
}
const BOLD = 1, ITALIC = 2, RESOLVE_BY_FONT_TABLE = -1;
/** computeMinikinStyle's weight */
const minikinWeight = (weight: number) => Math.min(1000, Math.max(1, weight));
/** Typeface::createRelative: the base weight 300 bolder for BOLD */
export const createRelative = (src: NativeTypeface, style: number) => new NativeTypeface(src.collection, src.baseWeight, style,
  minikinWeight(src.baseWeight + (style & BOLD ? 300 : 0)), (style & ITALIC) !== 0);
/** Typeface::createAbsolute: bold from semi-bold, as SkTypeface counts it */
export const createAbsolute = (src: NativeTypeface, weight: number, italic: boolean) => new NativeTypeface(src.collection, src.baseWeight,
  (weight >= 600 ? BOLD : 0) | (italic ? ITALIC : 0), minikinWeight(weight), italic);
/** Typeface::createWithDifferentBaseWeight, which a weight alias of fonts.xml is */
export const createWithBaseWeight = (src: NativeTypeface, weight: number) => createRelative(new NativeTypeface(src.collection, weight, 0, 0, false), src.apiStyle);
/** Typeface::createFromFamilies: the families, then the fallback's; a weight or slant left to the
 *  font table is the first family's regular face's */
export function createFromFamilies(families: NativeFamily[], weight: number, italic: number, fallback: NativeTypeface | null): NativeTypeface {
  const collection = new FontCollection(fallback ? families.concat(fallback.collection.families) : families);
  if (weight === RESOLVE_BY_FONT_TABLE || italic === RESOLVE_BY_FONT_TABLE) {
    const table = families[0]?.closest(400, false).style;
    if (weight === RESOLVE_BY_FONT_TABLE) weight = table ? table.weight : 400;
    if (italic === RESOLVE_BY_FONT_TABLE) italic = table?.italic ? 1 : 0;
  }
  if (weight < 0) weight = 400;
  return createAbsolute(new NativeTypeface(collection, weight, 0, 0, false), weight, italic !== 0);
}
/** Typeface::createFromTypefaceWithVariation: the style kept, each family supporting one of the
 *  axes rebuilt with them, the same collection when none does */
export function createWithVariation(src: NativeTypeface, list: object): NativeTypeface | Promise<NativeTypeface> {
  return after(vcall(list, "toArray", "()[Ljava/lang/Object;"), (array: object[]) => {
    const axes = axesOf(array), families = src.collection.families;
    const varies = (tags: readonly number[]) => axes.some((a) => tags.includes(a.tag));
    const same = () => new NativeTypeface(src.collection, src.baseWeight, src.apiStyle, src.weight, src.italic);
    if (!families.some((f) => varies(f.supportedAxes))) return same();
    const varied = families.map((f) => varies(f.supportedAxes)
      ? new NativeFamily(f.fonts.map((font) => varies(font.supportedAxes) ? font.clone(font.ttcIndex, font.weight, font.italic, axes) : font), f.langTags, f.variant) : f);
    return new NativeTypeface(new FontCollection(varied), src.baseWeight, src.apiStyle, src.weight, src.italic);
  });
}

let systemDefault: NativeTypeface | undefined;
/** Typeface::setDefault */
export const setDefaultTypeface = (t: NativeTypeface) => { systemDefault = t; };
/** Typeface::resolveDefault: null is the default */
export const resolveDefault = (t: NativeTypeface | null): NativeTypeface => t ?? systemDefault!;
let nativeInstance = "";
/** the native typeface behind a Java Typeface, the default for null */
export const typefaceOf = (t: object | null): NativeTypeface =>
  resolveDefault(t && deref<NativeTypeface>((t as Record<string, bigint>)[nativeInstance ||= declaredField("android/graphics/Typeface", "native_instance")]));

/** Typeface.create("sans-serif-medium", NORMAL), the face framework chrome uses (dialog buttons,
 *  picker values, the action bar title), once the system font map is loaded */
export let tfMedium: object | null = null;
/** the zygote's preload of the system font map (Typeface.DEFAULT and the named families) over the
 *  platform font index, with HarfBuzz and the default family's font loaded to measure text */
export async function loadSystemFontMap(): Promise<void> {
  const T = "android/graphics/Typeface";
  [fontIndex] = await Promise.all([pageShared("__wdFontIndex", fetchFontIndex), harfBuzz()]);
  await scall(T, "loadPreinstalledSystemFontMap", "()V");
  tfMedium = await scall(T, "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "sans-serif-medium", 0);
}

const fontSet = new Set<NativeFont>();
/** the system collections' fonts join the available font set (Typeface's registerGenericFamily and
 *  addFontCollections) */
export const addFontCollections = (t: NativeTypeface) => { for (const f of t.collection.families) for (const font of f.fonts) fontSet.add(font); };
/** SystemFonts::getAvailableFonts: the fonts of the system font map */
export const availableFonts = (): NativeFont[] => [...fontSet];
