import { JObj, rt, driven, type Gen } from "../runtime";
import { vcall } from "./jlang";
import { mangleMethod } from "../abi";

// ── Random (faithful java.util.Random LCG)
/** a 48-bit seed from the platform CSPRNG, for the Random subclasses that must not be predictable */
export function randomSeed(): bigint {
  const w = new BigUint64Array(1);
  crypto.getRandomValues(w);
  return BigInt.asIntN(64, w[0]);
}
const HALF = 0x1000000, M_HI = 0x5de, M_LO = 0xece66d;
export class JRandom extends JObj {
  // the 48-bit LCG state as two 24-bit halves: every partial product below stays under 2^53
  hi = 0; lo = 0;
  haveNextG = false; nextG = 0;
  setSeed(s: bigint) {
    const seed = Number((s ^ 0x5deece66dn) & 0xffffffffffffn);
    this.hi = Math.floor(seed / HALF); this.lo = seed % HALF;
  }
  next(bits: number): number {
    const low = this.lo * M_LO + 0xb, carry = Math.floor(low / HALF);
    this.hi = (this.hi * M_LO + this.lo * M_HI + carry) & 0xffffff;
    this.lo = low - carry * HALF;
    return Math.floor((this.hi * HALF + this.lo) / 2 ** (48 - bits)) | 0;
  }
  /** nextDouble's 53-bit draw in [0, 1) */
  unitDouble(): number { return ((this.next(26) * 134217728) + this.next(27)) / 9007199254740992; }
  /** nextInt(bound)'s uniform draw in [0, bound), bound > 0 */
  bounded(bound: number): number {
    if ((bound & -bound) === bound) return Math.floor(bound * this.next(31) / 0x80000000);
    let bits: number, val: number;
    do { bits = this.next(31); val = bits % bound; } while (((bits - val + (bound - 1)) | 0) < 0);
    return val;
  }
}
/** Random's JDK bodies for a subclass overriding next(bits): each yields the bit counts it draws */
function* unitDouble(): Generator<number, number, number> { return ((yield 26) * 134217728 + (yield 27)) / 9007199254740992; }
function* bounded(bound: number): Generator<number, number, number> {
  if (bound <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bound must be positive");
  // bound is a power of two here, so the product is exact
  if ((bound & -bound) === bound) return Math.floor(bound * (yield 31) / 0x80000000);
  let bits: number, val: number;
  // Java's rejection test relies on the int sum overflowing
  do { bits = yield 31; val = bits % bound; } while (((bits - val + (bound - 1)) | 0) < 0);
  return val;
}
const NEXT = mangleMethod("next", "(I)I");
const NEXT_DOUBLE = mangleMethod("nextDouble", "()D");
function nextBits(this: JRandom, bits: number) { return this.next(bits); }
/** `direct` while the class keeps our next(bits); `body` fed by an app's override of it otherwise */
function viaNext<A extends unknown[]>(direct: (this: JRandom, ...a: A) => unknown, body: (...a: A) => Generator<number, unknown, number>) {
  const overridden = driven(function* (this: JRandom, ...a: A): Gen {
    const g = body(...a);
    for (let r = g.next(0); ; r = g.next(yield vcall(this, "next", "(I)I", r.value))) if (r.done) return r.value;
  });
  return function (this: JRandom, ...a: A) { return (this as any)[NEXT] === nextBits ? direct.apply(this, a) : overridden.apply(this, a); };
}
const nextDouble = viaNext(function () { return this.unitDouble(); }, unitDouble);
const gaussianOverridden = driven(function* (this: JRandom): Gen {
  for (;;) {
    const g = gaussian(this, 2 * (yield vcall(this, "nextDouble", "()D")) - 1, 2 * (yield vcall(this, "nextDouble", "()D")) - 1);
    if (g !== null) return g;
  }
});
function gaussian(r: JRandom, v1: number, v2: number): number | null {
  const s = v1 * v1 + v2 * v2;
  if (s >= 1 || s === 0) return null;
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  r.nextG = v2 * mul; r.haveNextG = true;
  return v1 * mul;
}
rt.register({
  name: "java/util/Random", ctor: JRandom, ifaces: ["java/util/random/RandomGenerator", "java/io/Serializable"],
  methods: {
    "<init>()V": function (this: JRandom) { this.setSeed(BigInt(Date.now()) ^ BigInt((Math.random() * 1e9) | 0)); },
    "<init>(J)V": function (this: JRandom, s: bigint) { this.setSeed(s); },
    "setSeed(J)V": function (this: JRandom, s: bigint) { this.setSeed(s); },
    "nextBytes([B)V": driven(function* (this: JRandom, bytes: Int8Array): Gen {
      for (let i = 0; i < bytes.length;) {
        let value = yield vcall(this, "nextInt", "()I");
        for (let n = Math.min(bytes.length - i, 4); n-- > 0; value >>= 8) bytes[i++] = value;
      }
    }),
    "next(I)I": nextBits,
    "nextInt()I": viaNext(function () { return this.next(32); }, function* () { return yield 32; }),
    "nextInt(I)I": viaNext(function (bound: number) {
      if (bound <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bound must be positive");
      return this.bounded(bound);
    }, bounded),
    "nextLong()J": viaNext(function () { return BigInt.asIntN(64, (BigInt(this.next(32)) << 32n) + BigInt(this.next(32))); },
      function* () { return BigInt.asIntN(64, (BigInt(yield 32) << 32n) + BigInt(yield 32)); }),
    "nextBoolean()Z": viaNext(function () { return this.next(1) ? 1 : 0; }, function* () { return (yield 1) ? 1 : 0; }),
    "nextFloat()F": viaNext(function () { return this.next(24) / (1 << 24); }, function* () { return (yield 24) / (1 << 24); }),
    "nextDouble()D": nextDouble,
    "nextGaussian()D": function (this: JRandom) {
      if (this.haveNextG) { this.haveNextG = false; return this.nextG; }
      if ((this as any)[NEXT_DOUBLE] !== nextDouble || (this as any)[NEXT] !== nextBits) return gaussianOverridden.call(this);
      for (;;) { const g = gaussian(this, 2 * (nextDouble.call(this) as number) - 1, 2 * (nextDouble.call(this) as number) - 1); if (g !== null) return g; }
    },
  },
});
