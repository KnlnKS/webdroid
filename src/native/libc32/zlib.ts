// libz for an ARM32 process (a 64-bit one runs the reference build's libz) over zlib (src/zlib.ts). Each call runs on the
// guest z_stream's buffers and carries its counts, check value and message across, so input consumed, output produced,
// dictionaries, flushes and container checks are zlib's.

import { ZStream, Z, Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_FINISH, Z_STREAM_ERROR, Z_DATA_ERROR, Z_BUF_ERROR, zError, zlibVersion } from "../../zlib.ts";
import { mem, AddrMap, wrote } from "../mem.ts";
import { type HostFn, stp, ldp } from "../host.ts";

const streams = new AddrMap<ZStream>();
let stateSeq = 1;
/** zlib's static message strings, in host data */
const messages = new Map<string, number>();
const message = (text: string) => { let p = messages.get(text); if (p === undefined) messages.set(text, p = mem.hostStr(text)); return p; };
const CARRIED = [Z.TIN, Z.TOUT, Z.DATA_TYPE, Z.ADLER];
const EMPTY = new Uint8Array(0);

/** the z_stream's counts and check value, which zlib reads and advances in place */
function load(strm: number, s: ZStream): void {
  for (const f of CARRIED) s.set(f, mem.ld32(strm + f));
  s.set(Z.MSG, 0);
}
function store(strm: number, s: ZStream): void {
  for (const f of CARRIED) mem.st32(strm + f, s.get(f));
  const msg = s.msg;
  if (msg) stp(strm + Z.MSG, message(msg));
}
function open(strm: number, init: () => ZStream | number): number {
  if (!strm) return Z_STREAM_ERROR;
  const s = init();
  if (typeof s === "number") return s;
  streams.set(strm, s);
  stp(strm + Z.STATE, stateSeq++); stp(strm + Z.MSG, 0);
  store(strm, s);
  return Z_OK;
}
const lookup = (strm: number, deflating: boolean) => { const s = streams.get(strm); return s?.deflating === deflating ? s : undefined; };
/** a call on the guest stream's zlib stream, if it has one of this direction */
function on(strm: number, deflating: boolean, op: (s: ZStream) => number): number {
  const s = lookup(strm, deflating);
  if (!s) return Z_STREAM_ERROR;
  load(strm, s);
  const code = op(s);
  store(strm, s);
  return code;
}
/** one inflate or deflate over the z_stream's buffers in guest memory */
const step = (strm: number, deflating: boolean, flush: number): number => on(strm, deflating, (s) => {
  const nextIn = ldp(strm + Z.IN), availIn = mem.ld32(strm + Z.AVIN) >>> 0, nextOut = ldp(strm + Z.OUT), availOut = mem.ld32(strm + Z.AVOUT) >>> 0;
  // zlib's checks of the guest's pointers, which the module's windows stand in for
  if (!nextOut || !nextIn && availIn) {
    if (deflating) stp(strm + Z.MSG, message(zError(Z_STREAM_ERROR)));
    return Z_STREAM_ERROR;
  }
  const [code, read, written] = s.run(nextIn ? mem.bytes(nextIn, availIn) : EMPTY, mem.bytes(nextOut, availOut), flush);
  wrote(nextOut, written);
  stp(strm + Z.IN, nextIn + read); mem.st32(strm + Z.AVIN, availIn - read);
  stp(strm + Z.OUT, nextOut + written); mem.st32(strm + Z.AVOUT, availOut - written);
  return code;
});
const reset = (strm: number, deflating: boolean): number => on(strm, deflating, (s) => { stp(strm + Z.MSG, 0); return s.reset(); });
const setDictionary = (strm: number, deflating: boolean, d: number, n: number): number =>
  d ? on(strm, deflating, (s) => s.setDictionary(mem.bytes(d, n))) : Z_STREAM_ERROR;
function end(strm: number, deflating: boolean): number {
  const s = lookup(strm, deflating);
  if (!s) return Z_STREAM_ERROR;
  streams.delete(strm); stp(strm + Z.STATE, 0);
  return s.end();
}

export function zlibLibc(): Record<string, HostFn> {
  messages.clear();
  const zver = mem.hostStr(zlibVersion());
  return {
    deflateInit_: (_c, a) => { const strm = a.p(), level = a.i(); a.str(); a.i(); return open(strm, () => ZStream.deflater(level, 8, 15, 8, 0)); },
    deflateInit2_: (_c, a) => {
      const strm = a.p(), level = a.i(), method = a.i(), bits = a.i(), memory = a.i(), strategy = a.i(); a.str(); a.i();
      return open(strm, () => ZStream.deflater(level, method, bits, memory, strategy));
    },
    deflate: (_c, a) => { const strm = a.p(), flush = a.i(); return step(strm, true, flush); },
    deflateReset: (_c, a) => reset(a.p(), true),
    deflateSetDictionary: (_c, a) => { const strm = a.p(), d = a.p(), n = a.u(); return setDictionary(strm, true, d, n); },
    deflateEnd: (_c, a) => end(a.p(), true),
    inflateInit_: (_c, a) => { const strm = a.p(); a.str(); a.i(); return open(strm, () => ZStream.inflater(15)); },
    inflateInit2_: (_c, a) => { const strm = a.p(), bits = a.i(); a.str(); a.i(); return open(strm, () => ZStream.inflater(bits)); },
    inflate: (_c, a) => { const strm = a.p(), flush = a.i(); return step(strm, false, flush); },
    inflateReset: (_c, a) => reset(a.p(), false),
    inflateSetDictionary: (_c, a) => { const strm = a.p(), d = a.p(), n = a.u(); return setDictionary(strm, false, d, n); },
    inflateEnd: (_c, a) => end(a.p(), false),
    zlibVersion: () => zver,
    zError: (_c, a) => message(zError(a.i())),
    uncompress: (_c, a) => {
      // uncompress2's: the inflated length even on failure, and running out of input with room left is corrupt data
      const dst = a.p(), dstLen = a.p(), src = a.p(), length = a.u(), room = mem.ld32(dstLen) >>> 0, s = ZStream.inflater(15);
      if (typeof s === "number") return s;
      const [code, , written] = s.run(mem.bytes(src, length), mem.bytes(dst, room), Z_FINISH);
      s.end();
      wrote(dst, written);
      mem.st32(dstLen, written);
      return code === Z_STREAM_END ? Z_OK : code === Z_NEED_DICT || code === Z_BUF_ERROR && written < room ? Z_DATA_ERROR : code;
    },
  };
}
