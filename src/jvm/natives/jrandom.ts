import { JObj, rt, driven, type Gen } from "../runtime";
import { vcall } from "./jlang";

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
    // bound is a power of two here, so the product is exact
    if ((bound & -bound) === bound) return Math.floor(bound * this.next(31) / 0x80000000);
    let bits: number, val: number;
    // Java's rejection test relies on the int sum overflowing
    do { bits = this.next(31); val = bits % bound; } while (((bits - val + (bound - 1)) | 0) < 0);
    return val;
  }
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
    "nextInt()I": function (this: JRandom) { return this.next(32); },
    "nextInt(I)I": function (this: JRandom, bound: number) {
      if (bound <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bound must be positive");
      return this.bounded(bound);
    },
    "nextLong()J": function (this: JRandom) {
      return BigInt.asIntN(64, (BigInt(this.next(32)) << 32n) + BigInt(this.next(32)));
    },
    "nextBoolean()Z": function (this: JRandom) { return this.next(1) ? 1 : 0; },
    "nextFloat()F": function (this: JRandom) { return this.next(24) / (1 << 24); },
    "nextDouble()D": function (this: JRandom) { return this.unitDouble(); },
    "nextGaussian()D": function (this: JRandom) {
      if (this.haveNextG) { this.haveNextG = false; return this.nextG; }
      let v1: number, v2: number, s: number;
      do {
        v1 = 2 * this.unitDouble() - 1;
        v2 = 2 * this.unitDouble() - 1;
        s = v1 * v1 + v2 * v2;
      } while (s >= 1 || s === 0);
      const mul = Math.sqrt(-2 * Math.log(s) / s);
      this.nextG = v2 * mul; this.haveNextG = true;
      return v1 * mul;
    },
  },
});
