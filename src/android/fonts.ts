// The native half of android.graphics.fonts and Typeface: minikin's Font, FontFamily and
// FontCollection, and hwui's Typeface. A font is one face of a font file: an app's bytes, or one of
// the reference build's /system/fonts or the device's updates of them, whose glyphs load when first
// shaped or drawn. A collection is
// families in fallback order, and a typeface draws from one with a weight and slant.

import { rt, awaited, noops, peerField, waits, type Gen, type JObj } from "../jvm/runtime.ts";
import { scall, vcall, after, newObj, initClass, linkClass } from "../jvm/natives/jentry.ts";
import { type JBuffer, readOnlyBuffer, addressOf, isExternal, readBufferBytes, writeBufferBytes } from "../jvm/natives/jnio.ts";
import { mkFd } from "../jvm/natives/jio.ts";
import { ashmemFd } from "./os.ts";
import { OS_CONSTANTS } from "./os-constants.ts";
import { PLATFORM_DATA } from "../jvm/bootclasspath.ts";
import { FONT_UPDATES } from "./font-updates.ts";
import { vfs } from "../shell/vfs.ts";
import { deref, handle, weakHandle, take, FINALIZER } from "./handles.ts";
import { harfBuzz } from "./harfbuzz.ts";
import { type FaceMetrics, type FaceInfo, type FvarAxis, faceInfo, faceCount, sfntTables, T_CMAP, fontRevision, postScriptName, isPostScriptType1 } from "./sfnt.ts";

/** minikin's FontVariation: an OpenType axis tag and its value */
export interface Axis { tag: number; value: number }
// ── font files
/** A font whose bytes are not in memory yet. Text natives run synchronously over loaded fonts and
 *  throw this to wait for one, then run again (withFonts). */
export class FontPending { readonly wait: Promise<unknown>; constructor(wait: Promise<unknown>) { this.wait = wait; } }
/** `f()`, again once any font it reached has loaded; `f` must have no effect before it reads fonts.
 *  A native over a primitive array reads it into a value before it gets here, so a wait holds no view
 *  of linear memory; one that writes an array after the fonts takes `fontsOrRetry` and `retries`. */
export function withFonts<T>(f: () => T): T | Promise<T> {
  try { return f(); } catch (e) {
    if (e instanceof FontPending) return e.wait.then(() => withFonts(f));
    throw e;
  }
}
/** f's answer or, while a font it reads loads, a Promise that settles once it has: for a native that `retries`, called again then */
export function fontsOrRetry<T>(f: () => T): T | Promise<unknown> {
  try { return f(); } catch (e) {
    if (e instanceof FontPending) return e.wait;
    throw e;
  }
}
/** one font file: its bytes in memory, or a reference-build font file (isPlatformFont) read whole on
 *  first use. A platform file is the tab's: its realms share its bytes, and so HarfBuzz's face of it. */
class FontFile {
  private data: Uint8Array | null; readonly path: string;
  private loading?: Promise<void>;
  constructor(data: Uint8Array | null, path = "") { this.data = data; this.path = path; }
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
/** whether `path` is a reference-build font file, or an update of one, which loads lazily */
export const isPlatformFont = (path: string) => /^\/(system\/fonts|data\/fonts\/files)\//.test(path) && path in PLATFORM_DATA;
/** the file the device serves for a system font named without a PostScript name: its update, found
 *  by the name FontListParser derives from the file's (findUpdatedFontFile) */
export const servedFont = (path: string) => FONT_UPDATES.postScriptMap[path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf("."))] ?? path;
const files = new Map<string, FontFile>();
function platformFile(path: string): FontFile {
  let file = files.get(path);
  if (!file) files.set(path, file = new FontFile(null, path));
  return file;
}
/** a platform font file's bytes, read once per tab for HarfBuzz and Skia alike */
export async function platformFontBytes(path: string): Promise<Uint8Array> {
  const file = platformFile(path);
  await file.load();
  return file.bytes;
}
/** Typeface's nativeWarmUpCache: a system font read ahead, as the device pages its file in */
export const warmUpCache = (path: string): Promise<void> | void => isPlatformFont(path) ? platformFile(path).load() : undefined;

// The device's system server hands apps a serialized font map holding each font's style and
// coverage, so a process finds a family for a character without reading its fonts or parsing the
// font configuration. The page's equivalent is /font-index.json, built from the same files: each
// face's FaceInfo (platformFontIndex) and Typeface.serializeFontMap's bytes (scripts/font-index.ts).
type IndexedFace = Omit<FaceInfo, "coverage"> & { coverage: number[] };
/** the faces by "path#ttcIndex", and the serialized system font map in base64 */
export interface FontIndex { faces: Record<string, IndexedFace>; fontMap?: string }
let indexed: Promise<FontIndex> | undefined;
let fontIndex: FontIndex | null = null;
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
async function fetchFontIndex(): Promise<FontIndex> {
  if (typeof location === "undefined" || !location.protocol.startsWith("http")) return { faces: await platformFontIndex() };
  const res = await fetch("/font-index.json");
  if (!res.ok) throw new Error(`font-index.json: ${res.status}`);
  return res.json();
}
function indexedFace(path: string, ttcIndex: number): FaceInfo {
  const f = fontIndex?.faces[`${path}#${ttcIndex}`];
  if (!f) throw new Error(`${path} #${ttcIndex} is not in the platform font index`);
  const coverage = new Uint32Array(f.coverage.length);
  for (let i = 0, at = 0; i < coverage.length; i++) coverage[i] = at += f.coverage[i];
  return { ...f, coverage };
}

let sourceIds = 0;
/** minikin::Font over its MinikinFontSkia: one face of a font file, the style it is selected by,
 *  and the axes, path and locales it was built with. A clone shares the source id and file. */
export class NativeFont {
  readonly file: FontFile; readonly ttcIndex: number; readonly weight: number; readonly italic: boolean; readonly axes: readonly Axis[]; readonly locales: string; readonly sourceId: number;
  private face?: FaceInfo;
  constructor(file: FontFile, ttcIndex: number, weight: number, italic: boolean,
    axes: readonly Axis[] = [], locales = "", sourceId = sourceIds++) { this.file = file; this.ttcIndex = ttcIndex; this.weight = weight; this.italic = italic; this.axes = axes; this.locales = locales; this.sourceId = sourceId; }
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
class FontWrapper { readonly font: NativeFont; constructor(font: NativeFont) { this.font = font; } }
export const fontOf = (h: bigint) => deref<FontWrapper>(h).font;
export const wrapFont = (f: NativeFont) => handle(new FontWrapper(f));
/** minikin's FontFakery bits */
export const FAKE_BOLD = 1, FAKE_ITALIC = 2;
export const WGHT = 0x77676874, ITAL = 0x6974616c, WDTH = 0x77647468;
/** minikin's FakedFont: a font, its fakery bits, and the wght/ital values a variable font is set
 *  to in place of faking (-1 where the font has no such axis) */
export class FakedFont {
  readonly font: NativeFont; readonly fakery: number; readonly weight: number; readonly italic: number;
  constructor(font: NativeFont, fakery: number, weight: number, italic: number) { this.font = font; this.fakery = fakery; this.weight = weight; this.italic = italic; }
}

/** minikin's FontFamily: its fonts, their language tags and variant */
export class NativeFamily {
  readonly fonts: readonly NativeFont[]; readonly langTags: string; readonly variant: number;
  private axisTags?: readonly number[];
  constructor(fonts: readonly NativeFont[], langTags = "", variant = 0) { this.fonts = fonts; this.langTags = langTags; this.variant = variant; }
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

const familyPtr = peerField<bigint>("android/graphics/fonts/FontFamily", "mNativePtr");
const axisTag = peerField<number>("android/graphics/fonts/FontVariationAxis", "mTag");
const axisValue = peerField<number>("android/graphics/fonts/FontVariationAxis", "mStyleValue");
/** the native family behind a Java FontFamily */
export const familyOf = (f: object): NativeFamily => deref<NativeFamily>(familyPtr(f));
/** Java FontVariationAxis objects as the axes minikin receives */
const axesOf = (a: ArrayLike<object>): Axis[] => Array.from(a, (x) => ({ tag: axisTag(x), value: axisValue(x) }));

// ── hwui's Typeface
/** minikin's FontCollection: families in fallback order */
export class FontCollection {
  readonly families: readonly NativeFamily[];
  private axisTags?: readonly number[];
  constructor(families: readonly NativeFamily[]) { this.families = families; }
  /** getSupportedAxes, sorted */
  get supportedAxes(): readonly number[] {
    return this.axisTags ??= [...new Set(this.families.flatMap((f) => f.supportedAxes))].sort((a, b) => a - b);
  }
}
/** hwui's Typeface: a collection, the style the API reports (Typeface.BOLD and ITALIC bits), the
 *  base weight relative styles derive from, and the style its text is drawn in */
export class NativeTypeface {
  readonly collection: FontCollection; readonly baseWeight: number; readonly apiStyle: number; readonly weight: number; readonly italic: boolean;
  constructor(collection: FontCollection, baseWeight: number, apiStyle: number,
    weight: number, italic: boolean) { this.collection = collection; this.baseWeight = baseWeight; this.apiStyle = apiStyle; this.weight = weight; this.italic = italic; }
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
const typefaceInstance = peerField<bigint>("android/graphics/Typeface", "native_instance");
/** the native typeface behind a Java Typeface, the default for null */
export const typefaceOf = (t: object | null): NativeTypeface => resolveDefault(t && deref<NativeTypeface>(typefaceInstance(t)));

/** the zygote's share of text: the platform font index and HarfBuzz loaded, and Typeface's preloaded
 *  class initialized (its default fonts read ahead). The system font map is the application's, from
 *  bindApplication (systemFontMap). */
export function* preloadFonts(): Gen<void> {
  [fontIndex] = yield* awaited(Promise.all([indexed ??= fetchFontIndex(), harfBuzz()]));
  yield initClass("android/graphics/Typeface");
}
let fontMapMemory: JObj | undefined;
/** the serialized system font map bindApplication receives, as FontManagerService shares it: the
 *  index's, or one serialized here where the index carries none (a headless realm); none in a realm
 *  that loaded no fonts */
export function* systemFontMap(): Gen<JObj | null> {
  if (!fontIndex) return null;
  return fontMapMemory ??= fontIndex.fontMap
    ? yield newObj("android/os/SharedMemory", "(Ljava/io/FileDescriptor;)V", yield mkFd(ashmemFd(Uint8Array.fromBase64(fontIndex.fontMap), OS_CONSTANTS.PROT_READ)))
    : yield* serializeSystemFontMap();
}
/** FontManagerService.serializeFontMap over its system font configuration: the preinstalled one with
 *  each font an update replaces, by PostScript name, read from the update's file
 *  (UpdatableFontDir.getSystemFontConfig) */
function* serializeSystemFontMap(): Gen<JObj> {
  const SF = "android/graphics/fonts/SystemFonts", CONFIG = "Landroid/text/FontConfig;", files = yield newObj("android/util/ArrayMap", "()V");
  for (const [name, path] of Object.entries(FONT_UPDATES.postScriptMap))
    yield vcall(files, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", name, yield newObj("java/io/File", "(Ljava/lang/String;)V", path));
  const config = yield scall(SF, "getSystemFontConfig", `(Ljava/util/Map;JI)${CONFIG}`, files, BigInt(FONT_UPDATES.lastModifiedDate), FONT_UPDATES.configVersion);
  const fallback = yield scall(SF, "buildSystemFallback", `(${CONFIG}Landroid/util/ArrayMap;)Ljava/util/Map;`, config, yield newObj("android/util/ArrayMap", "()V"));
  const typefaces = yield scall(SF, "buildSystemTypefaces", `(${CONFIG}Ljava/util/Map;)Ljava/util/Map;`, config, fallback);
  return yield scall("android/graphics/Typeface", "serializeFontMap", "(Ljava/util/Map;)Landroid/os/SharedMemory;", typefaces);
}
/** the zygote's preload and the font map bindApplication sets, for a realm that binds no application */
export function* loadSystemFontMap(): Gen<void> {
  yield* preloadFonts();
  yield scall("android/graphics/Typeface", "setSystemFontMap", "(Landroid/os/SharedMemory;)V", yield* systemFontMap());
}

// minikin's FontCollection::writeVector and readVector: typefaces over shared collections and families
// of reference-build fonts, a font written as its path and style as MinikinFontSkia writes one. The
// format is these natives' own: a length, then JSON.
type SerializedFont = [path: string, ttcIndex: number, weight: number, italic: boolean, axes: [number, number][], locales: string];
interface SerializedTypefaces {
  fonts: SerializedFont[]; families: (readonly [fonts: number[], langTags: string, variant: number])[]; collections: number[][];
  typefaces: [collection: number, baseWeight: number, apiStyle: number, weight: number, italic: boolean][];
}
/** Typeface.nativeWriteTypefaces' bytes */
export function writeTypefaces(typefaces: readonly NativeTypeface[]): Uint8Array {
  const out: SerializedTypefaces = { fonts: [], families: [], collections: [], typefaces: [] }, ids = new Map<object, number>();
  const id = <T extends object, V>(o: T, list: V[], write: (o: T) => V): number => {
    let i = ids.get(o);
    if (i === undefined) { const v = write(o); ids.set(o, i = list.length); list.push(v); }
    return i;
  };
  const font = (f: NativeFont): SerializedFont => {
    if (!isPlatformFont(f.path)) throw new Error(`${f.path || "a font in memory"} is not a system font`);
    return [f.path, f.ttcIndex, f.weight, f.italic, f.axes.map((a) => [a.tag, a.value]), f.locales];
  };
  const family = (f: NativeFamily) => [f.fonts.map((x) => id(x, out.fonts, font)), f.langTags, f.variant] as const;
  const collection = (c: FontCollection) => c.families.map((f) => id(f, out.families, family));
  for (const t of typefaces) out.typefaces.push([id(t.collection, out.collections, collection), t.baseWeight, t.apiStyle, t.weight, t.italic]);
  const json = new TextEncoder().encode(JSON.stringify(out)), bytes = new Uint8Array(4 + json.length);
  new DataView(bytes.buffer).setUint32(0, json.length);
  bytes.set(json, 4);
  return bytes;
}
/** Typeface.nativeReadTypefaces: the typefaces `bytes` begins with */
export function readTypefaces(bytes: Uint8Array): NativeTypeface[] {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const s: SerializedTypefaces = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
  const fonts = s.fonts.map(([path, ttc, weight, italic, axes, locales]) =>
    NativeFont.platform(path, ttc, weight, italic, axes.map(([tag, value]) => ({ tag, value })), locales));
  const families = s.families.map(([members, langTags, variant]) => new NativeFamily(members.map((i) => fonts[i]), langTags, variant));
  const collections = s.collections.map((c) => new FontCollection(c.map((i) => families[i])));
  return s.typefaces.map(([c, baseWeight, apiStyle, weight, italic]) => new NativeTypeface(collections[c], baseWeight, apiStyle, weight, italic));
}

const fontSet = new Set<NativeFont>();
/** the system collections' fonts join the available font set (Typeface's registerGenericFamily and
 *  addFontCollections) */
export const addFontCollections = (t: NativeTypeface) => { for (const f of t.collection.families) for (const font of f.fonts) fontSet.add(font); };
/** SystemFonts::getAvailableFonts: the fonts of the system font map */
export const availableFonts = (): NativeFont[] => [...fontSet];

// ── android.graphics.Typeface ──────────────────────────────────────────────────────────
// hwui's Typeface over the collections above; a null handle is the default, as resolveDefault has it
const typefaceAt = (h: bigint) => resolveDefault(h ? deref<NativeTypeface>(h) : null);
rt.registerJnis("android/graphics/Typeface", {
  "nativeGetReleaseFunc()J": () => FINALIZER,
  "nativeCreateFromTypeface(JI)J": (h: bigint, style: number) => handle(createRelative(typefaceAt(h), style)),
  "nativeCreateFromTypefaceWithExactStyle(JIZ)J": (h: bigint, weight: number, italic: number) => handle(createAbsolute(typefaceAt(h), weight, !!italic)),
  "nativeCreateFromTypefaceWithVariation(JLjava/util/List;)J": (h: bigint, axes: object) => after(createWithVariation(typefaceAt(h), axes), handle),
  "nativeCreateWeightAlias(JI)J": (h: bigint, weight: number) => handle(createWithBaseWeight(typefaceAt(h), weight)),
  "nativeCreateFromArray([JJII)J": (families: BigInt64Array, fallback: bigint, weight: number, italic: number) =>
    handle(createFromFamilies(Array.from(families, (h) => deref<NativeFamily>(h)), weight, italic, fallback ? deref<NativeTypeface>(fallback) : null)),
  "nativeGetStyle(J)I": (h: bigint) => deref<NativeTypeface>(h).apiStyle,
  "nativeGetWeight(J)I": (h: bigint) => deref<NativeTypeface>(h).weight,
  "nativeGetSupportedAxes(J)[I": (h: bigint) => {
    const axes = deref<NativeTypeface>(h).collection.supportedAxes;
    return axes.length ? Int32Array.from(axes) : null;
  },
  "nativeSetDefault(J)V": (h: bigint) => { setDefaultTypeface(deref<NativeTypeface>(h)); },
  // DEFAULT and the other constants are static finals setSystemFontMap assigns
  "nativeForceSetStaticFinalField(Ljava/lang/String;Landroid/graphics/Typeface;)V": (name: string, t: object) => {
    linkClass("android/graphics/Typeface").setStatic(name, t, "Landroid/graphics/Typeface;");
  },
  // the system collections make up the available font set; minikin's registry of locale lists
  // serves its own lookups, which paint.ts keeps
  "nativeRegisterGenericFamily(Ljava/lang/String;J)V": (_name: string, h: bigint) => addFontCollections(typefaceAt(h)),
  "nativeAddFontCollections(J)V": (h: bigint) => addFontCollections(typefaceAt(h)),
  ...noops("nativeRegisterLocaleList(Ljava/lang/String;)V"),
  "nativeWarmUpCache(Ljava/lang/String;)V": waits((path: string) => warmUpCache(path)),
  // the font map the system server serializes for applications (Typeface.serializeFontMap)
  "nativeReadTypefaces(Ljava/nio/ByteBuffer;I)[J": waits((b: JBuffer, at: number) =>
    after(readBufferBytes(b, at), bytes => BigInt64Array.from(readTypefaces(bytes), handle))),
  "nativeWriteTypefaces(Ljava/nio/ByteBuffer;I[J)I": waits((b: JBuffer | null, at: number, typefaces: BigInt64Array) => {
    const bytes = writeTypefaces(Array.from(typefaces, (h) => deref<NativeTypeface>(h)));
    return b ? after(writeBufferBytes(b, bytes, at), () => bytes.length) : bytes.length;
  }),
});

// ── android.graphics.fonts ─────────────────────────────────────────────────────────────
// minikin's Font and FontFamily are NativeFont and NativeFamily.
/** a direct buffer's bytes, as GetDirectBufferAddress and GetDirectBufferCapacity see them;
 *  guest memory can move, so bytes there are copied */
function directBytes<T>(b: JBuffer | null, then: (bytes: Uint8Array) => T): T | Promise<T> {
  if (!b) rt.npe();
  const address = addressOf(b!);
  if (!address) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a direct buffer");
  return after(readBufferBytes(b!), bytes => then(isExternal(address) ? bytes : bytes.slice()));
}
const PACKED_ITALIC = 1 << 16;
rt.registerJnis("android/graphics/fonts/Font$Builder", {
  "nInitBuilder()J": () => handle({ axes: [] as Axis[] }),
  "nAddAxis(JIF)V": (b: bigint, tag: number, value: number) => { deref<{ axes: Axis[] }>(b).axes.push({ tag, value }); },
  "nBuild(JLjava/nio/ByteBuffer;Ljava/lang/String;Ljava/lang/String;IZI)J": waits((b: bigint, buffer: JBuffer | null, path: string, locales: string, weight: number, italic: number, ttcIndex: number) => {
    const { axes } = take<{ axes: Axis[] }>(b);
    // a system font is the mapping of its file: its glyphs load when first shaped or drawn
    if (buffer && isExternal(addressOf(buffer)) && isPlatformFont(path)) return wrapFont(NativeFont.platform(path, ttcIndex, weight, !!italic, axes, locales));
    return directBytes(buffer, (bytes) => {
      const font = NativeFont.of(bytes, ttcIndex, weight, !!italic, axes, path, locales);
      // what FreeType cannot open as a face (no head or hhea) Skia makes no typeface of
      if (!font.faceMetrics) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Failed to create internal object. maybe invalid font data.");
      return wrapFont(font);
    });
  }),
  // Skia's makeClone over the same data: new axes, style and collection index
  "nClone(JJIZI)J": (font: bigint, b: bigint, weight: number, italic: number, ttcIndex: number) => {
    const { axes } = take<{ axes: Axis[] }>(b);
    return wrapFont(fontOf(font).clone(ttcIndex, weight, !!italic, axes));
  },
});
// shaping.ts registers the Font natives that measure at a paint's size
rt.registerJnis("android/graphics/fonts/Font", {
  "nGetReleaseNativeFont()J": () => FINALIZER,
  "nCloneFont(J)J": (h: bigint) => wrapFont(fontOf(h)),
  "nNewByteBuffer(J)Ljava/nio/ByteBuffer;": (h: bigint) => withFonts(() => readOnlyBuffer(fontOf(h).bytes)),
  // identity only: Font.equals compares these
  "nGetMinikinFontPtr(J)J": (h: bigint) => weakHandle(fontOf(h)),
  "nGetSourceId(J)I": (h: bigint) => fontOf(h).sourceId,
  "nGetFontPath(J)Ljava/lang/String;": (h: bigint) => fontOf(h).path,
  "nGetLocaleList(J)Ljava/lang/String;": (h: bigint) => fontOf(h).locales,
  "nGetPackedStyle(J)I": (h: bigint) => { const f = fontOf(h); return f.weight | (f.italic ? PACKED_ITALIC : 0); },
  "nGetIndex(J)I": (h: bigint) => fontOf(h).ttcIndex,
  "nGetAxisCount(J)I": (h: bigint) => fontOf(h).axes.length,
  "nGetAxisInfo(JI)J": (h: bigint, i: number) => {
    const a = fontOf(h).axes[i];
    return BigInt(a.tag >>> 0) << 32n | BigInt(new Uint32Array(Float32Array.of(a.value).buffer)[0]);
  },
  "nGetAvailableFontSet()[J": () => BigInt64Array.from(availableFonts(), wrapFont),
});
rt.registerJnis("android/graphics/fonts/FontFamily$Builder", {
  "nInitBuilder()J": () => handle({ fonts: [] as NativeFont[] }),
  "nAddFont(JJ)V": (b: bigint, font: bigint) => { deref<{ fonts: NativeFont[] }>(b).fonts.push(fontOf(font)); },
  // minikin rejects a family whose default face has no cmap (no coverage); system fonts have theirs
  "nBuild(JLjava/lang/String;IZZI)J": (b: bigint, langTags: string | null, variant: number) => {
    const family = new NativeFamily(take<{ fonts: NativeFont[] }>(b).fonts, langTags ?? "", variant), regular = family.closest(400, false);
    if (!isPlatformFont(regular.path) && !sfntTables(regular.bytes, regular.ttcIndex)?.at.has(T_CMAP)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Failed to create internal object. maybe invalid font data");
    return handle(family);
  },
  "nGetReleaseNativeFamily()J": () => FINALIZER,
});
rt.registerJnis("android/graphics/fonts/FontFamily", {
  "nGetFont(JI)J": (h: bigint, i: number) => wrapFont(deref<NativeFamily>(h).fonts[i]),
  "nGetFontSize(J)I": (h: bigint) => deref<NativeFamily>(h).fonts.length,
  "nGetLangTags(J)Ljava/lang/String;": (h: bigint) => deref<NativeFamily>(h).langTags,
  "nGetVariant(J)I": (h: bigint) => deref<NativeFamily>(h).variant,
});
rt.registerJnis("android/graphics/fonts/FontFileUtil", {
  "nGetFontRevision(Ljava/nio/ByteBuffer;I)J": waits((b: JBuffer | null, index: number) => directBytes(b, (bytes) => fontRevision(bytes, index))),
  "nGetFontPostScriptName(Ljava/nio/ByteBuffer;I)Ljava/lang/String;": waits((b: JBuffer | null, index: number) => directBytes(b, (bytes) => postScriptName(bytes, index))),
  "nIsPostScriptType1Font(Ljava/nio/ByteBuffer;I)I": waits((b: JBuffer | null, index: number) => directBytes(b, (bytes) => isPostScriptType1(bytes, index))),
});
