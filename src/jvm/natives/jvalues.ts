import { JObj, rt, driven, type Gen } from "../runtime";
import { u8 } from "../abi";
import { after, scall, vcall } from "./jlang";
import { csText } from "./jchars";
import { md5 } from "./digest";

class JStringJoiner extends JObj { sep = ","; pre = ""; suf = ""; parts: string[] = []; }
rt.register({
  name: "java/util/StringJoiner", ctor: JStringJoiner,
  methods: {
    "<init>(Ljava/lang/CharSequence;)V": function (this: JStringJoiner, s: unknown) {
      return after(csText(s ?? rt.npe()), (sep: string) => { this.sep = sep; });
    },
    "<init>(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/CharSequence;)V": driven(function* (this: JStringJoiner, s: unknown, p: unknown, u: unknown): Gen {
      if (s == null || p == null || u == null) rt.npe();
      this.pre = yield csText(p); this.sep = yield csText(s); this.suf = yield csText(u);
    }),
    "add(Ljava/lang/CharSequence;)Ljava/util/StringJoiner;": function (this: JStringJoiner, s: unknown) {
      return after(s === null ? "null" : csText(s), (text: string) => { this.parts.push(text); return this; });
    },
    "toString()Ljava/lang/String;": function (this: JStringJoiner) { return this.pre + this.parts.join(this.sep) + this.suf; },
  },
});

class JUUID extends JObj { hi = 0n; lo = 0n; }
export function uuidFromString(s: string): JUUID {
  const parts = s.split("-");
  if (parts.length !== 5) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid UUID string: " + s);
  const u = new JUUID(), h = parts.map((p) => BigInt("0x" + p));
  u.hi = BigInt.asIntN(64, (h[0] << 32n) | (h[1] << 16n) | h[2]);
  u.lo = BigInt.asIntN(64, (h[3] << 48n) | h[4]);
  return u;
}
/** an RFC 4122 UUID of the given version from 16 bytes (random or a name's MD5) */
function uuidOf(b: Uint8Array, version: number): JUUID {
  b[6] = (b[6] & 0x0f) | version << 4; b[8] = (b[8] & 0x3f) | 0x80;
  const u = new JUUID(), dv = new DataView(b.buffer, b.byteOffset, 16);
  u.hi = dv.getBigInt64(0); u.lo = dv.getBigInt64(8);
  return u;
}
function compareUuids(this: JUUID, o: JUUID | null): number {
  if (!o) return rt.npe();
  return this.hi < o.hi ? -1 : this.hi > o.hi ? 1 : this.lo < o.lo ? -1 : this.lo > o.lo ? 1 : 0;
}
rt.register({
  name: "java/util/UUID", ctor: JUUID, ifaces: ["java/io/Serializable", "java/lang/Comparable"],
  serialization: { uid: -4856846361193249489n, fields: [
    { name: "leastSigBits", desc: "J", prop: "lo" }, { name: "mostSigBits", desc: "J", prop: "hi" },
  ] },
  methods: {
    "<init>(JJ)V": function (this: JUUID, hi: bigint, lo: bigint) { this.hi = hi; this.lo = lo; },
    "static randomUUID()Ljava/util/UUID;": () => uuidOf(crypto.getRandomValues(new Uint8Array(16)), 4),
    "static nameUUIDFromBytes([B)Ljava/util/UUID;": (name: Int8Array | null) => uuidOf(md5(u8(name ?? rt.npe())), 3),
    "toString()Ljava/lang/String;": function (this: JUUID) {
      const h = (v: bigint, n: number) => BigInt.asUintN(n * 4, v).toString(16).padStart(n, "0");
      return `${h(this.hi >> 32n, 8)}-${h(this.hi >> 16n, 4)}-${h(this.hi, 4)}-${h(this.lo >> 48n, 4)}-${h(this.lo, 12)}`;
    },
    "static fromString(Ljava/lang/String;)Ljava/util/UUID;": uuidFromString,
    "equals(Ljava/lang/Object;)Z": function (this: JUUID, o: unknown) { return o instanceof JUUID && o.hi === this.hi && o.lo === this.lo ? 1 : 0; },
    "hashCode()I": function (this: JUUID) { const x = this.hi ^ this.lo; return Number(BigInt.asIntN(32, (x >> 32n) ^ x)); },
    "compareTo(Ljava/util/UUID;)I": compareUuids,
    "compareTo(Ljava/lang/Object;)I": compareUuids,
    "getMostSignificantBits()J": function (this: JUUID) { return this.hi; },
    "getLeastSignificantBits()J": function (this: JUUID) { return this.lo; },
  },
});

/** a java.util.Locale, which libcore implements; native code reads one through its Java API */
export type JLocale = JObj;
const tags = new WeakMap<JLocale, string>();
/** a Locale's BCP 47 tag; Locales are immutable, so each one's is kept */
export function localeTag(locale: JLocale): string | Promise<string> {
  return tags.get(locale) ?? after(vcall(locale, "toLanguageTag", "()Ljava/lang/String;"), (tag: string) => { tags.set(locale, tag); return tag; });
}
// ICU script metadata; Intl's text direction can ignore explicit script subtags.
const rtlScripts = new Set("Arab Hebr Syrc Thaa Cprt Khar Hung Mand Mero Nkoo Orkh Phnx Lydi Armi Avst Mani Phli Phlp Prti Samr Sarb Mend Merc Narb Nbat Palm Hatr Adlm Rohg Sogd Sogo Elym Chrs Yezi Ougr".split(" "));
export function tagDirection(tag: string): number {
  if (tag === "und") return 0;
  try { const locale = new Intl.Locale(tag); return rtlScripts.has(locale.script ?? locale.maximize().script ?? "") ? 1 : 0; }
  catch { return 0; }
}
/** View.LAYOUT_DIRECTION_RTL (1) for a right-to-left locale, else LTR (0) */
export const localeDirection = (locale: JLocale | null): number | Promise<number> => locale ? after(localeTag(locale), tagDirection) : 0;
export const defaultLocale = (): JLocale | Promise<JLocale> => scall("java/util/Locale", "getDefault", "()Ljava/util/Locale;");
export const localeForTag = (tag: string): JLocale | Promise<JLocale> => scall("java/util/Locale", "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", tag);
