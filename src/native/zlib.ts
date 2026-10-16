// libz streaming inflate API over fflate's raw DEFLATE decoder, for an ARM32 process (a 64-bit one
// runs the reference build's libz). Container headers and trailers stay here so zlib, gzip, and
// auto-detect modes have zlib-compatible completion and checksums.

import { Inflate, Deflate, Zlib, Gzip } from "fflate";
import { mem, AddrMap } from "./mem.ts";
import { hostLib, type HostFn, stp, ldp } from "./host.ts";
import { concat } from "../jvm/abi.ts";
import { crc32 as javaCrc32, adler32 as javaAdler32 } from "../jvm/natives/jzip.ts";

// z_stream fields used here
const Z = { IN: 0, AVIN: 4, TIN: 8, OUT: 12, AVOUT: 16, TOUT: 20, MSG: 24, STATE: 28, ADLER: 48 };
const Z_OK = 0, Z_STREAM_END = 1, Z_NEED_DICT = 2, Z_STREAM_ERROR = -2, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5;

type Wrapper = "raw" | "zlib" | "gzip";
type Phase = "header" | "body" | "trailer" | "done" | "error";
interface RawInflate {
  ondata: (data: Uint8Array, final: boolean) => void;
  push(data: Uint8Array): void;
  s: { f?: number; l?: unknown; p?: number };
  p: Uint8Array;
}
interface Stream {
  windowBits: number;
  wrapper: Wrapper | null;
  phase: Phase;
  st: RawInflate | null;
  pending: Uint8Array;
  out: Uint8Array[];
  check: number;
  size: number;
  error: number;
  heldInput: number;
}
const streams = new AddrMap<Stream>();
let stateSeq = 1;
const empty = new Uint8Array(0);

// jzip's checksums answer Java's signed int; zlib's are unsigned
const crc32 = (sum: number, b: Uint8Array) => javaCrc32(sum, b) >>> 0, adler32 = (sum: number, b: Uint8Array) => javaAdler32(sum, b) >>> 0;

function loadUlong(address: number): number {
  return mem.ld32(address) >>> 0;
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  if (!b.length) return a;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a); joined.set(b, a.length);
  return joined;
}

function configuredWrapper(windowBits: number): Wrapper | null | undefined {
  if (windowBits <= -8 && windowBits >= -15) return "raw";
  if (windowBits === 0 || windowBits >= 8 && windowBits <= 15) return "zlib";
  if (windowBits >= 24 && windowBits <= 31) return "gzip";
  if (windowBits >= 40 && windowBits <= 47) return null;
  return undefined;
}

function startBody(s: Stream): void {
  const st = new Inflate() as unknown as RawInflate;
  st.ondata = (data) => {
    if (!data.length) return;
    s.out.push(data);
    s.check = s.wrapper === "gzip" ? crc32(s.check, data) : adler32(s.check, data);
    s.size = (s.size + data.length) >>> 0;
  };
  s.st = st;
  s.phase = "body";
}

function makeStream(windowBits: number): Stream | null {
  const wrapper = configuredWrapper(windowBits);
  if (wrapper === undefined) return null;
  const s: Stream = {
    windowBits, wrapper, phase: wrapper === "raw" ? "body" : "header", st: null,
    pending: empty, out: [], check: wrapper === "gzip" ? 0 : 1, size: 0, error: Z_OK, heldInput: 0,
  };
  if (wrapper === "raw") startBody(s);
  return s;
}

function open(strm: number, windowBits: number): number {
  if (!strm) return Z_STREAM_ERROR;
  const s = makeStream(windowBits);
  if (!s) return Z_STREAM_ERROR;
  streams.set(strm, s);
  stp(strm + Z.STATE, stateSeq++);
  mem.st32(strm + Z.TIN, 0); mem.st32(strm + Z.TOUT, 0);
  stp(strm + Z.MSG, 0); mem.st32(strm + Z.ADLER, s.check);
  return Z_OK;
}

function gzipHeaderLength(data: Uint8Array): number {
  if (data.length < 10) return 0;
  const flags = data[3];
  if (data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8 || flags & 0xe0) return -1;
  let at = 10;
  if (flags & 4) {
    if (data.length < at + 2) return 0;
    const length = data[at] | data[at + 1] << 8;
    at += 2;
    if (data.length < at + length) return 0;
    at += length;
  }
  for (const flag of [8, 16]) if (flags & flag) {
    while (at < data.length && data[at]) at++;
    if (at === data.length) return 0;
    at++;
  }
  if (flags & 2) {
    if (data.length < at + 2) return 0;
    const expected = data[at] | data[at + 1] << 8;
    if ((crc32(0, data.subarray(0, at)) & 0xffff) !== expected) return -1;
    at += 2;
  }
  return at;
}

function failStream(s: Stream, code = Z_DATA_ERROR): number {
  s.phase = "error";
  s.error = code;
  return code;
}

function parseHeader(s: Stream): number {
  if (s.wrapper === null) {
    if (s.pending.length < 2) return Z_OK;
    s.wrapper = s.pending[0] === 0x1f && s.pending[1] === 0x8b ? "gzip" : "zlib";
    s.check = s.wrapper === "gzip" ? 0 : 1;
  }
  if (s.wrapper === "zlib") {
    if (s.pending.length < 2) return Z_OK;
    const cmf = s.pending[0], flags = s.pending[1];
    const maximum = s.windowBits === 0 || s.windowBits >= 40 ? 15 : s.windowBits;
    if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || (cmf >>> 4) + 8 > maximum || ((cmf << 8) | flags) % 31) return failStream(s);
    if (flags & 0x20) {
      if (s.pending.length < 6) return Z_OK;
      s.pending = s.pending.subarray(6);
      return failStream(s, Z_NEED_DICT);
    }
    s.pending = s.pending.subarray(2);
  } else {
    const header = gzipHeaderLength(s.pending);
    if (header < 0) return failStream(s);
    if (!header) return Z_OK;
    s.pending = s.pending.subarray(header);
  }
  startBody(s);
  return Z_OK;
}

function little32(data: Uint8Array, at: number): number {
  return (data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24) >>> 0;
}

function processPending(s: Stream): number {
  if (s.phase === "error") return s.error;
  if (s.phase === "done") return Z_STREAM_END;
  if (s.phase === "header") {
    const code = parseHeader(s);
    if (code !== Z_OK || s.phase === "header") return code;
  }
  if (s.phase === "body" && s.pending.length) {
    const input = s.pending;
    s.pending = empty;
    try { s.st!.push(input); } catch { return failStream(s); }
    const st = s.st!;
    if (st.s.f && !st.s.l) {
      const remaining = Math.max(0, st.p.length - (((st.s.p ?? 0) & 7) ? 1 : 0));
      s.pending = remaining ? st.p.slice(st.p.length - remaining) : empty;
      s.phase = s.wrapper === "raw" ? "done" : "trailer";
    }
  }
  if (s.phase !== "trailer") return s.phase === "done" ? Z_STREAM_END : Z_OK;
  const trailerSize = s.wrapper === "gzip" ? 8 : 4;
  if (s.pending.length < trailerSize) return Z_OK;
  if (s.wrapper === "gzip") {
    if (little32(s.pending, 0) !== (s.check >>> 0) || little32(s.pending, 4) !== s.size) return failStream(s);
  } else {
    const expected = (s.pending[0] << 24 | s.pending[1] << 16 | s.pending[2] << 8 | s.pending[3]) >>> 0;
    if (expected !== (s.check >>> 0)) return failStream(s);
  }
  s.pending = s.pending.subarray(trailerSize);
  s.phase = "done";
  return Z_STREAM_END;
}

function drain(s: { out: Uint8Array[] }, strm: number): number {
  let avail = mem.ld32(strm + Z.AVOUT) >>> 0, out = ldp(strm + Z.OUT), wrote = 0;
  while (avail && s.out.length) {
    const chunk = s.out[0], take = Math.min(avail, chunk.length);
    mem.write(out, chunk.subarray(0, take));
    out += take; avail -= take; wrote += take;
    if (take === chunk.length) s.out.shift(); else s.out[0] = chunk.subarray(take);
  }
  stp(strm + Z.OUT, out); mem.st32(strm + Z.AVOUT, avail);
  mem.st32(strm + Z.TOUT, loadUlong(strm + Z.TOUT) + wrote);
  return wrote;
}

function consumeInput(s: Stream, strm: number): void {
  const consumed = s.heldInput;
  if (!consumed) return;
  stp(strm + Z.IN, ldp(strm + Z.IN) + consumed);
  mem.st32(strm + Z.AVIN, (mem.ld32(strm + Z.AVIN) >>> 0) - consumed);
  mem.st32(strm + Z.TIN, loadUlong(strm + Z.TIN) + consumed);
  s.heldInput = 0;
}

function inflate(strm: number): number {
  const s = streams.get(strm);
  if (!s) return Z_STREAM_ERROR;
  if (!mem.ld32(strm + Z.AVOUT)) return Z_BUF_ERROR;
  let wrote = drain(s, strm);
  if (s.out.length) return wrote ? Z_OK : Z_BUF_ERROR;
  consumeInput(s, strm);
  if (s.phase === "error") return s.error;
  if (s.phase === "done") return Z_STREAM_END;
  if (!mem.ld32(strm + Z.AVOUT)) return Z_OK;

  const availIn = mem.ld32(strm + Z.AVIN) >>> 0, nextIn = ldp(strm + Z.IN);
  let consumed = 0, code = Z_OK;
  if (availIn) {
    s.pending = append(s.pending, mem.u8.slice(nextIn, nextIn + availIn));
    code = processPending(s);
    const phase = s.phase as Phase;
    const extra = phase === "done" || phase === "error" ? Math.min(availIn, s.pending.length) : 0;
    consumed = availIn - extra;
    // Keep input available until its buffered output drains: scanline readers otherwise
    // advance past their final compressed chunk before receiving all image rows.
    s.heldInput = consumed;
    mem.st32(strm + Z.ADLER, s.check);
  }
  if (code < Z_OK || code === Z_NEED_DICT) { consumeInput(s, strm); return code; }
  wrote += drain(s, strm);
  if (!s.out.length) consumeInput(s, strm);
  if ((s.phase as Phase) === "done" && !s.out.length) return Z_STREAM_END;
  return consumed || wrote ? Z_OK : Z_BUF_ERROR;
}

function decodeZlib(data: Uint8Array): Uint8Array | null {
  const s = makeStream(15)!;
  s.pending = data;
  if (processPending(s) !== Z_STREAM_END) return null;
  return concat(s.out);
}

type Encoder = { codec: Deflate | Zlib | Gzip; out: Uint8Array[]; bits: number; level: number; check: number; finished: boolean; started: boolean; flush: number };
const encoders = new AddrMap<Encoder>();
function openEncoder(strm: number, level: number, bits: number): number {
  const compression = ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const)[level === -1 ? 6 : level];
  if (!strm || compression === undefined || ![-15, 15, 31].includes(bits)) return Z_STREAM_ERROR;
  const codec = bits < 0 ? new Deflate({ level: compression }) : bits === 31 ? new Gzip({ level: compression, mtime: 0 }) : new Zlib({ level: compression });
  const s: Encoder = { codec, out: [], bits, level, check: bits === 31 ? 0 : 1, finished: false, started: false, flush: -1 };
  codec.ondata = (chunk) => { if (chunk.length) s.out.push(chunk); };
  encoders.set(strm, s);
  stp(strm + Z.STATE, stateSeq++); stp(strm + Z.MSG, 0);
  mem.st32(strm + Z.TIN, 0); mem.st32(strm + Z.TOUT, 0); mem.st32(strm + Z.ADLER, s.check);
  return Z_OK;
}
function deflate(strm: number, flush: number): number {
  const s = encoders.get(strm);
  if (!s || ![0, 2, 4, 5].includes(flush)) return Z_STREAM_ERROR;
  const count = mem.ld32(strm + Z.AVIN) >>> 0;
  if (s.finished && (flush !== 4 || count)) return Z_STREAM_ERROR;
  if (!ldp(strm + Z.OUT) || count && !ldp(strm + Z.IN)) return Z_STREAM_ERROR;
  if (!mem.ld32(strm + Z.AVOUT)) return Z_BUF_ERROR;
  let wrote = drain(s, strm);
  if (s.out.length || !mem.ld32(strm + Z.AVOUT)) return Z_OK;
  if (s.finished) return Z_STREAM_END;
  if (!count && (flush === 0 || flush === s.flush)) return wrote ? Z_OK : Z_BUF_ERROR;
  const source = ldp(strm + Z.IN), bytes = mem.u8.subarray(source, source + count);
  s.check = s.bits === 31 ? crc32(s.check, bytes) : adler32(s.check, bytes);
  s.codec.push(bytes, flush === 4);
  if (flush === 2 || flush === 5) s.codec.flush(flush === 2);
  s.started = true; s.finished = flush === 4; s.flush = flush;
  stp(strm + Z.IN, source + count); mem.st32(strm + Z.AVIN, 0);
  mem.st32(strm + Z.TIN, loadUlong(strm + Z.TIN) + count); mem.st32(strm + Z.ADLER, s.check);
  wrote += drain(s, strm);
  return s.finished && !s.out.length ? Z_STREAM_END : count || wrote ? Z_OK : Z_BUF_ERROR;
}

export function zlibInit(): void {
  const M: Record<string, HostFn> = {
    deflateInit_: (_c, a) => { const strm = a.p(), level = a.i(); a.str(); a.i(); return openEncoder(strm, level, 15); },
    deflateInit2_: (_c, a) => {
      const strm = a.p(), level = a.i(), method = a.i(), bits = a.i(), memory = a.i(), strategy = a.i(); a.str(); a.i();
      return method === 8 && memory >= 1 && memory <= 9 && strategy >= 0 && strategy <= 4 ? openEncoder(strm, level, bits) : Z_STREAM_ERROR;
    },
    deflate: (_c, a) => deflate(a.p(), a.i()),
    deflateReset: (_c, a) => { const strm = a.p(), s = encoders.get(strm); return s ? openEncoder(strm, s.level, s.bits) : Z_STREAM_ERROR; },
    deflateEnd: (_c, a) => {
      const strm = a.p(), s = encoders.get(strm);
      if (!s) return Z_STREAM_ERROR;
      encoders.delete(strm); stp(strm + Z.STATE, 0);
      return s.started && !s.finished ? Z_DATA_ERROR : Z_OK;
    },
    inflateInit_: (_c, a) => { const strm = a.p(); a.str(); a.i(); return open(strm, 15); },
    inflateInit2_: (_c, a) => { const strm = a.p(), bits = a.i(); a.str(); a.i(); return open(strm, bits); },
    inflate: (_c, a) => inflate(a.p()),
    inflateEnd: (_c, a) => streams.delete(a.p()) ? Z_OK : Z_STREAM_ERROR,
    inflateReset: (_c, a) => { const strm = a.p(), s = streams.get(strm); return s ? open(strm, s.windowBits) : Z_STREAM_ERROR; },
    inflateSetDictionary: () => Z_STREAM_ERROR,
    crc32: (_c, a) => { const crc = a.i(), p = a.p(), n = a.u(); if (!p) return 0; return crc32(crc, mem.u8.subarray(p, p + n)); },
    adler32: (_c, a) => { const ad = a.i(), p = a.p(), n = a.u(); if (!p) return 1; return adler32(ad, mem.u8.subarray(p, p + n)); },
    zlibVersion: () => zver,
    zError: () => zver,
    uncompress: (_c, a) => {
      const dst = a.p(), dstLen = a.p(), src = a.p(), length = a.u();
      const out = decodeZlib(mem.u8.slice(src, src + length));
      if (!out) return Z_DATA_ERROR;
      if (out.length > loadUlong(dstLen)) return Z_BUF_ERROR;
      mem.write(dst, out); mem.st32(dstLen, out.length);
      return Z_OK;
    },
  };
  hostLib("libz.so", M);
  const zver = mem.hostStr("1.2.8");
}
