// The native halves of android.content.res: ApkAssets, AssetManager, XmlBlock and StringBlock, as
// libandroidfw answers them (ApkAssets, AssetManager2, Theme, AttributeResolution, ResXMLParser).
// The AssetManager handle is a Resources (res.ts), the AssetManager2.
//
// AOSP's TypedArray is a flat int[] in STYLE_NUM_ENTRIES layout that applyStyle fills and every
// getX() reads back, strings included: a string is (TYPE_STRING, pool index, cookie), read from
// the XML block's pool for cookie -1 and from ApkAssets[cookie - 1]'s table pool otherwise.

import { awaited, rt, driven, declaredField, getDeclared, setDeclared, type Gen } from "../jvm/runtime.ts";
import { handle, deref, release, FINALIZER } from "./handles.ts";
import { newObj, vcall } from "../jvm/natives/jentry.ts";
import { i8, u8, jarray } from "../jvm/abi.ts";
import {
  Resources, NativeTheme, type Apk, type SV, newSV, emptyApk, resolveAttributes, STYLE_NUM_ENTRIES,
} from "./res.ts";
import { TV, XE, parseAXMLDoc, StringPool, type XmlDoc, type XmlEvent, type XmlNode } from "./axml.ts";
import { qualifiers } from "./arsc.ts";
import { deviceQualifiers } from "./configuration.ts";
import { packages } from "./packages.ts";
import { appHost } from "./apphost.ts";
import { mkPfd } from "./os.ts";
import { BytesFile, readFully, type FileSource } from "../shell/lazyfile.ts";
import { apkPath } from "../shell/vfs.ts";

const delegate = rt.registerJnis.bind(rt);

// ── ApkAssets ───────────────────────────────────────────────────────────────────────────
// An apk is one the package registry installed: the framework's at its device path, an app's at
// the path PackageManager reports. The registry's record owns the table and the archive.

/** ApkAssets.PROPERTY_SYSTEM */
const PROPERTY_SYSTEM = 1;
/** an ApkAssets: the apk as loaded from the registry's `origin` (null for one never installed) */
interface ApkN extends Apk { path: string; origin: Apk | null; system: boolean; strings: bigint }
/** a split of the running app's: its table and entries are merged into the base's (shell/install.ts),
 *  so the ApkAssets ResourcesManager loads for its path adds nothing of its own */
const SPLIT = emptyApk();
/** the apk installed at `path`, as ApkAssets loads it */
function apkAt(path: string): Apk | null {
  for (const record of packages.values()) if (record.path === path) return record.apk;
  return appHost?.splits.some((name) => apkPath(name) === path) ? SPLIT : null;
}
const apkN = (h: bigint) => deref<ApkN>(h);
function loadApk(path: string, flags: number): bigint {
  const apk = apkAt(path);
  if (!apk) throw rt.mkThrowable("java/io/IOException", "Failed to load asset path " + path);
  return handle({ ...apk, path, origin: apk, system: (flags & PROPERTY_SYSTEM) !== 0, strings: 0n } satisfies ApkN);
}
/** the apks behind an AssetManager */
const apksOf = (res: Resources) => res.apks as ApkN[];
/** an archive entry's bytes, when they are in memory */
const entryBytes = (apk: Apk, path: string): Uint8Array | null => apk.zip[path] ?? apk.table?.files(path) ?? null;
function entrySource(apk: Apk, path: string): FileSource | null {
  const bytes = entryBytes(apk, path);
  return bytes ? new BytesFile(bytes) : apk.lazyEntries.get(path) ?? null;
}
/** AssetManager2::OpenNonAsset: the apk a cookie names, else the last apk holding the path */
function findEntry(res: Resources, path: string, cookie = 0): { apk: Apk; source: FileSource } | null {
  const apks = apksOf(res);
  const pick = (apk: Apk | undefined) => { const source = apk && entrySource(apk, path); return source ? { apk: apk!, source } : null; };
  if (cookie > 0) return pick(apks[cookie - 1]);
  for (let i = apks.length - 1; i >= 0; i--) { const hit = pick(apks[i]); if (hit) return hit; }
  return null;
}
/** AssetManager2::Open: assets/`path` from the last apk holding it */
export const assetEntry = (res: Resources, path: string): FileSource | null => findEntry(res, "assets/" + path)?.source ?? null;
/** AssetManager2::OpenDir: the names directly under assets/`dir` in every apk, sorted, each true
 *  for a regular file and false for a directory; a later apk's entry replaces an earlier one's */
export function assetDir(res: Resources, dir: string): [name: string, regular: boolean][] {
  const path = "assets/" + dir, prefix = path.endsWith("/") ? path : path + "/", names = new Map<string, boolean>();
  for (const apk of apksOf(res)) for (const entry of [...Object.keys(apk.zip), ...apk.lazyEntries.keys()]) {
    if (!entry.startsWith(prefix) || entry.length === prefix.length) continue;
    const slash = entry.indexOf("/", prefix.length);
    names.set(entry.slice(prefix.length, slash < 0 ? undefined : slash), slash < 0);
  }
  return [...names].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

delegate("android/content/res/ApkAssets", {
  "nativeLoad(ILjava/lang/String;ILandroid/content/res/loader/AssetsProvider;)J": (_format: number, path: string, flags: number) => loadApk(path, flags),
  "nativeLoadEmpty(ILandroid/content/res/loader/AssetsProvider;)J": (flags: number) =>
    handle({ ...emptyApk(), path: "empty", origin: null, system: (flags & PROPERTY_SYSTEM) !== 0, strings: 0n } satisfies ApkN),
  // a descriptor is served by the path it was opened from; one with no installed apk behind it
  // fails as a device fails an unreadable one
  "nativeLoadFd(ILjava/io/FileDescriptor;Ljava/lang/String;ILandroid/content/res/loader/AssetsProvider;)J":
    (_format: number, _fd: unknown, name: string, flags: number) => loadApk(name, flags),
  "nativeLoadFdOffsets(ILjava/io/FileDescriptor;Ljava/lang/String;JJILandroid/content/res/loader/AssetsProvider;)J":
    (_format: number, _fd: unknown, name: string, _off: bigint, _len: bigint, flags: number) => loadApk(name, flags),
  "nativeDestroy(J)V": release,
  "nativeGetAssetPath(J)Ljava/lang/String;": (h: bigint) => apkN(h).path,
  "nativeGetDebugName(J)Ljava/lang/String;": (h: bigint) => apkN(h).path,
  "nativeGetStringBlock(J)J": (h: bigint) => {
    const apk = apkN(h);
    return apk.strings || (apk.strings = apk.table?.values ? handle(apk.table.values) : 0n);
  },
  // stale once the registry holds another apk at its path, as a reinstall replaces it
  "nativeIsUpToDate(J)Z": (h: bigint) => { const apk = apkN(h); return +(apk.origin === null || apkAt(apk.path) === apk.origin); },
  "nativeOpenXml(JLjava/lang/String;)J": driven(function* (h: bigint, path: string): Gen {
    const source = entrySource(apkN(h), path);
    if (!source) throw rt.mkThrowable("java/io/FileNotFoundException", path);
    return handle(mkBlock(yield* awaited(readFully(source)), null));
  }),
  "nativeDefinesOverlayable(J)Z": (h: bigint) => (apkN(h).table?.overlayables.size ? 1 : 0),
  "nativeGetOverlayableInfo(JLjava/lang/String;)Landroid/content/om/OverlayableInfo;": (h: bigint, name: string) => {
    for (const named of apkN(h).table?.overlayables.values() ?? []) {
      const actor = named.get(name);
      if (actor !== undefined) return newObj("android/content/om/OverlayableInfo", "(Ljava/lang/String;Ljava/lang/String;)V", name, actor);
    }
    return null;
  },
});

// ── StringBlock / XmlBlock ─────────────────────────────────────────────────────────────
// XmlBlock is a pull parser whose accessors return string-pool indices into the block's own pool;
// XmlBlock$Parser resolves them. -1 is null for a name or a text, "" for a namespace.

interface Block { doc: XmlDoc; res: Resources | null; strings: bigint }
/** the parse cursor. It IS an AttributeSet: AOSP passes XmlBlock.Parser.mParseState to
 *  applyStyle, which reads the element off `node`. */
class ParseState {
  readonly blk: Block; readonly sourceResId: number;
  pos = 0;
  node: XmlNode | null = null;
  constructor(blk: Block, sourceResId: number) { this.blk = blk; this.sourceResId = sourceResId; }
  get ev(): XmlEvent { return this.blk.doc.events[this.pos]; }
}
const block = (h: bigint) => deref<Block>(h);
const state = (h: bigint) => deref<ParseState>(h);
const mkBlock = (bytes: Uint8Array, res: Resources | null): Block => ({ doc: parseAXMLDoc(bytes, true), res, strings: 0n });
/** the raw string value of the attribute the element named as its id or class, or -1 */
const namedRaw = (h: bigint, which: "idIdx" | "classIdx") => {
  const ev = state(h).ev, i = ev[which];
  return i < 0 ? -1 : ev.raw![i * 3 + 2];
};
/** the parse state's current start tag, whose attributes are the only ones a parser reports */
const startTag = (h: bigint) => { const ev = state(h).ev; return ev.type === XE.START_TAG ? ev.node : null; };

delegate("android/content/res/StringBlock", {
  "nativeCreate([BII)J": (b: Int8Array, off: number, len: number) =>
    handle(new StringPool(new DataView(b.buffer, b.byteOffset + off, len), 0)),
  "nativeDestroy(J)V": release,
  "nativeGetSize(J)I": (h: bigint) => deref<StringPool>(h).length,
  "nativeGetString(JI)Ljava/lang/String;": (h: bigint, i: number) => deref<StringPool>(h).at(i) ?? null,
  "nativeGetStyle(JI)[I": (h: bigint, i: number) => deref<StringPool>(h).styleOf(i),
});

delegate("android/content/res/XmlBlock", {
  "nativeCreate([BII)J": (b: Int8Array, off: number, len: number) => handle(mkBlock(u8(b, off, len), null)),
  "nativeDestroy(J)V": release,
  "nativeGetStringBlock(J)J": (h: bigint) => {
    const b = block(h);
    return b.strings || (b.strings = handle(b.doc.pool));
  },
  "nativeCreateParseState(JI)J": (h: bigint, sourceResId: number) => handle(new ParseState(block(h), sourceResId)),
  "nativeDestroyParseState(J)V": release,
  "nativeGetSourceResId(J)I": (h: bigint) => state(h).sourceResId,

  // the cursor starts on START_DOCUMENT, which XmlBlock$Parser reports itself before it ever
  // calls in; every next() from there returns the following event
  "nativeNext(J)I": (h: bigint) => {
    const st = state(h);
    if (st.pos < st.blk.doc.events.length - 1) st.pos++;
    const ev = st.ev;
    st.node = ev.type === XE.START_TAG ? ev.node : null;
    return ev.type;
  },
  "nativeGetName(J)I": (h: bigint) => (state(h).ev.type === XE.START_TAG || state(h).ev.type === XE.END_TAG ? state(h).ev.nameIdx : -1),
  "nativeGetNamespace(J)I": (h: bigint) => state(h).ev.nsIdx,
  "nativeGetText(J)I": (h: bigint) => (state(h).ev.type === XE.TEXT ? state(h).ev.nameIdx : -1),
  "nativeGetLineNumber(J)I": (h: bigint) => state(h).ev.line,

  "nativeGetAttributeCount(J)I": (h: bigint) => (state(h).ev.raw?.length ?? 0) / 3,
  "nativeGetAttributeNamespace(JI)I": (h: bigint, i: number) => state(h).ev.raw?.[i * 3] ?? -1,
  "nativeGetAttributeName(JI)I": (h: bigint, i: number) => state(h).ev.raw?.[i * 3 + 1] ?? -1,
  "nativeGetAttributeStringValue(JI)I": (h: bigint, i: number) => state(h).ev.raw?.[i * 3 + 2] ?? -1,
  "nativeGetAttributeResource(JI)I": (h: bigint, i: number) => startTag(h)?.attrs[i]?.resId ?? 0,
  "nativeGetAttributeDataType(JI)I": (h: bigint, i: number) => startTag(h)?.attrs[i]?.type ?? TV.NULL,
  "nativeGetAttributeData(JI)I": (h: bigint, i: number) => startTag(h)?.attrs[i]?.data ?? 0,
  // ResXMLParser::indexOfAttribute: a null namespace matches only attributes without one
  "nativeGetAttributeIndex(JLjava/lang/String;Ljava/lang/String;)I": (h: bigint, ns: string | null, name: string) => {
    const attrs = startTag(h)?.attrs;
    if (attrs && name != null) for (let i = 0; i < attrs.length; i++) if (attrs[i].name === name && attrs[i].ns === (ns ?? "")) return i;
    return -1;
  },
  // id and class are the raw string value of the attribute the element pointed at; style is
  // its resource id, and 0 unless it is one
  "nativeGetIdAttribute(J)I": (h: bigint) => namedRaw(h, "idIdx"),
  "nativeGetClassAttribute(J)I": (h: bigint) => namedRaw(h, "classIdx"),
  "nativeGetStyleAttribute(J)I": (h: bigint) => {
    const ev = state(h).ev;
    const a = ev.node?.attrs[ev.styleIdx];
    return a && (a.type === TV.REFERENCE || a.type === TV.ATTRIBUTE) ? a.data : 0;
  },
});

// ── AssetManager ────────────────────────────────────────────────────────────────────────

const assets = (h: bigint) => deref<Resources>(h);
let liveAssetManagers = 0, liveAssets = 0;

type TypedValueLike = Record<string, unknown>;
const TV_FIELDS = ["type", "assetCookie", "data", "string", "resourceId", "changingConfigurations", "density"] as const;
let tvKeys: string[] | null = null;
/** CopyValue: a selected value into the caller's TypedValue, returning its cookie; the Java side
 *  reads a string out of the cookie's pool */
function copyValue(res: Resources, v: SV, tv: TypedValueLike): number {
  const cookie = res.cookieOf(v.pkg);
  const k = tvKeys ??= TV_FIELDS.map((f) => declaredField("android/util/TypedValue", f));
  tv[k[0]] = v.t; tv[k[1]] = cookie; tv[k[2]] = v.d; tv[k[3]] = null;
  tv[k[4]] = v.resid; tv[k[5]] = v.flags; tv[k[6]] = v.density;
  return cookie;
}
const SVAL = newSV();
/** a bag entry as a selected value (SelectedValue(bag, entry)), resolved */
function bagValue(res: Resources, id: number, i: number): SV {
  const bag = res.bag(id)!;
  SVAL.t = bag.types[i]; SVAL.d = bag.data[i]; SVAL.pkg = bag.styles[i] >>> 24; SVAL.flags = bag.flags; SVAL.resid = 0; SVAL.density = 0;
  res.resolveReference(SVAL);
  return SVAL;
}
/** a resource's package, type and entry name, or null when it names nothing */
function resourceName(res: Resources, id: number): [string, string, string] | null {
  const table = res.tbl(id), entry = res.entry(id);
  return entry ? [table!.packageName(id >>> 24) ?? "", table!.typeName((id >> 16) & 0xff, id & 0xffff, id >>> 24, res.qualifiers), entry.key] : null;
}
/** AssetManager2::GetResourceId over "[package:][type/]entry": packages in load order, the
 *  framework's first when no package is named */
function resourceId(res: Resources, name: string, defType: string | null, defPkg: string | null): number {
  let pkg = "", type = "", start = name.startsWith("@") ? 1 : 0, sawPkg = false, sawType = false;
  for (let i = start; i < name.length; i++) {
    if (!type && name[i] === "/") { sawType = true; type = name.slice(start, i); start = i + 1; }
    else if (!pkg && name[i] === ":") { sawPkg = true; pkg = name.slice(start, i); start = i + 1; }
  }
  const entry = name.slice(start);
  if ((sawPkg && !pkg) || (sawType && !type) || !entry) return 0;
  pkg ||= defPkg ?? ""; type ||= defType ?? "";
  if (!type) return 0;
  for (const apk of apksOf(res)) {
    const table = apk.table;
    if (!table) continue;
    for (const id of table.packageIds()) {
      if (pkg && table.packageName(id) !== pkg) continue;
      const found = table.findId(type, entry, id, res.qualifiers) || (type === "attr" ? table.findId("^attr-private", entry, id, res.qualifiers) : 0);
      if (found) return found;
    }
  }
  return 0;
}
/** the locales the tables hold resources for, as BCP-47 tags */
function localesOf(res: Resources, excludeSystem: boolean): string[] {
  const out = new Set<string>();
  for (const apk of apksOf(res)) if (!(excludeSystem && apk.system)) for (const l of apk.table?.locales ?? []) out.add(l);
  return [...out];
}
delegate("android/content/res/AssetManager", {
  "nativeCreate()J": () => { liveAssetManagers++; return handle(new Resources([], deviceQualifiers())); },
  "nativeDestroy(J)V": (h: bigint) => { liveAssetManagers--; release(h); },
  "getGlobalAssetManagerCount()I": () => liveAssetManagers,
  "getGlobalAssetCount()I": () => liveAssets,
  // Asset::getAssetAllocations lists nothing when no asset is open
  "getAssetAllocations()Ljava/lang/String;": () => null,
  "nativeSetApkAssets(J[Landroid/content/res/ApkAssets;ZZ)V": (h: bigint, apkAssets: (Record<string, bigint> | null)[]) => {
    assets(h).setApks(apkAssets.map((a, i) => {
      if (!a) throw rt.mkThrowable("java/lang/NullPointerException", `ApkAssets at index ${i} is null`);
      return apkN(getDeclared(a, "android/content/res/ApkAssets", "mNativePtr"));
    }));
  },
  "nativeSetConfiguration(JIILjava/lang/String;[Ljava/lang/String;IIIIIIIIIIIIIIIIZ)V": (
    h: bigint, _mcc: number, _mnc: number, locale: string | null, _locales: unknown, orientation: number, _touch: number, density: number,
    _kb: number, _kbh: number, _nav: number, _sw: number, _sh: number, swdp: number, wdp: number, hdp: number, screenLayout: number,
    uiMode: number, _colorMode: number, _gender: number, sdk: number,
  ) => assets(h).configure(qualifiers(locale, orientation, density, swdp, wdp, hdp, screenLayout, uiMode, sdk)),
  "nativeContainsAllocatedTable(J)Z": () => 0,
  "nativeGetAssignedPackageIdentifiers(JZZ)Landroid/util/SparseArray;": driven(function* (h: bigint): Gen {
    const out = yield newObj("android/util/SparseArray", "()V");
    for (const apk of apksOf(assets(h))) for (const id of apk.table?.packageIds() ?? []) {
      yield vcall(out, "put", "(ILjava/lang/Object;)V", id, apk.table!.packageName(id) ?? "");
    }
    return out;
  }),
  "nativeGetLocales(JZ)[Ljava/lang/String;": (h: bigint, excludeSystem: number) => jarray(localesOf(assets(h), !!excludeSystem), "Ljava/lang/String;"),

  "nativeGetResourceValue(JISLandroid/util/TypedValue;Z)I": (h: bigint, id: number, density: number, tv: TypedValueLike, resolve: number) => {
    const res = assets(h), v = SVAL;
    if (!res.getResource(id, false, v, density)) return -1;
    if (resolve && !res.resolveReference(v)) return -1;
    return copyValue(res, v, tv);
  },
  "nativeGetResourceBagValue(JIILandroid/util/TypedValue;)I": (h: bigint, id: number, key: number, tv: TypedValueLike) => {
    const res = assets(h), i = res.bag(id)?.find(key) ?? -1;
    if (i < 0) return -1;
    const v = bagValue(res, id, i);
    return copyValue(res, v, tv);
  },
  "nativeGetStyleAttributes(JI)[I": (h: bigint, id: number) => { const bag = assets(h).bag(id); return bag ? bag.keys.slice() : null; },
  "nativeGetResourceArraySize(JI)I": (h: bigint, id: number) => assets(h).bag(id)?.keys.length ?? -1,
  "nativeGetResourceArray(JI[I)I": (h: bigint, id: number, out: Int32Array) => {
    const res = assets(h), n = res.bag(id)?.keys.length ?? -1;
    if (n < 0) return -1;
    if (out.length < n * STYLE_NUM_ENTRIES) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Input array is not large enough");
    for (let i = 0; i < n; i++) {
      const v = bagValue(res, id, i), at = i * STYLE_NUM_ENTRIES;
      if (v.t === TV.REFERENCE && v.d === 0) { v.t = TV.NULL; v.d = 0; }
      out[at] = v.t; out[at + 1] = v.d; out[at + 2] = res.cookieOf(v.pkg); out[at + 3] = v.resid; out[at + 4] = v.flags; out[at + 5] = v.density;
    }
    return n;
  },
  "nativeGetResourceIntArray(JI)[I": (h: bigint, id: number) => {
    const res = assets(h), n = res.bag(id)?.keys.length ?? -1;
    if (n < 0) return null;
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) { const v = bagValue(res, id, i); if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4) out[i] = v.d; }
    return out;
  },
  "nativeGetResourceStringArray(JI)[Ljava/lang/String;": (h: bigint, id: number) => {
    const res = assets(h), n = res.bag(id)?.keys.length ?? -1;
    if (n < 0) return null;
    const out: (string | null)[] = [];
    for (let i = 0; i < n; i++) out.push(res.string(bagValue(res, id, i)));
    return jarray(out, "Ljava/lang/String;");
  },
  "nativeGetResourceStringArrayInfo(JI)[I": (h: bigint, id: number) => {
    const res = assets(h), n = res.bag(id)?.keys.length ?? -1;
    if (n < 0) return null;
    const out = new Int32Array(n * 2);
    for (let i = 0; i < n; i++) { const v = bagValue(res, id, i); out[i * 2] = res.cookieOf(v.pkg); out[i * 2 + 1] = v.t === TV.STRING ? v.d : -1; }
    return out;
  },
  "nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I": (h: bigint, name: string, type: string | null, pkg: string | null) =>
    resourceId(assets(h), name, type, pkg),
  "nativeGetResourceName(JI)Ljava/lang/String;": (h: bigint, id: number) => {
    const n = resourceName(assets(h), id);
    return n ? (n[0] ? n[0] + ":" : "") + n[1] + "/" + n[2] : null;
  },
  "nativeGetResourcePackageName(JI)Ljava/lang/String;": (h: bigint, id: number) => resourceName(assets(h), id)?.[0] ?? null,
  "nativeGetResourceTypeName(JI)Ljava/lang/String;": (h: bigint, id: number) => resourceName(assets(h), id)?.[1] ?? null,
  "nativeGetResourceEntryName(JI)Ljava/lang/String;": (h: bigint, id: number) => resourceName(assets(h), id)?.[2] ?? null,
  "nativeGetParentThemeIdentifier(JI)I": (h: bigint, id: number) => assets(h).entry(id)?.bag?.parent ?? 0,
  "nativeGetSizeConfigurations(J)[Landroid/content/res/Configuration;": (h: bigint) => sizeConfigurations(assets(h), false),
  "nativeGetSizeAndUiModeConfigurations(J)[Landroid/content/res/Configuration;": (h: bigint) => sizeConfigurations(assets(h), true),
  "nativeGetOverlayableMap(JLjava/lang/String;)Ljava/util/Map;": driven(function* (h: bigint, pkg: string): Gen {
    const named = overlayablesOf(assets(h), pkg);
    if (!named) return null;
    const map = yield newObj("java/util/HashMap", "()V");
    for (const [name, actor] of named) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", name, actor);
    return map;
  }),
  "nativeGetOverlayablesToString(JLjava/lang/String;)Ljava/lang/String;": (h: bigint, pkg: string) => {
    const named = overlayablesOf(assets(h), pkg);
    return named ? [...named].map(([name, actor]) => `overlayable ${name} actor=${actor}\n`).join("") : null;
  },
  // resolution logging is off unless enabled, and then there is nothing recorded to report
  "nativeSetResourceResolutionLoggingEnabled(JZ)V": () => {},
  "nativeGetLastResourceResolution(J)Ljava/lang/String;": () => "",

  // themes
  "nativeThemeCreate(J)J": (h: bigint) => handle(new NativeTheme(assets(h))),
  "nativeGetThemeFreeFunction()J": () => FINALIZER,
  "nativeThemeApplyStyle(JJIZ)V": (_h: bigint, th: bigint, styleId: number, force: number) => deref<NativeTheme>(th).apply(styleId, !!force),
  "nativeThemeRebase(JJ[I[ZI)V": (h: bigint, th: bigint, styleIds: Int32Array, force: Int8Array, n: number) => {
    const styles: number[] = [];
    for (let i = 0; i < n; i++) styles.push(styleIds[i], force[i] ? 1 : 0);
    deref<NativeTheme>(th).rebase(assets(h), styles);
  },
  "nativeThemeCopy(JJJJ)V": (dstAm: bigint, dst: bigint, _srcAm: bigint, src: bigint) => {
    const d = deref<NativeTheme>(dst);
    d.res = assets(dstAm);
    d.setTo(deref<NativeTheme>(src));
  },
  "nativeThemeGetAttributeValue(JJILandroid/util/TypedValue;Z)I": (h: bigint, th: bigint, attrId: number, tv: TypedValueLike, resolve: number) => {
    const res = assets(h), v = SVAL;
    if (!deref<NativeTheme>(th).getAttribute(attrId, v)) return -1;
    if (resolve && !res.resolveReference(v)) return -1;
    return copyValue(res, v, tv);
  },
  "nativeThemeGetChangingConfigurations(J)I": (th: bigint) => deref<NativeTheme>(th).flags,
  "nativeThemeDump(JJILjava/lang/String;Ljava/lang/String;)V": () => {},

  // obtainStyledAttributes, which is what every widget constructor is really doing
  "nativeApplyStyle(JJIIJ[IJJ)V": (h: bigint, th: bigint, defStyleAttr: number, defStyleRes: number, xml: bigint, attrs: Int32Array, outValues: bigint, outIndices: bigint) => {
    const st = xml ? state(xml) : null;
    resolveAttributes(assets(h), deref<NativeTheme>(th), st?.node ?? null, st?.sourceResId ?? 0, defStyleAttr, defStyleRes,
      attrs, null, deref<Int32Array>(outValues), deref<Int32Array>(outIndices));
  },
  "nativeResolveAttrs(JJII[I[I[I[I)Z": (h: bigint, th: bigint, defStyleAttr: number, defStyleRes: number, values: Int32Array | null, attrs: Int32Array, outValues: Int32Array, outIndices: Int32Array | null) => {
    resolveAttributes(assets(h), deref<NativeTheme>(th), null, 0, defStyleAttr, defStyleRes, attrs, values?.length ? values : null, outValues, outIndices);
    return 1;
  },
  "nativeRetrieveAttributes(JJ[I[I[I)Z": (h: bigint, xml: bigint, attrs: Int32Array, outValues: Int32Array, outIndices: Int32Array | null) => {
    resolveAttributes(assets(h), null, xml ? state(xml).node : null, 0, 0, 0, attrs, null, outValues, outIndices);
    return 1;
  },
  "nativeAttributeResolutionStack(JJIII)[I": (h: bigint, th: bigint, xmlStyle: number, defStyleAttr: number, defStyleRes: number) => {
    const res = assets(h), v = SVAL;
    if (defStyleAttr && deref<NativeTheme>(th).getAttribute(defStyleAttr, v) && v.t === TV.REFERENCE) defStyleRes = v.d;
    return Int32Array.from([...styleStack(res, xmlStyle), ...styleStack(res, defStyleRes)]);
  },

  // asset streams over archive entries; 0 is AOSP's "no such asset"
  "nativeOpenAsset(JLjava/lang/String;I)J": (h: bigint, path: string) => openAsset(assets(h), "assets/" + path),
  "nativeOpenNonAsset(JILjava/lang/String;I)J": (h: bigint, cookie: number, path: string) => openAsset(assets(h), path, cookie),
  "nativeOpenXmlAsset(JILjava/lang/String;)J": driven(function* (h: bigint, cookie: number, path: string): Gen {
    const res = assets(h), hit = findEntry(res, path, cookie);
    if (!hit) throw rt.mkThrowable("java/io/FileNotFoundException", path);
    return handle(mkBlock(yield* awaited(readFully(hit.source)), res));
  }),
  "nativeOpenXmlAssetFd(JILjava/io/FileDescriptor;)J": () => { throw rt.mkThrowable("java/io/FileNotFoundException", "Corrupt XML binary file"); },
  "nativeOpenAssetFd(JLjava/lang/String;[J)Landroid/os/ParcelFileDescriptor;": (h: bigint, path: string, offsets: BigInt64Array) => openFd(assets(h), "assets/" + path, 0, offsets),
  "nativeOpenNonAssetFd(JILjava/lang/String;[J)Landroid/os/ParcelFileDescriptor;": (h: bigint, cookie: number, path: string, offsets: BigInt64Array) => openFd(assets(h), path, cookie, offsets),
  "nativeAssetDestroy(J)V": (a: bigint) => { liveAssets--; release(a); },
  "nativeAssetGetLength(J)J": (a: bigint) => BigInt(deref<Cursor>(a).source.size),
  "nativeAssetGetRemainingLength(J)J": (a: bigint) => { const c = deref<Cursor>(a); return BigInt(c.source.size - c.pos); },
  "nativeAssetReadChar(J)I": driven(function* (a: bigint): Gen {
    const c = deref<Cursor>(a);
    const bytes = yield* awaited(c.source.read(c.pos, 1));
    if (!bytes.length) return -1;
    c.pos++;
    return bytes[0];
  }),
  "nativeAssetRead(J[BII)I": driven(function* (a: bigint, out: Int8Array, off: number, len: number): Gen {
    const c = deref<Cursor>(a);
    if (!len) return 0;
    const bytes = yield* awaited(c.source.read(c.pos, len));
    if (!bytes.length) return -1;
    out.set(i8(bytes), off);
    c.pos += bytes.length;
    return bytes.length;
  }),
  "nativeAssetSeek(JJI)J": (a: bigint, off: bigint, whence: number) => {
    const c = deref<Cursor>(a);
    const base = whence === 0 ? 0 : whence === 1 ? c.pos : c.source.size;
    c.pos = Math.max(0, Math.min(c.source.size, base + Number(off)));
    return BigInt(c.pos);
  },
  "nativeList(JLjava/lang/String;)[Ljava/lang/String;": (h: bigint, path: string) =>
    jarray(assetDir(assets(h), path).map(([name]) => name), "Ljava/lang/String;"),
});

interface Cursor { source: FileSource; pos: number }
/** what an open asset has left, consumed: the stream BitmapFactory and ImageDecoder decode an asset through */
export function assetBytes(a: bigint): Promise<Uint8Array> {
  const c = deref<Cursor>(a), from = c.pos;
  c.pos = c.source.size;
  return readFully(c.source, from);
}
function openAsset(res: Resources, path: string, cookie = 0): bigint {
  const hit = findEntry(res, path, cookie);
  if (!hit) return 0n;
  liveAssets++;
  return handle({ source: hit.source, pos: 0 } as Cursor);
}
const openFd = driven(function* (res: Resources, path: string, cookie: number, offsets: BigInt64Array): Gen {
  const hit = findEntry(res, path, cookie);
  if (!hit) throw rt.mkThrowable("java/io/FileNotFoundException", path);
  const bytes = yield* awaited(readFully(hit.source));
  offsets[0] = 0n; offsets[1] = BigInt(bytes.length);
  return mkPfd(bytes, null);
});
/** the chain of styles a bag inherits from, itself first (AssetManager2::GetBagResIdStack) */
function styleStack(res: Resources, id: number): number[] {
  const out: number[] = [];
  for (let bag = res.entry(id)?.bag; id && bag && !out.includes(id); bag = res.entry(id)?.bag) { out.push(id); id = bag.parent; }
  return out;
}
function overlayablesOf(res: Resources, pkg: string): Map<string, string> | null {
  for (const apk of apksOf(res)) { const named = apk.table?.overlayables.get(pkg); if (named) return named; }
  return apksOf(res).some((apk) => apk.table?.packageId(pkg) !== undefined) ? new Map() : null;
}
/** the app's size (and UI mode) qualifiers as Configurations with just those fields set */
const sizeConfigurations = driven(function* (res: Resources, uiMode: boolean): Gen {
  const seen = new Set<string>(), out: unknown[] = [];
  for (const apk of apksOf(res)) {
    if (!apk.table || apk.table.pkgId === 0x01) continue;
    for (const c of apk.table.configs()) {
      const key = `${c.swdp}/${c.wdp}/${c.hdp}` + (uiMode ? `/${c.uiType}/${c.night}` : "");
      if (seen.has(key)) continue;
      seen.add(key);
      const config = yield newObj("android/content/res/Configuration", "()V");
      yield vcall(config, "unset", "()V");
      setDeclared(config, "android/content/res/Configuration", { smallestScreenWidthDp: c.swdp, screenWidthDp: c.wdp, screenHeightDp: c.hdp,
        ...uiMode ? { uiMode: c.uiType | (c.night > 0 ? 0x20 : c.night < 0 ? 0x10 : 0) } : {} });
      out.push(config);
    }
  }
  return jarray(out, "Landroid/content/res/Configuration;");
});
