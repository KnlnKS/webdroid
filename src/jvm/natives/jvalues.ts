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
    "static fromString(Ljava/lang/String;)Ljava/util/UUID;": (s: string) => {
      const parts = s.split("-");
      if (parts.length !== 5) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid UUID string: " + s);
      const u = new JUUID(), h = parts.map((p) => BigInt("0x" + p));
      u.hi = BigInt.asIntN(64, (h[0] << 32n) | (h[1] << 16n) | h[2]);
      u.lo = BigInt.asIntN(64, (h[3] << 48n) | h[4]);
      return u;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JUUID, o: unknown) { return o instanceof JUUID && o.hi === this.hi && o.lo === this.lo ? 1 : 0; },
    "hashCode()I": function (this: JUUID) { const x = this.hi ^ this.lo; return Number(BigInt.asIntN(32, (x >> 32n) ^ x)); },
    "compareTo(Ljava/lang/Object;)I": function (this: JUUID, o: JUUID) { return this.hi < o.hi ? -1 : this.hi > o.hi ? 1 : this.lo < o.lo ? -1 : this.lo > o.lo ? 1 : 0; },
    "getMostSignificantBits()J": function (this: JUUID) { return this.hi; },
    "getLeastSignificantBits()J": function (this: JUUID) { return this.lo; },
  },
});

export class JLocale extends JObj { lang = ""; country = ""; script = ""; variant = ""; }
// the two-letter codes an app's bundled locales use, in ISO 639-2/3166-alpha3 form
const ISO3: Record<string, string> = { en: "eng", de: "deu", fr: "fra", es: "spa", it: "ita", pt: "por", ru: "rus", ja: "jpn", ko: "kor", zh: "zho", ar: "ara", hi: "hin", id: "ind", in: "ind", th: "tha", tr: "tur", vi: "vie", nl: "nld", pl: "pol", sv: "swe" };
const ISO3_COUNTRY: Record<string, string> = { US: "USA", GB: "GBR", DE: "DEU", FR: "FRA", ES: "ESP", IT: "ITA", BR: "BRA", RU: "RUS", JP: "JPN", KR: "KOR", CN: "CHN", IN: "IND", CA: "CAN", AU: "AUS", MX: "MEX", NL: "NLD", TR: "TUR" };
export function localeTag(l: JLocale): string {
  return [l.lang || "und", l.script, l.country, l.variant.replaceAll("_", "-")].filter(Boolean).join("-");
}
// ICU script metadata; Intl's text direction can ignore explicit script subtags.
const rtlScripts = new Set("Arab Hebr Syrc Thaa Cprt Khar Hung Mand Mero Nkoo Orkh Phnx Lydi Armi Avst Mani Phli Phlp Prti Samr Sarb Mend Merc Narb Nbat Palm Hatr Adlm Rohg Sogd Sogo Elym Chrs Yezi Ougr".split(" "));
export function localeDirection(locale: JLocale | null): number {
  if (!locale || !locale.lang && !locale.script && !locale.country) return 0;
  try { return rtlScripts.has(locale.script || new Intl.Locale(localeTag(locale)).maximize().script || "") ? 1 : 0; }
  catch { return 0; }
}
/** the one locale the device speaks; also the default */
export const usLocale = Object.assign(new JLocale(), { lang: "en", country: "US" });
const localeNames = new Map<string, Intl.DisplayNames>();
function displayPart(value: string, type: "language" | "script" | "region", tag: string): string {
  if (!value) return "";
  const key = tag + ":" + type;
  let names = localeNames.get(key);
  if (!names) {
    try { names = new Intl.DisplayNames([tag], { type, languageDisplay: "standard" }); }
    catch { names = new Intl.DisplayNames([localeTag(usLocale)], { type, languageDisplay: "standard" }); }
    if (localeNames.size >= 64) localeNames.delete(localeNames.keys().next().value!);
    localeNames.set(key, names);
  }
  try { return names.of(value) ?? value; } catch { return value; }
}
function displayName(this: JLocale, displayLocale: JLocale): string {
  if (!displayLocale) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
  const tag = localeTag(displayLocale);
  return this.lang ? displayPart(localeTag(this), "language", tag)
    : [displayPart(this.script, "script", tag), displayPart(this.country, "region", tag), this.variant].filter(Boolean).join(", ");
}
rt.register({
  name: "java/util/Locale", ctor: JLocale,
  statics: { US: usLocale, ENGLISH: Object.assign(new JLocale(), { lang: "en" }), ROOT: new JLocale() },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JLocale, l: string) { this.lang = l.toLowerCase(); },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JLocale, l: string, c: string) { this.lang = l.toLowerCase(); this.country = c.toUpperCase(); },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JLocale, l: string, c: string, v: string) { this.lang = l.toLowerCase(); this.country = c.toUpperCase(); this.variant = v; },
    "static getDefault()Ljava/util/Locale;": () => usLocale,
    "static setDefault(Ljava/util/Locale;)V": () => {},
    "getDisplayName()Ljava/lang/String;": function (this: JLocale) { return displayName.call(this, usLocale); },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": displayName,
    "getLanguage()Ljava/lang/String;": function (this: JLocale) { return this.lang; },
    "getISO3Language()Ljava/lang/String;": function (this: JLocale) { return ISO3[this.lang] ?? this.lang; },
    "getISO3Country()Ljava/lang/String;": function (this: JLocale) { return ISO3_COUNTRY[this.country] ?? this.country; },
    "getCountry()Ljava/lang/String;": function (this: JLocale) { return this.country; },
    "getScript()Ljava/lang/String;": function (this: JLocale) { return this.script; },
    "getVariant()Ljava/lang/String;": function (this: JLocale) { return this.variant; },
    "getUnicodeLocaleType(Ljava/lang/String;)Ljava/lang/String;": () => null,
    "stripExtensions()Ljava/util/Locale;": function (this: JLocale) { return this; },
    "getExtension(C)Ljava/lang/String;": () => null,
    "toString()Ljava/lang/String;": function (this: JLocale) {
      return this.lang + (this.country || this.variant || this.script ? "_" + this.country : "") + (this.variant ? "_" + this.variant : "") + (this.script ? "_#" + this.script : "");
    },
    "toLanguageTag()Ljava/lang/String;": function (this: JLocale) { return localeTag(this); },
    "static forLanguageTag(Ljava/lang/String;)Ljava/util/Locale;": (t: string) => {
      const l = new JLocale();
      const m = /^([a-z]{2,8})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?((?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*)/i.exec(t);
      if (m) {
        l.lang = m[1].toLowerCase() === "und" ? "" : m[1].toLowerCase();
        l.script = m[2] ? m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() : "";
        l.country = m[3]?.toUpperCase() ?? "";
        l.variant = m[4].slice(1).replaceAll("-", "_");
      }
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
