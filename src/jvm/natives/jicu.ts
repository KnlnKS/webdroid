// libcore's ICU4C natives (libcore.icu.ICU and com.android.icu.*), answered by ICU4J: core-icu4j's
// android.icu bytecode over the reference build's ICU data, where the device runs ICU4C over the
// same data. Each follows what AOSP's C++ computes; the charset and regex natives are separate.

import { rt, driven, type Gen } from "../runtime";
import { vcall, newObj, after, scall } from "./jentry";
import { once } from "../suspend";
import { jarray, mangleField, mangleMethod, mangleStaticField } from "../abi";
import { BytesTrie, ResBundle, cString, icuItem, icuRead } from "./icudata";
import { pageShared } from "../../shell/pageshared";

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
function versionString(parts: number[]): string {
  while (parts.length > 2 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join(".");
}
const icuVersion = () => after(icuStaticField("android/icu/util/VersionInfo", "ICU_VERSION"), driven(function* (version: unknown): Gen<string> {
  const parts: number[] = [];
  for (const part of ["getMajor", "getMinor", "getMilli", "getMicro"]) parts.push(yield vcall(version, part, "()I"));
  return versionString(parts);
}));

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

/** LikelySubtags.Data: langInfo's likely-subtags table, decoded once for the page's realms, with its
 *  LSRs kept encoded (LSR.decodeInts) and the script names ICU4J's UScript gave them */
interface Likely {
  languageAliases: Map<string, string>; regionAliases: Map<string, string>; trie: Uint8Array; lsrs: Int32Array; m49: string[];
  und: [number, number]; undZzzz: [number, number]; defaultLsr: number; scripts: Map<number, string>;
}
declare global { interface Window { __wdLikelySubtags?: Promise<Likely | null> } }
const pageLikely = () => pageShared("__wdLikelySubtags", async () => {
  try {
    const bundle = await ResBundle.open("langInfo.res"), table = bundle.get(bundle.root, "likely")!;
    const pairs = (key: string) => {
      const res = bundle.get(table, key), map = new Map<string, string>();
      const a = res === undefined ? [] : bundle.strings(res);
      for (let i = 0; i < a.length; i += 2) map.set(a[i], a[i + 1]);
      return map;
    };
    const trie = bundle.binary(bundle.get(table, "trie")!), walk = new BytesTrie(trie);
    walk.next(42);
    const und = walk.state();
    walk.next(42);
    const undZzzz = walk.state();
    walk.next(42);
    return { languageAliases: pairs("languageAliases"), regionAliases: pairs("regionAliases"), trie, lsrs: bundle.ints(bundle.get(table, "lsrnum")!),
      m49: bundle.strings(bundle.get(table, "m49")!), und, undZzzz, defaultLsr: walk.value(), scripts: new Map() };
  } catch (e) { console.warn("[webdroid] likely subtags unavailable", e); return null; }
});
/** the table, once this realm has it: a process realm's page promise is another realm's Promise,
 *  which neither `once` nor `after` waits on, so this realm awaits it in a Promise of its own */
const likelyData = once(async () => pageLikely());
/** LikelySubtags.trieNext: a subtag's last character is marked with 0x80, an empty one is "*" */
function trieNext(iter: BytesTrie, s: string): number {
  let result: number;
  if (!s) result = iter.next(42);
  else for (let i = 0; ; i++) {
    if (i < s.length - 1) { if (!(iter.next(s.charCodeAt(i)) & 1)) return -1; }
    else { result = iter.next(s.charCodeAt(i) | 0x80); break; }
  }
  return result === 2 ? iter.value() : result === 3 ? 1 : result - 1;
}
/** LSR.CachedDecoder.decode */
function* decodeLsr(d: Likely, encoded: number): Gen<[string, string, string]> {
  if (encoded === 0) return ["", "", ""];
  if (encoded === 1) return ["skip", "script", ""];
  const letter = (i: number, base: number) => String.fromCharCode(i - 1 + base), lsr = encoded & 0xffffff, l = lsr % 19683, r = (lsr / 19683 | 0) % 729, code = encoded >>> 24;
  let script = d.scripts.get(code);
  if (script === undefined) d.scripts.set(code, script = yield icuStatic("android/icu/lang/UScript", "getShortName", `(I)${STRING}`, code));
  return [letter(l % 27, 97) + letter((l / 27 | 0) % 27, 97) + (l / 729 | 0 ? letter(l / 729 | 0, 97) : ""), script!,
    r < 27 ? d.m49[r] : letter(r % 27, 65) + letter((r / 27 | 0) % 27, 65)];
}
/** LikelySubtags.isMacroregion */
function* isMacroregion(region: string): Gen<boolean> {
  const type = yield vcall(yield icuStatic("android/icu/util/Region", "getInstance", `(${STRING})Landroid/icu/util/Region;`, region), "getType", "()Landroid/icu/util/Region$RegionType;");
  for (const macro of ["WORLD", "CONTINENT", "SUBCONTINENT"]) if (type === (yield icuStaticField("android/icu/util/Region$RegionType", macro))) return true;
  return false;
}
/** LikelySubtags.makeMaximizedLsr(language, script, region, "", true) as subtags, "" for each when
 *  nothing matched */
function* maximize(d: Likely, language: string, script: string, region: string): Gen<[string, string, string]> {
  language = d.languageAliases.get(language) ?? language;
  region = d.regionAliases.get(region) ?? region;
  if (language === "und") language = "";
  if (script === "Zzzz") script = "";
  if (region === "ZZ") region = "";
  if (language && script && region) return [language, script, region];
  const iter = new BytesTrie(d.trie);
  let value = trieNext(iter, language), state: [number, number] | null = null, retainScript: boolean, retainRegion = false, matchRegion = false;
  const matchLanguage = value >= 0, matchScript = value >= 0 && script !== "", retainLanguage = value < 0 || language !== "";
  if (value >= 0) state = iter.state();
  else iter.reset(d.und);
  if (value > 0) {
    if (value === 1) value = 0;
    retainScript = script !== "";
  } else if ((value = trieNext(iter, script)) >= 0) {
    retainScript = script !== "";
    state = iter.state();
  } else {
    retainScript = true;
    if (!state) iter.reset(d.undZzzz);
    else { value = trieNext(iter.reset(state), ""); state = iter.state(); }
  }
  if (value > 0) retainRegion = region !== "";
  else if ((value = trieNext(iter, region)) >= 0) {
    if (region && !(yield* isMacroregion(region))) retainRegion = matchRegion = true;
  } else {
    retainRegion = true;
    value = state ? trieNext(iter.reset(state), "") : d.defaultLsr;
  }
  if (!matchLanguage && !matchScript && !(matchRegion && !language)) return ["", "", ""];
  const lsr = yield* decodeLsr(d, d.lsrs[value]);
  if (!retainLanguage && !retainScript && !retainRegion) return lsr;
  return [retainLanguage ? language || "und" : lsr[0], retainScript ? script : lsr[1], retainRegion ? region : lsr[2]];
}
const LOCALE_ID = mangleField("android/icu/util/ULocale", "localeID"), U = "android/icu/util/ULocale";
// §4.7: ULocale.addLikelySubtags over the page's decoded table, so no realm decodes LikelySubtags.Data
// in Java (Typeface.<clinit>: first realm 88 -> 75 ms warm, a process realm 61-109 -> 17-21 ms);
// tests/intrinsics.test.ts compares it with the AOSP body
rt.intrinsic(U, {
  [`static addLikelySubtags(${ULOCALE})${ULOCALE}`]: (base) => function (this: unknown, loc: Record<string, string> | null) {
    if (loc === null) return base.call(this, loc);
    return after(likelyData(), driven(function* (d: Likely | null): Gen {
      if (!d) return yield base.call(null, loc);
      const id = loc[LOCALE_ID], at: number = yield scall(U, "parseTagString", `(${STRING}[${STRING})I`, id, jarray([null, null, null], STRING));
      // makeMaximizedLsrFrom's locale: its name never starts "@x=" and its variant is unread when
      // the input is returned unmatched
      const plain = yield newObj(U, `(${STRING}${STRING}${STRING})V`, yield vcall(loc, "getLanguage", `()${STRING}`),
        yield vcall(loc, "getScript", `()${STRING}`), yield vcall(loc, "getCountry", `()${STRING}`));
      const [language, script, region] = [yield vcall(plain, "getLanguage", `()${STRING}`), yield vcall(plain, "getScript", `()${STRING}`), yield vcall(plain, "getCountry", `()${STRING}`)];
      let lsr = yield* maximize(d, language, script, region);
      if (!lsr[0] && !lsr[1] && !lsr[2]) lsr = [language, script, region];
      const tag = yield scall(U, "createTagString", `(${STRING}${STRING}${STRING}${STRING})${STRING}`, ...lsr, at < id.length ? id.substring(at) : null);
      return tag === null ? loc : yield newObj(U, `(${STRING})V`, tag);
    }));
  },
});
const names = (cls: string, name: string) => after(icuStatic(cls, name, `()[${STRING}`), (a: string[]) => jarray([...a], STRING));
const ofLocale = (method: string) => (name: string) => after(ulocale(name), (l) => vcall(l, method, `()${STRING}`));
const displayOf = (method: string) => driven(function* (target: string, display: string): Gen {
  return vcall(yield ulocale(target), method, `(${ULOCALE})${STRING}`, yield ulocale(display));
});

/** a static of ICU4J's UCharacter, the counterpart of an ICU4C property call, called directly once
 *  its class is initialized */
export function uchar(name: string, desc: string): (...args: unknown[]) => unknown {
  let fn: ((...a: unknown[]) => unknown) | null = null;
  return (...args: unknown[]) => fn ? fn(...args) : after(icuClass("android/icu/lang/UCharacter"),
    (ctor) => (fn = (...a: unknown[]) => (ctor as Record<string, (...a: unknown[]) => unknown>)[mangleMethod(name, desc)](...a))(...args));
}
/** java_lang_Character.cpp: each native is one ICU4C property call, answered by UCharacter. ASCII,
 *  whose properties are fixed, is answered without it for the predicates text loops call. */
function characterNatives(): Record<string, (...args: never[]) => unknown> {
  const upper = (c: number) => c >= 65 && c <= 90, lower = (c: number) => c >= 97 && c <= 122, digit = (c: number) => c >= 48 && c <= 57;
  const ascii = (test: (c: number) => boolean, name: string) => {
    const icu = uchar(name, "(I)Z");
    return (c: number) => (c < 128 ? +test(c) : icu(c));
  };
  const hasProperty = uchar("hasBinaryProperty", "(II)Z"), numeric = uchar("getUnicodeNumericValue", "(I)D"), charName = uchar("getName", "(I)Ljava/lang/String;");
  return {
    "isDigitImpl(I)Z": ascii(digit, "isDigit"),
    "isLetterImpl(I)Z": ascii((c) => upper(c) || lower(c), "isLetter"),
    "isLetterOrDigitImpl(I)Z": ascii((c) => upper(c) || lower(c) || digit(c), "isLetterOrDigit"),
    "isUpperCaseImpl(I)Z": ascii(upper, "isUpperCase"),
    "isLowerCaseImpl(I)Z": ascii(lower, "isLowerCase"),
    "isTitleCaseImpl(I)Z": uchar("isTitleCase", "(I)Z"),
    "isDefinedImpl(I)Z": uchar("isDefined", "(I)Z"),
    "isIdentifierIgnorableImpl(I)Z": uchar("isIdentifierIgnorable", "(I)Z"),
    "isSpaceCharImpl(I)Z": uchar("isSpaceChar", "(I)Z"),
    "isWhitespaceImpl(I)Z": uchar("isWhitespace", "(I)Z"),
    "isMirroredImpl(I)Z": uchar("isMirrored", "(I)Z"),
    "isUnicodeIdentifierStartImpl(I)Z": uchar("isUnicodeIdentifierStart", "(I)Z"),
    "isUnicodeIdentifierPartImpl(I)Z": uchar("isUnicodeIdentifierPart", "(I)Z"),
    // UProperty.ALPHABETIC and IDEOGRAPHIC
    "isAlphabeticImpl(I)Z": (c: number) => hasProperty(c, 0),
    "isIdeographicImpl(I)Z": (c: number) => hasProperty(c, 17),
    "getTypeImpl(I)I": uchar("getType", "(I)I"),
    "getDirectionalityImpl(I)B": uchar("getDirection", "(I)I"),
    "digitImpl(II)I": uchar("digit", "(II)I"),
    "toLowerCaseImpl(I)I": uchar("toLowerCase", "(I)I"),
    "toUpperCaseImpl(I)I": uchar("toUpperCase", "(I)I"),
    "toTitleCaseImpl(I)I": uchar("toTitleCase", "(I)I"),
    // U_NO_NUMERIC_VALUE is -1; a value that is negative or not an integer is -2
    "getNumericValueImpl(I)I": (c: number) => after(numeric(c) as number | Promise<number>, (v: number) => v === -123456789 ? -1 : v < 0 || Math.floor(v + 0.5) !== v ? -2 : v | 0),
    "getNameImpl(I)Ljava/lang/String;": charName,
    "codePointOfImpl(Ljava/lang/String;)I": uchar("getCharFromName", "(Ljava/lang/String;)I"),
  };
}

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
  "java/lang/Character": characterNatives(),
};
for (const [cls, methods] of Object.entries(natives)) rt.registerJnis(cls, methods);
