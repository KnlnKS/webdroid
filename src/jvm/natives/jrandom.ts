import { JObj, rt, driven, type Gen } from "../runtime";
import { vcall } from "./jlang";

// ── Random (faithful java.util.Random LCG)
/** a 48-bit seed from the platform CSPRNG, for the Random subclasses that must not be predictable */
export function randomSeed(): bigint {
  const w = new BigUint64Array(1);
  crypto.getRandomValues(w);
  return BigInt.asIntN(64, w[0]);
}
export class JRandom extends JObj {
  seed = 0n;
  haveNextG = false; nextG = 0;
  setSeed(s: bigint) { this.seed = (s ^ 0x5deece66dn) & 0xffffffffffffn; }
  next(bits: number): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & 0xffffffffffffn;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }
}
rt.register({
  name: "java/util/Random", ctor: JRandom,
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
      if ((bound & -bound) === bound) return Number(BigInt(bound) * BigInt(this.next(31)) >> 31n);
      let bits: number, val: number;
      do { bits = this.next(31); val = bits % bound; } while (bits - val + (bound - 1) < 0);
      return val;
    },
    "nextLong()J": function (this: JRandom) {
      return BigInt.asIntN(64, (BigInt(this.next(32)) << 32n) + BigInt(this.next(32)));
    },
    "nextBoolean()Z": function (this: JRandom) { return this.next(1) ? 1 : 0; },
    "nextFloat()F": function (this: JRandom) { return this.next(24) / (1 << 24); },
    "nextDouble()D": function (this: JRandom) {
      return ((this.next(26) * 134217728) + this.next(27)) / 9007199254740992;
    },
    "nextGaussian()D": function (this: JRandom) {
      if (this.haveNextG) { this.haveNextG = false; return this.nextG; }
      let v1: number, v2: number, s: number;
      do {
        v1 = 2 * (((this.next(26) * 134217728) + this.next(27)) / 9007199254740992) - 1;
        v2 = 2 * (((this.next(26) * 134217728) + this.next(27)) / 9007199254740992) - 1;
        s = v1 * v1 + v2 * v2;
      } while (s >= 1 || s === 0);
      const mul = Math.sqrt(-2 * Math.log(s) / s);
      this.nextG = v2 * mul; this.haveNextG = true;
      return v1 * mul;
    },
  },
});
