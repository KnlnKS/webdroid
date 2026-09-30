// The native half of android.graphics.fonts and Typeface: minikin's Font, FontFamily and
// FontCollection, and hwui's Typeface. A font is the bytes of one face; a family becomes one CSS
// font family (each member a FontFace with its own weight/style, which is how CSS selects within a
// family); a collection is a CSS family list in fallback order, and a typeface draws from one with
// a weight and slant.

import { declaredField } from "../jvm/runtime";
import { scall, vcall, after } from "../jvm/natives/jlang";
import { vfs } from "../shell/vfs";
import { pageShared } from "../shell/pageshared";
import { utf8 } from "../jvm/abi";
import { deref, handle } from "./handles";

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
const T_OS2 = 0x4f532f32, T_HHEA = 0x68686561, T_HEAD = 0x68656164, T_NAME = 0x6e616d65, T_CFF = 0x43464620, T_CFF2 = 0x43464632, T_FVAR = 0x66766172;
export const T_CMAP = 0x636d6170;
const T_GLYF = 0x676c7966, T_CBLC = 0x43424c43;
const isScalable = (at: Map<number, number>) => at.has(T_GLYF) || at.has(T_CFF) || at.has(T_CFF2);

/** weight/italic from the face's OS/2 table (what AOSP's analyzeStyle reads), null if absent */
export function sfntStyle(b: Uint8Array, ttcIndex = 0): { weight: number; italic: boolean } | null {
  const t = sfntTables(b, ttcIndex);
  const off = t?.at.get(T_OS2);
  if (!t || off === undefined || off + 64 > b.length) return null;
  return { weight: t.dv.getUint16(off + 4), italic: (t.dv.getUint16(off + 62) & 1) !== 0 };
}

/** FreeType's scalable-face metrics as Skia reads them, in ems: hhea ascender/descender and line
 *  gap, and head's bounding box for top/bottom (all positive downwards from the baseline). A face
 *  with only bitmaps (a CBDT emoji font) has its largest strike's line metrics, scaled. */
export interface FaceMetrics { ascent: number; descent: number; top: number; bottom: number; leading: number }
function sfntMetrics(b: Uint8Array, ttcIndex = 0): FaceMetrics | null {
  const t = sfntTables(b, ttcIndex);
  const head = t?.at.get(T_HEAD), hhea = t?.at.get(T_HHEA);
  if (!t || head === undefined || hhea === undefined || head + 44 > b.length || hhea + 10 > b.length) return null;
  const upem = t.dv.getUint16(head + 18), cblc = t.at.get(T_CBLC);
  if (!upem) return null;
  if (!isScalable(t.at) && cblc !== undefined && cblc + 8 <= b.length) {
    let best = -1;
    for (let i = 0, n = t.dv.getUint32(cblc + 4), at = cblc + 8; i < n && at + 48 <= b.length; i++, at += 48)
      if (best < 0 || b[at + 45] > b[best + 45]) best = at;
    if (best >= 0 && b[best + 45]) {
      const ppem = b[best + 45], asc = t.dv.getInt8(best + 16) / ppem, desc = -t.dv.getInt8(best + 17) / ppem;
      return { ascent: asc, descent: desc, top: asc, bottom: desc, leading: 0 };
    }
  }
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

/** the variation axes a face declares in its fvar table */
function fvarAxes(b: Uint8Array, ttcIndex: number): number[] {
  const t = sfntTables(b, ttcIndex), fvar = t?.at.get(T_FVAR);
  if (!t || fvar === undefined || fvar + 12 > b.length) return [];
  const count = t.dv.getUint16(fvar + 8), size = t.dv.getUint16(fvar + 10), tags: number[] = [];
  for (let i = 0, at = fvar + t.dv.getUint16(fvar + 4); i < count && at + 4 <= b.length; i++, at += size) tags.push(t.dv.getUint32(at));
  return tags;
}

// ── the system fonts
/** Android's Roboto, a variable font: hhea ascender/descender and head yMax/yMin over 2048 units */
export const SYSTEM_FONT: FaceMetrics = { ascent: 1900 / 2048, descent: 500 / 2048, top: 2163 / 2048, bottom: 555 / 2048, leading: 0 };
interface SystemFamily { css: string; name?: string; lang?: string; metrics?: FaceMetrics; faces: readonly (readonly [file: string, weight: number, italic: boolean])[] }
/** The families under /system/fonts, as the device's font configuration declares them, each one CSS
 *  family on the page. The Roboto statics stand in for instances of the device's variable Roboto,
 *  so they keep its metrics; the emoji families are its und-Zsye fallbacks. */
export const SYSTEM_FAMILIES: readonly SystemFamily[] = [
  { css: "Roboto", name: "sans-serif", metrics: SYSTEM_FONT,
    faces: [["Roboto-Regular.ttf", 400, false], ["Roboto-Medium.ttf", 500, false], ["Roboto-Bold.ttf", 700, false], ["Roboto-Italic.ttf", 400, true]] },
  { css: "Noto Emoji", lang: "und-Zsye", faces: [["NotoColorEmoji.ttf", 400, false]] },
  { css: "Noto Emoji Flags", lang: "und-Zsye", faces: [["NotoColorEmojiFlags.ttf", 400, false]] },
];
/** the device's aliases of sans-serif; its other families and aliases name fonts the page lacks */
const SANS_SERIF_ALIASES = [["sans-serif-thin", 100], ["sans-serif-light", 300], ["sans-serif-medium", 500], ["sans-serif-black", 900],
  ["arial", 400], ["helvetica", 400], ["tahoma", 400], ["verdana", 400]] as const;
/** the files under /system/fonts, in SYSTEM_FAMILIES order */
export const SYSTEM_FONT_FILES = SYSTEM_FAMILIES.flatMap((f) => f.faces.map(([file]) => file));
const SYSTEM_FACES = new Map<string, { family: SystemFamily; weight: number; italic: boolean }>(SYSTEM_FAMILIES.flatMap((family) =>
  family.faces.map(([file, weight, italic]) => [`/system/fonts/${file}`, { family, weight, italic }] as const)));
const familyXml = (f: SystemFamily) => `<family${f.name ? ` name="${f.name}"` : ""}${f.lang ? ` lang="${f.lang}"` : ""}>` +
  f.faces.map(([file, weight, italic]) => `<font weight="${weight}" style="${italic ? "italic" : "normal"}">${file}</font>`).join("") + "</family>";
const fontsXml = (attrs: string) => `<?xml version="1.0" encoding="utf-8"?><familyset${attrs}>${familyXml(SYSTEM_FAMILIES[0])}` +
  SANS_SERIF_ALIASES.map(([name, weight]) => `<alias name="${name}" to="sans-serif"${weight === 400 ? "" : ` weight="${weight}"`}/>`).join("") +
  SYSTEM_FAMILIES.slice(1).map(familyXml).join("") + "</familyset>";

declare global { interface Window { __wdSystemFonts?: Promise<Uint8Array[]> } }
/** the system faces' bytes, in SYSTEM_FAMILIES order, fetched once per tab */
export function fetchSystemFonts(): Promise<Uint8Array[]> {
  return pageShared("__wdSystemFonts", () => Promise.all(SYSTEM_FONT_FILES.map(async (file) => {
    const res = await fetch(`/vendor/fonts/${file}`);
    if (!res.ok) throw new Error(`font ${file}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }))).then((list) => list.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
}
/** a realm's /system/fonts, and the font configuration naming them (the legacy and current files) */
export function mountSystemFonts(bytes: readonly Uint8Array[]): void {
  SYSTEM_FONT_FILES.forEach((file, i) => vfs.write(`/system/fonts/${file}`, bytes[i]));
  vfs.write("/system/etc/fonts.xml", utf8.enc.encode(fontsXml(' version="23"')));
  vfs.write("/system/etc/font_fallback.xml", utf8.enc.encode(fontsXml("")));
}
/** the page's FontFaces for the system faces, which its realms share */
export async function registerSystemFonts(bytes: readonly Uint8Array[]): Promise<void> {
  await Promise.all(SYSTEM_FONT_FILES.map((file, i) => {
    const path = `/system/fonts/${file}`, { family, weight, italic } = SYSTEM_FACES.get(path)!;
    return registerFace(new NativeFont(bytes[i], 0, weight, italic, [], path), family.css);
  }));
}

let sourceIds = 0;
/** minikin::Font over its MinikinFontSkia: one face of a font file, the style it is selected by,
 *  and the axes, path and locales it was built with. A clone shares the source id and bytes. */
export class NativeFont {
  private metrics?: FaceMetrics | null;
  private outlines?: boolean;
  private axisTags?: readonly number[];
  constructor(readonly bytes: Uint8Array, readonly ttcIndex: number, readonly weight: number, readonly italic: boolean,
    readonly axes: readonly Axis[] = [], readonly path = "", readonly locales = "", readonly sourceId = sourceIds++) {}
  get faceMetrics(): FaceMetrics | null {
    return this.metrics === undefined ? (this.metrics = SYSTEM_FACES.get(this.path)?.family.metrics ?? sfntMetrics(this.bytes, this.ttcIndex)) : this.metrics;
  }
  get supportedAxes(): readonly number[] { return this.axisTags ??= fvarAxes(this.bytes, this.ttcIndex); }
  /** whether the face has outlines, which FreeType hints: a bitmap-only face has linear advances */
  get scalable(): boolean { return this.outlines ??= isScalable(sfntTables(this.bytes, this.ttcIndex)?.at ?? new Map()); }
}
// A Java Font's pointer is a FontWrapper: every Java Font (FontFamily.getFont, a buffer's clone, a
// shaped glyph's font) owns its own reference, which its registry releases, to a font others share.
class FontWrapper { constructor(readonly font: NativeFont) {} }
export const fontOf = (h: bigint) => deref<FontWrapper>(h).font;
export const wrapFont = (f: NativeFont) => handle(new FontWrapper(f));
/** minikin's FontFakery bits for drawing `face` at a wanted weight and slant: bold faked two grades
 *  short of a semi-bold or heavier weight, italic on an upright face */
export const FAKE_BOLD = 1, FAKE_ITALIC = 2;
export const fakery = (face: NativeFont, weight: number, italic: boolean) =>
  (weight >= 600 && weight - face.weight >= 200 ? FAKE_BOLD : 0) | (italic && !face.italic ? FAKE_ITALIC : 0);

const availableFaces = new Map<string, NativeFont>();
/** the system collection's fonts (Font.getAvailableFonts), as installed under /system/fonts */
export async function systemFonts(): Promise<NativeFont[]> {
  const out: NativeFont[] = [];
  for (const [path, { weight, italic }] of SYSTEM_FACES) {
    let font = availableFaces.get(path);
    if (!font) {
      const bytes = await vfs.readFile(path);
      if (!bytes) continue;
      availableFaces.set(path, font = new NativeFont(bytes, 0, weight, italic, [], path));
    }
    out.push(font);
  }
  return out;
}

const familyCss = new WeakMap<NativeFont, string>();
/** the CSS family the page draws `font` from */
export const cssFamily = (font: NativeFont): string | undefined => SYSTEM_FACES.get(font.path)?.family.css ?? familyCss.get(font);

/** minikin's FontFamily: its fonts, registered under one CSS family */
export class NativeFamily {
  private axisTags?: readonly number[];
  constructor(readonly fonts: readonly NativeFont[], readonly css: string, readonly langTags = "", readonly variant = 0) {}
  /** getClosestMatch: the first member scoring lowest, a point per grade of weight and two for the slant */
  closest(weight: number, italic: boolean): NativeFont {
    const grade = Math.trunc(weight / 100);
    const score = (f: NativeFont) => Math.abs(grade - Math.trunc(f.weight / 100)) + (f.italic !== italic ? 2 : 0);
    let best = this.fonts[0];
    for (const f of this.fonts) if (score(f) < score(best)) best = f;
    return best;
  }
  get supportedAxes(): readonly number[] { return this.axisTags ??= [...new Set(this.fonts.flatMap((f) => f.supportedAxes))]; }
}

/** Register one face under a CSS family. The load is awaited so no text is ever measured against
 *  a face that later swaps in (every width memo in graphics.ts is keyed by font string alone). */
async function registerFace(f: NativeFont, family: string): Promise<void> {
  if (typeof FontFace === "undefined") return;
  const b = f.bytes, vm = f.faceMetrics;
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
/** the CSS family the page registered for exactly these faces, if they are one system family */
function pageFamily(fonts: readonly NativeFont[]): string | null {
  const family = fonts.length ? SYSTEM_FACES.get(fonts[0].path)?.family : undefined;
  if (!family || family.faces.length !== fonts.length) return null;
  for (const f of fonts) {
    const face = SYSTEM_FACES.get(f.path);
    if (face?.family !== family || f.weight !== face.weight || f.italic !== face.italic || f.ttcIndex || f.axes.length) return null;
  }
  return family.css;
}
let familySeq = 0;
/** a family of these faces: the page's own for its system faces, otherwise a fresh CSS family name,
 *  every face loaded before it is used */
export async function mkFamily(fonts: readonly NativeFont[], langTags = "", variant = 0): Promise<NativeFamily> {
  const page = pageFamily(fonts);
  if (page) return new NativeFamily(fonts, page, langTags, variant);
  const fam = new NativeFamily(fonts, "wd-font-" + (++familySeq), langTags, variant);
  for (const f of fonts) { familyCss.set(f, fam.css); await registerFace(f, fam.css); }
  return fam;
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
/** minikin's FontCollection: families in fallback order, one CSS font-family list */
export class FontCollection {
  readonly css: string;
  private axisTags?: readonly number[];
  constructor(readonly families: readonly NativeFamily[]) { this.css = [...new Set(families.map((f) => f.css))].join(", "); }
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
    const regular = families[0]?.closest(400, false), table = regular && sfntStyle(regular.bytes, regular.ttcIndex);
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
    return Promise.all(families.map((f) => varies(f.supportedAxes) ? mkFamily(f.fonts.map((font) => varies(font.supportedAxes)
      ? new NativeFont(font.bytes, font.ttcIndex, font.weight, font.italic, axes, font.path, font.locales, font.sourceId) : font), f.langTags, f.variant) : f))
      .then((varied) => new NativeTypeface(new FontCollection(varied), src.baseWeight, src.apiStyle, src.weight, src.italic));
  });
}

let systemDefault: NativeTypeface | undefined;
/** Typeface::setDefault */
export const setDefaultTypeface = (t: NativeTypeface) => { systemDefault = t; };
let nativeInstance = "";
/** The native typeface behind a Java Typeface, the default for null as hwui resolves it. Under a
 *  bytecode Paint the native paint is handed the native typeface itself. */
export function typefaceOf(t: object | null): NativeTypeface {
  if (!t) return systemDefault!;
  if (t instanceof NativeTypeface) return t;
  return deref<NativeTypeface>((t as Record<string, bigint>)[nativeInstance ||= declaredField("android/graphics/Typeface", "native_instance")]);
}

/** Typeface.create("sans-serif-medium", NORMAL), the face framework chrome uses (dialog buttons,
 *  picker values, the action bar title), once the system font map is loaded */
export let tfMedium: object | null = null;
/** the zygote's preload of the system font map: Typeface.DEFAULT and the named families */
export async function loadSystemFontMap(): Promise<void> {
  const T = "android/graphics/Typeface";
  await scall(T, "loadPreinstalledSystemFontMap", "()V");
  tfMedium = await scall(T, "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "sans-serif-medium", 0);
}
