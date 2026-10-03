// The ICU data as ICU4C reads it: items of the common data file, resource bundles (ResB) and the
// BytesTrie format, for natives that answer from the data without ICU4J's loaders.
import { PLATFORM_DATA } from "../bootclasspath";
import { vfs } from "../../shell/vfs";
import { readFully } from "../../shell/lazyfile";

export const ICU_DATA = Object.keys(PLATFORM_DATA).find((path) => path.endsWith(".dat"))!;
export const icuRead = async (at: number, length: number) => {
  const bytes = await readFully(vfs.source(ICU_DATA)!, at, length);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};
export const cString = (view: DataView, at: number) => { let s = ""; for (let c; (c = view.getUint8(at)); at++) s += String.fromCharCode(c); return s; };
/** udata_open: an item of the common data, found in its table of contents, as its header's offset */
export async function icuItem(name: string): Promise<number> {
  const header = (await icuRead(0, 2)).getUint16(0, true), first = await icuRead(header, 12), count = first.getUint32(0, true);
  const toc = await icuRead(0, header + first.getUint32(8, true)), path = `${ICU_DATA.slice(ICU_DATA.lastIndexOf("/") + 1, -4)}/${name}`;
  for (let i = 0; i < count; i++)
    if (cString(toc, header + toc.getUint32(header + 4 + 8 * i, true)) === path) return header + toc.getUint32(header + 8 + 8 * i, true);
  throw new Error(`no ${path} in ${ICU_DATA}`);
}
/** A resource bundle item read whole (ResB formatVersion 2 or 3, without a pool bundle), its resources
 *  resolved as ICUResourceBundleReader resolves them */
export class ResBundle {
  private readonly v: DataView;
  private readonly units: number;
  constructor(bytes: Uint8Array) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.units = this.v.getUint32(8, true) * 4;
    if ((this.v.getUint32(4, true) & 0xff) > 5 && this.v.getUint32(24, true) & 2) throw new Error("a bundle over a pool bundle");
  }
  static async open(item: string): Promise<ResBundle> {
    const at = await icuItem(item), base = at + (await icuRead(at, 2)).getUint16(0, true);
    return new ResBundle(await readFully(vfs.source(ICU_DATA)!, base, (await icuRead(base, 20)).getUint32(16, true) * 4));
  }
  get root(): number { return this.v.getUint32(0, true); }
  private u16 = (at: number) => this.v.getUint16(at, true);
  private i32 = (at: number) => this.v.getInt32(at, true);
  /** a table's value for `key`, or undefined */
  get(table: number, key: string): number | undefined {
    const type = table >>> 28, off = table & 0xfffffff;
    const wide = type === 4, at = type === 5 ? this.units + off * 2 : off * 4;
    if (type !== 2 && type !== 4 && type !== 5) throw new Error(`resource ${table.toString(16)} is no table`);
    if (!off && type !== 5) return undefined;
    const count = wide ? this.i32(at) : this.u16(at), keys = at + (wide ? 4 : 2);
    const values = type === 5 ? keys + 2 * count : wide ? keys + 4 * count : keys + 2 * (count + (~count & 1));
    for (let i = 0; i < count; i++) {
      let k = wide ? this.i32(keys + 4 * i) : this.u16(keys + 2 * i), name = "";
      for (let c; (c = this.v.getUint8(k)); k++) name += String.fromCharCode(c);
      if (name === key) return type === 5 ? 0x60000000 | this.u16(values + 2 * i) : this.v.getUint32(values + 4 * i, true);
    }
    return undefined;
  }
  string(res: number): string {
    const type = res >>> 28, off = res & 0xfffffff;
    let at: number, length: number;
    if (type === 0) { at = off * 4 + 4; length = off ? this.i32(off * 4) : 0; }
    else if (type === 6) {
      at = this.units + off * 2;
      const first = this.u16(at);
      if ((first & 0xfc00) !== 0xdc00) { length = 0; while (this.u16(at + 2 * length)) length++; }
      else if (first < 0xdfef) { length = first & 0x3ff; at += 2; }
      else if (first < 0xdfff) { length = (first - 0xdfef) << 16 | this.u16(at + 2); at += 4; }
      else { length = this.u16(at + 2) << 16 | this.u16(at + 4); at += 6; }
    } else throw new Error(`resource ${res.toString(16)} is no string`);
    let s = "";
    for (let i = 0; i < length; i++) s += String.fromCharCode(this.u16(at + 2 * i));
    return s;
  }
  strings(res: number): string[] {
    const type = res >>> 28, off = res & 0xfffffff;
    if (type === 9) return Array.from({ length: this.u16(this.units + off * 2) }, (_, i) => this.string(0x60000000 | this.u16(this.units + off * 2 + 2 + 2 * i)));
    if (type !== 8) throw new Error(`resource ${res.toString(16)} is no array`);
    return Array.from({ length: off ? this.i32(off * 4) : 0 }, (_, i) => this.string(this.v.getUint32(off * 4 + 4 + 4 * i, true)));
  }
  ints(res: number): Int32Array {
    if (res >>> 28 !== 14) throw new Error(`resource ${res.toString(16)} is no int vector`);
    const off = res & 0xfffffff;
    return Int32Array.from({ length: off ? this.i32(off * 4) : 0 }, (_, i) => this.i32(off * 4 + 4 + 4 * i));
  }
  binary(res: number): Uint8Array {
    if (res >>> 28 !== 1) throw new Error(`resource ${res.toString(16)} is no binary`);
    const off = res & 0xfffffff;
    return off ? new Uint8Array(this.v.buffer, this.v.byteOffset + off * 4 + 4, this.i32(off * 4)).slice() : new Uint8Array(0);
  }
}

/** BytesTrie's walk (android.icu.util.BytesTrie): `next` answers its Result's ordinal (NO_MATCH,
 *  NO_VALUE, FINAL_VALUE, INTERMEDIATE_VALUE) */
export class BytesTrie {
  pos = 0;
  remaining = -1;
  constructor(private readonly b: Uint8Array) {}
  state(): [number, number] { return [this.pos, this.remaining]; }
  reset([pos, remaining]: [number, number]): this { this.pos = pos; this.remaining = remaining; return this; }
  private result(pos: number): number { const node = this.b[pos]; return node >= 0x20 ? 2 + (~node & 1) : 1; }
  private stop(): number { this.pos = -1; return 0; }
  next(c: number): number {
    let pos = this.pos;
    if (pos < 0) return 0;
    let length = this.remaining;
    if (length >= 0) {
      if (c !== this.b[pos++]) return this.stop();
      this.remaining = --length; this.pos = pos;
      return length < 0 ? this.result(pos) : 1;
    }
    for (;;) {
      const node = this.b[pos++];
      if (node < 0x10) return this.branch(pos, node, c);
      if (node < 0x20) {
        length = node - 0x10;
        if (c !== this.b[pos++]) return this.stop();
        this.remaining = --length; this.pos = pos;
        return length < 0 ? this.result(pos) : 1;
      }
      if (node & 1) return this.stop();
      pos = this.skipValue(pos, node);
    }
  }
  private branch(pos: number, length: number, c: number): number {
    const b = this.b;
    if (length === 0) length = b[pos++];
    length++;
    while (length > 5) {
      if (c < b[pos++]) { length >>= 1; pos = this.jump(pos); }
      else { length -= length >> 1; const d = b[pos]; pos += d < 0xc0 ? 1 : d < 0xf0 ? 2 : d < 0xfe ? 3 : d === 0xfe ? 4 : 5; }
    }
    do {
      if (c === b[pos++]) {
        const node = b[pos];
        // a final value stays for value() to read; an intermediate one is the delta to the next node
        if (!(node & 1)) { const [delta, at] = this.readValue(pos + 1, node >> 1); pos = at + delta; }
        this.pos = pos;
        return node & 1 ? 2 : this.result(pos);
      }
      length--;
      pos = this.skipValue(pos + 1, b[pos]);
    } while (length > 1);
    if (c !== b[pos++]) return this.stop();
    this.pos = pos;
    return this.result(pos);
  }
  private jump(pos: number): number { const [delta, at] = this.readDelta(pos); return at + delta; }
  private readDelta(pos: number): [number, number] {
    const b = this.b, d = b[pos++];
    if (d < 0xc0) return [d, pos];
    if (d < 0xf0) return [(d - 0xc0) << 8 | b[pos], pos + 1];
    if (d < 0xfe) return [(d - 0xf0) << 16 | b[pos] << 8 | b[pos + 1], pos + 2];
    if (d === 0xfe) return [b[pos] << 16 | b[pos + 1] << 8 | b[pos + 2], pos + 3];
    return [b[pos] << 24 | b[pos + 1] << 16 | b[pos + 2] << 8 | b[pos + 3], pos + 4];
  }
  /** the value after a lead byte's upper 7 bits, and where it ends */
  private readValue(pos: number, lead: number): [number, number] {
    const b = this.b;
    if (lead < 0x51) return [lead - 0x10, pos];
    if (lead < 0x6c) return [(lead - 0x51) << 8 | b[pos], pos + 1];
    if (lead < 0x7e) return [(lead - 0x6c) << 16 | b[pos] << 8 | b[pos + 1], pos + 2];
    if (lead === 0x7e) return [b[pos] << 16 | b[pos + 1] << 8 | b[pos + 2], pos + 3];
    return [b[pos] << 24 | b[pos + 1] << 16 | b[pos + 2] << 8 | b[pos + 3], pos + 4];
  }
  private skipValue(pos: number, lead: number): number {
    return lead < 0xa2 ? pos : lead < 0xd8 ? pos + 1 : lead < 0xfc ? pos + 2 : pos + 3 + (lead >> 1 & 1);
  }
  value(): number { return this.readValue(this.pos + 1, this.b[this.pos] >> 1)[0]; }
}
