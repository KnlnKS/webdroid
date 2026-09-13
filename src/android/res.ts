// Resources: the app's resource table and the android: one, addressed by the package byte of a
// resource id. Implements the full attribute-resolution cascade (XML → style → defStyle → theme).

import { Arsc } from "./arsc";
import { TV, parseAXML, type XmlNode } from "./axml";
import { JObj } from "../jvm/runtime";
import { JDisplayMetrics, JTypedValue, complexToPx } from "./util";
import { mangleMethod, intBitsToFloat, floatToIntBits } from "../jvm/abi";
import type { FileSource } from "../shell/lazyfile";

let fwPkg: Arsc | null = null;
const aidMemo = new Map<string, number>();
/** framework attr id by name, e.g. AID("textColor") */
export const AID = (name: string): number => {
  let v = aidMemo.get(name);
  if (v === undefined) { aidMemo.set(name, v = fwPkg?.findId("attr", name) ?? 0); if (v) askedAttrs.add(v); }
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

/** an app XML colour literal (#rgb … #aarrggbb) — the one raw string form still parsed */
function parseColor(raw: string): number {
  let h = raw.slice(1);
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h = "ff" + h;
  return parseInt(h, 16) | 0;
}
interface Bag { parent: number; map: Map<number, RV>; }

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
export function setResourceNight(night: boolean): void {
  configGen++;
  for (const r of allResources) {
    r.invalidate();
    if (r.arsc) r.arsc.device.night = night ? 1 : 0;
  }
  if (fwPkg) {
    fwPkg.device.night = night ? 1 : 0;
  }
}

export function setResourceLocale(lang: string, dir: number): void {
  configGen++;
  for (const r of allResources) {
    r.invalidate();
    if (r.arsc) Object.assign(r.arsc.device, { lang, dir });
  }
  if (fwPkg) Object.assign(fwPkg.device, { lang, dir });
}

/** Re-resolve orientation and size-qualified entries in every live resource table. */
export function setResourceOrientation(orientation: number, wdp: number, hdp: number, swdp: number): void {
  configGen++;
  const update = (a: Arsc) => Object.assign(a.device, { orientation, wdp, hdp, swdp });
  for (const r of allResources) {
    r.invalidate();
    if (r.arsc) update(r.arsc);
  }
  if (fwPkg) update(fwPkg);
}

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

export class Resources {
  arsc: Arsc | null;
  zip: Record<string, Uint8Array>;
  lazyEntries: Map<string, FileSource>;
  dm = new JDisplayMetrics();
  bagCache = new Map<number, Bag | null>();
  selectorCache = new Map<number, number>();
  private framework: Arsc | null | undefined;
  jobj: any = null; // android.content.res.Resources instance

  constructor(arsc: Arsc | null, zip: Record<string, Uint8Array>, lazyEntries = new Map<string, FileSource>(), scoped = false) {
    this.arsc = arsc;
    this.zip = zip;
    this.lazyEntries = lazyEntries;
    if (!scoped) allResources.push(this);
  }

  invalidate(): void { this.bagCache.clear(); this.selectorCache.clear(); configGen++; }

  scoped(qualifiers: Partial<Arsc["device"]>): Resources {
    const copy = (table: Arsc | null): Arsc | null => table && Object.assign(Object.create(table), { device: { ...table.device, ...qualifiers } });
    const res = new Resources(copy(this.arsc), this.zip, this.lazyEntries, true);
    res.framework = copy(this.tbl(0x01000000));
    Object.assign(res.dm, this.dm);
    return res;
  }

  /** the table a resource id belongs to: package 0x01 is the framework, anything else the app */
  tbl(resId: number): Arsc | null { return resId >>> 24 === 0x01 ? (this.framework === undefined ? fwPkg : this.framework) : this.arsc; }

  /** the archive path a file resource names, the package that owns it, and the id the
   *  reference chain ended on — everything but the bytes, which cost an inflate */
  pathOf(resId: number, depth = 0, selected?: { density: number }): { path: string; id: number; arsc: Arsc } | null {
    const a = this.tbl(resId);
    const e = a?.entry(resId, selected);
    if (!e?.value) return null;
    if (e.value.type === TV.REFERENCE && e.value.data && depth < 8) return this.pathOf(e.value.data, depth + 1, selected);
    if (e.value.type !== TV.STRING) return null;
    return { path: a!.values.get(e.value.data), id: resId, arsc: a! };
  }

  /** the archive entry a file resource names, out of the package that owns it */
  fileOf(resId: number): { path: string; bytes: Uint8Array } | null {
    const f = this.pathOf(resId);
    const bytes = f && f.arsc.files(f.path);
    return bytes ? { path: f!.path, bytes } : null;
  }

  /** id by type and name; a package name picks a table, otherwise the app is searched first */
  idFor(type: string, name: string, pkg = ""): number {
    if (pkg && pkg === fwPkg?.pkgName) return fwPkg.findId(type, name);
    return this.arsc?.findId(type, name) || fwPkg?.findId(type, name) || 0;
  }

  idType(resId: number): string {
    const a = this.tbl(resId);
    return a ? a.typeName((resId >> 16) & 0xff, resId & 0xffff) : "?";
  }
  idName(resId: number): string {
    return this.tbl(resId)?.entry(resId)?.key ?? "0x" + resId.toString(16);
  }

  /** simple value for resId (no bag). */
  value(resId: number): RV {
    if (!resId) return NULL_RV;
    const a = this.tbl(resId);
    const e = a?.entry(resId);
    if (!e?.value) return NULL_RV;
    const v: RV = { t: e.value.type, d: e.value.data };
    if (v.t === TV.STRING) v.s = a!.values.get(e.value.data);
    return normRV(v);
  }

  /** the resolved value behind resource id `id` — value(id) with its REFERENCE chain followed */
  ref(id: number): RV { return this.resolveRefs({ t: TV.REFERENCE, d: id }); }

  /** resolve REFERENCE chains (not ATTRIBUTE) */
  resolveRefs(v: RV, depth = 0): RV {
    while (v.t === TV.REFERENCE && v.d && depth++ < 20) {
      const t = this.idType(v.d);
      if (t === "drawable" || t === "layout" || t === "style" || t === "anim" || t === "xml" || t === "menu" || t === "mipmap" || t === "raw" || t === "font" || t === "id" || t === "transition" || t === "interpolator" || t === "animator") break; // keep as ref; caller loads
      const nv = this.value(v.d);
      if (nv.t === TV.NULL) break;
      if (nv.t === TV.REFERENCE && nv.d === v.d) break;
      // color/dimen entries whose value is a file reference (color selector xml)
      if (nv.t === TV.STRING && nv.s?.endsWith(".xml")) { v = { t: TV.REFERENCE, d: v.d, s: nv.s }; break; }
      v = { ...nv, r: v.d };
    }
    return v;
  }

  bag(resId: number): Bag | null {
    if (!resId) return null;
    let b = this.bagCache.get(resId);
    if (b !== undefined) return b;
    b = this.computeBag(resId);
    this.bagCache.set(resId, b);
    return b;
  }

  private computeBag(resId: number): Bag | null {
    const a = this.tbl(resId);
    const e = a?.entry(resId);
    if (!e?.bag) return null;
    const map = new Map<number, RV>();
    for (const [attr, vt, vd] of e.bag.map) {
      const v: RV = { t: vt, d: vd };
      if (v.t === TV.STRING) v.s = a!.values.get(vd);
      map.set(attr, normRV(v));
    }
    return { parent: e.bag.parent, map };
  }

  /** search style chain for attr */
  styleLookup(styleId: number, attrId: number, depth = 0): RV | null {
    let id = styleId;
    while (id && depth++ < 30) {
      const b = this.bag(id);
      if (!b) return null;
      const v = b.map.get(attrId);
      if (v) return v;
      id = b.parent;
    }
    return null;
  }
}

export class JTheme extends JObj {
  res!: Resources;
  styles: number[] = []; // applied in order; later wins
  cache = new Map<number, RV | null>();
  gen = configGen;

  apply(styleId: number) { this.styles.push(styleId); this.cache.clear(); }

  lookup(attrId: number, depth = 0): RV | null {
    if (this.gen !== configGen) { this.cache.clear(); this.gen = configGen; }
    if (depth === 0) {
      const c = this.cache.get(attrId);
      if (c !== undefined) return c;
    }
    let out: RV | null = null;
    for (let i = this.styles.length - 1; i >= 0 && !out; i--) {
      out = this.res.styleLookup(this.styles[i], attrId);
    }
    if (out && out.t === TV.ATTRIBUTE && depth < 20) out = this.lookup(out.d, depth + 1);
    if (out) out = this.res.resolveRefs(out);
    if (depth === 0) this.cache.set(attrId, out);
    return out;
  }
}

// AttributeSet wrapper over parsed AXML node
export class JAttrSet extends JObj {
  node: XmlNode | null = null;
  res!: Resources;
  theme: JTheme | null = null;
}

export class JXmlParser extends JObj {
  events: { type: number; node: XmlNode | null; depth: number }[] = [];
  pos = -1;
  res!: Resources;
  set = new JAttrSet();
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

export function obtainStyled(
  res: Resources, theme: JTheme | null, set: JAttrSet | null,
  attrIds: Int32Array | number[], defStyleAttr: number, defStyleRes: number,
): JTypedArray {
  // an XmlResourceParser used as AttributeSet carries its live JAttrSet in .set
  const inner = (set as unknown as { set?: JAttrSet } | null)?.set;
  if (inner instanceof JAttrSet) set = inner;
  const ta = new JTypedArray();
  ta.res = res; ta.theme = theme;
  ta.attrIds = attrIds;
  const n = attrIds.length;
  ta.vals = new Array(n).fill(null);
  // asking is what counts, not finding: app classes reach their own framework attributes through
  // this same cascade, so an attribute nobody asks for is one nobody implements.
  for (let i = 0; i < n; i++) askedAttrs.add(attrIds[i]);

  // 3/4. defStyle chain
  let defStyleId = 0;
  if (defStyleAttr && theme) {
    const v = theme.lookup(defStyleAttr);
    if (v && (v.t === TV.REFERENCE || v.t >= TV.INT_DEC)) defStyleId = v.d;
  }
  if (!defStyleId && defStyleRes) defStyleId = defStyleRes;

  // 2. style= attr in XML
  let xmlStyleId = 0;
  if (set?.node) {
    for (const a of set.node.attrs) {
      if (a.name === "style" && !a.ns) {
        // `style="?attr/materialButtonOutlinedStyle"` is a THEME ATTRIBUTE, not a style id —
        // every Material widget in a layout is styled this way, and taking the raw data left
        // them with no style at all.
        xmlStyleId = a.type === TV.ATTRIBUTE ? theme?.lookup(a.data)?.d ?? 0 : a.data;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const attrId = attrIds[i];
    if (!attrId) continue;
    let v: RV | null = null;
    // 1. direct XML attribute
    if (set?.node) {
      for (const a of set.node.attrs) {
        if (a.resId === attrId) {
          v = a.type === TV.STRING ? { t: T_STR, d: 0, s: a.str ?? "" } : normRV({ t: a.type, d: a.data });
          break;
        }
      }
    }
    if (!v && xmlStyleId) v = res.styleLookup(xmlStyleId, attrId);
    if (!v && defStyleId) v = res.styleLookup(defStyleId, attrId);
    if (!v && theme) v = theme.lookup(attrId);
    ta.vals[i] = resolveStyleValue(res, theme, v);
  }
  return ta;
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
  if (v.t >= TV.INT_DEC) return String(v.d);
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
    if (e.value.type >= TV.COLOR_ARGB8 && e.value.type <= TV.COLOR_RGB4) { selCache.set(resId, e.value.data); return e.value.data; }
    if (e.value.type >= TV.INT_DEC && e.value.type <= TV.INT_HEX) { selCache.set(resId, e.value.data); return e.value.data; }
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
    if (t instanceof JTheme) { (ctx as { ownTheme?: JTheme }).ownTheme = t; return t; }
  }
  return themeOf(ctx);
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
  if (v.t >= TV.INT_DEC) return v.d;
  return dflt;
}
export function rvInt(res: Resources, v: RV | null, dflt = 0): number {
  if (!v) return dflt;
  if (v.t >= TV.INT_DEC || v.t === TV.BOOLEAN) return v.d;
  if (v.t === TV.FLOAT) return Math.round(v.d);
  if (v.t === T_PX) return Math.round(v.d);
  if (v.t === TV.DIMENSION) return Math.round(complexToPx(v.d, res.dm));
  if (v.t === T_STR && v.s && /^-?\d+$/.test(v.s)) return parseInt(v.s);
  return dflt;
}
export function rvFloat(res: Resources, v: RV | null, dflt = 0): number {
  if (!v) return dflt;
  if (v.t === TV.FLOAT) return v.d;
  if (v.t >= TV.INT_DEC) return v.d;
  if (v.t === T_PX) return v.d;
  if (v.t === T_STR && v.s) return parseFloat(v.s) || dflt;
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
