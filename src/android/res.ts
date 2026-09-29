// Resources: the app's resource table and the android: one, addressed by the package byte of a
// resource id. Implements the full attribute-resolution cascade (XML → style → defStyle → theme).

import { Arsc } from "./arsc";
import { TV, parseAXML, attr, type XmlNode, type XmlAttr } from "./axml";
import { JObj, rt } from "../jvm/runtime";
import { deref } from "./handles";
import { JDisplayMetrics, JTypedValue, complexToPx } from "./util";
import { mangleMethod, intBitsToFloat, floatToIntBits } from "../jvm/abi";
import type { FileSource } from "../shell/lazyfile";

let fwPkg: Arsc | null = null;
const aidMemo = new Map<string, number>();
/** framework attr id by name, e.g. AID("textColor") */
export const AID = (name: string): number => {
  let v = aidMemo.get(name);
  if (v === undefined) {
    v = fwPkg?.findId("attr", name) ?? 0;
    // a lookup before the framework package loads is not an answer, so it is not remembered
    if (fwPkg) aidMemo.set(name, v);
    if (v) askedAttrs.add(v);
  }
  return v;
};

// Naming an attribute here is the only way to read one, so every id AID has ever returned is the
// set we understand. A framework attribute on a tag outside it renders wrong in silence -- no
// missing class, no missing method, nothing in the log -- which is the hardest kind of gap to
// find in an app nobody has run before.
const askedAttrs = new Set<number>();
const unread = new Map<number, string>();
export function noteAttrsRead(...ids: number[]): void { for (const id of ids) askedAttrs.add(id); }
export function noteUnreadAttrs(node: XmlNode, cls: string): void {
  for (const a of node.attrs) {
    if (a.resId >>> 24 !== 0x01 || askedAttrs.has(a.resId) || unread.has(a.resId)) continue;
    unread.set(a.resId, cls);
  }
}
/** filtered at read time: a widget that had not been constructed yet has since named its own */
export function unreadAttrs(res: Resources): string[] {
  const out: string[] = [];
  for (const [id, cls] of unread) if (!askedAttrs.has(id)) out.push(`${cls} android:${res.idName(id)}`);
  return out.sort();
}

// The package arrives over the network, but the attr-id tables the widgets read are built while
// their modules evaluate. They are handed out empty and filled in place, before any app boots.
const deferred: (() => void)[] = [];
export function onFramework(fn: () => void): void { deferred.push(fn); }
export function attrTable<K extends string>(...names: K[]): Record<K, number> {
  const t = {} as Record<K, number>;
  onFramework(() => { for (const n of names) t[n] = AID(n); });
  return t;
}
export function setFramework(a: Arsc): void {
  fwPkg = a;
  aidMemo.clear();
  for (const fill of deferred) fill();
}

const M_getTheme = mangleMethod("getTheme", "()Landroid/content/res/Resources$Theme;");

// resolved value: binary Res_value types + internal PX (0xfe) and STR (0xfd)
/** r: the resource whose entry a resolved value came from — what getResourceId still reports */
export interface RV { t: number; d: number; s?: string; r?: number }
export const T_PX = 0xfe, T_STR = 0xfd;
const NULL_RV: RV = { t: TV.NULL, d: 0 };
/** binary Res_value → RV with FLOAT bits decoded to a JS number */
export function normRV(v: RV): RV {
  if (v.t === TV.FLOAT) return { t: TV.FLOAT, d: intBitsToFloat(v.d), s: v.s };
  return v;
}
/** a raw AXML attribute → RV, its string literal as T_STR */
export function xmlAttrRV(a: XmlAttr): RV {
  return a.type === TV.STRING ? { t: T_STR, d: 0, s: a.str ?? "" } : normRV({ t: a.type, d: a.data });
}
// An id of 0 is AID missing the name, and an attribute with no resource-map entry (style=, a
// tools: one) also carries 0 -- so a miss would bind to whichever of those came first.
/** the node's attribute with this resource id, as an RV */
export function nodeAttrRV(node: XmlNode, resId: number): RV | null {
  if (!resId) return null;
  for (const a of node.attrs) if (a.resId === resId) return xmlAttrRV(a);
  return null;
}
/** the node's attribute with this name, references resolved, as animation XML is read */
export function namedAttrRV(res: Resources, node: XmlNode, name: string): RV | null {
  const a = attr(node, name);
  if (!a) return null;
  const v = normRV({ t: a.type, d: a.data, s: a.str ?? undefined });
  return v.t === TV.REFERENCE ? res.resolveRefs(v) : v;
}

/** an app XML colour literal (#rgb … #aarrggbb) — the one raw string form still parsed */
function parseColor(raw: string): number {
  let h = raw.slice(1);
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h = "ff" + h;
  return parseInt(h, 16) | 0;
}
/**
 * A value as AssetManager2 selects it (its SelectedValue): the Res_value, the package id of the
 * table its entry came from (-1 for an XML attribute's own value, AOSP's kInvalidCookie), the
 * configuration axes its entries vary over, the resource it was read from and the density of the
 * configuration that answered. FLOAT data stays as its bits.
 */
export interface SV { t: number; d: number; pkg: number; flags: number; resid: number; density: number }
export const newSV = (): SV => ({ t: TV.NULL, d: 0, pkg: -1, flags: 0, resid: 0, density: 0 });
/** Res_value::DATA_NULL_EMPTY: @empty, a TYPE_NULL that still counts as a value */
export const DATA_NULL_EMPTY = 1;
const isValidResid = (id: number) => (id & 0x00ff0000) !== 0 && (id & 0xff000000) !== 0;

/** A bag with its parents merged in, keys ascending, child entries winning (AssetManager2::GetBag):
 *  entry i is (types[i], data[i]) out of style styles[i], whose table its strings index. */
export class Bag {
  private rvs: Map<number, RV> | null = null;
  constructor(readonly res: Resources, readonly parent: number, readonly flags: number, readonly keys: Int32Array,
    readonly types: Uint8Array, readonly data: Int32Array, readonly styles: Int32Array) {}
  /** the index of attribute `key`, or -1 */
  find(key: number): number {
    const keys = this.keys;
    let lo = 0, hi = keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, k = keys[mid];
      if (k === key) return mid;
      if (k < key) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }
  /** key → value as our own stack reads it, unresolved */
  get map(): Map<number, RV> {
    if (this.rvs) return this.rvs;
    const m = new Map<number, RV>();
    for (let i = 0; i < this.keys.length; i++) m.set(this.keys[i], this.res.rawRV(this.types[i], this.data[i], this.styles[i] >>> 24));
    return this.rvs = m;
  }
}
/** resource types a reference to stays a reference: the caller loads them by id */
const LOADED_BY_ID = new Set(["drawable", "layout", "style", "anim", "xml", "menu", "mipmap", "raw", "font", "id", "transition", "interpolator", "animator"]);
const SEL = { density: 0 };

/**
 * Every resource memo below is only valid for one device Configuration: the same id resolves to
 * a different entry once a qualifier changes (`-night` above all). setResourceNight() bumps this
 * generation so the caches — and every JTheme, which memoises attribute lookups — reload.
 */
let configGen = 0;
const allResources: Resources[] = [];
/** the booted app's Resources — the framework package is an Arsc, not one of these, so the
 *  most recent is the app's. AOSP's AssetManager handle is this (src/android/delegates.ts). */
export function currentResources(): Resources | null { return allResources[allResources.length - 1] ?? null; }
/** Re-resolve entries under changed qualifiers in every live resource table. */
function setDeviceQualifiers(qualifiers: Partial<Arsc["device"]>): void {
  configGen++;
  for (const r of allResources) {
    r.invalidate();
    if (r.arsc) Object.assign(r.arsc.device, qualifiers);
  }
  if (fwPkg) Object.assign(fwPkg.device, qualifiers);
}
export const setResourceNight = (night: boolean): void => setDeviceQualifiers({ night: night ? 1 : 0 });
export const setResourceLocale = (lang: string, dir: number): void => setDeviceQualifiers({ lang, dir });
export const setResourceOrientation = (orientation: number, wdp: number, hdp: number, swdp: number): void =>
  setDeviceQualifiers({ orientation: orientation as Arsc["device"]["orientation"], wdp, hdp, swdp });

/**
 * A theme attribute by name, in either package. A support library re-declares framework attr
 * names in the app's own package -- AppCompat's windowActionBar is not android:windowActionBar --
 * and only one decor implementation reads them here, so both ids can carry the answer. The app's
 * is the more specific statement of intent, so it is asked first.
 */
export function themeByName(res: Resources, theme: JTheme | null, name: string): RV | null {
  if (!theme) return null;
  const own = res.arsc?.findId("attr", name) ?? 0;
  return (own ? theme.lookup(own) : null) ?? (AID(name) ? theme.lookup(AID(name)) : null);
}

/** the native half of an ApkAssets: one archive and its resource table */
export interface Apk {
  path: string; table: Arsc | null;
  zip: Record<string, Uint8Array>; lazyEntries: Map<string, FileSource>;
}

/** AssetManager2: the tables of the loaded packages, addressed by the package byte of an id. */
export class Resources {
  arsc: Arsc | null;
  zip: Record<string, Uint8Array>;
  lazyEntries: Map<string, FileSource>;
  dm = new JDisplayMetrics();
  bagCache = new Map<number, Bag | null>();
  selectorCache = new Map<number, number>();
  private framework: Arsc | null | undefined;
  jobj: any = null; // android.content.res.Resources instance
  /** an AssetManager's apks in cookie order; null for the stack's own, whose framework is
   *  cookie 1 and app cookie 2 */
  apks: Apk[] | null = null;
  private cookies: Int8Array | null = null;
  private qualifiers: Partial<Arsc["device"]> = {};

  constructor(arsc: Arsc | null, zip: Record<string, Uint8Array>, lazyEntries = new Map<string, FileSource>(), scoped = false) {
    this.arsc = arsc;
    this.zip = zip;
    this.lazyEntries = lazyEntries;
    if (!scoped) allResources.push(this);
  }

  invalidate(): void { this.bagCache.clear(); this.selectorCache.clear(); configGen++; }

  scoped(qualifiers: Partial<Arsc["device"]>): Resources {
    const res = new Resources(scopeTable(this.arsc, qualifiers), this.zip, this.lazyEntries, true);
    res.framework = scopeTable(this.tbl(0x01000000), qualifiers);
    Object.assign(res.dm, this.dm);
    return res;
  }

  /** AssetManager2::SetApkAssets: the last package that is not the framework is the app's */
  setApks(apks: Apk[]): void {
    this.apks = apks;
    const app = appApk(apks);
    this.zip = app?.zip ?? {};
    this.lazyEntries = app?.lazyEntries ?? new Map();
    const cookies = this.cookies = new Int8Array(256).fill(-1);
    apks.forEach((a, i) => { if (a.table) for (const id of a.table.packageIds()) if (cookies[id] < 0) cookies[id] = i + 1; });
    this.configure(this.qualifiers);
  }
  /** AssetManager2::SetConfigurations: select under these qualifiers from now on */
  configure(qualifiers: Partial<Arsc["device"]>): void {
    this.qualifiers = qualifiers;
    const apks = this.apks ?? [];
    this.arsc = scopeTable(appApk(apks)?.table ?? null, qualifiers);
    this.framework = scopeTable(apks.find((a) => a.table?.pkgId === 0x01)?.table ?? null, qualifiers);
    this.invalidate();
  }
  /** the Java cookie of the apk a package id's table came from: 1-based, -1 for none */
  cookieOf(pkg: number): number {
    if (pkg < 0) return -1;
    return this.cookies ? this.cookies[pkg] : pkg === 0x01 ? 1 : 2;
  }

  /** the table a resource id belongs to: package 0x01 is the framework, anything else the app */
  tbl(resId: number): Arsc | null { return resId >>> 24 === 0x01 ? (this.framework === undefined ? fwPkg : this.framework) : this.arsc; }

  /** the archive path a file resource names, the package that owns it, the id the reference
   *  chain ended on and the density of the configuration it came from — everything but the
   *  bytes, which cost an inflate */
  pathOf(resId: number, depth = 0, selected: { density: number } = { density: 0 }, density?: number): { path: string; id: number; arsc: Arsc; density: number } | null {
    const a = this.tbl(resId);
    const e = a?.entry(resId, selected, density);
    if (!e?.value) return null;
    if (e.value.type === TV.REFERENCE && e.value.data && depth < 8) return this.pathOf(e.value.data, depth + 1, selected, density);
    if (e.value.type !== TV.STRING) return null;
    return { path: a!.values.get(e.value.data), id: resId, arsc: a!, density: selected.density };
  }

  /** the archive entry a file resource names, out of the package that owns it */
  fileOf(resId: number): { path: string; bytes: Uint8Array; density: number } | null {
    const f = this.pathOf(resId);
    const bytes = f && f.arsc.files(f.path);
    return bytes ? { path: f!.path, bytes, density: f!.density } : null;
  }

  /** id by type and name; a package name picks a table, otherwise the app is searched first */
  idFor(type: string, name: string, pkg = ""): number {
    if (pkg && pkg === fwPkg?.pkgName) return fwPkg.findId(type, name);
    if (pkg) {
      const id = this.arsc?.packageId(pkg);
      return id === undefined ? 0 : this.arsc!.findId(type, name, id);
    }
    return this.arsc?.findId(type, name) || fwPkg?.findId(type, name) || 0;
  }

  idPackage(resId: number): string { return this.tbl(resId)?.packageName(resId >>> 24) ?? "app"; }

  idType(resId: number): string {
    const a = this.tbl(resId);
    return a ? a.typeName((resId >> 16) & 0xff, resId & 0xffff, resId >>> 24) : "?";
  }
  idName(resId: number): string {
    return this.tbl(resId)?.entry(resId)?.key ?? "0x" + resId.toString(16);
  }

  /** simple value for resId (no bag). */
  value(resId: number, selected?: { density: number }): RV {
    if (!resId) return NULL_RV;
    const a = this.tbl(resId);
    const e = a?.entry(resId, selected);
    if (!e?.value) return NULL_RV;
    const v: RV = { t: e.value.type, d: e.value.data };
    if (v.t === TV.STRING) v.s = a!.values.get(e.value.data);
    return normRV(v);
  }

  /** AssetManager2::GetResource into `out`; false when `resid` names nothing, or a bag and
   *  `mayBeBag` is false. A bag reads back as a reference to itself. */
  getResource(resid: number, mayBeBag: boolean, out: SV, density = 0): boolean {
    const a = this.tbl(resid);
    SEL.density = 0;
    const e = a?.entry(resid, SEL, density || undefined);
    if (!e) return false;
    if (e.bag) {
      if (!mayBeBag) return false;
      out.t = TV.REFERENCE; out.d = resid;
    } else { out.t = e.value!.type; out.d = e.value!.data; }
    out.pkg = resid >>> 24; out.flags = a!.specFlags(resid); out.resid = resid; out.density = SEL.density;
    return true;
  }

  /** AssetManager2::ResolveReference: follow a reference to the value at the end of its chain.
   *  False when an id on the way names nothing; `v` then holds the last value that resolved. */
  resolveReference(v: SV): boolean {
    if (v.t !== TV.REFERENCE || v.d === 0) return true;
    const original = v.flags;
    let combined = 0, rid = v.d;
    for (let i = 0; ; i++) {
      if (!this.getResource(rid, true, v)) { v.resid = rid; return false; }
      v.flags |= combined;
      if (v.t !== TV.REFERENCE || v.d === 0 || v.d === rid || i === 20) { v.flags |= original; return true; }
      combined = v.flags; rid = v.d;
    }
  }

  /** a table value as our own stack reads it, strings out of the package's pool */
  rawRV(t: number, d: number, pkg: number): RV {
    if (t === TV.STRING) return { t, d, s: this.tbl(pkg << 24)?.values.get(d) };
    return t === TV.FLOAT ? { t, d: intBitsToFloat(d) } : { t, d };
  }

  /** A selected value as our own stack reads it. The stack loads files, styles and ids by id, so a
   *  value that came out of one stays a reference to it; an XML attribute's own value is `xa`'s. */
  toRV(v: SV, xa: XmlAttr | null = null): RV | null {
    const t = v.t;
    if (t === TV.NULL || t === TV.ATTRIBUTE) return null;
    if (v.pkg < 0) return xa ? xmlAttrRV(xa) : normRV({ t, d: v.d });
    if (v.resid) {
      const type = this.idType(v.resid);
      if (LOADED_BY_ID.has(type) || (t === TV.STRING && type === "color")) {
        const rv: RV = { t: TV.REFERENCE, d: v.resid };
        if (t === TV.STRING) rv.s = this.tbl(v.pkg << 24)?.values.get(v.d);
        return rv;
      }
    }
    const rv = this.rawRV(t, v.d, v.pkg);
    if (v.resid) rv.r = v.resid;
    return rv;
  }

  /** the resolved value behind resource id `id` — value(id) with its REFERENCE chain followed */
  ref(id: number): RV { return this.resolveRefs({ t: TV.REFERENCE, d: id }); }

  /** resolve REFERENCE chains (not ATTRIBUTE) */
  resolveRefs(v: RV): RV {
    if (v.t !== TV.REFERENCE || !v.d) return v;
    const sv = SCRATCH;
    sv.t = TV.REFERENCE; sv.d = v.d; sv.pkg = -1; sv.flags = 0; sv.resid = 0; sv.density = 0;
    this.resolveReference(sv);
    // a reference to itself (a bag) or one that did not resolve stays the value it was
    if (sv.t === TV.REFERENCE && sv.d === v.d) return v;
    const rv = this.toRV(sv);
    // a file resource reads back as a reference to its own id: resolving it again must answer the
    // same object, or a caller that resolves until nothing changes (rvString) never stops
    if (!rv || (rv.t === TV.REFERENCE && rv.d === v.d && (v.s !== undefined || rv.s === undefined))) return v;
    return rv;
  }

  /** the bag `resId` names with its parents merged in, or null (AssetManager2::GetBag) */
  bag(resId: number): Bag | null {
    if (!resId) return null;
    let b = this.bagCache.get(resId);
    if (b === undefined) this.bagCache.set(resId, b = this.computeBag(resId, [resId]));
    return b;
  }

  private computeBag(resId: number, chain: number[]): Bag | null {
    const a = this.tbl(resId);
    const e = a?.entry(resId);
    if (!e?.bag) return null;
    const own = e.bag.map, flags = a!.specFlags(resId), parentId = e.bag.parent;
    // a parent already on the chain is a cycle, and a bag in one inherits nothing
    const inherits = parentId !== 0 && !chain.includes(parentId);
    let parent: Bag | null = null;
    if (inherits) {
      parent = this.bagCache.get(parentId) ?? null;
      if (!this.bagCache.has(parentId)) { chain.push(parentId); this.bagCache.set(parentId, parent = this.computeBag(parentId, chain)); }
      // a parent that should exist and does not fails the bag
      if (!parent) return null;
    }
    const order = own.map((_, i) => i);
    // entries need not be stored in key order: aapt2 writes a plural's "one" before its "other"
    order.sort((x, y) => own[x][0] - own[y][0]);
    const pk = parent?.keys, n = order.length + (pk?.length ?? 0);
    const keys = new Int32Array(n), types = new Uint8Array(n), data = new Int32Array(n), styles = new Int32Array(n);
    let k = 0, i = 0, j = 0;
    while (i < order.length || (pk && j < pk.length)) {
      const mine = i < order.length ? own[order[i]] : null;
      if (mine && (!pk || j >= pk.length || mine[0] <= pk[j])) {
        if (pk && j < pk.length && mine[0] === pk[j]) j++;
        keys[k] = mine[0]; types[k] = mine[1]; data[k] = mine[2]; styles[k] = resId; i++;
      } else {
        keys[k] = pk![j]; types[k] = parent!.types[j]; data[k] = parent!.data[j]; styles[k] = parent!.styles[j]; j++;
      }
      k++;
    }
    return new Bag(this, parentId, flags | (parent?.flags ?? 0), keys.subarray(0, k), types.subarray(0, k), data.subarray(0, k), styles.subarray(0, k));
  }

  /** an attribute's raw value in a style or its parents */
  styleLookup(styleId: number, attrId: number): RV | null {
    return this.bag(styleId)?.map.get(attrId) ?? null;
  }
}
const SCRATCH = newSV();
/** the app's apk: the last whose package is not the framework's */
function appApk(apks: Apk[]): Apk | undefined {
  for (let i = apks.length - 1; i >= 0; i--) if (apks[i].table && apks[i].table!.pkgId !== 0x01) return apks[i];
  return undefined;
}
function scopeTable(table: Arsc | null, qualifiers: Partial<Arsc["device"]>): Arsc | null {
  return table && Object.assign(Object.create(table), { device: { ...table.device, ...qualifiers } });
}

interface ThemeEntry { t: number; d: number; pkg: number; flags: number }
/** A theme's native half (AssetManager2's Theme): the attributes of the styles applied to it,
 *  merged as Theme::ApplyStyle merges them. */
export class JTheme extends JObj {
  res!: Resources;
  /** the Resources.Theme this is the native half of, when AOSP's answers */
  jobj: unknown = null;
  entries = new Map<number, ThemeEntry>();
  /** the styles applied so far, with their force flags, in pairs */
  applied: number[] = [];
  flags = 0;
  /** resolved values (AOSP caches them too) and our own stack's reading of them, valid for one
   *  selection generation */
  private resolved = new Map<number, SV | null>();
  cache = new Map<number, RV | null>();
  private gen = configGen;
  /** A theme our own stack holds re-applies its styles when a qualifier changes; one AOSP's
   *  ThemeImpl holds is rebased by it instead. */
  live = true;

  private sync(): void {
    if (this.gen === configGen) return;
    this.gen = configGen;
    this.forget();
    if (this.live) this.replay(this.applied);
  }
  private replay(applied: number[]): void {
    this.entries.clear(); this.flags = 0; this.applied = [];
    for (let i = 0; i < applied.length; i += 2) this.apply(applied[i], applied[i + 1] !== 0);
  }

  apply(styleId: number, force = true): void {
    this.sync();
    this.applied.push(styleId, force ? 1 : 0);
    this.forget();
    const bag = this.res.bag(styleId);
    if (!bag) return;
    this.flags |= bag.flags;
    for (let i = 0; i < bag.keys.length; i++) {
      const key = bag.keys[i], t = bag.types[i], d = bag.data[i];
      // a bag that is not a style fails where its keys stop being attribute ids
      if (!isValidResid(key)) return;
      const undefinedValue = t === TV.NULL && d !== DATA_NULL_EMPTY;
      if (!force && undefinedValue) continue;
      if (this.entries.has(key)) {
        if (undefinedValue) this.entries.delete(key);
        else if (force) this.entries.set(key, { t, d, pkg: bag.styles[i] >>> 24, flags: bag.flags });
      } else this.entries.set(key, { t, d, pkg: bag.styles[i] >>> 24, flags: bag.flags });
    }
  }
  /** Theme::SetTo. Our own stack copies a theme onto another configuration's tables, where the
   *  same styles select other values, so it re-applies them there. */
  setTo(o: JTheme): void {
    o.sync();
    this.gen = configGen; this.forget();
    if (this.res && this.res !== o.res) { this.replay(o.applied); return; }
    this.res = o.res;
    this.entries = new Map(o.entries); this.flags = o.flags; this.applied = o.applied.slice();
  }
  /** Theme::Rebase: these styles over another AssetManager */
  rebase(res: Resources, styles: number[]): void { this.res = res; this.gen = configGen; this.forget(); this.replay(styles); }
  private forget(): void { this.resolved.clear(); this.cache.clear(); }

  /** Theme::GetAttribute: the value an attribute holds, through ?attr indirections, unresolved */
  getAttribute(resid: number, out: SV): boolean {
    this.sync();
    let flags = 0;
    for (let i = 0; i <= 20; i++) {
      const e = this.entries.get(resid);
      if (!e) return false;
      flags |= e.flags;
      if (e.t === TV.ATTRIBUTE) { resid = e.d; continue; }
      if (e.t === TV.NULL && e.d !== DATA_NULL_EMPTY) return false;
      out.t = e.t; out.d = e.d; out.pkg = e.pkg; out.flags = flags; out.resid = 0; out.density = 0;
      return true;
    }
    return false;
  }
  /** GetAttribute then ResolveReference, or null when the theme holds nothing for it */
  resolvedAttribute(attr: number): SV | null {
    this.sync();
    let v = this.resolved.get(attr);
    if (v === undefined) {
      v = newSV();
      if (this.getAttribute(attr, v)) this.res.resolveReference(v); else v = null;
      this.resolved.set(attr, v);
    }
    return v;
  }
  /** Theme::ResolveAttributeReference */
  resolveAttributeReference(v: SV): void {
    if (v.t !== TV.ATTRIBUTE) { this.res.resolveReference(v); return; }
    const t = this.resolvedAttribute(v.d);
    if (!t) return;
    v.t = t.t; v.d = t.d; v.pkg = t.pkg; v.flags |= t.flags; v.resid = t.resid; v.density = t.density;
  }

  /** an attribute's resolved value, as our own stack reads it */
  lookup(attrId: number): RV | null {
    let v = this.cache.get(attrId);
    if (v !== undefined && this.gen === configGen) return v;
    const sv = this.resolvedAttribute(attrId);
    v = sv && this.res.toRV(sv);
    this.cache.set(attrId, v);
    return v;
  }
}

// AttributeSet wrapper over parsed AXML node
export class JAttrSet extends JObj {
  node: XmlNode | null = null;
  res!: Resources;
  theme: JTheme | null = null;
}

export class JXmlParser extends JObj {
  events: { type: number; node: XmlNode | null; depth: number; text?: string; line?: number; namespace?: string }[] = [];
  pos = -1;
  res!: Resources;
  set = new JAttrSet();
  sourceResId = 0;
  get node(): XmlNode | null { return this.events[this.pos]?.node ?? null; }
}

/** A pull parser positioned on a drawable's current start tag, as DrawableInflater supplies it. */
export function xmlParserAtNode(res: Resources, root: XmlNode): JXmlParser {
  const parser = new JXmlParser();
  parser.res = res;
  parser.set.res = res;
  const events: JXmlParser["events"] = [];
  const walk = (node: XmlNode, depth: number) => {
    events.push({ type: 2, node, depth });
    for (const child of node.children) walk(child, depth + 1);
    events.push({ type: 3, node, depth });
  };
  walk(root, 1);
  events.push({ type: 1, node: null, depth: 0 });
  parser.events = events;
  parser.pos = 0;
  parser.set.node = root;
  return parser;
}

// ── TypedArray (result of obtainStyledAttributes)
export class JTypedArray extends JObj {
  res!: Resources;
  theme: JTheme | null = null;
  vals: (RV | null)[] = [];
  attrIds: Int32Array | number[] = [];
}

/** AOSP's TypedArray layout: STYLE_NUM_ENTRIES ints per attribute, (type, data, assetCookie,
 *  resourceId, changingConfigurations, density, sourceResourceId). */
export const STYLE_NUM_ENTRIES = 7;
const STYLED = newSV();

/**
 * libandroidfw's AttributeResolution in one pass: ApplyStyle with a theme (XML attribute, the
 * XML's style=, the default style, then the theme), ResolveAttrs when `srcValues` stands in for
 * the XML, RetrieveAttributes without a theme (XML attributes only). Each value lands in
 * `outValues`/`outIndices` in TypedArray's layout, or as our own stack's RV in `outRVs`.
 */
function ascending<T>(list: ArrayLike<T>, id: (t: T) => number): boolean {
  for (let i = 1; i < list.length; i++) if (id(list[i]) < id(list[i - 1])) return false;
  return true;
}
/** a style's value for `key` into `v`, returning the style it came from, or 0 */
function fromBag(bag: Bag, key: number, flags: number, v: SV): number {
  const i = bag.find(key);
  if (i < 0) return 0;
  v.t = bag.types[i]; v.d = bag.data[i]; v.pkg = bag.styles[i] >>> 24; v.flags = bag.flags | flags;
  return bag.styles[i];
}

export function resolveAttributes(
  res: Resources, theme: JTheme | null, node: XmlNode | null, sourceResId: number,
  defStyleAttr: number, defStyleRes: number, attrs: ArrayLike<number>, srcValues: ArrayLike<number> | null,
  outValues: Int32Array | null, outIndices: Int32Array | null, outRVs: (RV | null)[] | null,
): void {
  const v = STYLED;
  let defStyleFlags = 0, xmlStyleFlags = 0, xmlStyle = 0;
  if (theme) {
    if (defStyleAttr && theme.getAttribute(defStyleAttr, v)) {
      if (v.t === TV.REFERENCE) defStyleRes = v.d;
      defStyleFlags = v.flags;
    }
    // the element's style=, which may itself be a theme attribute
    const styleAttr = node?.attrs.find((a) => a.name === "style" && !a.ns);
    if (styleAttr) {
      let t = styleAttr.type, d = styleAttr.data;
      if (t === TV.ATTRIBUTE) {
        if (theme.getAttribute(d, v)) { t = v.t; d = v.d; xmlStyleFlags = v.flags; } else t = TV.NULL;
      }
      if (t === TV.REFERENCE) xmlStyle = d;
    }
  } else defStyleRes = 0;
  const xmlBag = xmlStyle ? res.bag(xmlStyle) : null, defBag = defStyleRes ? res.bag(defStyleRes) : null;
  const xmlAttrs = node?.attrs;
  // both lists are normally in ascending id order (styleables are sorted, aapt2 sorts an element's
  // attributes), which lets one cursor walk them together as AOSP's attribute finders do
  const merge = !!xmlAttrs && ascending(attrs, (id) => id) && ascending(xmlAttrs, (a) => a.resId);
  let found = 0, cursor = 0;
  for (let ii = 0; ii < attrs.length; ii++) {
    const cur = attrs[ii];
    v.t = TV.NULL; v.d = 0; v.pkg = -1; v.flags = 0; v.resid = 0; v.density = 0;
    let source = 0, xa: XmlAttr | null = null;
    if (srcValues && srcValues[ii]) { v.t = TV.ATTRIBUTE; v.d = srcValues[ii]; }
    else if (xmlAttrs && cur) {
      if (merge) {
        while (cursor < xmlAttrs.length && xmlAttrs[cursor].resId < cur) cursor++;
        if (cursor < xmlAttrs.length && xmlAttrs[cursor].resId === cur) xa = xmlAttrs[cursor];
      } else for (let k = 0; k < xmlAttrs.length; k++) if (xmlAttrs[k].resId === cur) { xa = xmlAttrs[k]; break; }
      if (xa) { v.t = xa.type; v.d = xa.data; source = sourceResId; }
    }
    if (xmlBag && v.t === TV.NULL && v.d !== DATA_NULL_EMPTY) source = fromBag(xmlBag, cur, xmlStyleFlags, v) || source;
    if (defBag && v.t === TV.NULL && v.d !== DATA_NULL_EMPTY) source = fromBag(defBag, cur, defStyleFlags, v) || source;
    let fromTheme = false;
    if (v.t !== TV.NULL) {
      if (theme) theme.resolveAttributeReference(v); else res.resolveReference(v);
    } else if (v.d !== DATA_NULL_EMPTY && theme) {
      const t = theme.resolvedAttribute(cur);
      if (t) { v.t = t.t; v.d = t.d; v.pkg = t.pkg; v.flags = t.flags; v.resid = t.resid; v.density = t.density; fromTheme = true; }
    }
    // @null turns back into TYPE_NULL, having masked whatever lay beneath it
    if (v.t === TV.REFERENCE && v.d === 0) { v.t = TV.NULL; v.pkg = -1; }
    const has = v.t !== TV.NULL || v.d === DATA_NULL_EMPTY;
    if (outValues) {
      const at = ii * STYLE_NUM_ENTRIES;
      outValues[at] = v.t; outValues[at + 1] = v.d; outValues[at + 2] = res.cookieOf(v.pkg);
      outValues[at + 3] = v.resid; outValues[at + 4] = v.flags; outValues[at + 5] = v.density; outValues[at + 6] = source;
    }
    if (outIndices && has) outIndices[++found] = ii;
    if (outRVs) outRVs[ii] = !has ? null : fromTheme ? theme!.lookup(cur) : res.toRV(v, v.pkg < 0 ? xa : null);
  }
  if (outIndices) outIndices[0] = found;
}

export function obtainStyled(
  res: Resources, theme: JTheme | null, set: JAttrSet | null,
  attrIds: Int32Array | number[], defStyleAttr: number, defStyleRes: number,
): JTypedArray {
  // an XmlResourceParser used as AttributeSet carries its live JAttrSet in .set
  set = attrSet(set);
  const ta = new JTypedArray();
  ta.res = res; ta.theme = theme;
  ta.attrIds = attrIds;
  const n = attrIds.length;
  ta.vals = new Array(n);
  // asking is what counts, not finding: app classes reach their own framework attributes through
  // this same cascade, so an attribute nobody asks for is one nobody implements.
  for (let i = 0; i < n; i++) askedAttrs.add(attrIds[i]);
  resolveAttributes(res, theme, set?.node ?? null, 0, defStyleAttr, defStyleRes, attrIds, null, null, null, ta.vals);
  return ta;
}

/** Theme.obtainStyledAttributes(resId, attrs): the style as the default style, over the theme */
export function obtainStyleAttributes(res: Resources, theme: JTheme | null, styleId: number, attrIds: Int32Array): JTypedArray {
  return obtainStyled(res, theme, null, attrIds, 0, styleId);
}

/**
 * Finish a raw style/theme value the way an attribute lookup does: dereference a theme
 * attribute, mask @null, then resolve references. `styleLookup` deliberately returns the raw
 * value, so anything reading a style directly has to come through here — an app-side
 * TextAppearance compiles its android:textSize to a `@dimen/...` reference, and reading that
 * raw silently yields no size at all.
 */
export function resolveStyleValue(res: Resources, theme: JTheme | null | undefined, v: RV | null): RV | null {
  if (v && v.t === TV.ATTRIBUTE) v = theme?.lookup(v.d) ?? null;
  // aapt flattens @null as a reference to 0; AOSP's ApplyStyle turns it back into TYPE_NULL
  // only at the end, after it has masked any style/theme value beneath it
  if (v && v.t === TV.REFERENCE && !v.d) v = null;
  return v && v.t !== TV.NULL ? res.resolveRefs(v) : null;
}

/** the string resource `id` names, "" when it is not one */
export const resString = (res: Resources, id: number): string => rvString(res, res.ref(id)) ?? "";
function frameworkValue<T>(type: string, name: string, read: (res: Resources, v: RV) => T, missing: T): T {
  const res = currentResources(), id = res?.idFor(type, name, "android");
  return id ? read(res!, res!.ref(id)) : missing;
}
/** a com.android.internal string, as the platform's own UI labels things */
export function frameworkString(name: string): string | null { return frameworkValue("string", name, rvString, null); }
/** a com.android.internal dimension in pixels, 0 when the framework lacks it */
export function frameworkDimen(name: string): number { return frameworkValue("dimen", name, (res, v) => Math.round(rvDimen(res, v)), 0); }
export function bagStrings(res: Resources, id: number): string[] {
  const bag = res.bag(id);
  return bag ? [...bag.map.values()].map((v) => rvString(res, res.resolveRefs(v)) ?? "") : [];
}
export function rvString(res: Resources, v: RV | null): string | null {
  if (!v || v.t === TV.NULL) return null;
  if (v.s !== undefined && (v.t === T_STR || v.t === TV.STRING)) return v.s;
  if (v.t === TV.REFERENCE) {
    const rv = res.resolveRefs(v);
    if (rv !== v) return rvString(res, rv);
    return res.value(v.d).s ?? null;
  }
  if (v.t === TV.FLOAT) return String(v.d);
  if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4) return String(v.d);
  return v.s ?? null;
}
export function rvColor(res: Resources, v: RV | null, dflt = 0, depth = 0): number {
  if (!v || depth > 12) return dflt;
  if (v.t >= TV.COLOR_ARGB8 && v.t <= TV.COLOR_RGB4) return v.d;
  if (v.t >= TV.INT_DEC && v.t <= TV.INT_HEX) return v.d;
  if (v.t === TV.BOOLEAN) return v.d;
  if (v.t === TV.REFERENCE) {
    const r = res.resolveRefs(v);
    if (r === v || (r.t === TV.REFERENCE && r.d === v.d)) {
      // reference didn't resolve to a value → likely a color-selector xml; return its default color
      return colorFromSelector(res, v.d, dflt);
    }
    return rvColor(res, r, dflt, depth + 1);
  }
  if (v.t === T_STR && v.s?.startsWith("#")) return parseColor(v.s);
  return dflt;
}
function colorFromSelector(res: Resources, resId: number, dflt: number): number {
  const selCache = res.selectorCache;
  const c = selCache.get(resId);
  if (c !== undefined) return c;
  selCache.set(resId, dflt); // guard against re-entry
  const e = res.tbl(resId)?.entry(resId);
  if (e?.value) {
    if (e.value.type >= TV.COLOR_ARGB8 && e.value.type <= TV.COLOR_RGB4 || e.value.type >= TV.INT_DEC && e.value.type <= TV.INT_HEX) {
      selCache.set(resId, e.value.data); return e.value.data;
    }
    if (e.value.type === TV.STRING) {
      const f = res.fileOf(resId);
      const bytes = f?.path.endsWith(".xml") ? f.bytes : null;
      if (bytes) {
        try {
          const root = parseAXML(bytes);
          // pick the default (stateless) item color, else the first
          let picked = dflt, first: number | null = null;
          for (const item of root.children) {
            if (item.name !== "item") continue;
            const ca = item.attrs.find((a) => a.name === "color");
            if (!ca) continue;
            const col = ca.type >= TV.COLOR_ARGB8 && ca.type <= TV.COLOR_RGB4 ? ca.data
              : ca.type === TV.STRING && ca.str?.startsWith("#") ? parseColor(ca.str)
              : ca.type === TV.REFERENCE ? colorFromSelector(res, ca.data, dflt) : dflt;
            if (first === null) first = col;
            const stateless = item.attrs.every((a) => a.name === "color" || a.name === "alpha");
            if (stateless) { picked = col; break; }
          }
          const result = picked !== dflt ? picked : (first ?? dflt);
          selCache.set(resId, result);
          return result;
        } catch { /* */ }
      }
    }
  }
  return dflt;
}
/**
 * The theme the Context itself reports, memoized as its ownTheme so the synchronous themeOf()
 * agrees from then on. appcompat's ContextThemeWrapper is app dex holding its own
 * Resources.Theme, invisible to a base-chain walk — and it is the wrapper Material puts every
 * widget's ThemeOverlay in.
 */
export async function askTheme(ctx: unknown): Promise<JTheme | null> {
  const f = ctx && (ctx as Record<string, unknown>)[M_getTheme];
  if (typeof f === "function") {
    const r = (f as () => unknown).call(ctx);
    const t = r instanceof Promise ? await r : r;
    const native = nativeTheme(t);
    if (native) { (ctx as { ownTheme?: JTheme }).ownTheme = native; return native; }
  }
  return themeOf(ctx);
}
const props = new Map<string, string>();
/** a Java instance field of `cls`, on a bytecode object or a spec's */
export function javaField<T>(o: unknown, cls: string, name: string): T {
  const key = cls + "." + name;
  let p = props.get(key);
  if (p === undefined) props.set(key, p = rt.fieldProp(cls, name) ?? "");
  return (o as Record<string, T>)[p];
}
/** the AssetManager2 behind a Resources, ours or AOSP's */
export function nativeRes(jres: unknown): Resources {
  const host = (jres as { host?: Resources }).host;
  if (host instanceof Resources) return host;
  const impl = javaField<object>(jres, "android/content/res/Resources", "mResourcesImpl");
  const res = nativeAssets(javaField(impl, "android/content/res/ResourcesImpl", "mAssets"));
  res.dm = javaField<JDisplayMetrics>(impl, "android/content/res/ResourcesImpl", "mMetrics");
  res.jobj ??= jres;
  return res;
}
/** the AssetManager2 behind an AssetManager, ours or AOSP's */
export function nativeAssets(am: unknown): Resources {
  const host = (am as { host?: Resources }).host;
  return host instanceof Resources ? host : deref<Resources>(javaField(am, "android/content/res/AssetManager", "mObject"));
}
/** the native theme behind a Resources.Theme, ours or AOSP's */
export function nativeTheme(theme: unknown): JTheme | null {
  if (!theme || theme instanceof JTheme) return (theme as JTheme | null) ?? null;
  if (!rt.iof(theme, "android/content/res/Resources$Theme")) return null;
  const t = deref<JTheme>(javaField(javaField(theme, "android/content/res/Resources$Theme", "mThemeImpl"), "android/content/res/ResourcesImpl$ThemeImpl", "mTheme"));
  t.jobj = theme;
  return t;
}
/** the element an AttributeSet stands on: our own, a parser of ours, or AOSP's XmlBlock$Parser */
export function attrSet(set: unknown): JAttrSet | null {
  if (!set) return null;
  if (set instanceof JAttrSet) return set;
  if (set instanceof JXmlParser) return set.set;
  if (!rt.iof(set, "android/content/res/XmlBlock$Parser")) return null;
  return deref<JAttrSet>(javaField(set, "android/content/res/XmlBlock$Parser", "mParseState"));
}
export function themeOf(ctx: unknown): JTheme | null {
  for (let c = ctx as { ownTheme?: JTheme; base?: unknown } | null | undefined; c; c = c.base as typeof c) {
    if (c.ownTheme) return c.ownTheme;
  }
  return (ctx as { $host?: { theme?: JTheme } } | null)?.$host?.theme ?? null;
}
export function rvDimen(res: Resources, v: RV | null, dflt = 0): number {
  if (!v) return dflt;
  if (v.t === T_PX) return v.d;
  if (v.t === TV.DIMENSION) return complexToPx(v.d, res.dm);
  if (v.t === TV.FLOAT) return v.d;
  if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4) return v.d;
  return dflt;
}
export function rvInt(res: Resources, v: RV | null, dflt = 0): number {
  if (!v) return dflt;
  if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4) return v.d;
  if (v.t === TV.FLOAT) return Math.round(v.d);
  if (v.t === T_PX) return Math.round(v.d);
  if (v.t === TV.DIMENSION) return Math.round(complexToPx(v.d, res.dm));
  if (v.t === T_STR && v.s && /^-?\d+$/.test(v.s)) return parseInt(v.s);
  return dflt;
}
export function rvFloat(res: Resources, v: RV | null, dflt = 0): number {
  if (!v) return dflt;
  if (v.t === TV.FLOAT) return v.d;
  if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4) return v.d;
  if (v.t === T_PX) return v.d;
  if (v.t === T_STR && v.s) {
    const n = parseFloat(v.s);
    return Number.isNaN(n) ? dflt : n;
  }
  return dflt;
}

// fill a java TypedValue from RV
export function fillTypedValue(res: Resources, v: RV | null, tv: JTypedValue): number {
  if (!v || v.t === TV.NULL) { tv.type = 0; return 0; }
  tv.assetCookie = 1; // everything we can resolve came out of the app's one loaded apk
  if (v.t === T_PX) { tv.type = TV.DIMENSION; tv.data = pxToComplex(v.d); return 1; }
  if (v.t === T_STR) { tv.type = TV.STRING; tv.string = v.s ?? null; return 1; }
  tv.type = v.t;
  // a normalized RV carries a float as a number; TypedValue.data holds the IEEE bits, as getFloat reads them
  tv.data = v.t === TV.FLOAT ? floatToIntBits(v.d) : v.d;
  if (v.r) tv.resourceId = v.r;
  if (v.t === TV.STRING) tv.string = v.s ?? null;
  if (v.t === TV.REFERENCE) {
    // a reference that resolveRefs kept (a file resource) is, once resolved as AOSP does it,
    // the file's path string carrying the id it came from
    tv.resourceId = v.d;
    const f = res.value(v.d);
    if (f.t === TV.STRING) { tv.type = TV.STRING; tv.string = f.s ?? null; }
  }
  return 1;
}
function pxToComplex(px: number): number {
  return ((Math.round(px) & 0xffffff) << 8) | 0; // COMPLEX_UNIT_PX, radix 0
}
