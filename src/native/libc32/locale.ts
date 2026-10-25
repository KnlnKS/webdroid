// Locale objects and the wide-character surface. The one locale is "C": newlocale hands back a
// token, uselocale keeps one per thread, and every *_l variant is its base function with the
// trailing locale_t unread.

import { wrote, mem } from "../mem.ts";
import { type HostFn, retF, retD, stp, ldp, ARG0, ptr, vaList } from "../host.ts";
import { utf8 as codec } from "../../jvm/abi.ts";
import { format } from "./printf.ts";

export const mbLen = (b0: number) => b0 < 0x80 ? 1 : b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc0 ? 2 : 1;
export function wlen(p: number): number { let n = 0; while (mem.ld32(p + n * 4)) n++; return n; }
export function wstr(p: number, max = 0x7fffffff): string {
  let s = "";
  for (let i = 0; i < max; i++) { const c = mem.ld32(p + i * 4); if (!c) return s; s += String.fromCodePoint(c >>> 0 > 0x10ffff ? 0xfffd : c >>> 0); }
  return s;
}
export const WCTYPES = ["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "xdigit"];
export const WCTEST: Record<string, RegExp> = {
  alnum: /[\p{L}\p{N}]/u, alpha: /\p{L}/u, blank: /[ \t]/, cntrl: /\p{Cc}/u, digit: /\d/, graph: /[^\s\p{Cc}]/u, lower: /\p{Ll}/u,
  print: /[^\p{Cc}]/u, punct: /\p{P}/u, space: /\s/, upper: /\p{Lu}/u, xdigit: /[0-9a-fA-F]/,
};
const wput = (p: number, s: string): number => { let i = 0; for (const ch of s) mem.st32(p + 4 * i++, ch.codePointAt(0)!); mem.st32(p + 4 * i, 0); return i; };
const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!);

/** parse an integer prefix of a wide string; returns [value, chars consumed] */
function wparse(s: string, base: number): [bigint, number] {
  const m = /^\s*([+-]?)(0[xX])?([0-9a-zA-Z]*)/.exec(s)!;
  let i = m[0].length - m[3].length, digits = m[3];
  if (m[2] && (base === 0 || base === 16)) base = 16; else if (m[2]) { digits = ""; i = m[1].length + 1; }
  if (base === 0) base = digits.startsWith("0") ? 8 : 10;
  let v = 0n, n = 0;
  for (const ch of digits) {
    const d = parseInt(ch, 36);
    if (isNaN(d) || d >= base) break;
    v = v * BigInt(base) + BigInt(d); n++;
  }
  if (!n) return [0n, 0];
  return [m[1] === "-" ? -v : v, i + n];
}

export function localeLibc(): Record<string, HostFn> {
  const cLocale = mem.hostAlloc(16);          // an opaque locale_t
  const current = new Map<number, bigint>();  // tid → opaque locale_t, including LC_GLOBAL_LOCALE
  const wint = (bits: 32 | 64, unsigned: boolean): HostFn => (_c, a) => {
    const p = a.p(), endp = a.p(), base = a.i();
    const [v, n] = wparse(wstr(p), base);
    if (endp) stp(endp, p + 4 * n);
    const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n, min = unsigned ? 0n : -(1n << BigInt(bits - 1));
    const r = v > max ? max : v < min ? min : v;
    return bits === 64 ? r : Number(BigInt.asIntN(32, r));
  };
  const wfloat: HostFn = (c, a) => {
    const p = a.p(), endp = a.p();
    const s = wstr(p), m = /^\s*[+-]?(?:inf(?:inity)?|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/i.exec(s);
    if (endp) stp(endp, p + 4 * (m ? m[0].length : 0));
    return retD(c, m ? parseFloat(m[0].replace(/inf(inity)?/i, "Infinity")) : 0);
  };
  const M: Record<string, HostFn> = {
    newlocale: () => cLocale, duplocale: () => cLocale, freelocale: () => {},
    uselocale: (cpu, a) => { const l = a.va(); const prev = current.get(cpu.tid) ?? -1n; if (l) current.set(cpu.tid, l); return prev; },
    wcschr: (_c, a) => { const p = a.p(), c = a.i(); for (let i = p; ; i += 4) { const x = mem.ld32(i); if (x === c) return ptr(i); if (!x) return 0; } },
    wcsrchr: (_c, a) => { const p = a.p(), c = a.i(); let r = 0; for (let i = p; ; i += 4) { const x = mem.ld32(i); if (x === c) r = i; if (!x) return ptr(r); } },
    wcsstr: (_c, a) => { const h = a.p(), n = a.p(), nl = wlen(n); for (let i = h; ; i += 4) { let k = 0; while (k < nl && mem.ld32(i + 4 * k) === mem.ld32(n + 4 * k)) k++; if (k === nl) return ptr(i); if (!mem.ld32(i)) return 0; } },
    wcsncmp: (_c, a) => { const x = a.p(), y = a.p(), n = a.u(); for (let i = 0; i < n; i++) { const p = mem.ld32(x + 4 * i), q = mem.ld32(y + 4 * i); if (p !== q) return p < q ? -1 : 1; if (!p) return 0; } return 0; },
    wcsncpy: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); let i = 0; for (; i < n && mem.ld32(s + 4 * i); i++) mem.st32(d + 4 * i, mem.ld32(s + 4 * i)); for (; i < n; i++) mem.st32(d + 4 * i, 0); return ARG0; },
    wcscpy: (_c, a) => { const d = a.p(), s = a.p(); const n = wlen(s); mem.memmove(d, s, 4 * n + 4); return ARG0; },
    wcscat: (_c, a) => { const d = a.p(), s = a.p(); const dl = wlen(d), n = wlen(s); mem.memmove(d + 4 * dl, s, 4 * n + 4); return ARG0; },
    wcsncat: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const dl = wlen(d); let i = 0; for (; i < n && mem.ld32(s + 4 * i); i++) mem.st32(d + 4 * (dl + i), mem.ld32(s + 4 * i)); mem.st32(d + 4 * (dl + i), 0); return ARG0; },
    wcsnlen: (_c, a) => { const p = a.p(), n = a.u(); let i = 0; while (i < n && mem.ld32(p + 4 * i)) i++; return i; },
    wcsdup: (_c, a) => { const s = a.p(); const n = wlen(s); const d = mem.malloc(4 * n + 4); mem.memmove(d, s, 4 * n + 4); return d; },
    wcspbrk: (_c, a) => { const p = a.p(), set = cps(wstr(a.p())); for (let i = p; mem.ld32(i); i += 4) if (set.includes(mem.ld32(i))) return ptr(i); return 0; },
    wcsspn: (_c, a) => { const p = a.p(), set = cps(wstr(a.p())); let i = 0; while (mem.ld32(p + 4 * i) && set.includes(mem.ld32(p + 4 * i))) i++; return i; },
    wcscspn: (_c, a) => { const p = a.p(), set = cps(wstr(a.p())); let i = 0; while (mem.ld32(p + 4 * i) && !set.includes(mem.ld32(p + 4 * i))) i++; return i; },
    wcstol: wint(32, false), wcstoul: wint(32, true), wcstoll: wint(64, false), wcstoull: wint(64, true),
    wcstod: wfloat, wcstold: wfloat,
    wcstof: (c, a) => { const p = a.p(), endp = a.p(); const s = wstr(p), m = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s); if (endp) stp(endp, p + 4 * (m ? m[0].length : 0)); return retF(c, m ? parseFloat(m[0]) : 0); },
    swprintf: (_c, a) => { const d = a.p(), n = a.u(), f = wstr(a.p()); const s = format(f, a); if ([...s].length >= n) return -1; return wput(d, s); },
    vswprintf: (_c, a) => { const d = a.p(), n = a.u(), f = wstr(a.p()); const s = format(f, vaList(a.p())); if ([...s].length >= n) return -1; return wput(d, s); },
    // no wide stream I/O: every one reports WEOF
    fputwc: () => -1, putwc: () => -1, getwc: () => -1, fgetwc: () => -1, ungetwc: () => -1,
    // multibyte (UTF-8) <-> wide
    mbtowc: (_c, a) => {
      const pwc = a.p(), s = a.p(), n = a.u();
      if (!s) return 0;
      const b0 = mem.u8[s];
      const len = mbLen(b0);
      if (n < len) return -1;
      if (pwc) mem.st32(pwc, codec.dec.decode(mem.u8.subarray(s, s + len)).codePointAt(0) ?? 0);
      return b0 === 0 ? 0 : len;
    },
    mbrlen: (_c, a) => { const s = a.p(), n = a.u(); if (!s) return 0; const b0 = mem.u8[s]; if (b0 === 0) return 0; const len = mbLen(b0); return n < len ? -2 : len; },
    mbsrtowcs: (_c, a) => mbsToWcs(a.p(), a.p(), 0x7fffffff, a.u()),
    mbsnrtowcs: (_c, a) => mbsToWcs(a.p(), a.p(), a.u(), a.u()),
    wcsrtombs: (_c, a) => wcsToMbs(a.p(), a.p(), 0x7fffffff, a.u()),
    wcsnrtombs: (_c, a) => wcsToMbs(a.p(), a.p(), a.u(), a.u()),
  };
  for (const k of ["alnum", "xdigit", "print", "blank", "cntrl", "punct", "graph"]) M["isw" + k] = M["isw" + k + "_l"] = (_c, a) => wtest(a.i(), WCTEST[k]);
  return M;
}
function wtest(c: number, re: RegExp): number { return c >= 0 && c <= 0x10ffff && re.test(String.fromCodePoint(c)) ? 1 : 0; }
/** mbs(n)rtowcs: convert up to `nms` bytes of *src into `len` wide chars; *src advances (NULL at the end) */
function mbsToWcs(dst: number, srcp: number, nms: number, len: number): number {
  let src = ldp(srcp);
  const end = Math.min(src + nms, src + mem.strlen(src));
  const s = codec.dec.decode(mem.u8.subarray(src, end));
  const chars = cps(s);
  if (!dst) return chars.length;
  const k = Math.min(chars.length, len);
  for (let i = 0; i < k; i++) mem.st32(dst + 4 * i, chars[i]);
  if (k < len) { mem.st32(dst + 4 * k, 0); stp(srcp, 0); }
  else stp(srcp, src + codec.enc.encode(String.fromCodePoint(...chars.slice(0, k))).length);
  return k;
}
function wcsToMbs(dst: number, srcp: number, nwc: number, len: number): number {
  const src = ldp(srcp);
  const s = wstr(src, nwc);
  const b = codec.enc.encode(s);
  if (!dst) return b.length;
  let k = 0, i = 0;
  for (const ch of s) { const e = codec.enc.encode(ch); if (k + e.length > len) break; mem.u8.set(e, dst + k); k += e.length; i++; }
  wrote(dst, k);
  if (k < len && i === [...s].length) { mem.st8(dst + k, 0); stp(srcp, 0); } else stp(srcp, src + 4 * i);
  return k;
}
