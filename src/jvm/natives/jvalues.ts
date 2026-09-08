import { JObj, rt } from "../runtime";
import { mangleMethod } from "../abi";

class JStringJoiner extends JObj { sep = ","; pre = ""; suf = ""; parts: string[] = []; }
rt.register({
  name: "java/util/StringJoiner", ctor: JStringJoiner,
  methods: {
    "<init>(Ljava/lang/CharSequence;)V": function (this: JStringJoiner, s: unknown) { this.sep = String(s); },
    "<init>(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/CharSequence;)V":
      function (this: JStringJoiner, s: unknown, p: unknown, u: unknown) { this.sep = String(s); this.pre = String(p); this.suf = String(u); },
    "add(Ljava/lang/CharSequence;)Ljava/util/StringJoiner;": function (this: JStringJoiner, s: unknown) {
      this.parts.push(s === null ? "null" : String(s)); return this;
    },
    "toString()Ljava/lang/String;": function (this: JStringJoiner) { return this.pre + this.parts.join(this.sep) + this.suf; },
  },
});

class JUUID extends JObj { hi = 0n; lo = 0n; }
rt.register({
  name: "java/util/UUID", ctor: JUUID, ifaces: ["java/io/Serializable", "java/lang/Comparable"],
  methods: {
    "<init>(JJ)V": function (this: JUUID, hi: bigint, lo: bigint) { this.hi = hi; this.lo = lo; },
    "static randomUUID()Ljava/util/UUID;": () => {
      const u = new JUUID();
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      let hi = 0n, lo = 0n;
      for (let i = 0; i < 8; i++) hi = (hi << 8n) | BigInt(b[i]);
      for (let i = 8; i < 16; i++) lo = (lo << 8n) | BigInt(b[i]);
      u.hi = BigInt.asIntN(64, hi); u.lo = BigInt.asIntN(64, lo);
      return u;
    },
    "toString()Ljava/lang/String;": function (this: JUUID) {
      const h = (v: bigint, n: number) => BigInt.asUintN(n * 4, v).toString(16).padStart(n, "0");
      return `${h(this.hi >> 32n, 8)}-${h(this.hi >> 16n, 4)}-${h(this.hi, 4)}-${h(this.lo >> 48n, 4)}-${h(this.lo, 12)}`;
    },
    "getMostSignificantBits()J": function (this: JUUID) { return this.hi; },
    "getLeastSignificantBits()J": function (this: JUUID) { return this.lo; },
  },
});

class JLocale extends JObj { lang = "en"; country = "US"; }
/** the one locale the device speaks; also the default */
export const usLocale = new JLocale();
rt.register({
  name: "java/util/Locale", ctor: JLocale,
  statics: { US: usLocale, ENGLISH: usLocale, ROOT: new JLocale() },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JLocale, l: string) { this.lang = l; },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JLocale, l: string, c: string) { this.lang = l; this.country = c; },
    "static getDefault()Ljava/util/Locale;": () => usLocale,
    "static setDefault(Ljava/util/Locale;)V": () => {},
    "getLanguage()Ljava/lang/String;": function (this: JLocale) { return this.lang; },
    "getCountry()Ljava/lang/String;": function (this: JLocale) { return this.country; },
    "toString()Ljava/lang/String;": function (this: JLocale) { return this.lang + "_" + this.country; },
    "toLanguageTag()Ljava/lang/String;": function (this: JLocale) { return this.lang + "-" + this.country; },
    "static forLanguageTag(Ljava/lang/String;)Ljava/util/Locale;": (t: string) => {
      const l = new JLocale();
      const [a, b] = t.split("-");
      l.lang = a ?? "en"; l.country = b ?? "";
      return l;
    },
  },
});

// Currency is data the browser already has: Intl knows every ISO 4217 code's symbol and its
// fraction digits, so nothing here is a table we would have to keep current.
class JCurrency extends JObj { code = "USD"; }
const currencyFmt = (code: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: code });
rt.register({
  name: "java/util/Currency", ctor: JCurrency,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/util/Currency;": (c: string) => {
      const cur = new JCurrency();
      cur.code = c;
      return cur;
    },
    "static getInstance(Ljava/util/Locale;)Ljava/util/Currency;": () => new JCurrency(),
    "getCurrencyCode()Ljava/lang/String;": function (this: JCurrency) { return this.code; },
    "toString()Ljava/lang/String;": function (this: JCurrency) { return this.code; },
    "getDisplayName()Ljava/lang/String;": function (this: JCurrency) { return this.code; },
    "getSymbol()Ljava/lang/String;": function (this: JCurrency) {
      const parts = currencyFmt(this.code).formatToParts(0);
      return parts.find((p) => p.type === "currency")?.value ?? this.code;
    },
    "getSymbol(Ljava/util/Locale;)Ljava/lang/String;": mangleMethod("getSymbol", "()Ljava/lang/String;"),
    "getDefaultFractionDigits()I": function (this: JCurrency) {
      return currencyFmt(this.code).resolvedOptions().maximumFractionDigits ?? 2;
    },
  },
});
