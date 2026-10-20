// The sfnt (TrueType/OpenType) tables minikin, Skia and FreeType read apart from glyphs: a font
// file's faces, their metrics, style, variation axes and cmap coverage, and FontFileUtil's answers.

/** the bytes as a buffer of their own, which FontFace and CanvasKit take whole */
export const ownBuffer = (b: Uint8Array): ArrayBuffer =>
  b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer as ArrayBuffer : b.slice().buffer;
/** a face's table directory: offsets of its tables by tag */
type Tables = { dv: DataView; at: Map<number, number> };
/** Offsets of the sfnt tables we read, by tag, or null if `b` is not a font we understand. */
export function sfntTables(b: Uint8Array, ttcIndex: number): Tables | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let base = 0;
  const tag = dv.getUint32(0);
  if (tag === TTCF) {
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
export const T_HEAD = 0x68656164, T_COLR = 0x434f4c52;
const T_OS2 = 0x4f532f32, T_HHEA = 0x68686561, T_POST = 0x706f7374, T_NAME = 0x6e616d65, T_CFF = 0x43464620, T_CFF2 = 0x43464632, T_FVAR = 0x66766172;
export const T_CMAP = 0x636d6170;
const T_GLYF = 0x676c7966, T_CBLC = 0x43424c43;
const isScalable = (at: Map<number, number>) => at.has(T_GLYF) || at.has(T_CFF) || at.has(T_CFF2);

/** weight/italic from the face's OS/2 table (what AOSP's analyzeStyle reads), null if absent */
function sfntStyle(b: Uint8Array, t: Tables | null): { weight: number; italic: boolean } | null {
  const off = t?.at.get(T_OS2);
  if (!t || off === undefined || off + 64 > b.length) return null;
  return { weight: t.dv.getUint16(off + 4), italic: (t.dv.getUint16(off + 62) & 1) !== 0 };
}

/** FreeType's scalable-face metrics as Skia reads them, in ems: hhea ascender/descender and line
 *  gap, and head's bounding box for top/bottom (all positive downwards from the baseline), and the
 *  underline's top and thickness from post. A face with only bitmaps (a CBDT emoji font) has its
 *  largest strike's line metrics, scaled, and no underline. */
export interface FaceMetrics { ascent: number; descent: number; top: number; bottom: number; leading: number; underline?: number; underlineThickness?: number }
function sfntMetrics(b: Uint8Array, t: Tables | null): FaceMetrics | null {
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

/** how many faces a font file holds: a collection's count, or one */
export function faceCount(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length >= 12 && dv.getUint32(0) === TTCF ? dv.getUint32(8) : 1;
}
const TTCF = 0x74746366;

/** an axis a face declares in its fvar table, with its range */
export interface FvarAxis { tag: number; min: number; def: number; max: number }
function fvarAxes(b: Uint8Array, t: Tables | null): FvarAxis[] {
  const fvar = t?.at.get(T_FVAR);
  if (!t || fvar === undefined || fvar + 12 > b.length) return [];
  const count = t.dv.getUint16(fvar + 8), size = t.dv.getUint16(fvar + 10), axes: FvarAxis[] = [];
  for (let i = 0, at = fvar + t.dv.getUint16(fvar + 4); i < count && at + 16 <= b.length; i++, at += size)
    axes.push({ tag: t.dv.getUint32(at), min: t.dv.getInt32(at + 4) / 65536, def: t.dv.getInt32(at + 8) / 65536, max: t.dv.getInt32(at + 12) / 65536 });
  return axes;
}

// FreeType's fixed-point helpers: rounded, on magnitudes
const mulDiv = (a: number, b: number, c: number) => Math.sign(a) * Math.sign(b) * Math.sign(c) * Math.floor((Math.abs(a) * Math.abs(b) + (Math.abs(c) >> 1)) / Math.abs(c));
const T_AVAR = 0x61766172, T_HVAR = 0x48564152, T_HMTX = 0x686d7478;
/** A varied face's advances in font units as FreeType loads them for Skia: design coordinates
 *  normalized in 16.16 and mapped through avar (FreeType keeps that precision where HarfBuzz rounds
 *  to 2.14), HVAR's deltas summed with each region's scalar and rounded to whole units. Null when
 *  the face has no HVAR or every axis is at its default. */
export function variedAdvances(b: Uint8Array, ttcIndex: number, coords: readonly (readonly [number, number])[]): ((glyph: number) => number) | null {
  const t = sfntTables(b, ttcIndex), hvar = t?.at.get(T_HVAR), hmtx = t?.at.get(T_HMTX), hhea = t?.at.get(T_HHEA);
  if (!t || hvar === undefined || hmtx === undefined || hhea === undefined) return null;
  const dv = t.dv, axes = fvarAxes(b, t), fixed = (v: number) => Math.round(v * 65536);
  const nc = axes.map((a) => {
    const v = fixed(Math.min(a.max, Math.max(a.min, coords.reduce((v, [tag, value]) => tag === a.tag ? value : v, a.def)))), def = fixed(a.def);
    return v > def ? (v >= fixed(a.max) ? 0x10000 : mulDiv(v - def, 0x10000, fixed(a.max) - def))
      : v < def ? (v <= fixed(a.min) ? -0x10000 : mulDiv(v - def, 0x10000, def - fixed(a.min))) : 0;
  });
  const avar = t.at.get(T_AVAR);
  if (avar !== undefined) for (let i = 0, at = avar + 8; i < Math.min(dv.getUint16(avar + 6), nc.length); i++) {
    const n = dv.getUint16(at), pair = (j: number) => [dv.getInt16(at + 2 + j * 4) * 4, dv.getInt16(at + 4 + j * 4) * 4];
    for (let j = 1; j < n; j++) {
      const [f0, t0] = pair(j - 1), [f1, t1] = pair(j);
      if (nc[i] < f1) { nc[i] = mulDiv(nc[i] - f0, t1 - t0, f1 - f0) + t0; break; }
    }
    at += 2 + n * 4;
  }
  if (nc.every((c) => c === 0)) return null;
  const store = hvar + dv.getUint32(hvar + 4), mapAt = dv.getUint32(hvar + 8), regionList = store + dv.getUint32(store + 2);
  const regionAxes = dv.getUint16(regionList), scalars = Array.from({ length: dv.getUint16(regionList + 2) }, (_, r) => {
    let scalar = 0x10000;
    for (let a = 0; a < regionAxes && a < nc.length; a++) {
      const at = regionList + 4 + (r * regionAxes + a) * 6, start = dv.getInt16(at) * 4, end = dv.getInt16(at + 4) * 4;
      let peak = dv.getInt16(at + 2) * 4;
      if (start < 0 && end > 0 || start > peak || peak > end) peak = 0;
      const c = nc[a];
      if (peak === c || peak === 0) continue;
      if (c <= start || c >= end) return 0;
      scalar = c < peak ? mulDiv(scalar, c - start, peak - start) : mulDiv(scalar, end - c, end - peak);
    }
    return scalar;
  });
  const metrics = dv.getUint16(hhea + 34), glyphs = new Map<number, number>();
  return (glyph) => {
    let units = glyphs.get(glyph);
    if (units !== undefined) return units;
    units = dv.getUint16(hmtx + Math.min(glyph, metrics - 1) * 4);
    let outer = 0, inner = glyph;
    if (mapAt) {
      const map = hvar + mapAt, format = b[map], entry = b[map + 1], count = format ? dv.getUint32(map + 2) : dv.getUint16(map + 2);
      const size = (entry >> 4 & 3) + 1, bits = (entry & 15) + 1, at = map + (format ? 6 : 4) + Math.min(glyph, count - 1) * size;
      let v = 0;
      for (let k = 0; k < size; k++) v = v * 256 + b[at + k];
      outer = v >>> bits; inner = v & (1 << bits) - 1;
    }
    if (outer < dv.getUint16(store + 6)) {
      const data = store + dv.getUint32(store + 8 + outer * 4), items = dv.getUint16(data), words = dv.getUint16(data + 2), regions = dv.getUint16(data + 4);
      if (inner < items) {
        const long = (words & 0x8000) !== 0, wide = words & 0x7fff, big = long ? 4 : 2, small = long ? 2 : 1;
        let at = data + 6 + regions * 2 + inner * (wide * big + (regions - wide) * small), sum = 0;
        for (let k = 0; k < regions; k++) {
          const d = k < wide ? (long ? dv.getInt32(at) : dv.getInt16(at)) : (long ? dv.getInt16(at) : dv.getInt8(at));
          at += k < wide ? big : small;
          sum += scalars[dv.getUint16(data + 6 + k * 2)] * d;
        }
        units += Math.floor((sum + 0x8000) / 0x10000);
      }
    }
    glyphs.set(glyph, units);
    return units;
  };
}

/** CmapCoverage: the code points a face's best Unicode cmap (format 12, else 4) maps, as sorted
 *  inclusive [first, last] pairs */
function cmapCoverage(b: Uint8Array, t: Tables | null): Uint32Array {
  const cmap = t?.at.get(T_CMAP), out: number[] = [];
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

/** what minikin and Skia read of a face apart from its glyphs: OS/2's style, the metrics, the
 *  variation axes, whether it has outlines, and its cmap's coverage */
export interface FaceInfo { style: { weight: number; italic: boolean } | null; metrics: FaceMetrics | null; axes: FvarAxis[]; scalable: boolean; coverage: Uint32Array }
export function faceInfo(b: Uint8Array, ttcIndex: number): FaceInfo {
  const t = sfntTables(b, ttcIndex);
  return { style: sfntStyle(b, t), metrics: sfntMetrics(b, t), axes: fvarAxes(b, t), scalable: !!t && isScalable(t.at), coverage: cmapCoverage(b, t) };
}
/** face `ttcIndex` of a font collection as a font file of its own: its table directory and tables */
export function sfntFace(b: Uint8Array, ttcIndex: number): Uint8Array {
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

