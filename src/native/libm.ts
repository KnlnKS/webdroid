// libm: what Math answers directly, with the C signatures. Registered under libm.so and libc.so
// (bionic exports both). A float result leaves through retF/retD so it lands in v0 on AAPCS64.

import { mem } from "./mem";
import { hostLib, type HostFn, retF, retD, PTR, VRET, fbits, bitsf } from "./host";
import type { Cpu } from "./cpu";

/** a long result: 64-bit on LP64 */
const retLong = (x: number) => (PTR === 8 ? BigInt(Math.trunc(x)) : Math.trunc(x) | 0);
/** round to nearest, ties away from zero (C's round) */
const rna = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));
/** round in FPCR's current mode: 0 nearest-even, 1 +inf, 2 -inf, 3 zero */
function rint(c: Cpu, x: number): number {
  switch ((c.fpcr >>> 22) & 3) {
    case 1: return Math.ceil(x);
    case 2: return Math.floor(x);
    case 3: return Math.trunc(x);
    default: { const r = Math.round(x); return r % 2 !== 0 && Math.abs(x - Math.trunc(x)) === 0.5 ? r - 1 : r; }
  }
}

export function libmInit(): void {
  const d1 = (f: (x: number) => number): HostFn => (c, a) => retD(c, f(a.d()));
  const d2 = (f: (x: number, y: number) => number): HostFn => (c, a) => retD(c, f(a.d(), a.d()));
  const f1 = (f: (x: number) => number): HostFn => (c, a) => retF(c, f(a.f()));
  const f2 = (f: (x: number, y: number) => number): HostFn => (c, a) => retF(c, f(a.f(), a.f()));
  const both = (name: string, f1d: (x: number) => number, f1f = f1d): [string, HostFn][] => [[name, d1(f1d)], [name + "f", f1(f1f)]];
  const both2 = (name: string, f: (x: number, y: number) => number): [string, HostFn][] => [[name, d2(f)], [name + "f", f2(f)]];
  const logb = (x: number) => (x === 0 ? -Infinity : !isFinite(x) ? Infinity : Math.floor(Math.log2(Math.abs(x))));
  const frexp = (v: number, ep: number): number => {
    if (v === 0 || !isFinite(v)) { mem.st32(ep, 0); return v; }
    const e = Math.floor(Math.log2(Math.abs(v))) + 1;
    mem.st32(ep, e);
    return v / 2 ** e;
  };
  const M: Record<string, HostFn> = Object.fromEntries([
    ...both("sin", Math.sin), ...both("cos", Math.cos), ...both("tan", Math.tan),
    ...both("asin", Math.asin), ...both("acos", Math.acos), ...both("atan", Math.atan),
    ...both("sinh", Math.sinh), ...both("cosh", Math.cosh), ...both("tanh", Math.tanh),
    ...both("asinh", Math.asinh), ...both("acosh", Math.acosh), ...both("atanh", Math.atanh),
    ...both("sqrt", Math.sqrt), ...both("cbrt", Math.cbrt), ...both("exp", Math.exp), ...both("exp2", (x) => 2 ** x), ...both("expm1", Math.expm1),
    ...both("log", Math.log), ...both("log2", Math.log2), ...both("log10", Math.log10), ...both("log1p", Math.log1p), ...both("logb", logb),
    ...both("floor", Math.floor), ...both("ceil", Math.ceil), ...both("trunc", Math.trunc), ...both("fabs", Math.abs),
    ...both2("atan2", Math.atan2), ...both2("pow", Math.pow), ...both2("fmod", (x, y) => x % y), ...both2("hypot", Math.hypot),
    ...both2("fmax", Math.max), ...both2("fmin", Math.min), ...both2("fdim", (x, y) => (x > y ? x - y : 0)),
    ...both2("copysign", (x, y) => (y < 0 || (y === 0 && 1 / y < 0) ? -Math.abs(x) : Math.abs(x))),
    ...both2("remainder", (x, y) => x - y * Math.round(x / y)),
  ]);
  Object.assign(M, {
    nextafterf: f2((x, y) => {
      if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
      if (x === y) return y;
      if (x === 0) return bitsf(y < 0 ? 0x80000001 : 1);
      return bitsf(fbits(x) + ((y > x) === (x > 0) ? 1 : -1));
    }),
    round: (c, a) => retD(c, rna(a.d())), roundf: (c, a) => retF(c, rna(a.f())),
    rint: (c, a) => retD(c, rint(c, a.d())), rintf: (c, a) => retF(c, rint(c, a.f())),
    nearbyint: (c, a) => retD(c, rint(c, a.d())), nearbyintf: (c, a) => retF(c, rint(c, a.f())),
    lround: (c, a) => retLong(rna(a.d())), lroundf: (c, a) => retLong(rna(a.f())),
    llround: (c, a) => BigInt(Math.trunc(rna(a.d()))), llroundf: (c, a) => BigInt(Math.trunc(rna(a.f()))),
    lrint: (c, a) => retLong(rint(c, a.d())), lrintf: (c, a) => retLong(rint(c, a.f())),
    llrint: (c, a) => BigInt(Math.trunc(rint(c, a.d()))), llrintf: (c, a) => BigInt(Math.trunc(rint(c, a.f()))),
    ldexp: (c, a) => retD(c, a.d() * 2 ** a.i()), ldexpf: (c, a) => retF(c, a.f() * 2 ** a.i()),
    scalbn: (c, a) => retD(c, a.d() * 2 ** a.i()), scalbnf: (c, a) => retF(c, a.f() * 2 ** a.i()),
    scalbln: (c, a) => retD(c, a.d() * 2 ** Number(PTR === 8 ? a.l() : a.i())),
    ilogb: (_c, a) => { const x = a.d(); return x === 0 ? -2147483648 : !isFinite(x) ? 2147483647 : logb(x); },
    ilogbf: (_c, a) => { const x = a.f(); return x === 0 ? -2147483648 : !isFinite(x) ? 2147483647 : logb(x); },
    frexp: (c, a) => { const v = a.d(), ep = a.p(); return retD(c, frexp(v, ep)); },
    frexpf: (c, a) => { const v = a.f(), ep = a.p(); return retF(c, frexp(v, ep)); },
    modf: (c, a) => { const v = a.d(), ip = a.p(); const i = Math.trunc(v); mem.stf64(ip, i); return retD(c, v - i); },
    modff: (c, a) => { const v = a.f(), ip = a.p(); const i = Math.trunc(v); mem.stf32(ip, i); return retF(c, v - i); },
    sincos: (_c, a) => { const x = a.d(), s = a.p(), co = a.p(); mem.stf64(s, Math.sin(x)); mem.stf64(co, Math.cos(x)); },
    sincosf: (_c, a) => { const x = a.f(), s = a.p(), co = a.p(); mem.stf32(s, Math.sin(x)); mem.stf32(co, Math.cos(x)); },
    fma: (c, a) => retD(c, a.d() * a.d() + a.d()), fmaf: (c, a) => retF(c, a.f() * a.f() + a.f()),
    nan: (c) => retD(c, NaN), nanf: (c) => retF(c, NaN),
    erf: (c, a) => retD(c, erf(a.d())), erff: (c, a) => retF(c, erf(a.f())),
    erfc: (c, a) => retD(c, 1 - erf(a.d())), erfcf: (c, a) => retF(c, 1 - erf(a.f())),
    __isnan: (_c, a) => (a.d() !== a.d() ? 1 : 0), __isnanf: (_c, a) => (a.f() !== a.f() ? 1 : 0),
    __isinf: (_c, a) => { const x = a.d(); return x === Infinity ? 1 : x === -Infinity ? -1 : 0; },
    __isinff: (_c, a) => { const x = a.f(); return x === Infinity ? 1 : x === -Infinity ? -1 : 0; },
    __isfinite: (_c, a) => (isFinite(a.d()) ? 1 : 0), __isfinitef: (_c, a) => (isFinite(a.f()) ? 1 : 0),
    __fpclassifyd: (_c, a) => fpclassify(a.d()), __fpclassifyf: (_c, a) => fpclassify(a.f()),
    // integer division pairs: the struct comes back in x0 (div_t) or x0:x1 (lldiv_t on LP64)
    div: (_c, a) => { const n = a.i(), d = a.i(); const q = d === 0 ? 0 : (n / d) | 0; return (BigInt((n - q * d) | 0) << 32n) | BigInt(q >>> 0); },
    ldiv: (c, a) => (PTR === 8 ? lldiv(c, a) : M.div(c, a)),
    lldiv: (c, a) => lldiv(c, a),
  } satisfies Record<string, HostFn>);
  hostLib("libm.so", M);
  hostLib("libc.so", M);
}

function lldiv(cpu: Cpu, a: { l(): bigint; p(): number }): ReturnType<HostFn> {
  if (PTR !== 8) {                                                                 // AAPCS32: a 16-byte struct is written through the hidden r0 pointer
    const out = a.p(), n = a.l(), d = a.l();
    const q = d === 0n ? 0n : n / d;
    mem.st64(out, q); mem.st64(out + 8, n - q * d);
    return out;
  }
  const n = a.l(), d = a.l();
  const q = d === 0n ? 0n : n / d, r = n - q * d;
  cpu.w[0] = Number(q & 0xffffffffn) | 0; cpu.w[1] = Number((q >> 32n) & 0xffffffffn) | 0;
  cpu.w[2] = Number(r & 0xffffffffn) | 0; cpu.w[3] = Number((r >> 32n) & 0xffffffffn) | 0;
  return VRET;
}

/** FP_NAN 0, FP_INFINITE 1, FP_ZERO 2, FP_SUBNORMAL 3, FP_NORMAL 4 (bionic's values) */
function fpclassify(x: number): number {
  if (x !== x) return 0;
  if (!isFinite(x)) return 1;
  if (x === 0) return 2;
  return Math.abs(x) < 2.2250738585072014e-308 ? 3 : 4;
}
/** Abramowitz–Stegun 7.1.26, |error| < 1.5e-7: the precision a float erf has */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1, t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
