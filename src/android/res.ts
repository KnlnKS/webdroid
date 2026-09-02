// Resources: unifies the app package (resources.arsc) with a synthetic "android"
// framework package generated from AOSP values (framework-res.json).
// Implements the full attribute-resolution cascade (XML → style → defStyle → theme).

import fw from "./framework-res.json";

/** framework attr id by name, e.g. AID("textColor") */
export const AID = (name: string): number => (fw.ids as any).attr?.[name] ?? 0;
import { Arsc } from "./arsc";
import { TV, parseAXML, type XmlNode } from "./axml";
import { JObj } from "../jvm/runtime";
import { JDisplayMetrics, JTypedValue, complexToPx } from "./os";

// ── framework tables
const fwIds = fw.ids as Record<string, Record<string, number>>;
const fwIdToName = new Map<number, [string, string]>();
for (const [type, m] of Object.entries(fwIds)) {
  for (const [name, id] of Object.entries(m)) fwIdToName.set(id, [type, name]);
}
// Private framework resources (ab_solid_dark_holo, material_grey_900 …) carry no public id.
// Mint a synthetic one so idName/idType still name them and the synthetic-drawable path can
// recognise them, instead of the whole attribute resolving to null.
let nextFwId = 0x01ff0000;
const fwMinted = new Map<string, number>();
function mintFwId(type: string, name: string): number {
  const k = type + "/" + name;
  let id = fwMinted.get(k);
  if (id === undefined) { fwMinted.set(k, (id = nextFwId++)); fwIdToName.set(id, [type, name]); }
  return id;
}
const fwAttrEnums = fw.attrEnums as Record<string, Record<string, number>>;
const fwStyles = fw.styles as Record<string, { parent: string; items: Record<string, string> }>;
const fwColors = fw.colors as Record<string, string>;
const fwDimens = fw.dimens as Record<string, string>;

// resolved value: binary Res_value types + internal PX (0xfe) and STR (0xfd)
export interface RV { t: number; d: number; s?: string }
export const T_PX = 0xfe, T_STR = 0xfd;
const NULL_RV: RV = { t: TV.NULL, d: 0 };
const fbuf = new DataView(new ArrayBuffer(4));
/** binary Res_value → RV with FLOAT bits decoded to a JS number */
export function normRV(v: RV): RV {
  if (v.t === TV.FLOAT) { fbuf.setInt32(0, v.d); return { t: TV.FLOAT, d: fbuf.getFloat32(0), s: v.s }; }
  return v;
}

export function parseFwValue(raw: string, attrName: string | null, res: Resources, depth = 0): RV | null {
  if (!raw) return NULL_RV;
  if (raw === "@null" || raw === "@empty") return NULL_RV;
  if (raw[0] === "#") {
    let h = raw.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length === 6) h = "ff" + h;
    return { t: TV.COLOR_ARGB8, d: parseInt(h, 16) | 0 };
  }
  if (raw[0] === "@" || raw[0] === "?") {
    const attr = raw[0] === "?";
    const body = raw.slice(1).replace(/^android:/, "").replace(/^\*?android:/, "");
    const [typeRaw, name] = body.includes("/") ? body.split("/") : ["attr", body];
    const type = typeRaw.replace("android:", "");
    const id = fwIds[type]?.[name] ?? res.appIdFor(type, name);
    // Private framework resources (material_grey_900 etc.) carry no public id but do have a
    // value in the generated tables — inline it rather than dropping the whole attribute.
    if (!id && !attr && depth < 8) {
      const inline = type === "color" ? fwColors[name] : type === "dimen" ? fwDimens[name] : undefined;
      if (inline) return parseFwValue(inline, attrName, res, depth + 1);
    }
    if (!id && !attr) return { t: TV.REFERENCE, d: mintFwId(type, name) };
    if (!id) return NULL_RV;
    return { t: attr ? TV.ATTRIBUTE : TV.REFERENCE, d: id };
  }
  const dm = /^(-?[\d.]+)(dp|dip|sp|px|pt|mm|in)$/.exec(raw);
  if (dm) {
    const v = parseFloat(dm[1]);
    const density = res.dm.density;
    const px = dm[2] === "px" ? v : dm[2] === "sp" ? v * res.dm.scaledDensity : dm[2] === "pt" ? v * density * 160 / 72 : v * density;
    return { t: T_PX, d: px };
  }
  if (raw === "true") return { t: TV.BOOLEAN, d: 1 };
  if (raw === "false") return { t: TV.BOOLEAN, d: 0 };
  if (/^-?\d+$/.test(raw)) return { t: TV.INT_DEC, d: parseInt(raw) | 0 };
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return { t: TV.INT_HEX, d: parseInt(raw, 16) | 0 };
  if (/^-?[\d.]+(e-?\d+)?$/.test(raw)) return { t: TV.FLOAT, d: parseFloat(raw) };
  if (/^[\d.]+%p?$/.test(raw)) return { t: TV.FRACTION, d: parseFloat(raw) / 100 };
  if (attrName) {
    const en = fwAttrEnums[attrName];
    if (en) {
      let acc = 0, ok = true;
      for (const part of raw.split("|")) {
        if (en[part] !== undefined) acc |= en[part];
        else ok = false;
      }
      if (ok) return { t: TV.INT_HEX, d: acc };
    }
  }
  return { t: T_STR, d: 0, s: raw };
}

interface Bag { parent: number; map: Map<number, RV>; }

/**
 * Every resource memo below is only valid for one device Configuration: the same id resolves to
 * a different entry once a qualifier changes (`-night` above all). setResourceNight() bumps this
 * generation so the caches — and every JTheme, which memoises attribute lookups — reload.
 */
let configGen = 0;
const allResources: Resources[] = [];
export function setResourceNight(night: boolean): void {
  configGen++;
  selCache.clear();
  for (const r of allResources) {
    r.bagCache.clear();
    if (r.arsc) r.arsc.device.night = night ? 1 : 0;
  }
}

export class Resources {
  arsc: Arsc | null;
  zip: Record<string, Uint8Array>;
  dm = new JDisplayMetrics();
  fwStyleBags = new Map<string, Bag | null>();
  fwStyleIds = new Map<number, string>();
  bagCache = new Map<number, Bag | null>();
  jobj: any = null; // android.content.res.Resources instance

  constructor(arsc: Arsc | null, zip: Record<string, Uint8Array>) {
    this.arsc = arsc;
    this.zip = zip;
    for (const [name, id] of Object.entries(fwIds.style ?? {})) this.fwStyleIds.set(id, name);
    allResources.push(this);
  }

  appIdFor(type: string, name: string): number {
    return this.arsc?.findId(type, name) ?? 0;
  }

  idType(resId: number): string {
    if (resId >>> 24 === 0x01) return fwIdToName.get(resId)?.[0] ?? "?";
    return this.arsc ? this.arsc.typeName((resId >> 16) & 0xff) : "?";
  }
  idName(resId: number): string {
    if (resId >>> 24 === 0x01) return fwIdToName.get(resId)?.[1] ?? "0x" + resId.toString(16);
    return this.arsc?.entry(resId)?.key ?? "0x" + resId.toString(16);
  }

  /** simple value for resId (no bag). */
  value(resId: number): RV {
    if (!resId) return NULL_RV;
    if (resId >>> 24 === 0x01) {
      const tn = fwIdToName.get(resId);
      if (!tn) return NULL_RV;
      const [type, name] = tn;
      if (type === "color") return parseFwValue(fwColors[name] ?? "#ff000000", null, this) ?? NULL_RV;
      if (type === "dimen") return parseFwValue(fwDimens[name] ?? "0dp", null, this) ?? NULL_RV;
      if (type === "string") return { t: T_STR, d: 0, s: (fw.strings as Record<string, string>)[name] ?? name };
      if (type === "bool") return { t: TV.BOOLEAN, d: name.includes("true") ? 1 : 0 };
      if (type === "integer") return { t: TV.INT_DEC, d: 0 };
      if (type === "drawable" || type === "style" || type === "layout" || type === "id" || type === "attr" || type === "mipmap" || type === "anim" || type === "interpolator" || type === "transition" || type === "array") {
        return { t: TV.REFERENCE, d: resId };
      }
      return NULL_RV;
    }
    const e = this.arsc?.entry(resId);
    if (!e || !e.value) return NULL_RV;
    const v: RV = { t: e.value.type, d: e.value.data };
    if (v.t === TV.STRING) v.s = this.arsc!.values.get(e.value.data);
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
      // app color/dimen entries whose value is a file reference (color selector xml)
      if (nv.t === TV.STRING && nv.s?.endsWith(".xml")) { v = { t: TV.REFERENCE, d: v.d, s: nv.s }; break; }
      v = nv;
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
    if (resId >>> 24 === 0x01) {
      const name = this.fwStyleIds.get(resId) ?? fwIdToName.get(resId)?.[1];
      return name ? this.fwBagByName(name) : null;
    }
    const e = this.arsc?.entry(resId);
    if (!e?.bag) return null;
    const map = new Map<number, RV>();
    for (const [attr, vt, vd] of e.bag.map) {
      const v: RV = { t: vt, d: vd };
      if (v.t === TV.STRING) v.s = this.arsc!.values.get(vd);
      map.set(attr, normRV(v));
    }
    return { parent: e.bag.parent, map };
  }

  fwBagByName(name: string): Bag | null {
    let b = this.fwStyleBags.get(name);
    if (b !== undefined) return b;
    const st = fwStyles[name];
    if (!st) { this.fwStyleBags.set(name, null); return null; }
    const map = new Map<number, RV>();
    for (const [attrName, raw] of Object.entries(st.items)) {
      const attrId = fwIds.attr?.[attrName];
      if (!attrId) continue;
      const v = parseFwValue(raw, attrName, this);
      if (v) map.set(attrId, v);
    }
    const parentId = st.parent ? fwIds.style?.[st.parent] ?? 0 : 0;
    b = { parent: parentId, map };
    this.fwStyleBags.set(name, b);
    return b;
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

// ── Theme
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
      if (a.name === "style" && !a.ns) xmlStyleId = a.data;
      if (a.resId === 0x01010000 /* theme attr on view */) { /* ignored here */ }
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
    if (v && v.t === TV.ATTRIBUTE) v = theme?.lookup(v.d) ?? null;
    // aapt flattens @null as a reference to 0; AOSP's ApplyStyle turns it back into TYPE_NULL
    // only at the end, after it has masked any style/theme value beneath it
    if (v && v.t === TV.REFERENCE && !v.d) v = null;
    if (v && v.t !== TV.NULL) ta.vals[i] = res.resolveRefs(v);
  }
  return ta;
}

// value coercion helpers
/** the string resource `id` names, "" when it is not one */
export const resString = (res: Resources, id: number): string => rvString(res, res.ref(id)) ?? "";
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
  if (v.t === T_STR && v.s?.startsWith("#")) return parseFwValue(v.s, null, res)?.d ?? dflt;
  return dflt;
}
const selCache = new Map<number, number>();
function colorFromSelector(res: Resources, resId: number, dflt: number): number {
  const c = selCache.get(resId);
  if (c !== undefined) return c;
  selCache.set(resId, dflt); // guard against re-entry
  const e = res.arsc?.entry(resId);
  if (e?.value) {
    if (e.value.type >= TV.COLOR_ARGB8 && e.value.type <= TV.COLOR_RGB4) { selCache.set(resId, e.value.data); return e.value.data; }
    if (e.value.type >= TV.INT_DEC && e.value.type <= TV.INT_HEX) { selCache.set(resId, e.value.data); return e.value.data; }
    if (e.value.type === TV.STRING) {
      const path = res.arsc!.values.get(e.value.data);
      const bytes = path && path.endsWith(".xml") ? res.zip[path] : null;
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
              : ca.type === TV.STRING && ca.str?.startsWith("#") ? (parseFwValue(ca.str, null, res)?.d ?? dflt)
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
  tv.data = v.d;
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
