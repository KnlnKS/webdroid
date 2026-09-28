import type { JSimpleEnum } from "./jlang";
import { JObj, rt, driven, type Gen } from "../runtime";
import { jarray, u8 } from "../abi";
import { after, defineException, mkEnumSet, stringHash, vcall } from "./jlang";
import { csText } from "./jchars";
import { newArrayList, newStringSet } from "./jutil";
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

export class JLocale extends JObj {
  lang = ""; country = ""; script = ""; variant = "";
  /** the serialized form's legacy fields: OpenJDK writes hashcode as -1 and no extensions here */
  readonly serialHash = -1; readonly extensions = "";
}
// the two-letter codes an app's bundled locales use, in ISO 639-2/3166-alpha3 form
const ISO3: Record<string, string> = { en: "eng", de: "deu", fr: "fra", es: "spa", it: "ita", pt: "por", ru: "rus", ja: "jpn", ko: "kor", zh: "zho", ar: "ara", hi: "hin", id: "ind", in: "ind", th: "tha", tr: "tur", vi: "vie", nl: "nld", pl: "pol", sv: "swe" };
/** ISO 3166-1 alpha-2, as Locale.getISOCountries lists them */
const ISO_COUNTRIES = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";
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
mkEnumSet("java/util/Locale$Category", ["DISPLAY", "FORMAT"]);
export let defaultLocale = usLocale;
const categoryLocales = new Map<string, JLocale>();
/** Locale.getDefault(Category.DISPLAY): what the no-argument display names are written in */
const displayLocale = () => categoryLocales.get("DISPLAY") ?? defaultLocale;
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
function localeFromLanguageTag(t: string): JLocale {
  const l = new JLocale();
  const m = /^([a-z]{2,8})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?((?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*)/i.exec(t);
  if (m) {
    l.lang = m[1].toLowerCase() === "und" ? "" : m[1].toLowerCase();
    l.script = m[2] ? m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() : "";
    l.country = m[3]?.toUpperCase() ?? "";
    l.variant = m[4].slice(1).replaceAll("-", "_");
  }
  return l;
}
rt.register({
  name: "java/util/Locale", ctor: JLocale, ifaces: ["java/io/Serializable", "java/lang/Cloneable"],
  serialization: { uid: 9149081749638150636n, fields: [
    { name: "hashcode", desc: "I", prop: "serialHash" }, { name: "country", desc: "Ljava/lang/String;", prop: "country" },
    { name: "extensions", desc: "Ljava/lang/String;", prop: "extensions" }, { name: "language", desc: "Ljava/lang/String;", prop: "lang" },
    { name: "script", desc: "Ljava/lang/String;", prop: "script" }, { name: "variant", desc: "Ljava/lang/String;", prop: "variant" },
  ] },
  statics: {
    US: usLocale, ENGLISH: Object.assign(new JLocale(), { lang: "en" }), ROOT: new JLocale(),
    ...Object.fromEntries(([["UK", "en", "GB"], ["CANADA", "en", "CA"], ["CANADA_FRENCH", "fr", "CA"], ["FRANCE", "fr", "FR"], ["GERMANY", "de", "DE"], ["ITALY", "it", "IT"],
      ["JAPAN", "ja", "JP"], ["KOREA", "ko", "KR"], ["CHINA", "zh", "CN"], ["PRC", "zh", "CN"], ["SIMPLIFIED_CHINESE", "zh", "CN"], ["TAIWAN", "zh", "TW"], ["TRADITIONAL_CHINESE", "zh", "TW"],
      ["FRENCH", "fr", ""], ["GERMAN", "de", ""], ["ITALIAN", "it", ""], ["JAPANESE", "ja", ""], ["KOREAN", "ko", ""], ["CHINESE", "zh", ""]] as const)
      .map(([name, lang, country]) => [name, Object.assign(new JLocale(), { lang, country })])),
  },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JLocale, l: string) { this.lang = l.toLowerCase(); },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JLocale, l: string, c: string) { this.lang = l.toLowerCase(); this.country = c.toUpperCase(); },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JLocale, l: string, c: string, v: string) { this.lang = l.toLowerCase(); this.country = c.toUpperCase(); this.variant = v; },
    "static getDefault()Ljava/util/Locale;": () => defaultLocale,
    "static getDefault(Ljava/util/Locale$Category;)Ljava/util/Locale;": (category: JSimpleEnum) => {
      if (!category) throw rt.mkThrowable("java/lang/NullPointerException", "category");
      return categoryLocales.get(category.ename) ?? defaultLocale;
    },
    "static setDefault(Ljava/util/Locale;)V": (locale: JLocale) => {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      defaultLocale = locale; categoryLocales.clear();
    },
    "static setDefault(Ljava/util/Locale$Category;Ljava/util/Locale;)V": (category: JSimpleEnum, locale: JLocale) => {
      if (!category || !locale) throw rt.mkThrowable("java/lang/NullPointerException", null);
      categoryLocales.set(category.ename, locale);
    },
    "getDisplayName()Ljava/lang/String;": function (this: JLocale) { return displayName.call(this, displayLocale()); },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": displayName,
    "getDisplayLanguage()Ljava/lang/String;": function (this: JLocale) { return displayPart(this.lang, "language", localeTag(displayLocale())); },
    "getDisplayLanguage(Ljava/util/Locale;)Ljava/lang/String;": function (this: JLocale, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayPart(this.lang, "language", localeTag(locale));
    },
    "getDisplayCountry()Ljava/lang/String;": function (this: JLocale) { return displayPart(this.country, "region", localeTag(displayLocale())); },
    "getDisplayCountry(Ljava/util/Locale;)Ljava/lang/String;": function (this: JLocale, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayPart(this.country, "region", localeTag(locale));
    },
    "getLanguage()Ljava/lang/String;": function (this: JLocale) { return this.lang; },
    "getISO3Language()Ljava/lang/String;": function (this: JLocale) { return ISO3[this.lang] ?? this.lang; },
    "static getISOLanguages()[Ljava/lang/String;": () => jarray(Object.keys(ISO3).sort(), "Ljava/lang/String;"),
    "static getISOCountries()[Ljava/lang/String;": () => jarray(ISO_COUNTRIES.split(" "), "Ljava/lang/String;"),
    "static getAvailableLocales()[Ljava/util/Locale;": () => jarray(availableULocales.map(u => u.locale), "Ljava/util/Locale;"),
    "getISO3Country()Ljava/lang/String;": function (this: JLocale) { return ISO3_COUNTRY[this.country] ?? this.country; },
    "getCountry()Ljava/lang/String;": function (this: JLocale) { return this.country; },
    "getScript()Ljava/lang/String;": function (this: JLocale) { return this.script; },
    "getVariant()Ljava/lang/String;": function (this: JLocale) { return this.variant; },
    "getUnicodeLocaleType(Ljava/lang/String;)Ljava/lang/String;": () => null,
    "stripExtensions()Ljava/util/Locale;": function (this: JLocale) { return this; },
    "getExtension(C)Ljava/lang/String;": () => null,
    // these locales carry no extensions (-u-, -t-, -x-): the sets are empty
    "hasExtensions()Z": () => 0,
    "getExtensionKeys()Ljava/util/Set;": () => newStringSet([]),
    "getUnicodeLocaleAttributes()Ljava/util/Set;": () => newStringSet([]),
    "getUnicodeLocaleKeys()Ljava/util/Set;": () => newStringSet([]),
    "toString()Ljava/lang/String;": function (this: JLocale) {
      return this.lang + (this.country || this.variant || this.script ? "_" + this.country : "") + (this.variant ? "_" + this.variant : "") + (this.script ? "_#" + this.script : "");
    },
    "toLanguageTag()Ljava/lang/String;": function (this: JLocale) { return localeTag(this); },
    "static forLanguageTag(Ljava/lang/String;)Ljava/util/Locale;": localeFromLanguageTag,
    "equals(Ljava/lang/Object;)Z": function (this: JLocale, b: unknown) {
      return b instanceof JLocale && this.lang === b.lang && this.country === b.country && this.script === b.script && this.variant === b.variant ? 1 : 0;
    },
    "hashCode()I": function (this: JLocale) { return stringHash(localeTag(this)); },
  },
});

defineException("java/util/IllformedLocaleException", "java/lang/RuntimeException");
class JLocaleBuilder extends JObj { value = new JLocale(); }
rt.register({ name: "java/util/Locale$Builder", ctor: JLocaleBuilder, methods: {
  "<init>()V": function () {},
  "setRegion(Ljava/lang/String;)Ljava/util/Locale$Builder;": function (this: JLocaleBuilder, region: string | null) {
    if (region && !/^(?:[a-z]{2}|\d{3})$/i.test(region)) throw rt.mkThrowable("java/util/IllformedLocaleException", "Ill-formed region: " + region);
    this.value.country = region?.toUpperCase() ?? ""; return this;
  },
  "build()Ljava/util/Locale;": function (this: JLocaleBuilder) { return Object.assign(new JLocale(), this.value); },
} });

class JULocale extends JObj {
  locale = new JLocale();
  keywords = new Map<string, string>();
}
function ulocaleFromId(id: string): JULocale {
  const out = new JULocale();
  const [base, keywordText] = String(id).split("@", 2);
  out.locale = localeFromLanguageTag(base.replaceAll("_", "-"));
  for (const entry of keywordText?.split(";") ?? []) {
    const i = entry.indexOf("=");
    if (i > 0) out.keywords.set(entry.slice(0, i).trim().toLowerCase(), entry.slice(i + 1).trim());
  }
  return out;
}
function ulocaleFromLocale(locale: JLocale): JULocale {
  if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
  const out = new JULocale();
  out.locale = locale;
  return out;
}
function cloneULocale(locale: JULocale): JULocale {
  const out = ulocaleFromLocale(Object.assign(new JLocale(), locale.locale));
  out.keywords = new Map(locale.keywords);
  return out;
}
function ulocaleId(locale: JULocale): string {
  const base = [locale.locale.lang, locale.locale.script, locale.locale.country, locale.locale.variant].filter(Boolean).join("_");
  return base + (locale.keywords.size ? "@" + [...locale.keywords].map(([k, v]) => `${k}=${v}`).join(";") : "");
}
const rootULocale = ulocaleFromLocale(new JLocale());
const englishULocale = ulocaleFromLocale(Object.assign(new JLocale(), { lang: "en" }));
const usULocale = ulocaleFromLocale(usLocale);
const availableULocales = [rootULocale, englishULocale, usULocale];
mkEnumSet("android/icu/util/ULocale$Category", ["DISPLAY", "FORMAT"]);
rt.register({
  name: "android/icu/util/ULocale", ctor: JULocale,
  statics: { ROOT: rootULocale, ENGLISH: englishULocale, US: usULocale },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JULocale, id: string) { Object.assign(this, ulocaleFromId(id)); },
    "static forLanguageTag(Ljava/lang/String;)Landroid/icu/util/ULocale;": (tag: string) => ulocaleFromId(tag),
    "static forLocale(Ljava/util/Locale;)Landroid/icu/util/ULocale;": ulocaleFromLocale,
    "static getDefault()Landroid/icu/util/ULocale;": () => ulocaleFromLocale(defaultLocale),
    "static getDefault(Landroid/icu/util/ULocale$Category;)Landroid/icu/util/ULocale;": (c: JSimpleEnum) => ulocaleFromLocale(categoryLocales.get(c?.ename) ?? defaultLocale),
    "static getAvailableLocales()[Landroid/icu/util/ULocale;": () => jarray(availableULocales.slice(), "Landroid/icu/util/ULocale;"),
    "getLanguage()Ljava/lang/String;": function (this: JULocale) { return this.locale.lang; },
    "getCountry()Ljava/lang/String;": function (this: JULocale) { return this.locale.country; },
    "getDisplayLanguage(Landroid/icu/util/ULocale;)Ljava/lang/String;": function (this: JULocale, display: JULocale) {
      if (!display) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayPart(this.locale.lang, "language", localeTag(display.locale));
    },
    "getDisplayCountry(Landroid/icu/util/ULocale;)Ljava/lang/String;": function (this: JULocale, display: JULocale) {
      if (!display) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayPart(this.locale.country, "region", localeTag(display.locale));
    },
    "getDisplayName()Ljava/lang/String;": function (this: JULocale) { return displayName.call(this.locale, displayLocale()); },
    "getDisplayName(Landroid/icu/util/ULocale;)Ljava/lang/String;": function (this: JULocale, display: JULocale) {
      if (!display) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayName.call(this.locale, display.locale);
    },
    "getKeywordValue(Ljava/lang/String;)Ljava/lang/String;": function (this: JULocale, key: string) { return this.keywords.get(key.toLowerCase()) ?? null; },
    "getKeywords()Ljava/util/Iterator;": function (this: JULocale) {
      return this.keywords.size ? vcall(newArrayList([...this.keywords.keys()]), "iterator", "()Ljava/util/Iterator;") : null;
    },
    "isRightToLeft()Z": function (this: JULocale) { return localeDirection(this.locale); },
    "toLanguageTag()Ljava/lang/String;": function (this: JULocale) { return localeTag(this.locale); },
    "toLocale()Ljava/util/Locale;": function (this: JULocale) { return this.locale; },
    "toString()Ljava/lang/String;": function (this: JULocale) { return ulocaleId(this); },
    "equals(Ljava/lang/Object;)Z": function (this: JULocale, other: unknown) {
      return other instanceof JULocale && ulocaleId(this) === ulocaleId(other) ? 1 : 0;
    },
    "hashCode()I": function (this: JULocale) { return stringHash(ulocaleId(this)); },
    "static acceptLanguage([Landroid/icu/util/ULocale;[Landroid/icu/util/ULocale;[Z)Landroid/icu/util/ULocale;":
      (wanted: JULocale[], available: JULocale[], fallback: Int8Array | null) => {
        for (const want of wanted ?? []) {
          const exact = (available ?? []).find((have) => ulocaleId(have) === ulocaleId(want));
          if (exact) { if (fallback?.length) fallback[0] = 0; return exact; }
          const language = (available ?? []).find((have) => have.locale.lang === want.locale.lang);
          if (language) { if (fallback?.length) fallback[0] = 1; return language; }
        }
        if (fallback?.length) fallback[0] = 1;
        return null;
      },
  },
});

class JULocaleBuilder extends JObj { value = cloneULocale(rootULocale); }
rt.register({
  name: "android/icu/util/ULocale$Builder", ctor: JULocaleBuilder,
  methods: {
    "<init>()V": function () {},
    "setLanguageTag(Ljava/lang/String;)Landroid/icu/util/ULocale$Builder;": function (this: JULocaleBuilder, tag: string) { this.value = ulocaleFromId(tag); return this; },
    "setLocale(Landroid/icu/util/ULocale;)Landroid/icu/util/ULocale$Builder;": function (this: JULocaleBuilder, locale: JULocale) { this.value = cloneULocale(locale); return this; },
    "setRegion(Ljava/lang/String;)Landroid/icu/util/ULocale$Builder;": function (this: JULocaleBuilder, region: string) { this.value.locale.country = region.toUpperCase(); return this; },
    "setUnicodeLocaleKeyword(Ljava/lang/String;Ljava/lang/String;)Landroid/icu/util/ULocale$Builder;": function (this: JULocaleBuilder, key: string, value: string | null) {
      if (value === null) this.value.keywords.delete(key.toLowerCase()); else this.value.keywords.set(key.toLowerCase(), value);
      return this;
    },
    "clearExtensions()Landroid/icu/util/ULocale$Builder;": function (this: JULocaleBuilder) { this.value.keywords.clear(); return this; },
    "build()Landroid/icu/util/ULocale;": function (this: JULocaleBuilder) { return cloneULocale(this.value); },
  },
});

export class JCurrency extends JObj { code = "USD"; }
const intlMemo = new Map<string, Intl.NumberFormat>();
/** the Intl formatter every number format shares for a locale and options */
export function intlNumber(tag: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = tag + JSON.stringify(options);
  let fmt = intlMemo.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(tag, options);
    // Intl accepts any well-formed currency code, so bound what arbitrary codes can accumulate
    if (intlMemo.size >= 256) intlMemo.clear();
    intlMemo.set(key, fmt);
  }
  return fmt;
}
// Intl knows every ISO 4217 code's symbol and fraction digits; only the currency of each
// ISO 3166 region is a table here, as Intl does not expose it
const REGION_CURRENCY: Record<string, string | undefined> = Object.fromEntries(("AE:AED AF:AFN AL:ALL AM:AMD AO:AOA AR:ARS AU:AUD AZ:AZN BA:BAM BD:BDT BG:BGN BH:BHD " +
  "BO:BOB BR:BRL BY:BYN BZ:BZD CA:CAD CH:CHF CL:CLP CN:CNY CO:COP CR:CRC CU:CUP CZ:CZK DK:DKK DO:DOP DZ:DZD EC:USD EG:EGP " +
  "ET:ETB GB:GBP GE:GEL GH:GHS GT:GTQ HK:HKD HN:HNL HU:HUF ID:IDR IL:ILS IN:INR IQ:IQD IR:IRR IS:ISK JM:JMD JO:JOD JP:JPY " +
  "KE:KES KG:KGS KH:KHR KR:KRW KW:KWD KZ:KZT LB:LBP LK:LKR MA:MAD MD:MDL MK:MKD MM:MMK MN:MNT MO:MOP MX:MXN MY:MYR NG:NGN " +
  "NI:NIO NO:NOK NP:NPR NZ:NZD OM:OMR PA:PAB PE:PEN PH:PHP PK:PKR PL:PLN PR:USD PY:PYG QA:QAR RO:RON RS:RSD RU:RUB SA:SAR " +
  "SE:SEK SG:SGD SV:USD TH:THB TN:TND TR:TRY TT:TTD TW:TWD TZ:TZS UA:UAH UG:UGX US:USD UY:UYU UZ:UZS VE:VES VN:VND ZA:ZAR " +
  "AD:EUR AT:EUR BE:EUR CY:EUR DE:EUR EE:EUR ES:EUR FI:EUR FR:EUR GR:EUR HR:EUR IE:EUR IT:EUR LT:EUR LU:EUR LV:EUR MC:EUR " +
  "ME:EUR MT:EUR NL:EUR PT:EUR SI:EUR SK:EUR SM:EUR VA:EUR XK:EUR").split(" ").map((e) => e.split(":")));
/** the currency of a locale's region, null for a locale without a region or a tender */
export const localeCurrency = (l: JLocale): string | null => REGION_CURRENCY[l.country.toUpperCase()] ?? null;
const currencyFmt = (code: string, tag = localeTag(usLocale)) => intlNumber(tag, { style: "currency", currency: code });
export function currency(code: string): JCurrency {
  if (!code) throw rt.mkThrowable("java/lang/NullPointerException", "currencyCode");
  const normalized = code.toUpperCase();
  try { currencyFmt(normalized); }
  catch { throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unsupported ISO 4217 currency code: " + code); }
  return Object.assign(new JCurrency(), { code: normalized });
}
function currencyDisplayName(code: string, locale: JLocale): string {
  try { return new Intl.DisplayNames([localeTag(locale)], { type: "currency" }).of(code) ?? code; }
  catch { return code; }
}
function currencySymbol(code: string, locale: JLocale): string {
  const parts = currencyFmt(code, localeTag(locale)).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? code;
}
// the bodies java.util.Currency and android.icu.util.Currency share
function currencyCode(this: JCurrency) { return this.code; }
function currencyHash(this: JCurrency) { return stringHash(this.code); }
export const currencyDigits = (code: string) => currencyFmt(code).resolvedOptions().maximumFractionDigits ?? 2;
function currencyFractionDigits(this: JCurrency) { return currencyDigits(this.code); }
function currencyNameIn(this: JCurrency, locale: JLocale) {
  if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
  return currencyDisplayName(this.code, locale);
}
function defaultCurrencySymbol(this: JCurrency) { return currencySymbol(this.code, displayLocale()); }
rt.register({
  name: "java/util/Currency", ctor: JCurrency,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/util/Currency;": currency,
    // the region's currency, null for a region without one
    "static getInstance(Ljava/util/Locale;)Ljava/util/Currency;": (locale: JLocale | null) => {
      if (!locale) return rt.npe();
      if (!locale.country) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unsupported locale: " + localeTag(locale));
      const code = localeCurrency(locale);
      return code === null ? null : currency(code);
    },
    "getCurrencyCode()Ljava/lang/String;": currencyCode,
    "toString()Ljava/lang/String;": currencyCode,
    "getDisplayName()Ljava/lang/String;": function (this: JCurrency) { return currencyDisplayName(this.code, displayLocale()); },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": currencyNameIn,
    "getSymbol()Ljava/lang/String;": defaultCurrencySymbol,
    "getSymbol(Ljava/util/Locale;)Ljava/lang/String;": function (this: JCurrency, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      return currencySymbol(this.code, locale);
    },
    "getDefaultFractionDigits()I": currencyFractionDigits,
    "equals(Ljava/lang/Object;)Z": function (this: JCurrency, other: unknown) { return other instanceof JCurrency && other.code === this.code ? 1 : 0; },
    "hashCode()I": currencyHash,
  },
});

rt.register({ name: "android/icu/util/MeasureUnit", ctor: class extends JObj {}, ifaces: ["java/io/Serializable"] });
class JICUCurrency extends JCurrency {}
/** ICU answers a region without a tender with "XXX" rather than null */
function icuCurrencyOf(locale: JLocale | null) {
  if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
  return Object.assign(new JICUCurrency(), currency(localeCurrency(locale) ?? "XXX"));
}
rt.register({
  name: "android/icu/util/Currency", ctor: JICUCurrency, sup: "android/icu/util/MeasureUnit",
  methods: {
    "static getInstance(Ljava/lang/String;)Landroid/icu/util/Currency;": (code: string) => Object.assign(new JICUCurrency(), currency(code)),
    "static getInstance(Ljava/util/Locale;)Landroid/icu/util/Currency;": (locale: JLocale | null) => icuCurrencyOf(locale),
    "static getInstance(Landroid/icu/util/ULocale;)Landroid/icu/util/Currency;": (locale: JULocale | null) => icuCurrencyOf(locale?.locale ?? null),
    "getCurrencyCode()Ljava/lang/String;": currencyCode,
    "getDefaultFractionDigits()I": currencyFractionDigits,
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": currencyNameIn,
    "getSymbol()Ljava/lang/String;": defaultCurrencySymbol,
    "getName(Landroid/icu/util/ULocale;I[Z)Ljava/lang/String;": function (this: JICUCurrency, locale: JULocale, style: number, isChoiceFormat: Int8Array | null) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      if (isChoiceFormat?.length) isChoiceFormat[0] = 0;
      return style === 0 ? currencySymbol(this.code, locale.locale) : currencyDisplayName(this.code, locale.locale);
    },
    "toString()Ljava/lang/String;": currencyCode,
    "equals(Ljava/lang/Object;)Z": function (this: JICUCurrency, other: unknown) { return other instanceof JICUCurrency && other.code === this.code ? 1 : 0; },
    "hashCode()I": currencyHash,
  },
});
