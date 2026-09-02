// resources.arsc parser + config-aware entry resolution.
// Refs: AOSP libs/androidfw/include/androidfw/ResourceTypes.h

import { StringPool } from "./axml";
import { device as dev } from "../shell/config";

interface ResEntry {
  key: string;                     // entry name
  value?: { type: number; data: number };            // simple
  bag?: { parent: number; map: [number, number, number][] };  // [attrResId, valueType, data]
}

interface TypeChunk {
  id: number;
  config: Config;
  entries: Map<number, ResEntry>;
}

interface Config {
  density: number; sdk: number; orientation: number; night: number;
  lang: string; swdp: number; wdp: number; hdp: number;
  score: number; // computed match score
}

const defaultConfig: Config = { density: 0, sdk: 0, orientation: 0, night: 0, lang: "", swdp: 0, wdp: 0, hdp: 0, score: 0 };

export class Arsc {
  values!: StringPool;
  typeNames!: StringPool;
  keyNames!: StringPool;
  pkgId = 0x7f;
  pkgName = "";
  types = new Map<number, TypeChunk[]>();   // typeId → chunks (one per config)
  device = { density: dev.densityDpi, sdk: dev.sdk, night: 0, wdp: dev.widthDp, hdp: dev.screenHeightDp, swdp: dev.widthDp, lang: dev.lang };

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== 0x0002) throw new Error("not arsc");
    let pos = view.getUint16(2, true);
    const total = view.getUint32(4, true);
    while (pos < total) {
      const type = view.getUint16(pos, true);
      const headerSize = view.getUint16(pos + 2, true);
      const size = view.getUint32(pos + 4, true);
      if (type === 0x0001) this.values = new StringPool(view, pos);
      else if (type === 0x0200) this.parsePackage(view, pos, headerSize, size);
      pos += size;
    }
  }

  private parsePackage(view: DataView, base: number, headerSize: number, size: number) {
    this.pkgId = view.getUint32(base + 8, true);
    let name = "";
    for (let i = 0; i < 128; i++) {
      const c = view.getUint16(base + 12 + i * 2, true);
      if (!c) break;
      name += String.fromCharCode(c);
    }
    this.pkgName = name;
    const typeStringsOff = view.getUint32(base + 268, true);
    const keyStringsOff = view.getUint32(base + 276, true);
    this.typeNames = new StringPool(view, base + typeStringsOff);
    this.keyNames = new StringPool(view, base + keyStringsOff);
    let pos = base + headerSize;
    const end = base + size;
    while (pos < end) {
      const ctype = view.getUint16(pos, true);
      const csize = view.getUint32(pos + 4, true);
      if (ctype === 0x0201) this.parseType(view, pos);
      pos += csize;
    }
  }

  private parseType(view: DataView, base: number) {
    const headerSize = view.getUint16(base + 2, true);
    const id = view.getUint8(base + 8);
    const flags = view.getUint8(base + 9);
    const entryCount = view.getUint32(base + 12, true);
    const entriesStart = view.getUint32(base + 16, true);
    const cfgSize = view.getUint32(base + 20, true);
    const cfg: Config = { ...defaultConfig };
    const c = base + 20;
    if (cfgSize >= 16) {
      const l1 = view.getUint8(c + 8), l2 = view.getUint8(c + 9);
      if (l1) cfg.lang = String.fromCharCode(l1, l2);
      cfg.orientation = view.getUint8(c + 12);
      cfg.density = view.getUint16(c + 14, true);
    }
    if (cfgSize >= 28) cfg.sdk = view.getUint16(c + 24, true);
    if (cfgSize >= 32) cfg.night = (view.getUint8(c + 29) & 0x30) === 0x20 ? 1 : (view.getUint8(c + 29) & 0x30) === 0x10 ? -1 : 0;
    if (cfgSize >= 36) {
      cfg.swdp = view.getUint16(c + 30, true);
      cfg.wdp = view.getUint16(c + 32, true);
      cfg.hdp = view.getUint16(c + 34, true);
    }
    const chunk: TypeChunk = { id, config: cfg, entries: new Map() };
    const offBase = base + headerSize;
    const sparse = (flags & 0x01) !== 0;
    const eBase = base + entriesStart;
    const readEntry = (entryIdx: number, off: number) => {
      const p = eBase + off;
      const sizeOrKey = view.getUint16(p, true);
      const eflags = view.getUint16(p + 2, true);
      if (eflags & 0x0008) {
        // FLAG_COMPACT: word0 = key(u16) + flags(u16, high byte = dataType), word1 = data
        const ent: ResEntry = {
          key: this.keyNames.get(sizeOrKey),
          value: { type: (eflags >> 8) & 0xff, data: view.getInt32(p + 4, true) },
        };
        chunk.entries.set(entryIdx, ent);
        return;
      }
      const size = sizeOrKey;
      const key = this.keyNames.get(view.getUint32(p + 4, true));
      const ent: ResEntry = { key };
      if (eflags & 0x0001) {
        const parent = view.getUint32(p + 8, true);
        const count = view.getUint32(p + 12, true);
        const map: [number, number, number][] = [];
        for (let j = 0; j < count; j++) {
          const mp = p + 16 + j * 12;
          map.push([
            view.getUint32(mp, true),
            view.getUint8(mp + 7),
            view.getInt32(mp + 8, true),
          ]);
        }
        ent.bag = { parent, map };
      } else {
        ent.value = { type: view.getUint8(p + size + 3), data: view.getInt32(p + size + 4, true) };
      }
      chunk.entries.set(entryIdx, ent);
    };
    if (sparse) {
      for (let i = 0; i < entryCount; i++) {
        const idx = view.getUint16(offBase + i * 4, true);
        const off = view.getUint16(offBase + i * 4 + 2, true) * 4;
        readEntry(idx, off);
      }
    } else {
      for (let i = 0; i < entryCount; i++) {
        const off = view.getUint32(offBase + i * 4, true);
        if (off !== 0xffffffff) readEntry(i, off);
      }
    }
    let list = this.types.get(id);
    if (!list) this.types.set(id, (list = []));
    list.push(chunk);
  }

  typeName(typeId: number): string { return this.typeNames.get(typeId - 1); }

  typeIdByName(name: string): number {
    for (let i = 0; i < this.typeNames.strings.length; i++) {
      if (this.typeNames.strings[i] === name) return i + 1;
    }
    return -1;
  }

  /** best-config entry for resId, or null */
  entry(resId: number): ResEntry | null {
    if ((resId >>> 24) !== this.pkgId) return null;
    const typeId = (resId >> 16) & 0xff;
    const entryIdx = resId & 0xffff;
    const chunks = this.types.get(typeId);
    if (!chunks) return null;
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

  private configScore(c: Config): number {
    const d = this.device;
    // eliminate non-matching
    if (c.sdk > d.sdk) return -1;
    if (c.lang && c.lang !== d.lang) return -1;
    if (c.night !== 0 && c.night !== (d.night ? 1 : -1)) return -1;
    if (c.orientation === 2) return -1;           // landscape variants
    if (c.swdp > d.swdp || c.wdp > d.wdp || c.hdp > d.hdp) return -1;
    let s = 0;
    if (c.lang) s += 1 << 20;
    if (c.swdp) s += (1 << 14) + c.swdp;
    if (c.wdp || c.hdp) s += (1 << 13) + c.wdp;
    if (c.night !== 0) s += 1 << 10;
    if (c.density) {
      // prefer closest density ≥ device, then closest below
      const diff = c.density === d.density ? 4096 : c.density > d.density ? 2048 - (c.density - d.density) / 8 : 1024 - (d.density - c.density) / 8;
      s += (1 << 11) + diff / 4096 * 1023;
    }
    if (c.sdk) s += c.sdk;
    return s;
  }

  /** find resource id by type name + entry name */
  findId(typeName: string, key: string): number {
    const tid = this.typeIdByName(typeName);
    if (tid < 0) return 0;
    for (const ch of this.types.get(tid) ?? []) {
      for (const [idx, e] of ch.entries) {
        if (e.key === key) return (this.pkgId << 24) | (tid << 16) | idx;
      }
    }
    return 0;
  }
}
