// libz streaming API (z_stream in guest memory) over fflate's streaming classes.

import { Inflate, Unzlib } from "fflate";
import { mem } from "./mem";
import { hostLib, type HostFn } from "./host";

// z_stream (32-bit): next_in 0, avail_in 4, total_in 8, next_out 12, avail_out 16, total_out 20,
// msg 24, state 28, zalloc 32, zfree 36, opaque 40, data_type 44, adler 48, reserved 52
const Z_OK = 0, Z_STREAM_END = 1, Z_STREAM_ERROR = -2, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5;

interface Stream { st: Inflate | Unzlib; out: Uint8Array[]; done: boolean; err: string | null }
const streams = new Map<number, Stream>();
let stateSeq = 1;

function open(strm: number, windowBits: number): number {
  const raw = windowBits < 0;
  const st = raw ? new Inflate() : new Unzlib();
  const s: Stream = { st, out: [], done: false, err: null };
  st.ondata = (d, final) => { if (d.length) s.out.push(d); if (final) s.done = true; };
  streams.set(strm, s);
  mem.st32(strm + 28, stateSeq++);
  mem.st32(strm + 8, 0); mem.st32(strm + 20, 0); mem.st32(strm + 24, 0);
  return Z_OK;
}

function inflate(strm: number): number {
  const s = streams.get(strm);
  if (!s) return Z_STREAM_ERROR;
  const availIn = mem.ld32(strm + 4) >>> 0, nextIn = mem.ld32(strm) >>> 0;
  if (availIn && !s.done) {
    try {
      const st = s.st as unknown as { push(d: Uint8Array): void; s: { f?: number; l?: unknown } };
      st.push(mem.u8.slice(nextIn, nextIn + availIn));
      // BFINAL block decoded (fflate only flags `final` on request) — see java.util.zip.Inflater
      if (st.s.f && !st.s.l) s.done = true;
    } catch (e) { s.err = String(e); return Z_DATA_ERROR; }
    mem.st32(strm, nextIn + availIn); mem.st32(strm + 4, 0);
    mem.st32(strm + 8, mem.ld32(strm + 8) + availIn);
  }
  let availOut = mem.ld32(strm + 16) >>> 0, nextOut = mem.ld32(strm + 12) >>> 0, wrote = 0;
  while (availOut > 0 && s.out.length) {
    const c = s.out[0];
    const take = Math.min(availOut, c.length);
    mem.u8.set(c.subarray(0, take), nextOut);
    nextOut += take; availOut -= take; wrote += take;
    if (take === c.length) s.out.shift(); else s.out[0] = c.subarray(take);
  }
  mem.st32(strm + 12, nextOut); mem.st32(strm + 16, availOut);
  mem.st32(strm + 20, mem.ld32(strm + 20) + wrote);
  if (s.done && !s.out.length) return Z_STREAM_END;
  if (!wrote && !availIn) return Z_BUF_ERROR;
  return Z_OK;
}

// CRC-32 (the zlib polynomial), table driven
const crcTab = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTab[n] = c; }
function crc32(crc: number, buf: Uint8Array): number {
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = crcTab[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return ~c;
}
function adler32(adler: number, buf: Uint8Array): number {
  let a = adler & 0xffff, b = (adler >>> 16) & 0xffff;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) | 0;
}

export function zlibInit(): void {
  const M: Record<string, HostFn> = {
    inflateInit_: (_c, a) => open(a.p(), 15),
    inflateInit2_: (_c, a) => { const strm = a.p(), wb = a.i(); return open(strm, wb); },
    inflate: (_c, a) => inflate(a.p()),
    inflateEnd: (_c, a) => { streams.delete(a.p()); return Z_OK; },
    inflateReset: (_c, a) => { const strm = a.p(); const s = streams.get(strm); return open(strm, s && s.st instanceof Inflate ? -15 : 15); },
    inflateSetDictionary: () => Z_STREAM_ERROR,
    crc32: (_c, a) => { const crc = a.i(), p = a.p(), n = a.u(); if (!p) return 0; return crc32(crc, mem.u8.subarray(p, p + n)); },
    adler32: (_c, a) => { const ad = a.i(), p = a.p(), n = a.u(); if (!p) return 1; return adler32(ad, mem.u8.subarray(p, p + n)); },
    zlibVersion: () => zver,
    zError: () => zver,
    uncompress: (_c, a) => {
      const dst = a.p(), dstLen = a.p(), src = a.p(), n = a.u();
      try {
        const out = new Unzlib();
        const chunks: Uint8Array[] = [];
        out.ondata = (d) => chunks.push(d);
        out.push(mem.u8.slice(src, src + n), true);
        let total = 0; for (const c of chunks) total += c.length;
        if (total > (mem.ld32(dstLen) >>> 0)) return Z_BUF_ERROR;
        let o = dst; for (const c of chunks) { mem.u8.set(c, o); o += c.length; }
        mem.st32(dstLen, total);
        return Z_OK;
      } catch { return Z_DATA_ERROR; }
    },
  };
  hostLib("libz.so", M);
  const zver = mem.hostStr("1.2.8");
}
