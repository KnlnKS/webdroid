// The pieces of a class file writer the generators of test classes share: a constant pool and big-endian numbers.
export const u2 = (v: number) => [(v >> 8) & 255, v & 255];
export const u4 = (v: number) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];

export class Pool {
  bytes: number[] = []; count = 1; private map = new Map<string, number>();
  private add(key: string, ...b: number[]) { let i = this.map.get(key); if (i === undefined) { i = this.count++; this.map.set(key, i); this.bytes.push(...b); } return i; }
  utf8(s: string) { const e = new TextEncoder().encode(s); return this.add("u" + s, 1, ...u2(e.length), ...e); }
  int(v: number) { return this.add("i" + v, 3, ...u4(v)); }
  numeric(tag: 4 | 5 | 6, value: number | bigint) {
    const bits = new DataView(new ArrayBuffer(8));
    if (tag === 4) bits.setFloat32(0, Number(value));
    else if (tag === 5) bits.setBigInt64(0, BigInt(value));
    else bits.setFloat64(0, Number(value));
    const bytes = [...new Uint8Array(bits.buffer)].slice(0, tag === 4 ? 4 : 8), before = this.count;
    const index = this.add(`v${tag}:${bytes}`, tag, ...bytes);
    if (tag !== 4 && this.count !== before) this.count++;
    return index;
  }
  cls(name: string) { return this.add("c" + name, 7, ...u2(this.utf8(name))); }
  string(s: string) { return this.add("s" + s, 8, ...u2(this.utf8(s))); }
  nameAndType(name: string, desc: string) { return this.add(`n${name}:${desc}`, 12, ...u2(this.utf8(name)), ...u2(this.utf8(desc))); }
  /** a Fieldref (9), Methodref (10) or InterfaceMethodref (11) */
  member(tag: 9 | 10 | 11, cls: string, name: string, desc: string) { return this.add(`m${tag}${cls}.${name}:${desc}`, tag, ...u2(this.cls(cls)), ...u2(this.nameAndType(name, desc))); }
  methodHandle(kind: number, ref: number) { return this.add(`h${kind}:${ref}`, 15, kind, ...u2(ref)); }
  methodType(desc: string) { return this.add("t" + desc, 16, ...u2(this.utf8(desc))); }
  invokeDynamic(bootstrap: number, name: string, desc: string) { return this.add(`d${bootstrap}${name}${desc}`, 18, ...u2(bootstrap), ...u2(this.nameAndType(name, desc))); }
}
