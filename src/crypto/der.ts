// DER (X.690) for the natives that parse and build keys and certificates.
import { concat } from "../jvm/abi.ts";

export type Tlv = { tag: number; /** the whole encoding */ raw: Uint8Array; body: Uint8Array };
export class DerError extends Error {}
/** f(), with a malformed encoding reported as err(e) */
export function orDer<T>(f: () => T, err: (e: DerError) => unknown): T {
  try { return f(); } catch (e) { if (e instanceof DerError) throw err(e); throw e; }
}

/** one TLV at `at`; `end` is the offset after it */
export function readTlv(b: Uint8Array, at = 0): Tlv & { end: number } {
  if (at + 2 > b.length) throw new DerError("truncated");
  const tag = b[at];
  if ((tag & 0x1f) === 0x1f) throw new DerError("high tag number");
  let len = b[at + 1], off = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || off + n > b.length) throw new DerError("bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[off++];
    if (len < 128 || (n > 1 && len < 1 << (8 * (n - 1)))) throw new DerError("non-minimal length");
  }
  const end = off + len;
  if (end > b.length) throw new DerError("truncated");
  return { tag, raw: b.subarray(at, end), body: b.subarray(off, end), end };
}
/** the children of a constructed value */
export function children(body: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < body.length;) { const t = readTlv(body, at); out.push(t); at = t.end; }
  return out;
}
/** a whole encoding that must be exactly one TLV */
export function parseOne(b: Uint8Array, tag?: number): Tlv {
  const t = readTlv(b, 0);
  if (t.end !== b.length || (tag !== undefined && t.tag !== tag)) throw new DerError("unexpected encoding");
  return t;
}
export function expect(t: Tlv | undefined, tag: number): Tlv {
  if (!t || t.tag !== tag) throw new DerError(`expected tag ${tag.toString(16)}`);
  return t;
}

export const SEQUENCE = 0x30, INTEGER = 2, BIT_STRING = 3, OCTET_STRING = 4, NULL = 5, OID = 6, BOOLEAN = 1;

export function oidToString(body: Uint8Array): string {
  const parts: number[] = [];
  let v = 0;
  for (const byte of body) {
    v = v * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      if (!parts.length) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
      else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}
function oidBody(oid: string): number[] {
  const p = oid.split(".").map(Number), out: number[] = [];
  const push = (v: number) => { const b = [v & 0x7f]; while ((v = Math.floor(v / 128))) b.unshift((v & 0x7f) | 0x80); out.push(...b); };
  push(40 * p[0] + p[1]);
  for (const v of p.slice(2)) push(v);
  return out;
}

export function tlv(tag: number, body: ArrayLike<number>): Uint8Array {
  const n = body.length, len = n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  const out = new Uint8Array(1 + len.length + n);
  out[0] = tag; out.set(len, 1); out.set(body, 1 + len.length);
  return out;
}
export const seq = (...parts: Uint8Array[]) => tlv(SEQUENCE, concat(parts));
export const oid = (s: string) => tlv(OID, oidBody(s));
export const derNull = () => Uint8Array.of(NULL, 0);
export const octets = (b: Uint8Array) => tlv(OCTET_STRING, b);
export const bits = (b: Uint8Array) => tlv(BIT_STRING, concat([Uint8Array.of(0), b]));

/** unsigned big-endian bytes ↔ bigint */
export function bytesToBig(b: Uint8Array): bigint {
  if (!b.length) return 0n;
  let hex = "";
  for (const x of b) hex += (x < 16 ? "0" : "") + x.toString(16);
  return BigInt("0x" + hex);
}
/** `v` as `len` big-endian bytes (minimal when len is omitted) */
export function bigToBytes(v: bigint, len?: number): Uint8Array {
  let hex = v.toString(16);
  if (hex.length & 1) hex = "0" + hex;
  if (v === 0n) hex = "";
  const n = len ?? hex.length / 2, out = new Uint8Array(n);
  for (let i = 0, o = n - hex.length / 2; i < hex.length; i += 2, o++) if (o >= 0) out[o] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}
/** a non-negative INTEGER */
export function integer(v: bigint): Uint8Array {
  const b = bigToBytes(v);
  return tlv(INTEGER, !b.length || b[0] & 0x80 ? concat([Uint8Array.of(0), b]) : b);
}
/** a DER INTEGER's value, which must be non-negative */
export function uintOf(t: Tlv): bigint {
  expect(t, INTEGER);
  if (!t.body.length || t.body[0] & 0x80) throw new DerError("negative or empty integer");
  return bytesToBig(t.body);
}
/** BigInteger.toByteArray's encoding → its value */
export function fromSigned(b: Uint8Array): bigint {
  const v = bytesToBig(b);
  return b.length && b[0] & 0x80 ? v - (1n << BigInt(8 * b.length)) : v;
}
