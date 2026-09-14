import { JObj, rt } from "../runtime";
import { jarray } from "../abi";
import { mkEnumSet, stringHash, vcallMaybe } from "./jlang";
import { newArrayList } from "./jutil";

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
export function uuidFromString(s: string): JUUID {
  const parts = s.split("-");
  if (parts.length !== 5) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid UUID string: " + s);
  const u = new JUUID(), h = parts.map((p) => BigInt("0x" + p));
  u.hi = BigInt.asIntN(64, (h[0] << 32n) | (h[1] << 16n) | h[2]);
  u.lo = BigInt.asIntN(64, (h[3] << 48n) | h[4]);
  return u;
}
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
    "static fromString(Ljava/lang/String;)Ljava/util/UUID;": uuidFromString,
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
export function localeFromLanguageTag(t: string): JLocale {
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
function localeEquals(a: JLocale, b: unknown): number {
  return b instanceof JLocale && a.lang === b.lang && a.country === b.country && a.script === b.script && a.variant === b.variant ? 1 : 0;
}
rt.register({
  name: "java/util/Locale", ctor: JLocale,
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
    "static getDefault()Ljava/util/Locale;": () => usLocale,
    "static setDefault(Ljava/util/Locale;)V": () => {},
    "getDisplayName()Ljava/lang/String;": function (this: JLocale) { return displayName.call(this, usLocale); },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": displayName,
    "getDisplayLanguage()Ljava/lang/String;": function (this: JLocale) { return displayPart(this.lang, "language", localeTag(usLocale)); },
    "getDisplayLanguage(Ljava/util/Locale;)Ljava/lang/String;": function (this: JLocale, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayPart(this.lang, "language", localeTag(locale));
    },
    "getDisplayCountry()Ljava/lang/String;": function (this: JLocale) { return displayPart(this.country, "region", localeTag(usLocale)); },
    "getDisplayCountry(Ljava/util/Locale;)Ljava/lang/String;": function (this: JLocale, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayPart(this.country, "region", localeTag(locale));
    },
    "getLanguage()Ljava/lang/String;": function (this: JLocale) { return this.lang; },
    "getISO3Language()Ljava/lang/String;": function (this: JLocale) { return ISO3[this.lang] ?? this.lang; },
    "static getISOLanguages()[Ljava/lang/String;": () => jarray(Object.keys(ISO3).sort(), "Ljava/lang/String;"),
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
    "static forLanguageTag(Ljava/lang/String;)Ljava/util/Locale;": localeFromLanguageTag,
    "equals(Ljava/lang/Object;)Z": function (this: JLocale, other: unknown) { return localeEquals(this, other); },
    "hashCode()I": function (this: JLocale) { return stringHash(localeTag(this)); },
  },
});

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
    "static getDefault()Landroid/icu/util/ULocale;": () => usULocale,
    "static getDefault(Landroid/icu/util/ULocale$Category;)Landroid/icu/util/ULocale;": () => usULocale,
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
    "getDisplayName()Ljava/lang/String;": function (this: JULocale) { return displayName.call(this.locale, usLocale); },
    "getDisplayName(Landroid/icu/util/ULocale;)Ljava/lang/String;": function (this: JULocale, display: JULocale) {
      if (!display) throw rt.mkThrowable("java/lang/NullPointerException", "displayLocale");
      return displayName.call(this.locale, display.locale);
    },
    "getKeywordValue(Ljava/lang/String;)Ljava/lang/String;": function (this: JULocale, key: string) { return this.keywords.get(key.toLowerCase()) ?? null; },
    "getKeywords()Ljava/util/Iterator;": function (this: JULocale) {
      return this.keywords.size ? vcallMaybe(newArrayList([...this.keywords.keys()]), "iterator", "()Ljava/util/Iterator;") : null;
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

// Currency is data the browser already has: Intl knows every ISO 4217 code's symbol and its
// fraction digits, so nothing here is a table we would have to keep current.
class JCurrency extends JObj { code = "USD"; }
function currencyFmt(code: string, locale = localeTag(usLocale)): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { style: "currency", currency: code });
}
function currency(code: string): JCurrency {
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
rt.register({
  name: "java/util/Currency", ctor: JCurrency,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/util/Currency;": currency,
    "static getInstance(Ljava/util/Locale;)Ljava/util/Currency;": () => new JCurrency(),
    "getCurrencyCode()Ljava/lang/String;": function (this: JCurrency) { return this.code; },
    "toString()Ljava/lang/String;": function (this: JCurrency) { return this.code; },
    "getDisplayName()Ljava/lang/String;": function (this: JCurrency) { return currencyDisplayName(this.code, usLocale); },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": function (this: JCurrency, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      return currencyDisplayName(this.code, locale);
    },
    "getSymbol()Ljava/lang/String;": function (this: JCurrency) { return currencySymbol(this.code, usLocale); },
    "getSymbol(Ljava/util/Locale;)Ljava/lang/String;": function (this: JCurrency, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      return currencySymbol(this.code, locale);
    },
    "getDefaultFractionDigits()I": function (this: JCurrency) {
      return currencyFmt(this.code).resolvedOptions().maximumFractionDigits ?? 2;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JCurrency, other: unknown) { return other instanceof JCurrency && other.code === this.code ? 1 : 0; },
    "hashCode()I": function (this: JCurrency) { return stringHash(this.code); },
  },
});

class JICUCurrency extends JCurrency {}
rt.register({
  name: "android/icu/util/Currency", ctor: JICUCurrency,
  methods: {
    "static getInstance(Ljava/lang/String;)Landroid/icu/util/Currency;": (code: string) => Object.assign(new JICUCurrency(), currency(code)),
    "getCurrencyCode()Ljava/lang/String;": function (this: JICUCurrency) { return this.code; },
    "getDefaultFractionDigits()I": function (this: JICUCurrency) { return currencyFmt(this.code).resolvedOptions().maximumFractionDigits ?? 2; },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": function (this: JICUCurrency, locale: JLocale) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      return currencyDisplayName(this.code, locale);
    },
    "getSymbol()Ljava/lang/String;": function (this: JICUCurrency) { return currencySymbol(this.code, usLocale); },
    "getName(Landroid/icu/util/ULocale;I[Z)Ljava/lang/String;": function (this: JICUCurrency, locale: JULocale, style: number, isChoiceFormat: Int8Array | null) {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      if (isChoiceFormat?.length) isChoiceFormat[0] = 0;
      return style === 0 ? currencySymbol(this.code, locale.locale) : currencyDisplayName(this.code, locale.locale);
    },
    "toString()Ljava/lang/String;": function (this: JICUCurrency) { return this.code; },
    "equals(Ljava/lang/Object;)Z": function (this: JICUCurrency, other: unknown) { return other instanceof JICUCurrency && other.code === this.code ? 1 : 0; },
    "hashCode()I": function (this: JICUCurrency) { return stringHash(this.code); },
  },
});
