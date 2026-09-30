// §4.7: FloatingDecimal's digit generation (BinaryToASCIIBuffer.dtoa), behind Double.toString,
// Float.toString and Formatter's %e, %f and %g. It keeps libcore's digits, which are not always
// the shortest JS prints: the same int, long and big-number paths, with FDBigInteger's quotient
// loop over JS bigint (the same values: floor quotients, remainders and comparisons).
import { mangleField } from "../abi";
import { rt } from "../runtime";

type Obj = Record<string, any>;

const B2A = "jdk/internal/math/FloatingDecimal$BinaryToASCIIBuffer";
const [DIGITS, DEC_EXP, FIRST, COUNT, ROUNDED_UP, EXACT] =
  ["digits", "decExponent", "firstDigitIndex", "nDigits", "decimalDigitsRoundedUp", "exactDecimalConversion"].map((f) => mangleField(B2A, f));
const I64 = (v: bigint) => BigInt.asIntN(64, v);
const pow5: bigint[] = [];
const POW5 = (n: number) => pow5[n] ??= 5n ** BigInt(n);
/** FDBigInteger.SMALL_5_POW */
const SMALL_5_POW = Array.from({ length: 14 }, (_, i) => 5 ** i);

function trailingZeros(v: bigint): number {
  const lo = Number(v & 0xffffffffn);
  return lo ? 31 - Math.clz32(lo & -lo) : 32 + trailingZeros(v >> 32n);
}
/** floor of an estimate of log10 of the value, as libcore computes it in double arithmetic */
function estimateDecExp(fractBits: bigint, binExp: number): number {
  const d2 = 1 + Number(fractBits & 0xfffffffffffffn) / 2 ** 52;
  return Math.floor((d2 - 1.5) * 0.289529654 + 0.176091259 + binExp * 0.301029995663981);
}
/** FDBigInteger.getNormalizationBias: the shift leaving 4 zero bits atop its top 32-bit word */
function normalizationBias(v: bigint): number {
  const zeros = 31 - ((v.toString(2).length - 1) & 31);
  return zeros < 4 ? 28 + zeros : zeros - 4;
}

function developLongDigits(buf: Obj, decExponent: number, lvalue: bigint, insignificant: number): void {
  if (insignificant !== 0) {
    const pow10 = POW5(insignificant) << BigInt(insignificant), residue = lvalue % pow10;
    lvalue /= pow10;
    decExponent += insignificant;
    if (residue >= pow10 >> 1n) lvalue++;
  }
  const digits: Uint16Array = buf[DIGITS];
  let at = digits.length - 1;
  if (lvalue <= 0x7fffffffn) {
    let v = Number(lvalue), c = v % 10;
    for (v = (v / 10) | 0; c === 0; v = (v / 10) | 0) { decExponent++; c = v % 10; }
    for (; v !== 0; v = (v / 10) | 0) { digits[at--] = c + 48; decExponent++; c = v % 10; }
    digits[at] = c + 48;
  } else {
    let v = lvalue, c = Number(v % 10n);
    for (v /= 10n; c === 0; v /= 10n) { decExponent++; c = Number(v % 10n); }
    for (; v !== 0n; v /= 10n) { digits[at--] = c + 48; decExponent++; c = Number(v % 10n); }
    digits[at] = c + 48;
  }
  buf[DEC_EXP] = decExponent + 1;
  buf[FIRST] = at;
  buf[COUNT] = digits.length - at;
}

function roundup(buf: Obj): void {
  const digits: Uint16Array = buf[DIGITS], first: number = buf[FIRST];
  let i = first + buf[COUNT] - 1, q = digits[i];
  if (q === 57) {
    while (q === 57 && i > first) { digits[i] = 48; q = digits[--i]; }
    if (q === 57) { buf[DEC_EXP]++; digits[first] = 49; return; }
  }
  digits[i] = q + 1;
  buf[ROUNDED_UP] = 1;
}

rt.intrinsic(B2A, {
  "dtoa(IJIZ)V": (_base, C) => {
    const statics = C as Record<string, number[]>, table: Map<string, string> = C.$i.staticFieldTable;
    const N_5_BITS = table.get("N_5_BITS:[I")!, INSIGNIFICANT = table.get("insignificantDigitsNumber:[I")!;
    return function (this: Obj, binExp: number, fractBits: bigint, nSignificantBits: number, compatible: number): void {
      const n5Bits = statics[N_5_BITS], digits: Uint16Array = this[DIGITS];
      const tailZeros = trailingZeros(fractBits), nFractBits = 53 - tailZeros;
      this[ROUNDED_UP] = 0;
      this[EXACT] = 0;
      const nTinyBits = Math.max(0, nFractBits - binExp - 1);
      // an integer value that a long holds: its digits, less those a double's precision does not fix
      if (binExp <= 62 && binExp >= -21 && nTinyBits === 0 && nFractBits + n5Bits[0] < 64) {
        const p2 = binExp - nSignificantBits - 1, table = statics[INSIGNIFICANT];
        const insignificant = binExp > nSignificantBits && p2 > 1 && p2 < table.length ? table[p2] : 0;
        developLongDigits(this, 0, binExp >= 52 ? I64(fractBits << BigInt(binExp - 52)) : fractBits >> BigInt(52 - binExp), insignificant);
        return;
      }
      let decExp = estimateDecExp(fractBits, binExp);
      const B5 = Math.max(0, -decExp), S5 = Math.max(0, decExp), M5 = B5;
      let B2 = B5 + nTinyBits + binExp, S2 = S5 + nTinyBits, M2 = B2 - nSignificantBits;
      const fract = fractBits >> BigInt(tailZeros);
      B2 -= nFractBits - 1;
      const common = Math.min(B2, S2);
      B2 -= common; S2 -= common; M2 -= common;
      if (nFractBits === 1) M2 -= 1;
      if (M2 < 0) { B2 -= M2; S2 -= M2; M2 = 0; }
      const Bbits = nFractBits + B2 + (B5 < n5Bits.length ? n5Bits[B5] : B5 * 3);
      const tenSbits = S2 + 1 + (S5 + 1 < n5Bits.length ? n5Bits[S5 + 1] : (S5 + 1) * 3);
      // Each path develops a digit a step until the remainder is within the rounding interval
      // (low) or its complement (high); the first digit may be a leading zero, and the forms that
      // are not Double.toString's compatible one always take a second.
      let ndigit = 0, low = false, high = false, lowDigitDifference = 0, q = 0, exact = false;
      if (Bbits < 32 && tenSbits < 32) {
        let b = Math.imul(Number(fract), SMALL_5_POW[B5]) << B2, m = SMALL_5_POW[M5] << M2;
        const s = SMALL_5_POW[S5] << S2, tens = Math.imul(s, 10);
        for (let first = true; ; first = false) {
          q = (b / s) | 0; b = Math.imul(10, b % s); m = Math.imul(m, 10);
          if (first || m > 0) { low = b < m; high = ((b + m) | 0) > tens; } else low = high = true;
          if (!first) digits[ndigit++] = 48 + q;
          else {
            if (q === 0 && !high) decExp--; else digits[ndigit++] = 48 + q;
            if (!compatible || decExp < -3 || decExp >= 8) high = low = false;
          }
          if (low || high) break;
        }
        lowDigitDifference = ((b << 1) - tens) | 0;
        exact = b === 0;
      } else if (Bbits < 64 && tenSbits < 64) {
        let b = I64(I64(fract * POW5(B5)) << BigInt(B2)), m = I64(POW5(M5) << BigInt(M2));
        const s = I64(POW5(S5) << BigInt(S2)), tens = I64(s * 10n);
        for (let first = true; ; first = false) {
          q = Number(b / s); b = I64(10n * (b % s)); m = I64(m * 10n);
          if (first || m > 0n) { low = b < m; high = I64(b + m) > tens; } else low = high = true;
          if (!first) digits[ndigit++] = 48 + q;
          else {
            if (q === 0 && !high) decExp--; else digits[ndigit++] = 48 + q;
            if (!compatible || decExp < -3 || decExp >= 8) high = low = false;
          }
          if (low || high) break;
        }
        const d = I64((b << 1n) - tens);
        lowDigitDifference = d < 0n ? -1 : d > 0n ? 1 : 0;
        exact = b === 0n;
      } else {
        const unbiased = POW5(S5) << BigInt(S2), bias = normalizationBias(unbiased), S = unbiased << BigInt(bias);
        const tenS = POW5(S5 + 1) << BigInt(S2 + bias + 1);
        let B = fract * POW5(B5) << BigInt(B2 + bias), M = POW5(M5 + 1) << BigInt(M2 + bias + 1);
        for (let first = true; ; first = false) {
          q = Number(B / S); B = (B % S) * 10n;
          if (!first) M *= 10n;
          low = B < M; high = tenS <= B + M;
          if (!first) digits[ndigit++] = 48 + q;
          else {
            if (q === 0 && !high) decExp--; else digits[ndigit++] = 48 + q;
            if (!compatible || decExp < -3 || decExp >= 8) high = low = false;
          }
          if (low || high) break;
        }
        if (high && low) { B <<= 1n; lowDigitDifference = B < tenS ? -1 : B > tenS ? 1 : 0; }
        exact = B === 0n;
      }
      this[EXACT] = exact ? 1 : 0;
      this[DEC_EXP] = decExp + 1;
      this[FIRST] = 0;
      this[COUNT] = ndigit;
      if (high) {
        if (!low || lowDigitDifference > 0 || (lowDigitDifference === 0 && digits[ndigit - 1] & 1)) roundup(this);
      }
    };
  },
});
