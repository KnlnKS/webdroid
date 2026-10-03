// libcore's ICU4C natives (libcore.icu.ICU and com.android.icu.*), answered by ICU4J: core-icu4j's
// android.icu bytecode over the reference build's ICU data, where the device runs ICU4C over the
// same data. Each follows what AOSP's C++ computes; the charset and regex natives are separate.

import { rt, driven, type Gen } from "../runtime";
import { vcall, newObj, after, scall } from "./jlang";
import { jarray, mangleField, mangleMethod, mangleStaticField } from "../abi";
import { PLATFORM_DATA } from "../bootclasspath";
import { vfs } from "../../shell/vfs";
import { readFully } from "../../shell/lazyfile";
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
const ICU_DATA = Object.keys(PLATFORM_DATA).find((path) => path.endsWith(".dat"))!;
const icuRead = async (at: number, length: number) => {
  const bytes = await readFully(vfs.source(ICU_DATA)!, at, length);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};
const cString = (view: DataView, at: number) => { let s = ""; for (let c; (c = view.getUint8(at)); at++) s += String.fromCharCode(c); return s; };
/** udata_open: an item of the common data, found in its table of contents, as its header's offset */
async function icuItem(name: string): Promise<number> {
  const header = (await icuRead(0, 2)).getUint16(0, true), first = await icuRead(header, 12), count = first.getUint32(0, true);
  const toc = await icuRead(0, header + first.getUint32(8, true)), path = `${ICU_DATA.slice(ICU_DATA.lastIndexOf("/") + 1, -4)}/${name}`;
  for (let i = 0; i < count; i++)
    if (cString(toc, header + toc.getUint32(header + 4 + 8 * i, true)) === path) return header + toc.getUint32(header + 8 + 8 * i, true);
  throw new Error(`no ${path} in ${ICU_DATA}`);
}
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

/** A resource bundle item read whole (ResB formatVersion 2 or 3, without a pool bundle), its resources
 *  resolved as ICUResourceBundleReader resolves them */
class ResBundle {
  private readonly v: DataView;
  private readonly units: number;
  constructor(bytes: Uint8Array) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.units = this.v.getUint32(8, true) * 4;
    if ((this.v.getUint32(4, true) & 0xff) > 5 && this.v.getUint32(24, true) & 2) throw new Error("a bundle over a pool bundle");
  }
  static async open(item: string): Promise<ResBundle> {
    const at = await icuItem(item), base = at + (await icuRead(at, 2)).getUint16(0, true);
    return new ResBundle(await readFully(vfs.source(ICU_DATA)!, base, (await icuRead(base, 20)).getUint32(16, true) * 4));
  }
  get root(): number { return this.v.getUint32(0, true); }
  private u16 = (at: number) => this.v.getUint16(at, true);
  private i32 = (at: number) => this.v.getInt32(at, true);
  /** a table's value for `key`, or undefined */
  get(table: number, key: string): number | undefined {
    const type = table >>> 28, off = table & 0xfffffff;
    const wide = type === 4, at = type === 5 ? this.units + off * 2 : off * 4;
    if (type !== 2 && type !== 4 && type !== 5) throw new Error(`resource ${table.toString(16)} is no table`);
    if (!off && type !== 5) return undefined;
    const count = wide ? this.i32(at) : this.u16(at), keys = at + (wide ? 4 : 2);
    const values = type === 5 ? keys + 2 * count : wide ? keys + 4 * count : keys + 2 * (count + (~count & 1));
    for (let i = 0; i < count; i++) {
      let k = wide ? this.i32(keys + 4 * i) : this.u16(keys + 2 * i), name = "";
      for (let c; (c = this.v.getUint8(k)); k++) name += String.fromCharCode(c);
      if (name === key) return type === 5 ? 0x60000000 | this.u16(values + 2 * i) : this.v.getUint32(values + 4 * i, true);
    }
    return undefined;
  }
  string(res: number): string {
    const type = res >>> 28, off = res & 0xfffffff;
    let at: number, length: number;
    if (type === 0) { at = off * 4 + 4; length = off ? this.i32(off * 4) : 0; }
    else if (type === 6) {
      at = this.units + off * 2;
      const first = this.u16(at);
      if ((first & 0xfc00) !== 0xdc00) { length = 0; while (this.u16(at + 2 * length)) length++; }
      else if (first < 0xdfef) { length = first & 0x3ff; at += 2; }
      else if (first < 0xdfff) { length = (first - 0xdfef) << 16 | this.u16(at + 2); at += 4; }
      else { length = this.u16(at + 2) << 16 | this.u16(at + 4); at += 6; }
    } else throw new Error(`resource ${res.toString(16)} is no string`);
    let s = "";
    for (let i = 0; i < length; i++) s += String.fromCharCode(this.u16(at + 2 * i));
    return s;
  }
  strings(res: number): string[] {
    const type = res >>> 28, off = res & 0xfffffff;
    if (type === 9) return Array.from({ length: this.u16(this.units + off * 2) }, (_, i) => this.string(0x60000000 | this.u16(this.units + off * 2 + 2 + 2 * i)));
    if (type !== 8) throw new Error(`resource ${res.toString(16)} is no array`);
    return Array.from({ length: off ? this.i32(off * 4) : 0 }, (_, i) => this.string(this.v.getUint32(off * 4 + 4 + 4 * i, true)));
  }
  ints(res: number): Int32Array {
    if (res >>> 28 !== 14) throw new Error(`resource ${res.toString(16)} is no int vector`);
    const off = res & 0xfffffff;
    return Int32Array.from({ length: off ? this.i32(off * 4) : 0 }, (_, i) => this.i32(off * 4 + 4 + 4 * i));
  }
  binary(res: number): Uint8Array {
    if (res >>> 28 !== 1) throw new Error(`resource ${res.toString(16)} is no binary`);
    const off = res & 0xfffffff;
    return off ? new Uint8Array(this.v.buffer, this.v.byteOffset + off * 4 + 4, this.i32(off * 4)).slice() : new Uint8Array(0);
  }
}

/** BytesTrie's walk (android.icu.util.BytesTrie): `next` answers its Result's ordinal (NO_MATCH,
 *  NO_VALUE, FINAL_VALUE, INTERMEDIATE_VALUE) */
class BytesTrie {
  pos = 0;
  remaining = -1;
  constructor(private readonly b: Uint8Array) {}
  state(): [number, number] { return [this.pos, this.remaining]; }
  reset([pos, remaining]: [number, number]): this { this.pos = pos; this.remaining = remaining; return this; }
  private result(pos: number): number { const node = this.b[pos]; return node >= 0x20 ? 2 + (~node & 1) : 1; }
  private stop(): number { this.pos = -1; return 0; }
  next(c: number): number {
    let pos = this.pos;
    if (pos < 0) return 0;
    let length = this.remaining;
    if (length >= 0) {
      if (c !== this.b[pos++]) return this.stop();
      this.remaining = --length; this.pos = pos;
      return length < 0 ? this.result(pos) : 1;
    }
    for (;;) {
      const node = this.b[pos++];
      if (node < 0x10) return this.branch(pos, node, c);
      if (node < 0x20) {
        length = node - 0x10;
        if (c !== this.b[pos++]) return this.stop();
        this.remaining = --length; this.pos = pos;
        return length < 0 ? this.result(pos) : 1;
      }
      if (node & 1) return this.stop();
      pos = this.skipValue(pos, node);
    }
  }
  private branch(pos: number, length: number, c: number): number {
    const b = this.b;
    if (length === 0) length = b[pos++];
    length++;
    while (length > 5) {
      if (c < b[pos++]) { length >>= 1; pos = this.jump(pos); }
      else { length -= length >> 1; const d = b[pos]; pos += d < 0xc0 ? 1 : d < 0xf0 ? 2 : d < 0xfe ? 3 : d === 0xfe ? 4 : 5; }
    }
    do {
      if (c === b[pos++]) {
        const node = b[pos];
        // a final value stays for value() to read; an intermediate one is the delta to the next node
        if (!(node & 1)) { const [delta, at] = this.readValue(pos + 1, node >> 1); pos = at + delta; }
        this.pos = pos;
        return node & 1 ? 2 : this.result(pos);
      }
      length--;
      pos = this.skipValue(pos + 1, b[pos]);
    } while (length > 1);
    if (c !== b[pos++]) return this.stop();
    this.pos = pos;
    return this.result(pos);
  }
  private jump(pos: number): number { const [delta, at] = this.readDelta(pos); return at + delta; }
  private readDelta(pos: number): [number, number] {
    const b = this.b, d = b[pos++];
    if (d < 0xc0) return [d, pos];
    if (d < 0xf0) return [(d - 0xc0) << 8 | b[pos], pos + 1];
    if (d < 0xfe) return [(d - 0xf0) << 16 | b[pos] << 8 | b[pos + 1], pos + 2];
    if (d === 0xfe) return [b[pos] << 16 | b[pos + 1] << 8 | b[pos + 2], pos + 3];
    return [b[pos] << 24 | b[pos + 1] << 16 | b[pos + 2] << 8 | b[pos + 3], pos + 4];
  }
  /** the value after a lead byte's upper 7 bits, and where it ends */
  private readValue(pos: number, lead: number): [number, number] {
    const b = this.b;
    if (lead < 0x51) return [lead - 0x10, pos];
    if (lead < 0x6c) return [(lead - 0x51) << 8 | b[pos], pos + 1];
    if (lead < 0x7e) return [(lead - 0x6c) << 16 | b[pos] << 8 | b[pos + 1], pos + 2];
    if (lead === 0x7e) return [b[pos] << 16 | b[pos + 1] << 8 | b[pos + 2], pos + 3];
    return [b[pos] << 24 | b[pos + 1] << 16 | b[pos + 2] << 8 | b[pos + 3], pos + 4];
  }
  private skipValue(pos: number, lead: number): number {
    return lead < 0xa2 ? pos : lead < 0xd8 ? pos + 1 : lead < 0xfc ? pos + 2 : pos + 3 + (lead >> 1 & 1);
  }
  value(): number { return this.readValue(this.pos + 1, this.b[this.pos] >> 1)[0]; }
}
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
let likely: Likely | null | Promise<Likely | null> | undefined;
/** the table, once this realm has it: a process realm's page promise is another realm's Promise,
 *  which `after` does not wait on */
const likelyData = () => likely !== undefined ? likely : likely = Promise.resolve(pageLikely()).then((d) => likely = d);
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
