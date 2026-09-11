// resources.arsc parser + config-aware entry resolution.
// Refs: AOSP libs/androidfw/include/androidfw/ResourceTypes.h

import { StringPool } from "./axml";
import { device as dev } from "../shell/config";
import { u8 } from "../jvm/abi";

interface ResEntry {
  key: string;                     // entry name
  value?: { type: number; data: number };            // simple
  bag?: { parent: number; map: [number, number, number][] };  // [attrResId, valueType, data]
}

interface TypeChunk {
  id: number;
  /** the type's name in the package chunk this came from — a table may carry several */
  name: string;
  config: Config;
  entries: Map<number, ResEntry>;
  load?: () => void;
}

interface ResourceProfile {
  lang: string; dir: number;
  types: Map<number, TypeChunk[]>;
  names: Map<string, Map<string, number>>;
}

interface Config {
  density: number; sdk: number; orientation: number; night: number;
  lang: string; region: string; swdp: number; wdp: number; hdp: number;
  /** screenLayout: size class (0=any…4=xlarge) and layout direction (0x40 ltr, 0x80 rtl) */
  size: number; dir: number;
  /** uiMode type: 0=any, 1=normal, 3=car, 4=television, 6=watch … */
  uiType: number;
  score: number; // computed match score
}

const defaultConfig: Config = { density: 0, sdk: 0, orientation: 0, night: 0, lang: "", region: "", swdp: 0, wdp: 0, hdp: 0, size: 0, dir: 0, uiType: 0, score: 0 };
const localePart = (a: number, b: number, base: number) => !a ? "" : a & 0x80
  ? String.fromCharCode(base + (b & 31), base + ((b >> 5) | ((a & 3) << 3)), base + ((a >> 2) & 31)) : String.fromCharCode(a, b);

/** a split table's string index → its slot in the base pool */
type Remap = ((i: number) => number) | null;
/** the archive an Arsc was parsed from: a res/… path to its bytes, or null */
type Files = (path: string) => Uint8Array | null;

/** AOSP's screen size class for a smallest-width in dp */
const sizeClass = (swdp: number): number => swdp >= 720 ? 4 : swdp >= 480 ? 3 : swdp >= 320 ? 2 : 1;

export class Arsc {
  values!: StringPool;
  pkgId = 0x7f;
  pkgName = "";
  types = new Map<number, TypeChunk[]>();   // typeId → chunks (one per config)
  locales = new Set<string>();
  device = { density: dev.densityDpi, sdk: dev.sdk, orientation: dev.orientation, night: dev.night ? 1 : 0,
    wdp: dev.widthDp, hdp: dev.screenHeightDp, swdp: dev.smallestWidthDp, lang: dev.lang, region: dev.region,
    size: sizeClass(dev.smallestWidthDp), dir: 0x40, uiType: 1 };
  private profiles = new Map<string, ResourceProfile>();
  private active: ResourceProfile | null = null;

  constructor(bytes: Uint8Array, readonly files: Files = () => null) { this.parse(bytes, false); }

  /** A config split's table: the same package, carrying only its configs' entries. Its value
   *  strings are appended past the base pool so every entry keeps indexing one pool. */
  add(bytes: Uint8Array): void { this.parse(bytes, true); }

  private parse(bytes: Uint8Array, split: boolean) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== 0x0002) throw new Error("not arsc");
    let pos = view.getUint16(2, true);
    const total = view.getUint32(4, true);
    let remap: Remap = null;
    while (pos < total) {
      const type = view.getUint16(pos, true);
      const headerSize = view.getUint16(pos + 2, true);
      const size = view.getUint32(pos + 4, true);
      if (type === 0x0001) {
        const pool = new StringPool(view, pos);
        if (!split) this.values = pool;
        else { const at = this.values.strings.length; this.values.strings.push(...pool.strings); remap = (i) => i === 0xffffffff ? i : at + i; }
      } else if (type === 0x0200) this.parsePackage(view, pos, headerSize, size, remap);
      pos += size;
    }
  }

  private parsePackage(view: DataView, base: number, headerSize: number, size: number, remap: Remap) {
    this.pkgId = view.getUint32(base + 8, true);
    let name = "";
    for (let i = 0; i < 128; i++) {
      const c = view.getUint16(base + 12 + i * 2, true);
      if (!c) break;
      name += String.fromCharCode(c);
    }
    this.pkgName = name;
    // A table may hold several package chunks under one id (aapt2 emits one per staged public
    // group), each with its own name pools — so they are read per chunk, never kept on `this`.
    const typeNames = new StringPool(view, base + view.getUint32(base + 268, true));
    const keyNames = new StringPool(view, base + view.getUint32(base + 276, true));
    let pos = base + headerSize;
    const end = base + size;
    while (pos < end) {
      const ctype = view.getUint16(pos, true);
      const csize = view.getUint32(pos + 4, true);
      if (ctype === 0x0201) this.parseType(view, pos, typeNames, keyNames, remap);
      pos += csize;
    }
  }

  private parseType(view: DataView, base: number, typeNames: StringPool, keyNames: StringPool, remap: Remap) {
    const id = view.getUint8(base + 8);
    const cfgSize = view.getUint32(base + 20, true);
    const cfg: Config = { ...defaultConfig };
    const c = base + 20;
    if (cfgSize >= 16) {
      const l1 = view.getUint8(c + 8), l2 = view.getUint8(c + 9), r1 = view.getUint8(c + 10), r2 = view.getUint8(c + 11);
      cfg.lang = localePart(l1, l2, 97);
      // a pseudolocale (en-XA) or a regional variant answers only for its own region
      cfg.region = localePart(r1, r2, 48);
      cfg.orientation = view.getUint8(c + 12);
      cfg.density = view.getUint16(c + 14, true);
    }
    if (cfgSize >= 28) cfg.sdk = view.getUint16(c + 24, true);
    if (cfgSize >= 32) {
      const sl = view.getUint8(c + 28), ui = view.getUint8(c + 29);
      cfg.size = sl & 0x0f;
      cfg.dir = sl & 0xc0;
      cfg.uiType = ui & 0x0f;
      cfg.night = (ui & 0x30) === 0x20 ? 1 : (ui & 0x30) === 0x10 ? -1 : 0;
    }
    if (cfgSize >= 36) {
      cfg.swdp = view.getUint16(c + 30, true);
      cfg.wdp = view.getUint16(c + 32, true);
      cfg.hdp = view.getUint16(c + 34, true);
    }
    if (cfg.lang) {
      const script = cfgSize >= 48 ? String.fromCharCode(...u8(view, c + 36, 4)).replace(/\0.*$/, "") : "";
      const variant = cfgSize >= 48 ? String.fromCharCode(...u8(view, c + 40, 8)).replace(/\0.*$/, "") : "";
      this.locales.add([cfg.lang, script, cfg.region, variant].filter(Boolean).join("-"));
    }
    // Keep other locales as encoded chunks until a scoped resource lookup selects them.
    if (this.skipAtParse(cfg)) return;
    const chunk: TypeChunk = { id, name: typeNames.get(id - 1), config: cfg, entries: new Map() };
    if (cfg.lang && cfg.lang !== this.device.lang || cfg.dir && cfg.dir !== this.device.dir) {
      chunk.load = () => this.parseEntries(view, base, keyNames, chunk, remap);
    } else this.parseEntries(view, base, keyNames, chunk, remap);
    let list = this.types.get(id);
    if (!list) this.types.set(id, (list = []));
    list.push(chunk);
  }

  private parseEntries(view: DataView, base: number, keyNames: StringPool, chunk: TypeChunk, remap: Remap): void {
    const str = (type: number, data: number) => type === 0x03 && remap ? remap(data) : data;
    const headerSize = view.getUint16(base + 2, true), flags = view.getUint8(base + 9);
    const entryCount = view.getUint32(base + 12, true), entriesStart = view.getUint32(base + 16, true);
    const offBase = base + headerSize;
    const sparse = (flags & 0x01) !== 0;
    const eBase = base + entriesStart;
    const readEntry = (entryIdx: number, off: number) => {
      const p = eBase + off;
      const sizeOrKey = view.getUint16(p, true);
      const eflags = view.getUint16(p + 2, true);
      if (eflags & 0x0008) {
        // FLAG_COMPACT: word0 = key(u16) + flags(u16, high byte = dataType), word1 = data
        const type = (eflags >> 8) & 0xff;
        const ent: ResEntry = { key: keyNames.get(sizeOrKey), value: { type, data: str(type, view.getInt32(p + 4, true)) } };
        chunk.entries.set(entryIdx, ent);
        return;
      }
      const size = sizeOrKey;
      const key = keyNames.get(view.getUint32(p + 4, true));
      const ent: ResEntry = { key };
      if (eflags & 0x0001) {
        const parent = view.getUint32(p + 8, true);
        const count = view.getUint32(p + 12, true);
        const map: [number, number, number][] = [];
        for (let j = 0; j < count; j++) {
          const mp = p + 16 + j * 12;
          const vt = view.getUint8(mp + 7);
          map.push([view.getUint32(mp, true), vt, str(vt, view.getInt32(mp + 8, true))]);
        }
        ent.bag = { parent, map };
      } else {
        const type = view.getUint8(p + size + 3);
        ent.value = { type, data: str(type, view.getInt32(p + size + 4, true)) };
      }
      chunk.entries.set(entryIdx, ent);
    };
    if (sparse) {
      for (let i = 0; i < entryCount; i++) {
        const idx = view.getUint16(offBase + i * 4, true);
        const off = view.getUint16(offBase + i * 4 + 2, true) * 4;
        readEntry(idx, off);
      }
    } else if (flags & 0x02) {
      // FLAG_OFFSET16: the offset array is u16 in units of 4 bytes, 0xffff meaning no entry
      for (let i = 0; i < entryCount; i++) {
        const off = view.getUint16(offBase + i * 2, true);
        if (off !== 0xffff) readEntry(i, off * 4);
      }
    } else {
      for (let i = 0; i < entryCount; i++) {
        const off = view.getUint32(offBase + i * 4, true);
        if (off !== 0xffffffff) readEntry(i, off);
      }
    }
    chunk.load = undefined;
  }

  private profile() {
    const { lang, dir } = this.device;
    if (this.active?.lang !== lang || this.active.dir !== dir) {
      const key = lang + ":" + dir;
      let profile = this.profiles.get(key);
      if (!profile) this.profiles.set(key, profile = { lang, dir, types: new Map(), names: new Map() });
      this.active = profile;
    }
    return this.active;
  }

  private chunksFor(typeId: number): TypeChunk[] {
    const profile = this.profile();
    let chunks = profile.types.get(typeId);
    if (!chunks) {
      chunks = (this.types.get(typeId) ?? []).filter(ch => (!ch.config.lang || ch.config.lang === profile.lang) && (!ch.config.dir || ch.config.dir === profile.dir));
      for (const chunk of chunks) chunk.load?.();
      profile.types.set(typeId, chunks);
    }
    return chunks;
  }

  typeName(typeId: number): string { return this.types.get(typeId)?.[0]?.name ?? "?"; }

  /** every type name the table defines, each once */
  allTypes(): string[] {
    const s = new Set<string>();
    for (const chunks of this.types.values()) for (const ch of chunks) s.add(ch.name);
    return [...s];
  }

  /** best-config entry for resId, or null */
  entry(resId: number): ResEntry | null {
    if ((resId >>> 24) !== this.pkgId) return null;
    const typeId = (resId >> 16) & 0xff;
    const entryIdx = resId & 0xffff;
    const chunks = this.chunksFor(typeId);
    let best: ResEntry | null = null;
    let bestScore = -1;
    for (const ch of chunks) {
      const e = ch.entries.get(entryIdx);
      if (!e) continue;
      const s = this.configScore(ch.config);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return best;
  }

  /** Static parse-time rejection. Night and display axes can both change while the table lives. */
  private skipAtParse(c: Config): boolean {
    const d = this.device;
    const fitsEitherAxis = (c.wdp <= d.wdp && c.hdp <= d.hdp) || (c.wdp <= d.hdp && c.hdp <= d.wdp);
    return c.sdk > d.sdk
      || c.swdp > d.swdp || !fitsEitherAxis
      || c.size > d.size || (c.uiType !== 0 && c.uiType !== d.uiType);
  }

  /** Match the current Configuration. Unlike parse-time viability, the current axes are exact. */
  private skipCurrent(c: Config): boolean {
    const d = this.device;
    return c.sdk > d.sdk || (!!c.lang && c.lang !== d.lang) || (!!c.region && c.region !== d.region) || (!!c.orientation && c.orientation !== d.orientation)
      || c.swdp > d.swdp || c.wdp > d.wdp || c.hdp > d.hdp
      || c.size > d.size || (c.dir !== 0 && c.dir !== d.dir) || (c.uiType !== 0 && c.uiType !== d.uiType);
  }

  private configScore(c: Config): number {
    const d = this.device;
    if (this.skipCurrent(c)) return -1;
    if (c.night !== 0 && c.night !== (d.night ? 1 : -1)) return -1;
    let s = 0;
    if (c.lang) s += 1 << 20;
    if (c.region) s += 1 << 18;
    if (c.dir) s += 1 << 19;
    if (c.swdp) s += (1 << 14) + c.swdp;
    if (c.wdp || c.hdp) s += (1 << 13) + c.wdp;
    if (c.size) s += 1 << 12;
    if (c.orientation) s += 1 << 12;
    if (c.night !== 0) s += 1 << 10;
    if (c.uiType) s += 1 << 9;
    if (c.density) {
      // prefer closest density ≥ device, then closest below
      const diff = c.density === d.density ? 4096 : c.density > d.density ? 2048 - (c.density - d.density) / 8 : 1024 - (d.density - c.density) / 8;
      s += (1 << 11) + diff / 4096 * 1023;
    }
    if (c.sdk) s += c.sdk;
    return s;
  }

  /** every entry name of a type → its id, built once per type */
  names(typeName: string): Map<string, number> {
    const names = this.profile().names;
    let m = names.get(typeName);
    if (m) return m;
    names.set(typeName, m = new Map());
    // A resource still being staged is emitted twice: once at its finalized id and once under a
    // staging type id, which is allocated high. Ascending type id, first name wins, so the
    // finalized id is the one a name resolves to.
    for (const tid of [...this.types.keys()].sort((a, b) => a - b)) {
      if (this.typeName(tid) !== typeName) continue;
      for (const ch of this.chunksFor(tid)) {
        for (const [idx, e] of ch.entries) if (!m.has(e.key)) m.set(e.key, (this.pkgId << 24) | (tid << 16) | idx);
      }
    }
    return m;
  }

  /** find resource id by type name + entry name */
  findId(typeName: string, key: string): number { return this.names(typeName).get(key) ?? 0; }
}
