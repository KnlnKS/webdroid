// libz streaming API (z_stream in guest memory) over fflate's streaming classes.

import { Inflate, Unzlib } from "fflate";
import { mem, AddrMap } from "./mem";
import { hostLib, type HostFn, PTR, stp, ldp } from "./host";

// z_stream: next_in, avail_in, total_in, next_out, avail_out, total_out, msg, state, ... — pointer
// and ulong fields, so the offsets follow the pointer width (32-bit: 0/4/8/12/16/20/24/28;
// LP64: 0/8/16/24/32/40/48/56, 112 bytes in all)
let Z = { IN: 0, AVIN: 4, TIN: 8, OUT: 12, AVOUT: 16, TOUT: 20, MSG: 24, STATE: 28 };
const Z_OK = 0, Z_STREAM_END = 1, Z_STREAM_ERROR = -2, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5;

interface Stream { st: Inflate | Unzlib; out: Uint8Array[]; done: boolean; err: string | null }
const streams = new AddrMap<Stream>();
let stateSeq = 1;

function open(strm: number, windowBits: number): number {
  const raw = windowBits < 0;
  const st = raw ? new Inflate() : new Unzlib();
  const s: Stream = { st, out: [], done: false, err: null };
  st.ondata = (d, final) => { if (d.length) s.out.push(d); if (final) s.done = true; };
  streams.set(strm, s);
  stp(strm + Z.STATE, stateSeq++);
  stp(strm + Z.TIN, 0); stp(strm + Z.TOUT, 0); stp(strm + Z.MSG, 0);
  return Z_OK;
}

function inflate(strm: number): number {
  const s = streams.get(strm);
  if (!s) return Z_STREAM_ERROR;
  const availIn = mem.ld32(strm + Z.AVIN) >>> 0, nextIn = ldp(strm + Z.IN);
  if (availIn && !s.done) {
    try {
      const st = s.st as unknown as { push(d: Uint8Array): void; s: { f?: number; l?: unknown } };
      st.push(mem.u8.slice(nextIn, nextIn + availIn));
      // BFINAL block decoded (fflate only flags `final` on request) — see java.util.zip.Inflater
      if (st.s.f && !st.s.l) s.done = true;
    } catch (e) { s.err = String(e); return Z_DATA_ERROR; }
    stp(strm + Z.IN, nextIn + availIn); mem.st32(strm + Z.AVIN, 0);
    stp(strm + Z.TIN, mem.ld32(strm + Z.TIN) + availIn);
  }
  let availOut = mem.ld32(strm + Z.AVOUT) >>> 0, nextOut = ldp(strm + Z.OUT), wrote = 0;
  while (availOut > 0 && s.out.length) {
    const c = s.out[0];
    const take = Math.min(availOut, c.length);
    mem.u8.set(c.subarray(0, take), nextOut);
    nextOut += take; availOut -= take; wrote += take;
    if (take === c.length) s.out.shift(); else s.out[0] = c.subarray(take);
  }
  stp(strm + Z.OUT, nextOut); mem.st32(strm + Z.AVOUT, availOut);
  stp(strm + Z.TOUT, mem.ld32(strm + Z.TOUT) + wrote);
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
  if (PTR === 8) Z = { IN: 0, AVIN: 8, TIN: 16, OUT: 24, AVOUT: 32, TOUT: 40, MSG: 48, STATE: 56 };
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
        stp(dstLen, total);
        return Z_OK;
      } catch { return Z_DATA_ERROR; }
    },
  };
  hostLib("libz.so", M);
  const zver = mem.hostStr("1.2.8");
}
