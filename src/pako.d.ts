// pako's zlib port, used through its zlib-level API (a z_stream and the inflate/deflate calls)
declare module "pako/lib/zlib/zstream.js" {
  export default class ZStream {
    input: Uint8Array | null; next_in: number; avail_in: number; total_in: number;
    output: Uint8Array | null; next_out: number; avail_out: number; total_out: number;
    msg: string; state: unknown; data_type: number; adler: number;
  }
}
declare module "pako/lib/zlib/inflate.js" {
  type Z = import("pako/lib/zlib/zstream.js").default;
  export function inflateInit2(strm: Z, windowBits: number): number;
  export function inflate(strm: Z, flush: number): number;
  export function inflateReset(strm: Z): number;
  export function inflateEnd(strm: Z): number;
  export function inflateSetDictionary(strm: Z, dictionary: Uint8Array): number;
}
declare module "pako/lib/zlib/deflate.js" {
  type Z = import("pako/lib/zlib/zstream.js").default;
  export function deflateInit2(strm: Z, level: number, method: number, windowBits: number, memLevel: number, strategy: number): number;
  export function deflate(strm: Z, flush: number): number;
  export function deflateReset(strm: Z): number;
  export function deflateEnd(strm: Z): number;
  export function deflateSetDictionary(strm: Z, dictionary: Uint8Array): number;
}
declare module "pako/lib/zlib/messages.js" {
  /** zlib's z_errmsg, by return code */
  const messages: Record<number, string>;
  export default messages;
}
