// libcore's ICU4C natives (libcore.icu.ICU and com.android.icu.*), answered by ICU4J: core-icu4j's
// android.icu bytecode over the reference build's ICU data, where the device runs ICU4C over the
// same data. Each follows what AOSP's C++ computes; the charset and regex natives are separate.

import { rt, driven, type Gen } from "../runtime";
import { vcall, newObj, after } from "./jlang";
import { jarray, mangleStaticField } from "../abi";

const ULOCALE = "Landroid/icu/util/ULocale;", STRING = "Ljava/lang/String;";

/** an initialized ICU4J class's constructor */
function icuClass(cls: string): unknown {
  const info = rt.link(cls), pending = rt.initClass(info);
  return pending ? pending.then(() => info.ctor) : info.ctor;
}
const icuStatic = (cls: string, name: string, desc: string, ...args: unknown[]) =>
  after(icuClass(cls), (ctor) => vcall(ctor, name, desc, ...args));
const icuStaticField = (cls: string, field: string) => after(icuClass(cls), (ctor) => (ctor as Record<string, unknown>)[mangleStaticField(field)]);
/** ScopedIcuLocale: an ICU locale ID or language tag, as ICU canonicalizes either */
const ulocale = (name: string) => newObj("android/icu/util/ULocale", `(${STRING})V`, name ?? rt.npe());

/** u_versionToString: dotted, without trailing zero fields beyond the minor */
const versionText = driven(function* (version: unknown): Gen<string> {
  const parts: number[] = [];
  for (const part of ["getMajor", "getMinor", "getMilli", "getMicro"]) parts.push(yield vcall(version, part, "()I"));
  while (parts.length > 2 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join(".");
});
const icuVersion = () => after(icuStaticField("android/icu/util/VersionInfo", "ICU_VERSION"), versionText);
const unicodeVersion = () => after(icuStatic("android/icu/lang/UCharacter", "getUnicodeVersion", "()Landroid/icu/util/VersionInfo;"), versionText);
const cldrVersion = () => after(icuStatic("android/icu/util/LocaleData", "getCLDRVersion", "()Landroid/icu/util/VersionInfo;"), versionText);
const names = (cls: string, name: string) => after(icuStatic(cls, name, `()[${STRING}`), (a: string[]) => jarray([...a], STRING));
const ofLocale = (method: string) => (name: string) => after(ulocale(name), (l) => vcall(l, method, `()${STRING}`));
const displayOf = (method: string) => driven(function* (target: string, display: string): Gen {
  return vcall(yield ulocale(target), method, `(${ULOCALE})${STRING}`, yield ulocale(display));
});

const natives: Record<string, Record<string, (...args: never[]) => unknown>> = {
  "libcore/icu/ICU": {
    [`getAvailableLocalesNative()[${STRING}`]: driven(function* (): Gen {
      const locales: unknown[] = yield icuStatic("android/icu/util/ULocale", "getAvailableLocales", `()[${ULOCALE}`);
      const out: string[] = [];
      for (const l of locales) out.push(yield vcall(l, "getName", `()${STRING}`));
      return jarray(out, STRING);
    }),
    [`getCldrVersion()${STRING}`]: cldrVersion,
    [`getDefaultLocale()${STRING}`]: () => after(icuStatic("android/icu/util/ULocale", "getDefault", `()${ULOCALE}`), (l) => vcall(l, "getName", `()${STRING}`)),
    [`getISO3Country(${STRING})${STRING}`]: ofLocale("getISO3Country"),
    [`getISO3Language(${STRING})${STRING}`]: ofLocale("getISO3Language"),
    [`getISOCountriesNative()[${STRING}`]: () => names("android/icu/util/ULocale", "getISOCountries"),
    [`getISOLanguagesNative()[${STRING}`]: () => names("android/icu/util/ULocale", "getISOLanguages"),
    [`getIcuVersion()${STRING}`]: icuVersion,
    [`getScript(${STRING})${STRING}`]: ofLocale("getScript"),
    [`getUnicodeVersion()${STRING}`]: unicodeVersion,
  },
  "com/android/icu/util/Icu4cMetadata": {
    [`getCldrVersion()${STRING}`]: cldrVersion,
    [`getIcuVersion()${STRING}`]: icuVersion,
    [`getTzdbVersion()${STRING}`]: () => icuStatic("android/icu/util/TimeZone", "getTZDataVersion", `()${STRING}`),
    [`getUnicodeVersion()${STRING}`]: unicodeVersion,
  },
  "com/android/icu/util/LocaleNative": {
    [`getDisplayCountryNative(${STRING}${STRING})${STRING}`]: displayOf("getDisplayCountry"),
    [`getDisplayLanguageNative(${STRING}${STRING})${STRING}`]: displayOf("getDisplayLanguage"),
    [`getDisplayScriptNative(${STRING}${STRING})${STRING}`]: displayOf("getDisplayScript"),
    [`getDisplayVariantNative(${STRING}${STRING})${STRING}`]: displayOf("getDisplayVariant"),
    // ICU4C's process default; ICU4J follows java.util.Locale's default by itself
    [`setDefaultNative(${STRING})V`]: () => {},
  },
  "com/android/icu/util/CaseMapperNative": {
    [`toLowerCase(${STRING}${STRING})${STRING}`]: (s: string, tag: string) =>
      after(ulocale(tag), (l) => icuStatic("android/icu/lang/UCharacter", "toLowerCase", `(${ULOCALE}${STRING})${STRING}`, l, s)),
    [`toUpperCase(${STRING}${STRING})${STRING}`]: (s: string, tag: string) =>
      after(ulocale(tag), (l) => icuStatic("android/icu/lang/UCharacter", "toUpperCase", `(${ULOCALE}${STRING})${STRING}`, l, s)),
  },
  "com/android/icu/text/TimeZoneNamesNative": {
    // each row is [id, long standard, short standard, long daylight, short daylight], named as of now
    [`fillZoneStringsNative(${STRING}[[${STRING})V`]: driven(function* (locale: string, rows: string[][]): Gen {
      const zoneNames = yield icuStatic("android/icu/text/TimeZoneNames", "getInstance", `(${ULOCALE})Landroid/icu/text/TimeZoneNames;`, yield ulocale(locale));
      const types = yield icuClass("android/icu/text/TimeZoneNames$NameType"), now = BigInt(Date.now());
      const kinds = ["LONG_STANDARD", "SHORT_STANDARD", "LONG_DAYLIGHT", "SHORT_DAYLIGHT"].map((k) => (types as Record<string, unknown>)[mangleStaticField(k)]);
      for (const row of rows) for (let i = 0; i < kinds.length; i++)
        row[i + 1] = yield vcall(zoneNames, "getDisplayName", `(${STRING}Landroid/icu/text/TimeZoneNames$NameType;J)${STRING}`, row[0], kinds[i], now);
    }),
  },
  // a preload of ICU4C's zone bundles, which ICU4J opens on demand
  "com/android/icu/util/UResourceBundleNative": { "cacheTimeZoneBundles()V": () => {} },
};
for (const [cls, methods] of Object.entries(natives)) for (const [sig, fn] of Object.entries(methods)) rt.registerJni(cls, sig, fn);
