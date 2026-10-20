// libcore's ICU4C natives (libcore.icu.ICU and com.android.icu.*), answered by ICU4J: core-icu4j's
// android.icu bytecode over the reference build's ICU data, where the device runs ICU4C over the
// same data. Each follows what AOSP's C++ computes; the charset and regex natives are separate.

import { rt, driven, waits, type Gen } from "../runtime.ts";
import { vcall, newObj, after, scall, staticField, linkInit } from "./jentry.ts";
import type { JavaClass } from "../tier.ts";
import { jarray } from "../abi.ts";
import { cString, icuItem, icuRead } from "./icudata.ts";

const ULOCALE = "Landroid/icu/util/ULocale;", STRING = "Ljava/lang/String;";

/** ScopedIcuLocale: an ICU locale ID or language tag, as ICU canonicalizes either */
const ulocale = (name: string) => newObj("android/icu/util/ULocale", `(${STRING})V`, name ?? rt.npe());

/** u_versionToString: dotted, without trailing zero fields beyond the minor */
function versionString(parts: number[]): string {
  while (parts.length > 2 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join(".");
}
const icuVersion = waits(() => after(staticField("android/icu/util/VersionInfo", "ICU_VERSION"), driven(function* (version: unknown): Gen<string> {
  const parts: number[] = [];
  for (const part of ["getMajor", "getMinor", "getMilli", "getMicro"]) parts.push(yield vcall(version, part, "()I"));
  return versionString(parts);
})));

// The Unicode and CLDR versions are read from the ICU data as ICU4C reads them: System.<clinit> asks
// before its properties exist, and ICU4J's data loader reads System properties.
/** ures_getStringByKey on a bundle's root table (a URES_TABLE of URES_STRING_V2 values) */
async function icuRootString(item: string, key: string): Promise<string> {
  const at = await icuItem(item), base = at + (await icuRead(at, 2)).getUint16(0, true), indexes = await icuRead(base, 12);
  const root = indexes.getUint32(0, true), keysTop = indexes.getUint32(8, true) * 4, keys = await icuRead(base, keysTop);
  const table = base + (root & 0xfffffff) * 4, count = (await icuRead(table, 2)).getUint16(0, true), entries = await icuRead(table, 4 + 8 * count);
  for (let i = 0; i < count && root >>> 28 === 2; i++) {
    if (cString(keys, entries.getUint16(2 + 2 * i, true)) !== key) continue;
    const value = entries.getUint32(2 + 2 * (count + (~count & 1)) + 4 * i, true);
    if (value >>> 28 !== 6) break;
    // a short string's units run to a NUL; a longer one's start with a length unit (>= 0xdc00)
    const units = await icuRead(base + keysTop + (value & 0xfffffff) * 2, 64);
    let s = "";
    for (let k = 0, c; k < 32 && (c = units.getUint16(2 * k, true)) && c < 0xdc00; k++) s += String.fromCharCode(c);
    return s;
  }
  throw new Error(`no string ${key} in ${item}`);
}
/** uprops.icu's UDataInfo.dataVersion is the Unicode version */
const unicodeVersion = async () => {
  const info = await icuRead(await icuItem("uprops.icu") + 20, 4);
  return versionString([0, 1, 2, 3].map((k) => info.getUint8(k)));
};
/** ulocdata_getCLDRVersion: supplementalData's cldrVersion */
const cldrVersion = async () => versionString(Object.assign([0, 0, 0, 0], (await icuRootString("supplementalData.res", "cldrVersion")).split(".").map(Number)));

const names = (cls: string, name: string) => after(scall(cls, name, `()[${STRING}`), (a: string[]) => jarray([...a], STRING));
const ofLocale = (method: string) => (name: string) => after(ulocale(name), (l) => vcall(l, method, `()${STRING}`));
const displayOf = (method: string) => driven(function* (target: string, display: string): Gen {
  return vcall(yield ulocale(target), method, `(${ULOCALE})${STRING}`, yield ulocale(display));
});

/** a static of ICU4J's UCharacter, the counterpart of an ICU4C property call, called directly once
 *  its class is initialized */
export function uchar(name: string, desc: string): (...args: unknown[]) => unknown {
  let fn: ((...a: unknown[]) => unknown) | null = null;
  return (...args: unknown[]) => fn ? fn(...args) : after(linkInit("android/icu/lang/UCharacter"),
    (ucharacter) => (fn = ucharacter.call(name, desc))(...args));
}

const natives: Record<string, Record<string, (...args: never[]) => unknown>> = {
  "libcore/icu/ICU": {
    [`getAvailableLocalesNative()[${STRING}`]: driven(function* (): Gen {
      const locales: unknown[] = yield scall("android/icu/util/ULocale", "getAvailableLocales", `()[${ULOCALE}`);
      const out: string[] = [];
      for (const l of locales) out.push(yield vcall(l, "getName", `()${STRING}`));
      return jarray(out, STRING);
    }),
    [`getCldrVersion()${STRING}`]: cldrVersion,
    [`getDefaultLocale()${STRING}`]: () => after(scall("android/icu/util/ULocale", "getDefault", `()${ULOCALE}`), (l) => vcall(l, "getName", `()${STRING}`)),
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
    [`getTzdbVersion()${STRING}`]: () => scall("android/icu/util/TimeZone", "getTZDataVersion", `()${STRING}`),
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
      after(ulocale(tag), (l) => scall("android/icu/lang/UCharacter", "toLowerCase", `(${ULOCALE}${STRING})${STRING}`, l, s)),
    [`toUpperCase(${STRING}${STRING})${STRING}`]: (s: string, tag: string) =>
      after(ulocale(tag), (l) => scall("android/icu/lang/UCharacter", "toUpperCase", `(${ULOCALE}${STRING})${STRING}`, l, s)),
  },
  "com/android/icu/text/TimeZoneNamesNative": {
    // each row is [id, long standard, short standard, long daylight, short daylight], named as of now
    [`fillZoneStringsNative(${STRING}[[${STRING})V`]: driven(function* (locale: string, rows: string[][]): Gen {
      const zoneNames = yield scall("android/icu/text/TimeZoneNames", "getInstance", `(${ULOCALE})Landroid/icu/text/TimeZoneNames;`, yield ulocale(locale));
      const types = yield linkInit("android/icu/text/TimeZoneNames$NameType"), now = BigInt(Date.now());
      const kinds = ["LONG_STANDARD", "SHORT_STANDARD", "LONG_DAYLIGHT", "SHORT_DAYLIGHT"].map((k) => (types as JavaClass).static(k));
      for (const row of rows) for (let i = 0; i < kinds.length; i++)
        row[i + 1] = yield vcall(zoneNames, "getDisplayName", `(${STRING}Landroid/icu/text/TimeZoneNames$NameType;J)${STRING}`, row[0], kinds[i], now);
    }),
  },
  // a preload of ICU4C's zone bundles, which ICU4J opens on demand
  "com/android/icu/util/UResourceBundleNative": { "cacheTimeZoneBundles()V": () => {} },
};
for (const [cls, methods] of Object.entries(natives)) rt.registerJnis(cls, methods);
