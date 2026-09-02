// java.util.zip on fflate streaming codecs (Inflater/Deflater raw+zlib, CRC32).
import { Inflate, Unzlib, Deflate, Zlib } from "fflate";
import { rt, JObj } from "../runtime";

type Codec = Inflate | Unzlib | Deflate | Zlib;
class JInflater extends JObj {
  raw = false;
  st: Codec | null = null;
  out: Uint8Array[] = [];
  done = false;
  fed = 0;
  ensure() {
    if (!this.st) {
      this.st = this.raw ? new Inflate() : new Unzlib();
      this.st.ondata = (d, final) => { if (d.length) this.out.push(d); if (final) this.done = true; };
    }
    return this.st;
  }
}
function drain(z: JInflater, b: Int8Array, off: number, len: number): number {
  let n = 0;
  while (n < len && z.out.length) {
    const c = z.out[0];
    const take = Math.min(len - n, c.length);
    new Uint8Array(b.buffer, b.byteOffset + off + n, take).set(c.subarray(0, take));
    n += take;
    if (take === c.length) z.out.shift(); else z.out[0] = c.subarray(take);
  }
  return n;
}
rt.register({
  name: "java/util/zip/Inflater", ctor: JInflater,
  methods: {
    "<init>()V": function (this: JInflater) { this.raw = false; },
    "<init>(Z)V": function (this: JInflater, nowrap: number) { this.raw = !!nowrap; },
    "setInput([BII)V": function (this: JInflater, b: Int8Array, off: number, len: number) {
      this.fed += len;
      this.ensure().push(new Uint8Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + len)));
    },
    "setInput([B)V": function (this: JInflater, b: Int8Array) {
      this.fed += b.length;
      this.ensure().push(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
    },
    "inflate([BII)I": function (this: JInflater, b: Int8Array, off: number, len: number) { return drain(this, b, off, len); },
    "inflate([B)I": function (this: JInflater, b: Int8Array) { return drain(this, b, 0, b.length); },
    "needsInput()Z": function (this: JInflater) { return this.out.length ? 0 : 1; },
    "needsDictionary()Z": () => 0,
    "finished()Z": function (this: JInflater) { return this.done && !this.out.length ? 1 : 0; },
    "getBytesRead()J": function (this: JInflater) { return BigInt(this.fed); },
    "getBytesWritten()J": function (this: JInflater) { return BigInt(this.fed); },
    "reset()V": function (this: JInflater) { this.st = null; this.out = []; this.done = false; this.fed = 0; },
    "end()V": function (this: JInflater) { this.st = null; this.out = []; },
  },
});

class JDeflater extends JObj {
  raw = false;
  st: Codec | null = null;
  out: Uint8Array[] = [];
  done = false;
  pending: Uint8Array | null = null;
  ensure() {
    if (!this.st) {
      this.st = this.raw ? new Deflate() : new Zlib();
      this.st.ondata = (d, final) => { if (d.length) this.out.push(d); if (final) this.done = true; };
    }
    return this.st;
  }
}
rt.register({
  name: "java/util/zip/Deflater", ctor: JDeflater,
  methods: {
    "<init>()V": function () {},
    // fflate's Deflate has no level knob: the level argument is accepted and ignored.
    "<init>(I)V": function () {},
    "<init>(IZ)V": function (this: JDeflater, _level: number, nowrap: number) { this.raw = !!nowrap; },
    "setInput([BII)V": function (this: JDeflater, b: Int8Array, off: number, len: number) {
      this.pending = new Uint8Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + len));
    },
    "finish()V": function (this: JDeflater) {
      this.ensure().push(this.pending ?? new Uint8Array(0), true);
      this.pending = null;
    },
    "deflate([BII)I": function (this: JDeflater, b: Int8Array, off: number, len: number) {
      if (this.pending) { this.ensure().push(this.pending); this.pending = null; }
      const z = this as unknown as JInflater;
      return drain(z, b, off, len);
    },
    "finished()Z": function (this: JDeflater) { return this.done && !this.out.length ? 1 : 0; },
    "needsInput()Z": function (this: JDeflater) { return this.pending ? 0 : 1; },
    "end()V": function (this: JDeflater) { this.st = null; this.out = []; },
    "reset()V": function (this: JDeflater) { this.st = null; this.out = []; this.done = false; this.pending = null; },
  },
});

class JCRC32 extends JObj { crc = 0xffffffff; }
const CRC_T = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[i] = c >>> 0; }
rt.register({
  name: "java/util/zip/CRC32", ctor: JCRC32,
  methods: {
    "<init>()V": function () {},
    "update([BII)V": function (this: JCRC32, b: Int8Array, off: number, len: number) {
      let c = this.crc;
      for (let i = 0; i < len; i++) c = CRC_T[(c ^ b[off + i]) & 0xff] ^ (c >>> 8);
      this.crc = c >>> 0;
    },
    "update(I)V": function (this: JCRC32, v: number) { this.crc = (CRC_T[(this.crc ^ v) & 0xff] ^ (this.crc >>> 8)) >>> 0; },
    "getValue()J": function (this: JCRC32) { return BigInt((this.crc ^ 0xffffffff) >>> 0); },
    "reset()V": function (this: JCRC32) { this.crc = 0xffffffff; },
  },
});
