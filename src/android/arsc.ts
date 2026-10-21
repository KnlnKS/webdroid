// resources.arsc parser + config-aware entry resolution.
// Refs: AOSP libs/androidfw/include/androidfw/ResourceTypes.h

import { StringPool } from "./axml.ts";
import { device as dev } from "../shell/config.ts";
import { u8 } from "../jvm/abi.ts";
import { perf } from "../perf.ts";

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
  /** resource id → the name of the type chunk defining it */
  typeNames: Map<number, string>;
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
export const sizeClass = (swdp: number): number => swdp >= 720 ? 4 : swdp >= 480 ? 3 : swdp >= 320 ? 2 : 1;

/** the configuration a lookup selects under, on ResTable_config's axes */
export interface Qualifiers {
  density: number; sdk: number; orientation: number; night: number; wdp: number; hdp: number; swdp: number;
  lang: string; region: string; size: number; dir: number; uiType: number;
}
/** the qualifiers a Configuration's fields select under (AssetManager.setConfiguration's arguments) */
export function qualifiers(locale: string | null, orientation: number, density: number, swdp: number, wdp: number, hdp: number,
  screenLayout: number, uiMode: number, sdk: number): Qualifiers {
  const [lang = "", ...rest] = (locale ?? "").split("-");
  const region = rest.find((p) => /^[A-Z]{2}$|^\d{3}$/.test(p)) ?? "";
  return {
    lang: lang === "und" ? "" : lang, region, orientation, density, swdp, wdp, hdp,
    size: (screenLayout & 0x0f) || sizeClass(swdp), dir: screenLayout & 0xc0,
    uiType: uiMode & 0x0f, night: (uiMode & 0x30) === 0x20 ? 1 : 0, sdk,
  };
}
/** what a name lookup reads of the qualifiers: names resolve over one language's chunks */
type NameScope = Pick<Qualifiers, "lang" | "dir">;
const DEFAULT_SCOPE: NameScope = { lang: "", dir: 0 };

/** a NUL-terminated UTF-16 field of up to `max` units */
function utf16z(view: DataView, at: number, max: number): string {
  let s = "";
  for (let i = 0; i < max; i++) { const c = view.getUint16(at + i * 2, true); if (!c) break; s += String.fromCharCode(c); }
  return s;
}

export class Arsc {
  readonly files: Files;
  values!: StringPool;
  pkgId = 0x7f;
  pkgName = "";
  types = new Map<number, TypeChunk[]>();   // default package: typeId → configurations
  private packages = new Map<number, { name: string; types: Map<number, TypeChunk[]> }>();
  /** (package << 8 | type) → each entry's ResTable_typeSpec flags: the configuration axes it varies over */
  private specs = new Map<number, Uint32Array>();
  /** overlayable name → actor, per package name (ResTable_overlayable_header) */
  readonly overlayables = new Map<string, Map<string, string>>();
  locales = new Set<string>();
  private profiles = new Map<string, ResourceProfile>();
  private active: ResourceProfile | null = null;

  constructor(bytes: Uint8Array, files: Files = () => null) {
    this.files = files;
    const started = performance.now();
    this.parse(bytes, false);
    perf.resParseMs += performance.now() - started;
  }

  /** A config split's table: the same package, carrying only its configs' entries. Its value
   *  strings are appended past the base pool so every entry keeps indexing one pool. */
  add(bytes: Uint8Array): void { this.parse(bytes, true); this.profiles.clear(); this.active = null; }

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
        else { const at = this.values.append(pool); remap = (i) => i === 0xffffffff ? i : at + i; }
      } else if (type === 0x0200) this.parsePackage(view, pos, headerSize, size, remap);
      pos += size;
    }
  }

  private parsePackage(view: DataView, base: number, headerSize: number, size: number, remap: Remap) {
    const pkgId = view.getUint32(base + 8, true);
    const name = utf16z(view, base + 12, 128);
    const first = this.packages.size === 0;
    let pkg = this.packages.get(pkgId);
    if (!pkg) this.packages.set(pkgId, pkg = { name, types: new Map() });
    if (first || pkgId === 0x7f || pkgId === this.pkgId) {
      this.pkgId = pkgId; this.pkgName = name; this.types = pkg.types;
    }
    // A table may hold several package chunks under one id (aapt2 emits one per staged public
    // group), each with its own name pools — so they are read per chunk, never kept on `this`.
    const typeNames = new StringPool(view, base + view.getUint32(base + 268, true));
    const keyNames = new StringPool(view, base + view.getUint32(base + 276, true));
    const typeIdOffset = headerSize >= 288 ? view.getUint32(base + 284, true) : 0;
    let pos = base + headerSize;
    const end = base + size;
    while (pos < end) {
      const ctype = view.getUint16(pos, true);
      const csize = view.getUint32(pos + 4, true);
      if (ctype === 0x0201) this.parseType(view, pos, typeNames, keyNames, remap, typeIdOffset, pkg.types);
      else if (ctype === 0x0202) {
        const count = view.getUint32(pos + 12, true), at = pos + view.getUint16(pos + 2, true);
        const flags = new Uint32Array(count);
        for (let i = 0; i < count; i++) flags[i] = view.getUint32(at + i * 4, true);
        const key = (pkgId << 8) | (view.getUint8(pos + 8) + typeIdOffset);
        const old = this.specs.get(key);
        if (old) for (let i = 0; i < Math.min(old.length, count); i++) flags[i] |= old[i];
        this.specs.set(key, flags);
      } else if (ctype === 0x0204) {
        let named = this.overlayables.get(name);
        if (!named) this.overlayables.set(name, named = new Map());
        named.set(utf16z(view, pos + 8, 256), utf16z(view, pos + 520, 256));
      }
      pos += csize;
    }
  }

  private parseType(view: DataView, base: number, typeNames: StringPool, keyNames: StringPool, remap: Remap, typeIdOffset: number, types: Map<number, TypeChunk[]>) {
    const rawId = view.getUint8(base + 8), id = rawId + typeIdOffset;
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
    if (this.skipAtParse(cfg)) return;
    // Entries stay encoded until a lookup first selects the chunk's type (chunksFor).
    const chunk: TypeChunk = { id, name: typeNames.get(rawId - 1), config: cfg, entries: new Map() };
    chunk.load = () => this.parseEntries(view, base, keyNames, chunk, remap);
    let list = types.get(id);
    if (!list) types.set(id, (list = []));
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

  private profile({ lang, dir }: NameScope) {
    if (this.active?.lang !== lang || this.active.dir !== dir) {
      const key = lang + ":" + dir;
      let profile = this.profiles.get(key);
      if (!profile) this.profiles.set(key, profile = { lang, dir, types: new Map(), names: new Map(), typeNames: new Map() });
      this.active = profile;
    }
    return this.active;
  }

  private packageTypes(pkgId: number): Map<number, TypeChunk[]> | undefined {
    return pkgId === this.pkgId ? this.types : this.packages.get(pkgId)?.types;
  }

  packageIds(): number[] { return [...this.packages.keys()]; }
  packageName(pkgId: number): string | undefined { return pkgId === this.pkgId ? this.pkgName : this.packages.get(pkgId)?.name; }
  packageId(name: string): number | undefined {
    if (name === this.pkgName) return this.pkgId;
    for (const [id, pkg] of this.packages) if (pkg.name === name) return id;
    return undefined;
  }

  private chunksFor(typeId: number, pkgId: number, scope: NameScope): TypeChunk[] {
    const profile = this.profile(scope);
    const key = (pkgId << 8) | typeId;
    let chunks = profile.types.get(key);
    if (!chunks) {
      chunks = (this.packageTypes(pkgId)?.get(typeId) ?? []).filter(ch => (!ch.config.lang || ch.config.lang === profile.lang) && (!ch.config.dir || ch.config.dir === profile.dir));
      for (const chunk of chunks) chunk.load?.();
      profile.types.set(key, chunks);
    }
    return chunks;
  }

  typeName(typeId: number, entryIdx?: number, pkgId = this.pkgId, scope = DEFAULT_SCOPE): string {
    if (entryIdx === undefined) return this.chunksFor(typeId, pkgId, scope)[0]?.name ?? "?";
    const names = this.profile(scope).typeNames, id = (pkgId << 24 | typeId << 16 | entryIdx) >>> 0;
    let name = names.get(id);
    if (name === undefined) names.set(id, name = this.chunksFor(typeId, pkgId, scope).find((chunk) => chunk.entries.has(entryIdx))?.name ?? "?");
    return name;
  }

  /** every configuration the default package's types are defined under */
  configs(): Config[] {
    const out: Config[] = [];
    for (const chunks of this.types.values()) for (const ch of chunks) out.push(ch.config);
    return out;
  }

  /** the configuration axes the entry's values vary over (ResTable_typeSpec flags) */
  specFlags(resId: number): number { return this.specs.get(resId >>> 16)?.[resId & 0xffff] ?? 0; }

  /** values a device overlay replaces in every configuration, as fabricated overlays do */
  private overlaid = new Map<number, ResEntry>();
  overlay(resId: number, key: string, value: { type: number; data: number }): void { this.overlaid.set(resId, { key, value }); }

  /** the entry `resId` selects under `q`, with the density of the configuration that answered in `selected` */
  entry(resId: number, q: Qualifiers, selected?: { density: number }, density = q.density): ResEntry | null {
    const overlaid = this.overlaid.get(resId);
    if (overlaid) return overlaid;
    const pkgId = resId >>> 24;
    const typeId = (resId >> 16) & 0xff;
    const entryIdx = resId & 0xffff;
    const chunks = this.chunksFor(typeId, pkgId, q);
    let best: ResEntry | null = null;
    let bestScore = -1;
    for (const ch of chunks) {
      const e = ch.entries.get(entryIdx);
      if (!e) continue;
      const s = configScore(ch.config, q, density);
      if (s > bestScore) { bestScore = s; best = e; if (selected) selected.density = ch.config.density; }
    }
    return best;
  }

  /** Static parse-time rejection: what this display selects in neither rotation. Night, locale and
   *  orientation can change while the table lives. */
  private skipAtParse(c: Config): boolean {
    const w = Math.round(dev.width / dev.density), h = Math.round(dev.height / dev.density);
    const fitsEitherAxis = (c.wdp <= w && c.hdp <= h) || (c.wdp <= h && c.hdp <= w);
    return c.sdk > dev.sdk
      || c.swdp > dev.smallestWidthDp || !fitsEitherAxis
      || c.size > sizeClass(dev.smallestWidthDp) || (c.uiType !== 0 && c.uiType !== 1);
  }

  /** every entry name of a type → its id, built once per type */
  names(typeName: string, pkgId = this.pkgId, scope = DEFAULT_SCOPE): Map<string, number> {
    const names = this.profile(scope).names;
    const key = pkgId + ":" + typeName;
    let m = names.get(key);
    if (m) return m;
    names.set(key, m = new Map());
    // A resource still being staged is emitted twice: once at its finalized id and once under a
    // staging type id, which is allocated high. Ascending type id, first name wins, so the
    // finalized id is the one a name resolves to.
    for (const tid of [...(this.packageTypes(pkgId)?.keys() ?? [])].sort((a, b) => a - b)) {
      for (const ch of this.chunksFor(tid, pkgId, scope)) {
        if (ch.name !== typeName) continue;
        for (const [idx, e] of ch.entries) if (!m.has(e.key)) m.set(e.key, (pkgId << 24) | (tid << 16) | idx);
      }
    }
    return m;
  }

  /** find resource id by type name + entry name */
  findId(typeName: string, key: string, pkgId = this.pkgId, scope = DEFAULT_SCOPE): number { return this.names(typeName, pkgId, scope).get(key) ?? 0; }
}

/** Match the selecting configuration. Unlike parse-time viability, its axes are exact. */
function skipCurrent(c: Config, d: Qualifiers): boolean {
  return c.sdk > d.sdk || (!!c.lang && c.lang !== d.lang) || (!!c.region && c.region !== d.region) || (!!c.orientation && c.orientation !== d.orientation)
    || c.swdp > d.swdp || c.wdp > d.wdp || c.hdp > d.hdp
    || c.size > d.size || (c.dir !== 0 && c.dir !== d.dir) || (c.uiType !== 0 && c.uiType !== d.uiType);
}

function configScore(c: Config, d: Qualifiers, density: number): number {
  if (skipCurrent(c, d)) return -1;
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
    const diff = c.density === density ? 4096 : c.density > density ? 2048 - (c.density - density) / 8 : 1024 - (density - c.density) / 8;
    s += (1 << 11) + diff / 4096 * 1023;
  }
  if (c.sdk) s += c.sdk;
  return s;
}
