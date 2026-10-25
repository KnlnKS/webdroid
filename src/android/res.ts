// Resources: AssetManager2, the resource tables of the loaded apks addressed by the package byte of a
// resource id, with its themes and the attribute-resolution cascade (XML → style → defStyle → theme).

import type { Arsc, Qualifiers } from "./arsc.ts";
import { TV, type XmlNode, type XmlAttr } from "./axml.ts";
import { getDeclared } from "../jvm/runtime.ts";
import { deref } from "./handles.ts";
import { intBitsToFloat } from "../jvm/abi.ts";
import type { FileSource } from "../shell/lazyfile.ts";

/**
 * A value as AssetManager2 selects it (its SelectedValue): the Res_value, the package id of the
 * table its entry came from (-1 for an XML attribute's own value, AOSP's kInvalidCookie), the
 * configuration axes its entries vary over, the resource it was read from and the density of the
 * configuration that answered. FLOAT data stays as its bits.
 */
export interface SV { t: number; d: number; pkg: number; flags: number; resid: number; density: number }
export const newSV = (): SV => ({ t: TV.NULL, d: 0, pkg: -1, flags: 0, resid: 0, density: 0 });
/** Res_value::DATA_NULL_EMPTY: @empty, a TYPE_NULL that still counts as a value */
const DATA_NULL_EMPTY = 1;
const isValidResid = (id: number) => (id & 0x00ff0000) !== 0 && (id & 0xff000000) !== 0;

/** A bag with its parents merged in, keys ascending, child entries winning (AssetManager2::GetBag):
 *  entry i is (types[i], data[i]) out of style styles[i], whose table its strings index. */
export class Bag {
  readonly parent: number; readonly flags: number; readonly keys: Int32Array; readonly types: Uint8Array; readonly data: Int32Array; readonly styles: Int32Array;
  constructor(parent: number, flags: number, keys: Int32Array,
    types: Uint8Array, data: Int32Array, styles: Int32Array) { this.parent = parent; this.flags = flags; this.keys = keys; this.types = types; this.data = data; this.styles = styles; }
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
}
const SEL = { density: 0 };

/** the native half of an ApkAssets: one archive and its resource table */
export interface Apk { table: Arsc | null; zip: Record<string, Uint8Array>; lazyEntries: Map<string, FileSource> }
export const emptyApk = (): Apk => ({ table: null, zip: {}, lazyEntries: new Map() });

/** AssetManager2: its apks' tables by package id, selecting under one configuration. */
export class Resources {
  bagCache = new Map<number, Bag | null>();
  /** Selection changes invalidate this AssetManager's bags and its themes' resolved values. */
  generation = 0;
  /** the apks in cookie order */
  apks: Apk[] = [];
  qualifiers: Qualifiers;
  /** by package id: the table that defines it and the 1-based cookie of that table's apk, -1 for none */
  private tables: (Arsc | undefined)[] = [];
  private cookies = new Int8Array(256);

  constructor(apks: Apk[], qualifiers: Qualifiers) { this.qualifiers = qualifiers; this.setApks(apks); }

  invalidate(): void { this.bagCache.clear(); this.generation++; }

  /** AssetManager2::SetApkAssets: a package id belongs to the first apk that defines it */
  setApks(apks: Apk[]): void {
    this.apks = apks;
    const cookies = this.cookies.fill(-1), tables: (Arsc | undefined)[] = this.tables = [];
    apks.forEach(({ table }, i) => { if (table) for (const id of table.packageIds()) if (cookies[id] < 0) { cookies[id] = i + 1; tables[id] = table; } });
    this.invalidate();
  }
  /** AssetManager2::SetConfigurations: select under these qualifiers from now on */
  configure(qualifiers: Qualifiers): void { this.qualifiers = qualifiers; this.invalidate(); }
  /** the Java cookie of the apk a package id's table came from: 1-based, -1 for none */
  cookieOf(pkg: number): number { return pkg < 0 ? -1 : this.cookies[pkg]; }

  /** the table a resource id's package belongs to */
  tbl(resId: number): Arsc | undefined { return this.tables[resId >>> 24]; }
  /** the entry `resId` selects */
  entry(resId: number) { return this.tbl(resId)?.entry(resId, this.qualifiers) ?? null; }

  /** AssetManager2::GetResource into `out`; false when `resid` names nothing, or a bag and
   *  `mayBeBag` is false. A bag reads back as a reference to itself. */
  getResource(resid: number, mayBeBag: boolean, out: SV, density = 0): boolean {
    const a = this.tbl(resid);
    SEL.density = 0;
    const e = a?.entry(resid, this.qualifiers, SEL, density || undefined);
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

  /** a TYPE_STRING value out of its package's pool; null for an XML attribute's own string or another type */
  string(v: SV): string | null { return v.t === TV.STRING && v.pkg >= 0 ? this.tbl(v.pkg << 24)?.values.get(v.d) ?? null : null; }

  /** the bag `resId` names with its parents merged in, or null (AssetManager2::GetBag) */
  bag(resId: number): Bag | null {
    if (!resId) return null;
    let b = this.bagCache.get(resId);
    if (b === undefined) this.bagCache.set(resId, b = this.computeBag(resId, [resId]));
    return b;
  }

  private computeBag(resId: number, chain: number[]): Bag | null {
    const a = this.tbl(resId);
    const e = a?.entry(resId, this.qualifiers);
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
    return new Bag(parentId, flags | (parent?.flags ?? 0), keys.subarray(0, k), types.subarray(0, k), data.subarray(0, k), styles.subarray(0, k));
  }
}

interface ThemeEntry { t: number; d: number; pkg: number; flags: number }
/** A theme's native half (AssetManager2's Theme): the attributes of the styles applied to it,
 *  merged as Theme::ApplyStyle merges them. */
export class NativeTheme {
  res: Resources;
  constructor(res: Resources) { this.res = res; this.gen = res.generation; }
  entries = new Map<number, ThemeEntry>();
  /** the styles applied so far, with their force flags, in pairs */
  applied: number[] = [];
  flags = 0;
  /** resolved values (AOSP caches them too), valid for one selection generation; AOSP's ThemeImpl
   *  rebases the theme when a qualifier changes */
  private resolved = new Map<number, SV | null>();
  private gen: number;

  private sync(): void {
    if (this.gen === this.res.generation) return;
    this.gen = this.res.generation;
    this.resolved.clear();
  }
  private replay(applied: number[]): void {
    this.entries.clear(); this.flags = 0; this.applied = [];
    for (let i = 0; i < applied.length; i += 2) this.apply(applied[i], applied[i + 1] !== 0);
  }

  apply(styleId: number, force = true): void {
    this.sync();
    this.applied.push(styleId, force ? 1 : 0);
    this.resolved.clear();
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
  /** Theme::SetTo. A theme copied onto another AssetManager's tables, where the same styles select
   *  other values, re-applies them there. */
  setTo(o: NativeTheme): void {
    o.sync();
    this.resolved.clear();
    if (this.res !== o.res) { this.replay(o.applied); return; }
    this.gen = this.res.generation;
    this.entries = new Map(o.entries); this.flags = o.flags; this.applied = o.applied.slice();
  }
  /** Theme::Rebase: these styles over another AssetManager */
  rebase(res: Resources, styles: number[]): void { this.res = res; this.gen = res.generation; this.resolved.clear(); this.replay(styles); }

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
}

/** AOSP's TypedArray layout: STYLE_NUM_ENTRIES ints per attribute, (type, data, assetCookie,
 *  resourceId, changingConfigurations, density, sourceResourceId). */
export const STYLE_NUM_ENTRIES = 7;
const STYLED = newSV();

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

/**
 * libandroidfw's AttributeResolution in one pass: ApplyStyle with a theme (XML attribute, the
 * XML's style=, the default style, then the theme), ResolveAttrs when `srcValues` stands in for
 * the XML, RetrieveAttributes without a theme (XML attributes only). Each value lands in
 * `outValues`/`outIndices` in TypedArray's layout.
 */
export function resolveAttributes(
  res: Resources, theme: NativeTheme | null, node: XmlNode | null, sourceResId: number,
  defStyleAttr: number, defStyleRes: number, attrs: ArrayLike<number>, srcValues: ArrayLike<number> | null,
  outValues: Int32Array, outIndices: Int32Array | null,
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
    if (v.t !== TV.NULL) {
      if (theme) theme.resolveAttributeReference(v); else res.resolveReference(v);
    } else if (v.d !== DATA_NULL_EMPTY && theme) {
      const t = theme.resolvedAttribute(cur);
      if (t) { v.t = t.t; v.d = t.d; v.pkg = t.pkg; v.flags = t.flags; v.resid = t.resid; v.density = t.density; }
    }
    // @null turns back into TYPE_NULL, having masked whatever lay beneath it
    if (v.t === TV.REFERENCE && v.d === 0) { v.t = TV.NULL; v.pkg = -1; }
    const at = ii * STYLE_NUM_ENTRIES;
    outValues[at] = v.t; outValues[at + 1] = v.d; outValues[at + 2] = res.cookieOf(v.pkg);
    outValues[at + 3] = v.resid; outValues[at + 4] = v.flags; outValues[at + 5] = v.density; outValues[at + 6] = source;
    if (outIndices && (v.t !== TV.NULL || v.d === DATA_NULL_EMPTY)) outIndices[++found] = ii;
  }
  if (outIndices) outIndices[0] = found;
}

const RESOLVED = newSV();
/** a value with its references followed through `res`, as a TypedArray reads an XML attribute; the
 *  result is scratch, read before the next call */
export function resolved(res: Resources, t: number, d: number): SV {
  const v = RESOLVED;
  v.t = t; v.d = d; v.pkg = -1; v.flags = 0; v.resid = 0; v.density = 0;
  res.resolveReference(v);
  return v;
}
/** the string resource `id` names, "" when it is none: a file resource names its path, a number reads in decimal */
export function resString(res: Resources, id: number): string {
  const v = resolved(res, TV.REFERENCE, id);
  if (v.t === TV.STRING) return res.string(v) ?? "";
  if (v.t === TV.FLOAT) return String(intBitsToFloat(v.d));
  return v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4 ? String(v.d) : "";
}
/** the AssetManager2 behind AOSP's AssetManager */
export function nativeAssets(am: unknown): Resources {
  return deref<Resources>(getDeclared(am, "android/content/res/AssetManager", "mObject"));
}
