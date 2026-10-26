// libz for an ARM32 process (a 64-bit one runs the reference build's libz) over pako, a
// line-for-line port of zlib 1.2.8. Each call runs on the guest z_stream's own buffers, so input
// consumed, output produced, dictionaries, flushes and container checks are zlib's.

import * as zInflate from "pako/lib/zlib/inflate.js";
import * as zDeflate from "pako/lib/zlib/deflate.js";
import ZStream from "pako/lib/zlib/zstream.js";
import MESSAGES from "pako/lib/zlib/messages.js";
import { mem, AddrMap, wrote } from "../mem.ts";
import { type HostFn, stp, ldp } from "../host.ts";

// z_stream fields
const Z = { IN: 0, AVIN: 4, TIN: 8, OUT: 12, AVOUT: 16, TOUT: 20, MSG: 24, STATE: 28, DATA_TYPE: 44, ADLER: 48 };
const Z_OK = 0, Z_STREAM_END = 1, Z_NEED_DICT = 2, Z_FINISH = 4, Z_STREAM_ERROR = -2, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5;
const EMPTY = new Uint8Array(0);

const inflaters = new AddrMap<ZStream>(), deflaters = new AddrMap<ZStream>();
let stateSeq = 1;
/** zlib's static message strings, in host data */
const messages = new Map<string, number>();
const message = (text: string) => { let p = messages.get(text); if (p === undefined) messages.set(text, p = mem.hostStr(text)); return p; };

/** the z_stream's counts and check value, which zlib reads and advances in place */
function load(strm: number, s: ZStream): void {
  s.total_in = mem.ld32(strm + Z.TIN) >>> 0; s.total_out = mem.ld32(strm + Z.TOUT) >>> 0;
  s.data_type = mem.ld32(strm + Z.DATA_TYPE); s.adler = mem.ld32(strm + Z.ADLER) >>> 0; s.msg = "";
}
function store(strm: number, s: ZStream): void {
  mem.st32(strm + Z.TIN, s.total_in); mem.st32(strm + Z.TOUT, s.total_out);
  mem.st32(strm + Z.DATA_TYPE, s.data_type); mem.st32(strm + Z.ADLER, s.adler);
  if (s.msg) stp(strm + Z.MSG, message(s.msg));
}
/** one inflate or deflate over the z_stream's buffers in guest memory */
function run(strm: number, s: ZStream, op: (s: ZStream, flush: number) => number, flush: number): number {
  const nextIn = ldp(strm + Z.IN), availIn = mem.ld32(strm + Z.AVIN) >>> 0, nextOut = ldp(strm + Z.OUT), availOut = mem.ld32(strm + Z.AVOUT) >>> 0;
  s.input = nextIn ? mem.bytes(nextIn, availIn) : null; s.next_in = 0; s.avail_in = availIn;
  s.output = nextOut ? mem.bytes(nextOut, availOut) : null; s.next_out = 0; s.avail_out = availOut;
  load(strm, s);
  const code = op(s, flush), read = s.next_in, written = s.next_out;
  s.input = s.output = EMPTY;
  wrote(nextOut, written);
  stp(strm + Z.IN, nextIn + read); mem.st32(strm + Z.AVIN, availIn - read);
  stp(strm + Z.OUT, nextOut + written); mem.st32(strm + Z.AVOUT, availOut - written);
  store(strm, s);
  return code;
}
function open(strm: number, streams: AddrMap<ZStream>, init: (s: ZStream) => number): number {
  if (!strm) return Z_STREAM_ERROR;
  const s = new ZStream(), code = init(s);
  if (code !== Z_OK) return code;
  streams.set(strm, s);
  stp(strm + Z.STATE, stateSeq++); stp(strm + Z.MSG, 0);
  store(strm, s);
  return Z_OK;
}
function reset(strm: number, s: ZStream | undefined, op: (s: ZStream) => number): number {
  if (!s) return Z_STREAM_ERROR;
  load(strm, s);
  const code = op(s);
  stp(strm + Z.MSG, 0); store(strm, s);
  return code;
}
function end(strm: number, streams: AddrMap<ZStream>, op: (s: ZStream) => number): number {
  const s = streams.get(strm);
  if (!s) return Z_STREAM_ERROR;
  streams.delete(strm); stp(strm + Z.STATE, 0);
  return op(s);
}
function setDictionary(strm: number, s: ZStream | undefined, dictionary: number, length: number, op: (s: ZStream, d: Uint8Array) => number): number {
  if (!s || !dictionary) return Z_STREAM_ERROR;
  load(strm, s);
  const code = op(s, mem.bytes(dictionary, length));
  store(strm, s);
  return code;
}

export function zlibLibc(): Record<string, HostFn> {
  messages.clear();
  const zver = mem.hostStr("1.2.8");
  const M: Record<string, HostFn> = {
    deflateInit_: (_c, a) => { const strm = a.p(), level = a.i(); a.str(); a.i(); return open(strm, deflaters, (s) => zDeflate.deflateInit2(s, level, 8, 15, 8, 0)); },
    deflateInit2_: (_c, a) => {
      const strm = a.p(), level = a.i(), method = a.i(), bits = a.i(), memory = a.i(), strategy = a.i(); a.str(); a.i();
      return open(strm, deflaters, (s) => zDeflate.deflateInit2(s, level, method, bits, memory, strategy));
    },
    deflate: (_c, a) => { const strm = a.p(), flush = a.i(), s = deflaters.get(strm); return s ? run(strm, s, zDeflate.deflate, flush) : Z_STREAM_ERROR; },
    deflateReset: (_c, a) => { const strm = a.p(); return reset(strm, deflaters.get(strm), zDeflate.deflateReset); },
    deflateSetDictionary: (_c, a) => { const strm = a.p(), d = a.p(), n = a.u(); return setDictionary(strm, deflaters.get(strm), d, n, zDeflate.deflateSetDictionary); },
    deflateEnd: (_c, a) => end(a.p(), deflaters, zDeflate.deflateEnd),
    inflateInit_: (_c, a) => { const strm = a.p(); a.str(); a.i(); return open(strm, inflaters, (s) => zInflate.inflateInit2(s, 15)); },
    inflateInit2_: (_c, a) => { const strm = a.p(), bits = a.i(); a.str(); a.i(); return open(strm, inflaters, (s) => zInflate.inflateInit2(s, bits)); },
    inflate: (_c, a) => { const strm = a.p(), flush = a.i(), s = inflaters.get(strm); return s ? run(strm, s, zInflate.inflate, flush) : Z_STREAM_ERROR; },
    inflateReset: (_c, a) => { const strm = a.p(); return reset(strm, inflaters.get(strm), zInflate.inflateReset); },
    inflateSetDictionary: (_c, a) => { const strm = a.p(), d = a.p(), n = a.u(); return setDictionary(strm, inflaters.get(strm), d, n, zInflate.inflateSetDictionary); },
    inflateEnd: (_c, a) => end(a.p(), inflaters, zInflate.inflateEnd),
    zlibVersion: () => zver,
    zError: (_c, a) => message(MESSAGES[a.i()] ?? ""),
    uncompress: (_c, a) => {
      // zlib 1.2.8's: one Z_FINISH inflate, where running out of input is corrupt data
      const dst = a.p(), dstLen = a.p(), src = a.p(), length = a.u(), s = new ZStream();
      zInflate.inflateInit2(s, 15);
      s.input = mem.bytes(src, length); s.avail_in = length;
      s.output = mem.bytes(dst, mem.ld32(dstLen) >>> 0); s.avail_out = s.output.length;
      const code = zInflate.inflate(s, Z_FINISH);
      wrote(dst, s.next_out);
      zInflate.inflateEnd(s);
      if (code !== Z_STREAM_END) return code === Z_NEED_DICT || code === Z_BUF_ERROR && !s.avail_in ? Z_DATA_ERROR : code;
      mem.st32(dstLen, s.total_out);
      return Z_OK;
    },
  };
  return M;
}
