// C99 printf/scanf formatting over an ArgReader (registers+stack, a va_list, or a JS array in tests).

import type { ArgReader } from "../host.ts";
import { mem } from "../mem.ts";
import { utf8 } from "../../jvm/abi.ts";

function pad(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  if (left) return s + " ".repeat(width - s.length);
  if (zero) {
    let sign = "";
    if (s[0] === "-" || s[0] === "+" || s[0] === " ") { sign = s[0]; s = s.slice(1); }
    else if (s.startsWith("0x") || s.startsWith("0X")) { sign = s.slice(0, 2); s = s.slice(2); }
    return sign + "0".repeat(width - sign.length - s.length) + s;
  }
  return " ".repeat(width - s.length) + s;
}

function fmtFloat(v: number, conv: string, prec: number, alt: boolean): string {
  if (v !== v) return conv === conv.toUpperCase() ? "NAN" : "nan";
  if (v === Infinity || v === -Infinity) { const s = v < 0 ? "-inf" : "inf"; return conv === conv.toUpperCase() ? s.toUpperCase() : s; }
  const lc = conv.toLowerCase();
  let s: string;
  if (lc === "f") s = Math.abs(v) < 1e21 ? v.toFixed(prec) : v.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: prec, minimumFractionDigits: prec });
  else if (lc === "e") s = v.toExponential(prec).replace(/e([+-])(\d)$/, "e$10$2");
  else if (lc === "g") {
    const p = prec === 0 ? 1 : prec;
    if (v === 0) s = "0";
    else {
      const exp = Math.floor(Math.log10(Math.abs(v)));
      if (exp < -4 || exp >= p) { s = v.toExponential(p - 1); if (!alt) s = s.replace(/\.?0+e/, "e"); s = s.replace(/e([+-])(\d)$/, "e$10$2"); }
      else { s = v.toFixed(Math.max(0, p - 1 - exp)); if (!alt && s.includes(".")) s = s.replace(/\.?0+$/, ""); }
    }
  } else { // a: hex float
    s = v.toString(16);
  }
  if (alt && !s.includes(".") && lc === "f") s += ".";
  return conv === conv.toUpperCase() ? s.toUpperCase() : s;
}

/** a length modifier whose integer is 64-bit on ARM32: ll/L/q/j */
const wide = (len: string): boolean => len === "ll" || len === "L" || len === "q" || len === "j";
/** format `fmt` pulling arguments from `args` (long/long long via l(), doubles via d()) */
export function format(fmt: string, args: ArgReader): string {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") {
      const j = fmt.indexOf("%", i);
      if (j < 0) { out += fmt.slice(i); break; }
      out += fmt.slice(i, j);
      i = j;
    }
    i++;
    if (fmt[i] === "%") { out += "%"; continue; }
    let left = false, plus = false, space = false, alt = false, zero = false;
    for (;; i++) {
      const f = fmt[i];
      if (f === "-") left = true; else if (f === "+") plus = true; else if (f === " ") space = true;
      else if (f === "#") alt = true; else if (f === "0") zero = true; else break;
    }
    let width = -1;
    if (fmt[i] === "*") { width = args.i(); i++; if (width < 0) { left = true; width = -width; } }
    else { let w = 0, any = false; while (fmt[i] >= "0" && fmt[i] <= "9") { w = w * 10 + (fmt.charCodeAt(i) - 48); i++; any = true; } if (any) width = w; }
    let prec = -1;
    if (fmt[i] === ".") {
      i++;
      if (fmt[i] === "*") { prec = args.i(); i++; }
      else { let p = 0; while (fmt[i] >= "0" && fmt[i] <= "9") { p = p * 10 + (fmt.charCodeAt(i) - 48); i++; } prec = p; }
    }
    let len = "";
    while ("hlLqjzt".includes(fmt[i])) { len += fmt[i]; i++; }
    const conv = fmt[i];
    const isLL = wide(len);
    let s: string;
    switch (conv) {
      case "d": case "i": {
        const v = isLL ? args.l() : len === "h" ? (args.i() << 16) >> 16 : len === "hh" ? (args.i() << 24) >> 24 : args.i();
        const neg = v < 0;
        let digits = (neg ? -v : v).toString();
        if (prec >= 0) { digits = digits.padStart(prec, "0"); if (prec === 0 && digits === "0") digits = ""; zero = false; }
        s = (neg ? "-" : plus ? "+" : space ? " " : "") + digits;
        break;
      }
      case "u": case "x": case "X": case "o": {
        let v: bigint | number = isLL ? BigInt.asUintN(64, args.l()) : args.i() >>> 0;
        if (typeof v === "number") { if (len === "h") v &= 0xffff; else if (len === "hh") v &= 0xff; }
        else if (len === "h") v &= 0xffffn; else if (len === "hh") v &= 0xffn;
        const radix = conv === "u" ? 10 : conv === "o" ? 8 : 16;
        const isZero = typeof v === "number" ? v === 0 : v === 0n;
        let digits = v.toString(radix);
        if (conv === "X") digits = digits.toUpperCase();
        if (prec >= 0) { digits = digits.padStart(prec, "0"); if (prec === 0 && isZero) digits = ""; zero = false; }
        if (alt && !isZero) digits = (conv === "o" ? "0" : conv === "x" ? "0x" : "0X") + digits;
        s = digits;
        break;
      }
      case "c": s = String.fromCharCode(args.i() & 0xff); break;
      case "s": {
        const p = args.p();
        s = p ? args.strAt(p) : "(null)";
        if (prec >= 0) s = s.slice(0, prec);
        break;
      }
      case "p": { const v = BigInt.asUintN(32, args.va()); s = v ? "0x" + v.toString(16) : "(nil)"; break; }
      case "f": case "F": case "e": case "E": case "g": case "G": case "a": case "A": {
        const v = args.d();
        let body = fmtFloat(Math.abs(v), conv, prec < 0 ? 6 : prec, alt);
        const neg = v < 0 || (v === 0 && 1 / v < 0);
        s = (neg ? "-" : plus ? "+" : space ? " " : "") + body;
        if (!/[0-9]/.test(body)) zero = false;
        break;
      }
      case "n": args.p(); s = ""; break;
      case undefined: return out;
      default: s = "%" + len + conv; break;
    }
    out += width > 0 ? pad(s, width, left, zero) : s;
  }
  return out;
}

type ScanSink = (kind: "i" | "h" | "b" | "l" | "f" | "d" | "s" | "n", value: number | bigint | string) => number;

/** sscanf core: parses `input` per `fmt`, calling `out` per conversion (kind, value); returns the count */
const WS = /\s/;
export function scan(input: string, fmt: string, out: ScanSink): number {
  let pos = 0, count = 0;
  const skipWs = () => { while (pos < input.length && WS.test(input[pos])) pos++; };
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (WS.test(ch)) { skipWs(); continue; }
    if (ch !== "%") { if (input[pos] !== ch) return count; pos++; continue; }
    i++;
    if (fmt[i] === "%") { skipWs(); if (input[pos] !== "%") return count; pos++; continue; }
    let suppress = false;
    if (fmt[i] === "*") { suppress = true; i++; }
    let width = 0;
    while (fmt[i] >= "0" && fmt[i] <= "9") { width = width * 10 + (fmt.charCodeAt(i) - 48); i++; }
    let len = "";
    while ("hlLqjzt".includes(fmt[i])) { len += fmt[i]; i++; }
    const conv = fmt[i];
    const lim = width > 0 ? width : Infinity;
    if (conv === "n") { if (!suppress) out("n", pos); continue; }
    if (conv === "c") {
      const n = width > 0 ? width : 1;
      if (pos + n > input.length) return count;
      if (!suppress) { out("s", input.slice(pos, pos + n)); count++; }
      pos += n;
      continue;
    }
    if (conv === "[") {
      let j = i + 1, neg = false;
      if (fmt[j] === "^") { neg = true; j++; }
      let set = "";
      if (fmt[j] === "]") { set += "]"; j++; }
      while (j < fmt.length && fmt[j] !== "]") set += fmt[j++];
      i = j;
      const chars = new Set<string>();
      for (let k = 0; k < set.length; k++) {
        if (set[k + 1] === "-" && k + 2 < set.length) { for (let c = set.charCodeAt(k); c <= set.charCodeAt(k + 2); c++) chars.add(String.fromCharCode(c)); k += 2; }
        else chars.add(set[k]);
      }
      const start = pos;
      while (pos < input.length && pos - start < lim && chars.has(input[pos]) !== neg) pos++;
      if (pos === start) return count;
      if (!suppress) { out("s", input.slice(start, pos)); count++; }
      continue;
    }
    skipWs();
    if (pos >= input.length) return count === 0 ? -1 : count;
    const start = pos;
    if (conv === "s") {
      while (pos < input.length && pos - start < lim && !WS.test(input[pos])) pos++;
      if (!suppress) { out("s", input.slice(start, pos)); count++; }
      continue;
    }
    if (conv === "d" || conv === "i" || conv === "u" || conv === "x" || conv === "X" || conv === "o" || conv === "p") {
      let radix = conv === "x" || conv === "X" || conv === "p" ? 16 : conv === "o" ? 8 : conv === "i" ? 0 : 10;
      let j = pos;
      if (input[j] === "+" || input[j] === "-") j++;
      if (radix === 0) {
        if (input[j] === "0" && (input[j + 1] === "x" || input[j + 1] === "X")) { radix = 16; j += 2; }
        else if (input[j] === "0") radix = 8; else radix = 10;
      } else if (radix === 16 && input[j] === "0" && (input[j + 1] === "x" || input[j + 1] === "X")) j += 2;
      const digitOk = (c: string) => { const d = parseInt(c, radix); return !isNaN(d); };
      const ds = j;
      while (j < input.length && j - pos < lim && digitOk(input[j])) j++;
      if (j === ds) return count;
      const text = input.slice(pos, j);
      pos = j;
      if (suppress) continue;
      const isLL = wide(len);
      const neg = text[0] === "-";
      const body = text.replace(/^[+-]/, "").replace(/^0[xX]/, "");
      let v = 0n;
      for (const c of body) v = v * BigInt(radix) + BigInt(parseInt(c, radix));
      if (neg) v = -v;
      if (isLL) out("l", BigInt.asIntN(64, v));
      else out(len === "hh" ? "b" : len === "h" ? "h" : "i", Number(BigInt.asIntN(32, v)));
      count++;
      continue;
    }
    if ("fFeEgGaA".includes(conv)) {
      const m = /^[+-]?(?:inf(?:inity)?|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F.]+(?:[pP][+-]?\d+)?)/i.exec(input.slice(pos, width > 0 ? pos + width : undefined));
      if (!m) return count;
      pos += m[0].length;
      if (suppress) continue;
      out(len === "l" || len === "L" ? "d" : "f", parseFloat(m[0]));
      count++;
      continue;
    }
    return count;
  }
  return count;
}

/** `s` as snprintf leaves it in the `n` bytes at `d`; its whole length */
export function snprintfInto(d: number, n: number, s: string): number {
  const b = utf8.enc.encode(s);
  if (n > 0) { const k = Math.min(b.length, n - 1); mem.write(d, b.subarray(0, k)); mem.st8(d + k, 0); }
  return b.length;
}
/** where scanf's conversions land: the next pointer argument each */
export function scanSink(a: { p(): number }) {
  return (kind: string, v: unknown): number => {
    const dst = a.p();
    if (!dst) return 0;
    if (kind === "i" || kind === "n") mem.st32(dst, v as number);
    else if (kind === "h") mem.st16(dst, v as number);
    else if (kind === "b") mem.st8(dst, v as number);
    else if (kind === "l") mem.st64(dst, v as bigint);
    else if (kind === "f") mem.stf32(dst, v as number);
    else if (kind === "d") mem.stf64(dst, v as number);
    else if (kind === "s") mem.putCstr(dst, v as string);
    return 0;
  };
}
