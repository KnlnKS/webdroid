// The sfnt (TrueType/OpenType) tables minikin, Skia and FreeType read apart from glyphs: a font
// file's faces, their metrics, style, variation axes and cmap coverage, and FontFileUtil's answers.

/** Offsets of the sfnt tables we read, by tag, or null if `b` is not a font we understand. */
export function sfntTables(b: Uint8Array, ttcIndex: number): { dv: DataView; at: Map<number, number> } | null {
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
export function sfntMetrics(b: Uint8Array, ttcIndex = 0): FaceMetrics | null {
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

/** how many faces a font file holds: a collection's count, or one */
export function faceCount(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length >= 12 && dv.getUint32(0) === TTCF ? dv.getUint32(8) : 1;
}
const TTCF = 0x74746366;

/** an axis a face declares in its fvar table, with its range */
export interface FvarAxis { tag: number; min: number; def: number; max: number }
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

/** what minikin and Skia read of a face apart from its glyphs: OS/2's style, the metrics, the
 *  variation axes, whether it has outlines, and its cmap's coverage */
export interface FaceInfo { style: { weight: number; italic: boolean } | null; metrics: FaceMetrics | null; axes: FvarAxis[]; scalable: boolean; coverage: Uint32Array }
export function faceInfo(b: Uint8Array, ttcIndex: number): FaceInfo {
  return { style: sfntStyle(b, ttcIndex), metrics: sfntMetrics(b, ttcIndex), axes: fvarAxes(b, ttcIndex),
    scalable: isScalable(sfntTables(b, ttcIndex)?.at ?? new Map()), coverage: cmapCoverage(b, ttcIndex) };
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

