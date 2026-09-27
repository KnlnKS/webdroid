// Java-facing android.content.res.* on top of res.ts + drawable.ts

import { rt, JObj, type NativeSpec, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { device } from "../shell/config";
import { newXmlPullParser, newXmlSerializer } from "./xmlpull";
import { parseSax } from "./sax";
import { Resources, currentResources, setResourceLocale, setResourceNight, setResourceOrientation, JTheme, JAttrSet, JTypedArray, JXmlParser, obtainStyled, obtainStyleAttributes, rvString, rvColor, rvDimen, rvInt, rvFloat, fillTypedValue, T_PX, T_STR, type RV, normRV, bagStrings } from "./res";
import { loadDrawable, loadColorStateList, mkCsl, loadDrawableRV, type JColorStateList } from "./drawable";
import { JTypedValue, complexToFraction, type JDisplayMetrics } from "./util";
import { TV, parseAXML, parseAXMLDoc, xmlAttrString, type XmlNode, type XmlAttr } from "./axml";
import { sizeClass } from "./arsc";
import { javaFormat, defineException, vcall, after } from "../jvm/natives/jlang";
import { type JLocale, localeTag, localeDirection, usLocale } from "../jvm/natives/jvalues";
import { jarray } from "../jvm/abi";
import { streamOf, streamOfSource } from "../jvm/natives/jio";
import { mkPfd } from "./os";
import { BytesFile, readFully, type FileSource } from "../shell/lazyfile";
import { fontResource } from "./fonts";
import { type JParcel, readString, writeString } from "./parcel";
import { parcelCreator } from "./parcelable";
import { annotatedResource } from "./text";
import { appHost } from "./apphost";

export class JResources extends JObj {
  host!: Resources;
  config: JConfiguration | null = null;
}
/** a raw resource's file and its bytes, filling `value` as the table resolves it */
function rawResource(res: Resources, id: number, value?: JTypedValue) {
  const file = res.pathOf(id, 0, value);
  const bytes = file?.arsc.files(file.path);
  if (!file || !bytes) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Resource 0x" + id.toString(16));
  return { file, bytes };
}
function openRawResource(this: JResources, id: number, value = new JTypedValue()) {
  const { file, bytes } = rawResource(this.host, id, value);
  fillTypedValue(this.host, { t: TV.REFERENCE, d: file.id }, value);
  return streamOf(bytes);
}
function openRawResourceFd(this: JResources, id: number) { return mkAssetFd(rawResource(this.host, id).bytes); }
/** the app's Resources double as the system ones: framework attrs resolve through the same table */
let systemRes: JResources | null = null;
export function mkJResources(host: Resources, system = true): JResources {
  rt.link("android/content/res/Resources");
  const r = new JResources();
  r.host = host;
  host.jobj = r;
  if (system) systemRes = r;
  return r;
}
export class JLocaleList extends JObj { values: JLocale[] = []; }
const emptyLocaleList = new JLocaleList();
const localeList = Object.assign(new JLocaleList(), { values: [usLocale] });
const sameLocale = (a: JLocale | null, b: JLocale | null) => a === b || !!a && !!b &&
  a.lang === b.lang && a.country === b.country && a.script === b.script && a.variant === b.variant;
function configLocales(c: JConfiguration): JLocaleList {
  if (!sameLocale(c.locale, c.locales.values[0] ?? null)) {
    c.locales = c.locale ? Object.assign(new JLocaleList(), { values: [c.locale] }) : emptyLocaleList;
  }
  return c.locales;
}
function setLocales(c: JConfiguration, list: JLocaleList | null): void {
  c.locales = list || emptyLocaleList;
  c.locale = c.locales.values[0] ?? null;
  c.screenLayout = (c.screenLayout & ~0xc0) | ((localeDirection(c.locale) + 1) << 6);
}
export class JConfiguration extends JObj {
  orientation = device.orientation;
  screenWidthDp = device.widthDp; screenHeightDp = device.heightDp;
  smallestScreenWidthDp = device.smallestWidthDp;
  densityDpi = device.densityDpi;
  fontScale = 1;
  // UI_MODE_TYPE_NORMAL | the device's night bit
  uiMode = 0x01 | (device.night ? 0x20 : 0x10);
  locale: JLocale | null = null;
  locales = emptyLocaleList;
  mcc = 0; mnc = 0; touchscreen = 3; keyboard = 1; keyboardHidden = 2; navigation = 1;
  navigationHidden = 2; hardKeyboardHidden = 2; screenLayout = 0x10 | sizeClass(device.smallestWidthDp); // SCREENLAYOUT_LONG_NO
  fontWeightAdjustment = 0;  // accessibility "bold text" is off, so no weight is added
  colorMode = 1 | 4;         // WIDE_COLOR_GAMUT_NO | HDR_NO: a plain sRGB canvas
}
const CONFIG_FIELDS = ["orientation", "screenWidthDp", "screenHeightDp", "smallestScreenWidthDp", "densityDpi", "fontScale", "uiMode",
  "mcc", "mnc", "touchscreen", "keyboard", "keyboardHidden", "navigation", "navigationHidden", "hardKeyboardHidden", "screenLayout",
  "fontWeightAdjustment", "colorMode"] as const;
/** AOSP compareTo(...) == 0: every public field, not identity (appcompat's resource caches keep a
 *  COPY of the configuration they were filled under and compare it against the live one) */
function configEquals(a: JConfiguration, b: JConfiguration): boolean {
  for (const k of CONFIG_FIELDS) if (a[k] !== b[k]) return false;
  const al = configLocales(a).values, bl = configLocales(b).values;
  return al.length === bl.length && al.every((l, i) => sameLocale(l, bl[i]));
}
rt.register({
  name: "android/content/res/Configuration", ctor: JConfiguration,
  fields: ["orientation", "screenWidthDp", "screenHeightDp", "smallestScreenWidthDp", "densityDpi", "fontScale",
    "uiMode", "locale", "mcc", "mnc", "touchscreen", "keyboard", "keyboardHidden", "navigation", "navigationHidden",
    "hardKeyboardHidden", "screenLayout", "fontWeightAdjustment", "colorMode"],
  methods: {
    "<init>(Landroid/content/res/Configuration;)V": function (this: JConfiguration, o: JConfiguration) {
      if (o) Object.assign(this, o);
    },
    "setTo(Landroid/content/res/Configuration;)V": function (this: JConfiguration, o: JConfiguration) { Object.assign(this, o); },
    ...noops("<init>()V"),
    ...stubs(0, "diff(Landroid/content/res/Configuration;)I", "updateFrom(Landroid/content/res/Configuration;)I"),
    "equals(Ljava/lang/Object;)Z": function (this: JConfiguration, o: unknown) { return o instanceof JConfiguration && configEquals(this, o) ? 1 : 0; },
    "equals(Landroid/content/res/Configuration;)Z": function (this: JConfiguration, o: JConfiguration | null) { return o && configEquals(this, o) ? 1 : 0; },
    "hashCode()I": function (this: JConfiguration) {
      let h = 17;
      for (const k of CONFIG_FIELDS) h = (h * 31 + ((this as any)[k] | 0)) | 0;
      return h;
    },
    "getLocales()Landroid/os/LocaleList;": function (this: JConfiguration) { return configLocales(this); },
    "setLocales(Landroid/os/LocaleList;)V": function (this: JConfiguration, list: JLocaleList | null) { setLocales(this, list); },
    "setLocale(Ljava/util/Locale;)V": function (this: JConfiguration, locale: JLocale | null) {
      setLocales(this, locale ? Object.assign(new JLocaleList(), { values: [locale] }) : null);
    },
    "setLayoutDirection(Ljava/util/Locale;)V": function (this: JConfiguration, locale: JLocale | null) {
      this.screenLayout = (this.screenLayout & ~0xc0) | ((localeDirection(locale) + 1) << 6);
    },
    "getLayoutDirection()I": function (this: JConfiguration) { return (this.screenLayout & 0xc0) === 0x80 ? 1 : 0; },
    "isNightModeActive()Z": function (this: JConfiguration) { return (this.uiMode & 0x30) === 0x20 ? 1 : 0; },
    "isLayoutSizeAtLeast(I)Z": function (this: JConfiguration, size: number) { const cur = this.screenLayout & 15; return cur && cur >= size ? 1 : 0; },
    "isScreenWideColorGamut()Z": function (this: JConfiguration) { return (this.colorMode & 3) === 2 ? 1 : 0; },
    "isScreenHdr()Z": function (this: JConfiguration) { return (this.colorMode & 12) === 8 ? 1 : 0; },
  },
});
// API 33 per-app languages: the app's own list, empty to follow the system's. The host persists
// it and delivers the configuration change; adopting it is applyApplicationLocales below.
let appLocales = emptyLocaleList;
rt.register({
  name: "android/app/LocaleManager", ctor: class extends JObj {},
  methods: {
    "getApplicationLocales()Landroid/os/LocaleList;": () => appLocales,
    "getApplicationLocales(Ljava/lang/String;)Landroid/os/LocaleList;": (pkg: string) => {
      if (pkg !== appHost?.pkg) throw rt.mkThrowable("java/lang/SecurityException", "Reading another app's locales requires READ_APP_SPECIFIC_LOCALES");
      return appLocales;
    },
    "setApplicationLocales(Landroid/os/LocaleList;)V": (list: JLocaleList | null) => {
      if (!list) rt.npe();
      appHost?.setApplicationLocales(list!);
    },
    "getSystemLocales()Landroid/os/LocaleList;": () => localeList,
    "getOverrideLocaleConfig()Landroid/app/LocaleConfig;": () => null,
  },
});
rt.register({
  name: "android/os/LocaleList", ctor: JLocaleList, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/os/LocaleList", readLocaleList); } },
  methods: {
    "<init>([Ljava/util/Locale;)V": function (this: JLocaleList, locales: JLocale[]) {
      if (!locales || locales.some(l => !l)) throw rt.mkThrowable("java/lang/NullPointerException", "locales");
      this.values = locales.filter((l, i) => locales.findIndex(other => sameLocale(l, other)) === i);
    },
    "static getDefault()Landroid/os/LocaleList;": () => configLocales(theConfig),
    "static getAdjustedDefault()Landroid/os/LocaleList;": () => configLocales(theConfig),
    "static getEmptyLocaleList()Landroid/os/LocaleList;": () => emptyLocaleList,
    "static forLanguageTags(Ljava/lang/String;)Landroid/os/LocaleList;": driven(function* (tags: string | null): Gen {
      const list = new JLocaleList();
      for (const t of (tags ?? "").split(",").filter(Boolean)) list.values.push(yield vcall(rt.link("java/util/Locale").ctor, "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", t.trim()));
      return list;
    }),
    "get(I)Ljava/util/Locale;": function (this: JLocaleList, i: number) { return this.values[i] ?? null; },
    "size()I": function (this: JLocaleList) { return this.values.length; },
    "isEmpty()Z": function (this: JLocaleList) { return this.values.length === 0 ? 1 : 0; },
    "toLanguageTags()Ljava/lang/String;": function (this: JLocaleList) { return this.values.map(localeTag).join(","); },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JLocaleList, parcel: JParcel) { writeString(parcel, this.values.map(localeTag).join(",")); },
  },
});
export function readLocaleList(parcel: JParcel): Promise<JLocaleList> {
  return vcall(rt.link("android/os/LocaleList").ctor, "forLanguageTags", "(Ljava/lang/String;)Landroid/os/LocaleList;", readString(parcel));
}

/**
 * The one device Configuration every Resources reports. Night mode is device state, not an app
 * constant: an app changes it by handing us a Configuration through Resources.updateConfiguration
 * (that is what AppCompat's day/night delegate does), and Compose's isSystemInDarkTheme(), the
 * `-night` resource qualifier and the window background all read the bit back off this object.
 */
const theConfig = new JConfiguration();
setLocales(theConfig, localeList);
const isNight = () => (theConfig.uiMode & 0x30) === 0x20;
/** Adopt a Configuration and invalidate resource selections for changed qualifiers. */
function applyDeviceConfiguration(c: JConfiguration): void {
  const was = isNight(), lang = theConfig.locale?.lang, dir = theConfig.screenLayout & 0xc0;
  Object.assign(theConfig, c);
  if (isNight() !== was) setResourceNight(isNight());
  if (theConfig.locale?.lang !== lang || (theConfig.screenLayout & 0xc0) !== dir) {
    setResourceLocale(theConfig.locale?.lang ?? "", theConfig.screenLayout & 0xc0);
  }
}
function configurationQualifiers(c: JConfiguration) {
  return { lang: c.locale?.lang ?? "", dir: c.screenLayout & 0xc0, night: (c.uiMode & 0x30) === 0x20 ? 1 : 0,
    orientation: c.orientation, density: c.densityDpi, wdp: c.screenWidthDp, hdp: c.screenHeightDp,
    swdp: c.smallestScreenWidthDp, size: c.screenLayout & 0xf, uiType: c.uiMode & 0xf };
}
function mergeConfiguration(base: JConfiguration, delta: JConfiguration): void {
  for (const key of CONFIG_FIELDS) {
    if (key === "uiMode" || key === "screenLayout" || key === "colorMode") continue;
    if (key === "orientation") { if (delta.orientation) base.orientation = delta.orientation; continue; }
    const value = delta[key];
    if (key === "fontScale" ? value > 0 : key === "fontWeightAdjustment" ? value !== 0x7fffffff : value !== 0) base[key] = value;
  }
  const locales = configLocales(delta);
  if (locales.values.length) setLocales(base, locales);
  for (const [key, masks] of [["uiMode", [0xf, 0x30]], ["screenLayout", [0xf, 0x30, 0xc0, 0x300]], ["colorMode", [3, 12]]] as const) {
    for (const mask of masks) if (delta[key] & mask) base[key] = (base[key] & ~mask) | (delta[key] & mask);
  }
  if (delta.screenLayout) base.screenLayout = (base.screenLayout & ~0x10000000) | (delta.screenLayout & 0x10000000);
}
function configurationMetrics(resources: JResources): void {
  const config = resources.config!;
  resources.host.dm.densityDpi = config.densityDpi;
  resources.host.dm.density = config.densityDpi / 160;
  resources.host.dm.scaledDensity = resources.host.dm.density * config.fontScale;
}
/** give `r` its own configuration and selection scope over `source`'s tables, `config` applied
 *  as a delta the way Configuration.updateFrom does */
function scopeResources(r: JResources, source: Resources, config: JConfiguration): void {
  r.config = Object.assign(new JConfiguration(), source.jobj instanceof JResources ? source.jobj.config ?? theConfig : theConfig);
  mergeConfiguration(r.config, config);
  r.host = source.scoped(configurationQualifiers(r.config));
  r.host.jobj = r;
  configurationMetrics(r);
}
export function scopedResources(source: Resources, config: JConfiguration): JResources {
  if (!config) throw rt.mkThrowable("java/lang/IllegalArgumentException", "overrideConfiguration must not be null");
  const r = new JResources();
  scopeResources(r, source, config);
  return r;
}
export const deviceConfiguration = (): JConfiguration => theConfig;
/** Keep Configuration and resource qualifiers in step with the shell framebuffer. */
export function syncDeviceOrientation(): void {
  theConfig.orientation = device.orientation;
  theConfig.screenWidthDp = device.widthDp;
  theConfig.screenHeightDp = device.heightDp;
  theConfig.smallestScreenWidthDp = device.smallestWidthDp;
  setResourceOrientation(theConfig.orientation, theConfig.screenWidthDp, device.screenHeightDp, theConfig.smallestScreenWidthDp);
}
/** Adopt the app's language list (empty: the system's) as the platform's configuration change
 *  does: Configuration, resource selection and the default Locale follow it. Returns whether
 *  the effective locales moved. */
export function applyApplicationLocales(list: JLocaleList): boolean {
  appLocales = list;
  const next = list.values.length ? list : localeList, current = configLocales(theConfig).values;
  if (next.values.length === current.length && next.values.every((l, i) => sameLocale(l, current[i]))) return false;
  setLocales(theConfig, next);
  setResourceLocale(theConfig.locale?.lang ?? "", theConfig.screenLayout & 0xc0);
  void vcall(rt.link("java/util/Locale").ctor, "setDefault", "(Ljava/util/Locale;)V", theConfig.locale);
  return true;
}
export const localesFromTags = (tags: string): Promise<JLocaleList> =>
  vcall(rt.link("android/os/LocaleList").ctor, "forLanguageTags", "(Ljava/lang/String;)Landroid/os/LocaleList;", tags);
/** The device's own night setting changed. Returns whether anything moved. */
export function setDeviceNight(night: boolean): boolean {
  if (night === isNight()) return false;
  theConfig.uiMode = (theConfig.uiMode & ~0x30) | (night ? 0x20 : 0x10);
  setResourceNight(night);
  return true;
}
export class JAssetManager extends JObj { host!: Resources; }
class JAssetFd extends JObj { bytes!: Uint8Array; pfd: unknown = null; }
export function mkAssetFd(bytes: Uint8Array, pfd: unknown = null): JAssetFd {
  const fd = new JAssetFd();
  fd.bytes = bytes;
  fd.pfd = pfd;
  return fd;
}
rt.register({
  name: "android/content/res/AssetFileDescriptor", ctor: JAssetFd,
  methods: {
    "createInputStream()Ljava/io/FileInputStream;": function (this: JAssetFd) { return streamOf(this.bytes); },
    "getLength()J": function (this: JAssetFd) { return BigInt(this.bytes.length); },
    "getDeclaredLength()J": function (this: JAssetFd) { return BigInt(this.bytes.length); },
    "getStartOffset()J": () => 0n,
    // an entry with no ParcelFileDescriptor of its own is served as one over its bytes, which is
    // why getStartOffset answers 0
    "getFileDescriptor()Ljava/io/FileDescriptor;": function (this: JAssetFd) {
      return vcall(this.pfd ??= mkPfd(this.bytes, null), "getFileDescriptor", "()Ljava/io/FileDescriptor;");
    },
    "getParcelFileDescriptor()Landroid/os/ParcelFileDescriptor;": function (this: JAssetFd) { return this.pfd ??= mkPfd(this.bytes, null); },
    "close()V": () => {},
  },
});
function assetSource(am: JAssetManager, p: string): FileSource {
  const path = "assets/" + p;
  const bytes = am.host.zip[path];
  const source = bytes ? new BytesFile(bytes) : am.host.lazyEntries.get(path);
  if (!source) throw rt.mkThrowable("java/io/FileNotFoundException", "asset " + p);
  return source;
}
/** the names directly under assets/`dir`, from the eager and the lazy zip entries */
function assetNames(res: Resources, dir: string): Set<string> {
  const prefix = "assets/" + (dir ? dir + "/" : "");
  const names = new Set<string>();
  for (const k of [...Object.keys(res.zip), ...res.lazyEntries.keys()]) {
    if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
  }
  return names;
}
const assetOpen = function (this: JAssetManager, p: string) {
  const bytes = this.host.zip["assets/" + p];
  return bytes ? streamOf(bytes) : streamOfSource(assetSource(this, p));
};
rt.register({
  name: "android/content/res/AssetManager", ctor: JAssetManager,
  methods: {
    "getLocales()[Ljava/lang/String;": function (this: JAssetManager) { return jarray([...new Set([...this.host.tbl(0x01000000)?.locales ?? [], ...this.host.arsc?.locales ?? []])], "Ljava/lang/String;"); },
    "getNonSystemLocales()[Ljava/lang/String;": function (this: JAssetManager) { return jarray([...this.host.arsc?.locales ?? []], "Ljava/lang/String;"); },
    "open(Ljava/lang/String;)Ljava/io/InputStream;": assetOpen,
    "open(Ljava/lang/String;I)Ljava/io/InputStream;": assetOpen,
    "openXmlResourceParser(Ljava/lang/String;)Landroid/content/res/XmlResourceParser;": driven(function* (this: JAssetManager, path: string): Gen {
      const bytes = this.host.zip[path], source = this.host.lazyEntries.get(path);
      if (!bytes && !source) throw rt.mkThrowable("java/io/FileNotFoundException", path);
      return xmlFromBytes(this.host, bytes ?? (yield readFully(source!)));
    }),
    "openFd(Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;": driven(function* (this: JAssetManager, p: string): Gen {
      return mkAssetFd(yield readFully(assetSource(this, p)));
    }),
    "list(Ljava/lang/String;)[Ljava/lang/String;": function (this: JAssetManager, p: string) { return jarray([...assetNames(this.host, p)], "Ljava/lang/String;"); },
    "close()V": () => {},
  },
});

/** Resources(AssetManager, DisplayMetrics, Configuration): a ResourcesImpl of its own over the
 *  asset tables, which is what an app's Resources subclass wraps around the package's */
function initResources(this: JResources, assets: JAssetManager | null, metrics: JDisplayMetrics | null, config: JConfiguration | null): void {
  if (!assets) throw rt.mkThrowable("java/lang/NullPointerException", "assets");
  scopeResources(this, assets.host, config ?? new JConfiguration());
  if (metrics) { Object.assign(this.host.dm, metrics); configurationMetrics(this); }
}
const notFound = (what: string, id: number) => rt.mkThrowable("android/content/res/Resources$NotFoundException", `${what} resource ID #0x${(id >>> 0).toString(16)}`);
/** the string behind `id`; an id the table has no entry for is NotFoundException, as AOSP throws it — an app's
 *  Resources subclass may catch that and serve the string from a store of its own */
const stringOf = (res: Resources, id: number): string => rvString(res, res.ref(id)) ?? (() => { throw notFound("String", id); })();
const pluralOf = (res: Resources, id: number, n: number): string => pluralString(res, id, n) ?? (() => { throw notFound("Plural", id); })();
const stringsOf = (res: Resources, id: number): string[] => res.bag(id) ? bagStrings(res, id) : (() => { throw notFound("String array", id); })();
const getString = function (this: JResources, id: number) { return stringOf(this.host, id); };
function resourceText(res: Resources, id: number): unknown {
  const value = res.ref(id), pool = res.tbl(value.r ?? id)?.values;
  return value.t === TV.STRING && pool ? annotatedResource(pool, value.d) : rvString(res, value);
}
const getColor = function (this: JResources, id: number) { return rvColor(this.host, this.host.ref(id), 0); };
/** The file the table picks for `density` (0 is the device's own). The bitmap keeps its bucket's
 *  density, where AOSP would report a bucket matching the request at the screen's. */
function drawableForDensity(this: JResources, id: number, density: number, theme: JTheme | null = null) {
  const file = density ? this.host.pathOf(id, 0, undefined, density) : null;
  return file && file.arsc === this.host.arsc ? loadDrawableRV(this.host, { t: TV.STRING, d: 0, s: file.path }, theme) : loadDrawable(this.host, id, theme);
}
const resMethods: NativeSpec["methods"] = {
  "getString(I)Ljava/lang/String;": getString,
  "getString(I[Ljava/lang/Object;)Ljava/lang/String;": function (this: JResources, id: number, args: unknown[]) {
    return javaFormat(stringOf(this.host, id), args);
  },
  "getText(I)Ljava/lang/CharSequence;": function (this: JResources, id: number) {
    const text = resourceText(this.host, id);
    if (text == null) throw notFound("Text", id);
    return text;
  },
  "getText(ILjava/lang/CharSequence;)Ljava/lang/CharSequence;": function (this: JResources, id: number, def: unknown) {
    return resourceText(this.host, id) ?? def;
  },
  "getQuantityString(II)Ljava/lang/String;": function (this: JResources, id: number, n: number) {
    return pluralOf(this.host, id, n);
  },
  "getQuantityString(II[Ljava/lang/Object;)Ljava/lang/String;": function (this: JResources, id: number, n: number, args: unknown[]) {
    return javaFormat(pluralOf(this.host, id, n), args);
  },
  "getQuantityText(II)Ljava/lang/CharSequence;": function (this: JResources, id: number, n: number) {
    return pluralOf(this.host, id, n);
  },
  "getColor(I)I": getColor,
  "getColor(ILandroid/content/res/Resources$Theme;)I": getColor,
  "getColorStateList(I)Landroid/content/res/ColorStateList;": function (this: JResources, id: number) {
    return loadColorStateList(this.host, id, null);
  },
  "getColorStateList(ILandroid/content/res/Resources$Theme;)Landroid/content/res/ColorStateList;":
    function (this: JResources, id: number, theme: JTheme | null) {
      return loadColorStateList(this.host, id, theme);
    },
  "getDimension(I)F": function (this: JResources, id: number) { return rvDimen(this.host, this.host.ref(id), 0); },
  "getDimensionPixelSize(I)I": function (this: JResources, id: number) { return Math.round(rvDimen(this.host, this.host.ref(id), 0)); },
  "getDimensionPixelOffset(I)I": function (this: JResources, id: number) { return Math.trunc(rvDimen(this.host, this.host.ref(id), 0)); },
  "getBoolean(I)Z": function (this: JResources, id: number) { return rvInt(this.host, this.host.ref(id), 0) ? 1 : 0; },
  "getInteger(I)I": function (this: JResources, id: number) { return rvInt(this.host, this.host.ref(id), 0); },
  "getFraction(III)F": function (this: JResources, id: number, base: number, pbase: number) {
    const value = this.host.ref(id);
    if (value?.t !== TV.FRACTION) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", `Resource ${id} is not a fraction`);
    return complexToFraction(value.d, base, pbase);
  },
  "getDrawable(I)Landroid/graphics/drawable/Drawable;": function (this: JResources, id: number) {
    return loadDrawable(this.host, id, null);
  },
  "getDrawable(ILandroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;":
    function (this: JResources, id: number, t: JTheme | null) {
      return loadDrawable(this.host, id, t);
    },
  "getDrawableForDensity(II)Landroid/graphics/drawable/Drawable;": drawableForDensity,
  "getDrawableForDensity(IILandroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;": drawableForDensity,
  "getFloat(I)F": function (this: JResources, id: number) {
    const v = this.host.ref(id);
    if (v.t !== TV.FLOAT) throw notFound(`Float (type 0x${v.t.toString(16)})`, id);
    return v.d;
  },
  "getStringArray(I)[Ljava/lang/String;": function (this: JResources, id: number) { return jarray(stringsOf(this.host, id), "Ljava/lang/String;"); },
  "getTextArray(I)[Ljava/lang/CharSequence;": function (this: JResources, id: number) { return jarray(stringsOf(this.host, id), "Ljava/lang/CharSequence;"); },
  "getIntArray(I)[I": function (this: JResources, id: number) {
    return Int32Array.from(arrayValues(this.host, id).map((v) => rvInt(this.host, this.host.resolveRefs(v), 0)));
  },
  "obtainTypedArray(I)Landroid/content/res/TypedArray;": function (this: JResources, id: number) {
    const ta = new JTypedArray();
    ta.res = this.host;
    ta.vals = arrayValues(this.host, id);
    ta.attrIds = new Array(ta.vals.length).fill(0);
    return ta;
  },
  "getValue(ILandroid/util/TypedValue;Z)V": function (this: JResources, id: number, tv: JTypedValue, resolve: number) {
    tv.density = 0;
    let v = this.host.value(id, tv);
    for (let depth = 0; resolve && v.t === TV.REFERENCE && v.d && depth < 20; depth++) {
      id = v.d;
      v = this.host.value(id, tv);
    }
    if (!resolve && v.t === TV.REFERENCE) { tv.type = v.t; tv.data = v.d; tv.assetCookie = 1; }
    else fillTypedValue(this.host, v, tv);
    tv.resourceId = id;
  },
  "getResourceName(I)Ljava/lang/String;": function (this: JResources, id: number) {
    return this.host.idPackage(id) + ":" + this.host.idType(id) + "/" + this.host.idName(id);
  },
  "getResourceEntryName(I)Ljava/lang/String;": function (this: JResources, id: number) { return this.host.idName(id); },
  "getResourceTypeName(I)Ljava/lang/String;": function (this: JResources, id: number) { return this.host.idType(id); },
  "getResourcePackageName(I)Ljava/lang/String;": function (this: JResources, id: number) {
    return this.host.idPackage(id);
  },
  "getIdentifier(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I":
    function (this: JResources, name: string, defType: string | null, defPkg: string | null) {
      let type = defType ?? "", n = name, pkg = defPkg ?? "";
      const slash = name.indexOf("/");
      if (slash > 0) {
        const head = name.slice(0, slash), colon = head.indexOf(":");
        if (colon >= 0) pkg = head.slice(0, colon);
        type = head.replace(/^.*:/, "");
        n = name.slice(slash + 1);
      }
      return this.host.idFor(type, n, pkg);
    },
  "getDisplayMetrics()Landroid/util/DisplayMetrics;": function (this: JResources) { return this.host.dm; },
  "getConfiguration()Landroid/content/res/Configuration;": function (this: JResources) { return this.config ?? theConfig; },
  "newTheme()Landroid/content/res/Resources$Theme;": function (this: JResources) {
    const t = new JTheme();
    t.res = this.host;
    return t;
  },
  "getAssets()Landroid/content/res/AssetManager;": function (this: JResources) {
    const a = new JAssetManager();
    a.host = this.host;
    return a;
  },
  "openRawResource(I)Ljava/io/InputStream;": openRawResource,
  "openRawResource(ILandroid/util/TypedValue;)Ljava/io/InputStream;": openRawResource,
  "openRawResourceFd(I)Landroid/content/res/AssetFileDescriptor;": openRawResourceFd,
  "obtainAttributes(Landroid/util/AttributeSet;[I)Landroid/content/res/TypedArray;": function (this: JResources, set: JAttrSet | null, attrs: Int32Array) {
    return obtainStyled(this.host, null, set, attrs, 0, 0);
  },
  "getLayout(I)Landroid/content/res/XmlResourceParser;": xmlParser,
  "getXml(I)Landroid/content/res/XmlResourceParser;": xmlParser,
  "getAnimation(I)Landroid/content/res/XmlResourceParser;": xmlParser,
  "updateConfiguration(Landroid/content/res/Configuration;Landroid/util/DisplayMetrics;)V": function (this: JResources, c: JConfiguration | null) {
    if (!c) return;
    if (!this.config) { applyDeviceConfiguration(c); return; }
    mergeConfiguration(this.config, c);
    const qualifiers = configurationQualifiers(this.config);
    for (const table of [this.host.arsc, this.host.tbl(0x01000000)]) if (table) Object.assign(table.device, qualifiers);
    configurationMetrics(this);
    this.host.invalidate();
  },
  "getFont(I)Landroid/graphics/Typeface;": driven(function* (this: JResources, id: number): Gen {
    const t = yield fontResource(this.host, id);
    if (!t) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Font resource ID #0x" + (id >>> 0).toString(16));
    return t;
  }),
  "static getSystem()Landroid/content/res/Resources;": () => systemRes,
  "<init>(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V": initResources,
};
rt.register({ name: "android/content/res/Resources", ctor: JResources, methods: resMethods });

function xmlParser(this: JResources, id: number) { return mkXmlParser(this.host, id); }
function arrayValues(res: Resources, id: number): RV[] {
  const bag = res.bag(id);
  return bag ? [...bag.map.values()] : [];
}
function pluralString(res: Resources, id: number, n: number): string | null {
  const bag = res.bag(id);
  if (!bag) return null;
  // plurals bag keys: 0x01000004=other, 5=zero, 6=one, 7=two, 8=few, 9=many
  const pick = (k: number) => bag.map.get(k);
  const v = (n === 1 ? pick(0x01000006) : undefined) ?? pick(0x01000004) ?? [...bag.map.values()][0];
  return v ? rvString(res, res.resolveRefs(v)) : null;
}

rt.register({
  name: "android/content/res/Resources$Theme", ctor: JTheme,
  methods: {
    "applyStyle(IZ)V": function (this: JTheme, id: number) { this.apply(id); },
    "rebase()V": function (this: JTheme) { this.cache.clear(); },
    "resolveAttribute(ILandroid/util/TypedValue;Z)Z": function (this: JTheme, attr: number, tv: JTypedValue) {
      const v = this.lookup(attr);
      if (!v) return 0;
      fillTypedValue(this.res, v, tv);
      return 1;
    },
    "obtainStyledAttributes([I)Landroid/content/res/TypedArray;": function (this: JTheme, attrs: Int32Array) {
      return obtainStyled(this.res, this, null, attrs, 0, 0);
    },
    "obtainStyledAttributes(I[I)Landroid/content/res/TypedArray;": function (this: JTheme, styleId: number, attrs: Int32Array) {
      return obtainStyleAttributes(this.res, this, styleId, attrs);
    },
    "obtainStyledAttributes(Landroid/util/AttributeSet;[III)Landroid/content/res/TypedArray;":
      function (this: JTheme, set: JAttrSet | null, attrs: Int32Array, defStyleAttr: number, defStyleRes: number) {
        return obtainStyled(this.res, this, set, attrs, defStyleAttr, defStyleRes);
      },
    "getResources()Landroid/content/res/Resources;": function (this: JTheme) { return this.res.jobj; },
    "dump(ILjava/lang/String;Ljava/lang/String;)V": () => {},
    "setTo(Landroid/content/res/Resources$Theme;)V": function (this: JTheme, o: JTheme) {
      this.styles = o.styles.slice();
      this.cache.clear();
    },
  },
});

defineException("android/content/res/Resources$NotFoundException", "java/lang/RuntimeException");

const hasValue = function (this: JTypedArray, i: number) { return this.vals[i] ? 1 : 0; };
const typedString = function (this: JTypedArray, i: number) { return rvString(this.res, this.vals[i]); };
const typedInt = function (this: JTypedArray, i: number, d: number) { return this.vals[i] ? rvInt(this.res, this.vals[i], d) : d; };
/** a layout_width/height: MATCH_PARENT/WRAP_CONTENT as their negative ints, else a dimension */
function layoutDimension(ta: JTypedArray, i: number, d: number): number {
  const v = ta.vals[i];
  if (!v) return d;
  if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4 && v.d < 0) return v.d;
  return Math.round(rvDimen(ta.res, v, d));
}
rt.register({
  name: "android/content/res/TypedArray", ctor: JTypedArray,
  methods: {
    "length()I": function (this: JTypedArray) { return this.attrIds.length; },
    "getResources()Landroid/content/res/Resources;": function (this: JTypedArray) { return this.res.jobj; },
    "getChangingConfigurations()I": () => 0,
    "hasValueOrEmpty(I)Z": hasValue,
    "getIndexCount()I": function (this: JTypedArray) { return this.vals.filter((v) => v).length; },
    "getIndex(I)I": function (this: JTypedArray, at: number) {
      let n = -1;
      for (let i = 0; i < this.vals.length; i++) {
        if (this.vals[i]) { n++; if (n === at) return i; }
      }
      return 0;
    },
    "hasValue(I)Z": hasValue,
    "peekValue(I)Landroid/util/TypedValue;": function (this: JTypedArray, i: number) {
      const v = this.vals[i];
      if (!v) return null;
      const tv = new JTypedValue();
      fillTypedValue(this.res, v, tv);
      return tv;
    },
    "getValue(ILandroid/util/TypedValue;)Z": function (this: JTypedArray, i: number, tv: JTypedValue) {
      const v = this.vals[i];
      if (!v) return 0;
      fillTypedValue(this.res, v, tv);
      return 1;
    },
    "getString(I)Ljava/lang/String;": typedString,
    "getText(I)Ljava/lang/CharSequence;": typedString,
    "getTextArray(I)[Ljava/lang/CharSequence;": function (this: JTypedArray, i: number) {
      const v = this.vals[i];
      return v && v.t === TV.REFERENCE && v.d ? jarray(bagStrings(this.res, v.d), "Ljava/lang/CharSequence;") : null;
    },
    "getNonResourceString(I)Ljava/lang/String;": typedString,
    "getBoolean(IZ)Z": function (this: JTypedArray, i: number, d: number) {
      const v = this.vals[i];
      return v ? (rvInt(this.res, v, d) ? 1 : 0) : d;
    },
    "getInt(II)I": typedInt,
    "getInteger(II)I": typedInt,
    "getFraction(IIIF)F": function (this: JTypedArray, i: number, base: number, pbase: number, d: number) {
      const value = this.vals[i];
      if (!value || value.t === TV.NULL) return d;
      if (value.t !== TV.FRACTION) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `Cannot convert value at ${i} to fraction`);
      return complexToFraction(value.d, base, pbase);
    },
    "getFloat(IF)F": function (this: JTypedArray, i: number, d: number) { return this.vals[i] ? rvFloat(this.res, this.vals[i], d) : d; },
    "getColor(II)I": function (this: JTypedArray, i: number, d: number) {
      const v = this.vals[i];
      if (v?.t === TV.REFERENCE) return after(loadColorStateList(this.res, v.d, this.theme), (c: JColorStateList) => c.defColor);
      return rvColor(this.res, v, d);
    },
    "getColorStateList(I)Landroid/content/res/ColorStateList;": function (this: JTypedArray, i: number) {
      const v = this.vals[i];
      if (!v) return null;
      if (v.t === TV.REFERENCE) return loadColorStateList(this.res, v.d, this.theme);
      return mkCsl(rvColor(this.res, v, 0));
    },
    "getDimension(IF)F": function (this: JTypedArray, i: number, d: number) { return this.vals[i] ? rvDimen(this.res, this.vals[i], d) : d; },
    "getDimensionPixelSize(II)I": function (this: JTypedArray, i: number, d: number) {
      return this.vals[i] ? Math.round(rvDimen(this.res, this.vals[i], d)) : d;
    },
    "getDimensionPixelOffset(II)I": function (this: JTypedArray, i: number, d: number) {
      return this.vals[i] ? Math.trunc(rvDimen(this.res, this.vals[i], d)) : d;
    },
    "getLayoutDimension(ILjava/lang/String;)I": function (this: JTypedArray, i: number) { return layoutDimension(this, i, 0); },
    "getLayoutDimension(II)I": function (this: JTypedArray, i: number, d: number) { return layoutDimension(this, i, d); },
    "getResourceId(II)I": function (this: JTypedArray, i: number, d: number) {
      const v = this.vals[i];
      return v && (v.t === TV.REFERENCE || v.t === TV.ATTRIBUTE) ? v.d : v?.r ?? d;
    },
    "getDrawable(I)Landroid/graphics/drawable/Drawable;": function (this: JTypedArray, i: number) {
      const v = this.vals[i];
      if (!v) return null;
      return loadDrawableRV(this.res, v, this.theme);
    },
    "getFont(I)Landroid/graphics/Typeface;": driven(function* (this: JTypedArray, i: number): Gen {
      const value = this.vals[i];
      if (!value) return null;
      const id = value.t === TV.REFERENCE ? value.d : value.r ?? 0;
      const font = id ? yield fontResource(this.res, id) : null;
      if (!font) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Font resource at index " + i);
      return font;
    }),
    "getType(I)I": function (this: JTypedArray, i: number) {
      const v = this.vals[i];
      if (!v) return 0;
      if (v.t === T_PX) return TV.DIMENSION;
      if (v.t === T_STR) return TV.STRING;
      return v.t;
    },
    "recycle()V": () => {},
    "getPositionDescription()Ljava/lang/String;": () => "<webdroid>",
  },
});

rt.register({
  name: "android/util/AttributeSet", ctor: class extends JObj {},
});
// The AttributeSet surface, shared by the inflater's attribute set and the XML parser that
// doubles as one (AOSP's XmlBlock.Parser); `node` is the element the reader is positioned on.
type HasNode = { node: XmlNode | null };
const byIdx = (s: HasNode, i: number) => s.node?.attrs[i];
const byName = (s: HasNode, name: string) => s.node?.attrs.find((x) => x.name === name);
const attrInt = (a: XmlAttr | undefined, d: number) => a && a.type >= TV.INT_DEC ? a.data : d;
const attrBool = (a: XmlAttr | undefined, d: number) => a && a.type === TV.BOOLEAN ? (a.data ? 1 : 0) : d;
const attrFloat = (a: XmlAttr | undefined, d: number) => a?.type === TV.FLOAT ? normRV({ t: a.type, d: a.data }).d : d;
const attrRef = (a: XmlAttr | undefined, d: number) => a && a.type === TV.REFERENCE ? a.data : d;
const attributeSetMethods: NativeSpec["methods"] = {
  "getAttributeCount()I": function (this: HasNode) { return this.node?.attrs.length ?? 0; },
  "getAttributeName(I)Ljava/lang/String;": function (this: HasNode, i: number) { return byIdx(this, i)?.name ?? ""; },
  "getAttributeNameResource(I)I": function (this: HasNode, i: number) { return byIdx(this, i)?.resId ?? 0; },
  "getAttributeValue(I)Ljava/lang/String;": function (this: HasNode, i: number) { return xmlAttrString(byIdx(this, i)); },
  "getAttributeValue(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": function (this: HasNode, _ns: string, n: string) { return xmlAttrString(byName(this, n)); },
  "getAttributeResourceValue(II)I": function (this: HasNode, i: number, d: number) { return attrRef(byIdx(this, i), d); },
  "getAttributeResourceValue(Ljava/lang/String;Ljava/lang/String;I)I": function (this: HasNode, _ns: string, n: string, d: number) { return attrRef(byName(this, n), d); },
  "getAttributeIntValue(II)I": function (this: HasNode, i: number, d: number) { return attrInt(byIdx(this, i), d); },
  "getAttributeIntValue(Ljava/lang/String;Ljava/lang/String;I)I": function (this: HasNode, _ns: string, n: string, d: number) { return attrInt(byName(this, n), d); },
  "getAttributeUnsignedIntValue(II)I": function (this: HasNode, i: number, d: number) { return attrInt(byIdx(this, i), d); },
  "getAttributeBooleanValue(IZ)Z": function (this: HasNode, i: number, d: number) { return attrBool(byIdx(this, i), d); },
  "getAttributeBooleanValue(Ljava/lang/String;Ljava/lang/String;Z)Z": function (this: HasNode, _ns: string, n: string, d: number) { return attrBool(byName(this, n), d); },
  "getAttributeFloatValue(IF)F": function (this: HasNode, i: number, d: number) { return attrFloat(byIdx(this, i), d); },
  "getAttributeFloatValue(Ljava/lang/String;Ljava/lang/String;F)F": function (this: HasNode, _ns: string, n: string, d: number) { return attrFloat(byName(this, n), d); },
  "getStyleAttribute()I": function (this: HasNode) { return this.node?.attrs.find((x) => x.name === "style" && !x.ns)?.data ?? 0; },
  "getIdAttributeResourceValue(I)I": function (this: HasNode, d: number) { return this.node?.attrs.find((x) => x.resId === 0x010100d0)?.data ?? d; },
};
rt.register({
  name: "webdroid/AttrSet", ctor: JAttrSet, ifaces: ["android/util/AttributeSet"],
  methods: {
    ...attributeSetMethods,
    "getIdAttribute()Ljava/lang/String;": () => null,
    "getClassAttribute()Ljava/lang/String;": function (this: JAttrSet) { return this.node?.attrs.find((x) => x.name === "class")?.str ?? null; },
    "getPositionDescription()Ljava/lang/String;": () => "<webdroid xml>",
  },
});

// XmlResourceParser (pull parser over XmlNode tree)
export function mkXmlParser(res: Resources, id: number): JXmlParser {
  const bytes = id ? res.fileOf(id)?.bytes : null;
  if (!bytes) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "xml resource 0x" + id.toString(16));
  return xmlFromBytes(res, bytes);
}
function xmlFromBytes(res: Resources, bytes: Uint8Array): JXmlParser {
  rt.link("android/content/res/XmlResourceParser");
  const p = new JXmlParser();
  p.res = res;
  p.set.res = res;
  const events: JXmlParser["events"] = [{ type: 0, node: null, depth: 0 }];
  const root = parseAXML(bytes);
  const walk = (n: XmlNode, depth: number) => {
    events.push({ type: 2, node: n, depth });
    for (const c of n.children) walk(c, depth + 1);
    events.push({ type: 3, node: n, depth });
  };
  walk(root, 1);
  events.push({ type: 1, node: null, depth: 0 });
  p.events = events;
  return p;
}
function nextXml(parser: JXmlParser): number {
  parser.pos = Math.min(parser.pos + 1, parser.events.length - 1);
  const event = parser.events[parser.pos];
  parser.set.node = event.node;
  return event.type;
}
const xmlParserMethods: NativeSpec["methods"] = {
  "next()I": function (this: JXmlParser) { return nextXml(this); },
  "nextToken()I": function (this: JXmlParser) { return nextXml(this); },
  "nextTag()I": function (this: JXmlParser) {
    do {
      this.pos = Math.min(this.pos + 1, this.events.length - 1);
    } while (this.events[this.pos].type !== 2 && this.events[this.pos].type !== 3 && this.events[this.pos].type !== 1);
    this.set.node = this.events[this.pos].node;
    return this.events[this.pos].type;
  },
  "nextText()Ljava/lang/String;": function (this: JXmlParser) {
    if (this.events[this.pos]?.type !== 2) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "parser must be on START_TAG");
    const next = this.events[++this.pos];
    const text = next?.type === 4 ? next.text ?? "" : "";
    if (next?.type === 4) this.pos++;
    this.set.node = this.events[this.pos]?.node ?? null;
    if (this.events[this.pos]?.type !== 3) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "event TEXT must be followed by END_TAG");
    return text;
  },
  "getEventType()I": function (this: JXmlParser) { return this.pos < 0 ? 0 : this.events[this.pos].type; },
  "getNamespace()Ljava/lang/String;": function (this: JXmlParser) { return this.events[this.pos]?.namespace ?? ""; },
  "getNamespace(Ljava/lang/String;)Ljava/lang/String;": () => null,
  "getNamespaceCount(I)I": () => 0,
  "getNamespacePrefix(I)Ljava/lang/String;": () => null,
  "getNamespaceUri(I)Ljava/lang/String;": () => null,
  "getPrefix()Ljava/lang/String;": () => null,
  "require(ILjava/lang/String;Ljava/lang/String;)V": function (this: JXmlParser, type: number, _ns: string | null, name: string | null) {
    const e = this.events[this.pos];
    if (e?.type !== type || (name !== null && e.node?.name !== name)) {
      throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "expected " + (name ?? "event " + type) + " at " + (e?.node?.name ?? "start"));
    }
  },
  "getName()Ljava/lang/String;": function (this: JXmlParser) { return this.events[this.pos]?.node?.name ?? null; },
  "getDepth()I": function (this: JXmlParser) { return this.events[this.pos]?.depth ?? 0; },
  "getLineNumber()I": function (this: JXmlParser) { return this.events[this.pos]?.line ?? -1; },
  "getColumnNumber()I": () => -1,
  "getInputEncoding()Ljava/lang/String;": () => null,
  "getSourceResId()I": function (this: JXmlParser) { return this.sourceResId; },
  "close()V": () => {},
  ...attributeSetMethods,
  "getAttributeNamespace(I)Ljava/lang/String;": function (this: JXmlParser, i: number) { return byIdx(this, i)?.ns ?? ""; },
  "getAttributeType(I)Ljava/lang/String;": () => "CDATA",
  "getAttributePrefix(I)Ljava/lang/String;": () => null,
  "getIdAttribute()Ljava/lang/String;": function (this: JXmlParser) { return xmlAttrString(this.node?.attrs.find((x) => x.name === "id")); },
  "getClassAttribute()Ljava/lang/String;": function (this: JXmlParser) { return xmlAttrString(this.node?.attrs.find((x) => x.name === "class")); },
  "getText()Ljava/lang/String;": function (this: JXmlParser) { return this.events[this.pos]?.text ?? null; },
  "getPositionDescription()Ljava/lang/String;": function (this: JXmlParser) { return `<webdroid xml line ${this.events[this.pos]?.line ?? -1}>`; },
  "isEmptyElementTag()Z": function (this: JXmlParser) {
    const e = this.events[this.pos];
    return e?.type === 2 && !e.node?.children.length ? 1 : 0;
  },
  "isWhitespace()Z": function (this: JXmlParser) { return +(this.events[this.pos]?.type === 4 && !this.events[this.pos]?.text?.trim()); },
  "getFeature(Ljava/lang/String;)Z": (name: string) => +(name.endsWith("#process-namespaces") || name.endsWith("#report-namespace-prefixes")),
  ...noops("setFeature(Ljava/lang/String;Z)V", "setProperty(Ljava/lang/String;Ljava/lang/Object;)V"),
  ...stubs(null, "getProperty(Ljava/lang/String;)Ljava/lang/Object;"),
};
rt.register({
  name: "android/content/res/XmlResourceParser", ctor: JXmlParser,
  ifaces: ["org/xmlpull/v1/XmlPullParser", "android/util/AttributeSet"],
  methods: xmlParserMethods,
});

class JXmlBlock extends JObj {
  doc: ReturnType<typeof parseAXMLDoc> | null = null;
  res: Resources | null = null;
}
class JXmlBlockParser extends JXmlParser {}
function initXmlBlock(block: JXmlBlock, bytes: Int8Array, off: number, len: number): void {
  block.doc = parseAXMLDoc(new Uint8Array(bytes.buffer, bytes.byteOffset + off, len), true);
  block.res = currentResources();
}
function newBlockParser(block: JXmlBlock, sourceResId: number): JXmlBlockParser | null {
  if (!block.doc) return null;
  const parser = new JXmlBlockParser();
  if (block.res) { parser.res = block.res; parser.set.res = block.res; }
  parser.sourceResId = sourceResId;
  parser.events = block.doc.events.map((event) => ({
    type: event.type, node: event.node, depth: event.depth, line: event.line,
    namespace: event.nsIdx < 0 ? "" : block.doc!.pool.get(event.nsIdx),
    text: event.type === 4 && event.nameIdx >= 0 ? block.doc!.pool.get(event.nameIdx) : undefined,
  }));
  return parser;
}
rt.register({
  name: "android/content/res/XmlBlock", ctor: JXmlBlock,
  methods: {
    "<init>([B)V": function (this: JXmlBlock, bytes: Int8Array) { initXmlBlock(this, bytes, 0, bytes.length); },
    "<init>([BII)V": function (this: JXmlBlock, bytes: Int8Array, off: number, len: number) { initXmlBlock(this, bytes, off, len); },
    "newParser()Landroid/content/res/XmlResourceParser;": function (this: JXmlBlock) { return newBlockParser(this, 0); },
    "newParser(I)Landroid/content/res/XmlResourceParser;": function (this: JXmlBlock, sourceResId: number) { return newBlockParser(this, sourceResId); },
    "newParser(ILandroid/content/res/Validator;)Landroid/content/res/XmlResourceParser;": function (this: JXmlBlock, sourceResId: number) { return newBlockParser(this, sourceResId); },
    "close()V": function (this: JXmlBlock) { this.doc = null; },
  },
});
rt.register({
  name: "android/content/res/XmlBlock$Parser", ctor: JXmlBlockParser,
  ifaces: ["android/content/res/XmlResourceParser", "org/xmlpull/v1/XmlPullParser", "android/util/AttributeSet"],
  methods: xmlParserMethods,
});
rt.register({
  name: "android/util/Xml", ctor: class extends JObj {},
  methods: {
    // our XmlResourceParser already implements AttributeSet
    "static asAttributeSet(Lorg/xmlpull/v1/XmlPullParser;)Landroid/util/AttributeSet;": (p: unknown) => p,
    "static newPullParser()Lorg/xmlpull/v1/XmlPullParser;": () => newXmlPullParser(),
    "static newSerializer()Lorg/xmlpull/v1/XmlSerializer;": () => newXmlSerializer(),
    "static parse(Ljava/lang/String;Lorg/xml/sax/ContentHandler;)V": parseSax,
  },
});

// Implemented by app/library code, never handed out by us — it only has to exist so a
// class declaring `implements NamespaceContext` links instead of being auto-stubbed.
rt.markers("javax/xml/namespace/NamespaceContext");
