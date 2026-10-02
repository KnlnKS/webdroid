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
import { harfBuzz, instanceFace } from "./harfbuzz";

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
const T_OS2 = 0x4f532f32, T_HHEA = 0x68686561, T_HEAD = 0x68656164, T_POST = 0x706f7374, T_NAME = 0x6e616d65, T_CFF = 0x43464620, T_CFF2 = 0x43464632, T_FVAR = 0x66766172;
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
 *  gap, and head's bounding box for top/bottom (all positive downwards from the baseline), and the
 *  underline's top and thickness from post. A face with only bitmaps (a CBDT emoji font) has its
 *  largest strike's line metrics, scaled, and no underline. */
export interface FaceMetrics { ascent: number; descent: number; top: number; bottom: number; leading: number; underline?: number; underlineThickness?: number }
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
  const asc = t.dv.getInt16(hhea + 4) / upem, desc = -t.dv.getInt16(hhea + 6) / upem, post = t.at.get(T_POST);
  const m: FaceMetrics = { ascent: asc, descent: desc, top: t.dv.getInt16(head + 42) / upem, bottom: -t.dv.getInt16(head + 38) / upem, leading: t.dv.getInt16(hhea + 8) / upem };
  // FreeType moves post's underline position (its centre) to the top, and Skia moves it back
  if (post !== undefined && post + 12 <= b.length && t.dv.getInt16(post + 10) > 0) {
    m.underline = -t.dv.getInt16(post + 8) / upem; m.underlineThickness = t.dv.getInt16(post + 10) / upem;
  }
  return m;
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
/** an axis a face declares in its fvar table, with its range */
interface FvarAxis { tag: number; min: number; def: number; max: number }
function fvarAxes(b: Uint8Array, ttcIndex: number): FvarAxis[] {
  const t = sfntTables(b, ttcIndex), fvar = t?.at.get(T_FVAR);
  if (!t || fvar === undefined || fvar + 12 > b.length) return [];
  const count = t.dv.getUint16(fvar + 8), size = t.dv.getUint16(fvar + 10), axes: FvarAxis[] = [];
  for (let i = 0, at = fvar + t.dv.getUint16(fvar + 4); i < count && at + 16 <= b.length; i++, at += size)
    axes.push({ tag: t.dv.getUint32(at), min: t.dv.getInt32(at + 4) / 65536, def: t.dv.getInt32(at + 8) / 65536, max: t.dv.getInt32(at + 12) / 65536 });
  return axes;
}

/** CmapCoverage: the code points a face's best Unicode cmap (format 12, else 4) maps, as sorted
 *  inclusive [first, last] pairs */
export function cmapCoverage(b: Uint8Array, ttcIndex: number): Uint32Array {
  const t = sfntTables(b, ttcIndex), cmap = t?.at.get(T_CMAP), out: number[] = [];
  if (!t || cmap === undefined || cmap + 4 > b.length) return new Uint32Array(0);
  const dv = t.dv, add = (first: number, last: number) => {
    if (out.length && out[out.length - 1] + 1 >= first) out[out.length - 1] = Math.max(out[out.length - 1], last);
    else out.push(first, last);
  };
  let table = -1, format = 0;
  for (let i = 0, n = dv.getUint16(cmap + 2); i < n && cmap + 12 + i * 8 <= b.length; i++) {
    const platform = dv.getUint16(cmap + 4 + i * 8), encoding = dv.getUint16(cmap + 6 + i * 8), at = cmap + dv.getUint32(cmap + 8 + i * 8);
    if (at + 2 > b.length) continue;
    const f = dv.getUint16(at);
    if (f === 12 && (platform === 3 && encoding === 10 || platform === 0 && (encoding === 4 || encoding === 6))) { table = at; format = 12; }
    else if (f === 4 && format !== 12 && (platform === 3 && encoding === 1 || platform === 0)) { table = at; format = 4; }
  }
  if (format === 12) {
    for (let i = 0, n = dv.getUint32(table + 12); i < n && table + 28 + i * 12 <= b.length; i++) {
      const g = table + 16 + i * 12, first = dv.getUint32(g), last = Math.min(dv.getUint32(g + 4), 0x10ffff);
      if (first <= last) add(first, last);
    }
  } else if (format === 4) {
    const segs = dv.getUint16(table + 6) >> 1, ends = table + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, offsets = deltas + segs * 2;
    for (let i = 0; i < segs && offsets + i * 2 + 2 <= b.length; i++) {
      const first = dv.getUint16(starts + i * 2), last = dv.getUint16(ends + i * 2);
      if (first === 0xffff || first > last) continue;
      const delta = dv.getUint16(deltas + i * 2), offset = dv.getUint16(offsets + i * 2);
      if (!offset) { for (let c = first; c <= last; c++) if ((c + delta & 0xffff) !== 0) add(c, c); continue; }
      for (let c = first; c <= last; c++) {
        const at = offsets + i * 2 + offset + (c - first) * 2;
        if (at + 2 <= b.length && dv.getUint16(at) !== 0) add(c, c);
      }
    }
  }
  return Uint32Array.from(out);
}

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
 *  first use (once per tab: the realms share its bytes, and so HarfBuzz's face of it) */
class FontFile {
  private loading?: Promise<void>;
  constructor(private data: Uint8Array | null, readonly path = "") {}
  get bytes(): Uint8Array { return this.data ?? pending(this.load()); }
  load(): Promise<void> {
    return this.loading ??= this.data ? Promise.resolve() : platformBytes(this.path).then((b) => { this.data = b; });
  }
}
const pending = (wait: Promise<unknown>): never => { throw new FontPending(wait); };
declare global { interface Window { __wdFontFiles?: Map<string, Promise<Uint8Array>> } }
function platformBytes(path: string): Promise<Uint8Array> {
  const files = pageShared("__wdFontFiles", () => new Map<string, Promise<Uint8Array>>());
  let bytes = files.get(path);
  if (!bytes) files.set(path, bytes = Promise.resolve(vfs.readFile(path)).then((b) => {
    if (!b) throw new Error(`font ${path} is not mounted`);
    return b;
  }));
  return bytes;
}
const platformFiles = new Map<string, FontFile>();
/** whether `path` is a reference-build font file, which loads lazily */
export const isPlatformFont = (path: string) => path.startsWith("/system/fonts/") && path in PLATFORM_DATA;
function platformFile(path: string): FontFile {
  let file = platformFiles.get(path);
  if (!file) platformFiles.set(path, file = new FontFile(null, path));
  return file;
}
/** Typeface's nativeWarmUpCache: a system font read ahead, as the device pages its file in */
export const warmUpCache = (path: string): Promise<void> | void => isPlatformFont(path) ? platformFile(path).load() : undefined;

/** what minikin and Skia read of a face apart from its glyphs: OS/2's style, the metrics, the
 *  variation axes, whether it has outlines, and its cmap's coverage */
interface FaceInfo { style: { weight: number; italic: boolean } | null; metrics: FaceMetrics | null; axes: FvarAxis[]; scalable: boolean; coverage: Uint32Array }
function faceInfo(b: Uint8Array, ttcIndex: number): FaceInfo {
  return { style: sfntStyle(b, ttcIndex), metrics: sfntMetrics(b, ttcIndex), axes: fvarAxes(b, ttcIndex),
    scalable: isScalable(sfntTables(b, ttcIndex)?.at ?? new Map()), coverage: cmapCoverage(b, ttcIndex) };
}
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
    const bytes = await platformBytes(path), dv = new DataView(bytes.buffer, bytes.byteOffset);
    for (let i = 0, n = dv.getUint32(0) === 0x74746366 ? dv.getUint32(8) : 1; i < n; i++) {
      const info = faceInfo(bytes, i);
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

/** face `ttcIndex` of a font collection as a font file of its own: its table directory and tables */
function sfntFace(b: Uint8Array, ttcIndex: number): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), base = dv.getUint32(12 + ttcIndex * 4), n = dv.getUint16(base + 4);
  const records = Array.from({ length: n }, (_, i) => [base + 12 + i * 16, dv.getUint32(base + 20 + i * 16), dv.getUint32(base + 24 + i * 16)]);
  let size = 12 + n * 16;
  for (const [, , length] of records) size += (length + 3) & ~3;
  const out = new Uint8Array(size), ov = new DataView(out.buffer);
  out.set(b.subarray(base, base + 12));
  let at = 12 + n * 16;
  records.forEach(([record, offset, length], i) => {
    out.set(b.subarray(record, record + 8), 12 + i * 16);
    ov.setUint32(20 + i * 16, at); ov.setUint32(24 + i * 16, length);
    out.set(b.subarray(offset, offset + length), at);
    at += (length + 3) & ~3;
  });
  return out;
}

// ── drawing through the page's text engine
// Canvas2D draws text with CSS fonts. Each font drawn is registered as its own CSS family once
// loaded, its weight left to CSS when it has a wght axis (Chrome sets wght from the requested
// weight). An axis Chrome would set otherwise than the font wants (opsz, which it sets from the
// size; ital, which it leaves at the default; wdth and slnt away from 100 and 0) is pinned in an
// instance HarfBuzz makes.
/** the value Chrome gives an axis on a canvas with a normal stretch and style */
const chromeAxis = (a: FvarAxis) => a.tag === WDTH ? 100 : a.tag === SLNT ? 0 : a.tag === OPSZ ? NaN : a.def;
const WDTH = 0x77647468, SLNT = 0x736c6e74, OPSZ = 0x6f70737a;
const cssFaces = new WeakMap<NativeFont, Map<number, string | Promise<string>>>();
let cssFaceIds = 0;
/** the CSS family that draws `f` as minikin draws it, once registered */
export function cssFace(f: FakedFont): string {
  const font = f.font, ital = f.italic < 0 ? -1 : f.italic;
  let byItal = cssFaces.get(font);
  if (!byItal) cssFaces.set(font, byItal = new Map());
  const face = byItal.get(ital);
  if (typeof face === "string") return face;
  if (face) pending(face);
  const made = registerCss(font, ital).then((name) => { byItal!.set(ital, name); return name; });
  byItal.set(ital, made);
  return pending(made);
}
async function registerCss(font: NativeFont, ital: number): Promise<string> {
  await font.file.load();
  const name = `wd-font-${++cssFaceIds}`;
  if (typeof FontFace === "undefined") return name;
  const fvar = font.fvarAxes, wght = fvar.find((a) => a.tag === WGHT);
  const pins: [number, number][] = [];
  for (const a of fvar) {
    const value = a.tag === ITAL && ital >= 0 ? ital : font.axes.find((x) => x.tag === a.tag)?.value ?? a.def;
    if (a.tag !== WGHT && value !== chromeAxis(a)) pins.push([a.tag, value]);
  }
  const ttc = new DataView(font.bytes.buffer, font.bytes.byteOffset).getUint32(0) === 0x74746366;
  const bytes = pins.length ? await instanceFace(font.bytes, font.ttcIndex, pins) : ttc ? sfntFace(font.bytes, font.ttcIndex) : font.bytes;
  const m = font.faceMetrics, desc: FontFaceDescriptors = {
    weight: wght ? `${wght.min} ${wght.max}` : String(font.weight),
    style: font.italic || ital === 1 ? "italic" : "normal",
  };
  // keep the browser's line metrics Paint's
  if (m) { desc.ascentOverride = `${m.ascent * 100}%`; desc.descentOverride = `${m.descent * 100}%`; }
  const src = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  try {
    const face = new FontFace(name, src as ArrayBuffer, desc);
    await face.load();
    document.fonts.add(face);
  } catch (e) {
    console.warn("[fonts] FontFace rejected", font.path, e);
  }
  return name;
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
