// The device configuration and its languages: the values AOSP's Configuration and LocaleList
// are built from (resources.ts), android.os.LocaleList and LocaleManager, and android.util.Xml.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { device } from "../shell/config";
import { newXmlPullParser, newXmlSerializer } from "./xmlpull";
import { type Resources, setResourceLocale, setResourceNight, setResourceOrientation } from "./res";
import { sizeClass } from "./arsc";
import { vcall, after, scall, newObj } from "../jvm/natives/jlang";
import { type JLocale, localeTag, localeForTag, tagDirection } from "../jvm/natives/jvalues";
import { mkPfd } from "./os";
import { type JParcel, readString, writeString } from "./parcel";
import { parcelCreator } from "./parcelable";
import { appHost } from "./apphost";

/** a raw resource's bytes; NotFoundException when the table has no file for it */
export function rawResourceBytes(res: Resources, id: number): Uint8Array {
  const bytes = res.fileOf(id)?.bytes;
  if (!bytes) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Resource 0x" + id.toString(16));
  return bytes;
}
/** an AssetFileDescriptor over bytes, the whole of a ParcelFileDescriptor served over them */
export function mkAssetFd(bytes: Uint8Array, pfd: unknown = null): Promise<unknown> {
  return newObj("android/content/res/AssetFileDescriptor", "(Landroid/os/ParcelFileDescriptor;JJ)V", pfd ?? mkPfd(bytes, null), 0n, BigInt(bytes.length));
}
/** Locales with their tags, which configuration comparisons and resource selection read */
export class JLocaleList extends JObj { values: JLocale[] = []; tags: string[] = []; }
const emptyLocaleList = new JLocaleList();
/** the device's languages, from boot (initDeviceLocales) */
let localeList = emptyLocaleList;
function withTags(values: JLocale[]): JLocaleList | Promise<JLocaleList> {
  const tags = values.map(localeTag), list = (tags: string[]) => Object.assign(new JLocaleList(), { values, tags });
  return tags.some((tag) => tag instanceof Promise) ? Promise.all(tags).then(list) : list(tags as string[]);
}
const sameTags = (a: JLocaleList, b: JLocaleList) => a.tags.length === b.tags.length && a.tags.every((tag, i) => tag === b.tags[i]);
/** Configuration.locale is a public field an app may assign: its list follows it */
function syncLocales(c: JConfiguration): void | Promise<void> {
  if (c.locale === (c.locales.values[0] ?? null)) return;
  if (!c.locale) { c.locales = emptyLocaleList; return; }
  return after(withTags([c.locale]), (list) => { c.locales = list; });
}
/** the resource qualifier language of a configuration's first locale */
const configLang = (c: JConfiguration) => { const lang = c.locales.tags[0]?.split("-")[0] ?? ""; return lang === "und" ? "" : lang; };
function setLocales(c: JConfiguration, list: JLocaleList | null): void {
  c.locales = list || emptyLocaleList;
  c.locale = c.locales.values[0] ?? null;
  c.screenLayout = (c.screenLayout & ~0xc0) | (((c.locales.tags[0] ? tagDirection(c.locales.tags[0]) : 0) + 1) << 6);
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
export const CONFIG_FIELDS = ["orientation", "screenWidthDp", "screenHeightDp", "smallestScreenWidthDp", "densityDpi", "fontScale", "uiMode",
  "mcc", "mnc", "touchscreen", "keyboard", "keyboardHidden", "navigation", "navigationHidden", "hardKeyboardHidden", "screenLayout",
  "fontWeightAdjustment", "colorMode"] as const;
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
      return after(withTags(locales), ({ values, tags }) => {
        const first = tags.map((tag, i) => tags.indexOf(tag) === i);
        this.values = values.filter((_, i) => first[i]); this.tags = tags.filter((_, i) => first[i]);
      });
    },
    "static getDefault()Landroid/os/LocaleList;": () => after(syncLocales(theConfig), () => theConfig.locales),
    "static getAdjustedDefault()Landroid/os/LocaleList;": () => after(syncLocales(theConfig), () => theConfig.locales),
    "static getEmptyLocaleList()Landroid/os/LocaleList;": () => emptyLocaleList,
    "static forLanguageTags(Ljava/lang/String;)Landroid/os/LocaleList;": driven(function* (tags: string | null): Gen {
      const values: JLocale[] = [];
      for (const t of (tags ?? "").split(",").filter(Boolean)) values.push(yield localeForTag(t.trim()));
      return withTags(values);
    }),
    "get(I)Ljava/util/Locale;": function (this: JLocaleList, i: number) { return this.values[i] ?? null; },
    "size()I": function (this: JLocaleList) { return this.values.length; },
    "isEmpty()Z": function (this: JLocaleList) { return this.values.length === 0 ? 1 : 0; },
    "toLanguageTags()Ljava/lang/String;": function (this: JLocaleList) { return this.tags.join(","); },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JLocaleList, parcel: JParcel) { writeString(parcel, this.tags.join(",")); },
  },
});
export function readLocaleList(parcel: JParcel): Promise<JLocaleList> {
  return vcall(rt.link("android/os/LocaleList").ctor, "forLanguageTags", "(Ljava/lang/String;)Landroid/os/LocaleList;", readString(parcel));
}
/**
 * The device's configuration. AOSP's Resources take it as a Configuration of their own
 * (resources.ts javaConfiguration) at boot and on every change the shell delivers; night mode,
 * orientation and locales are device state kept here.
 */
const theConfig = new JConfiguration();
/** the device's languages as Locales, once libcore can build them */
export const initDeviceLocales = driven(function* initDeviceLocales(): Gen {
  localeList = yield withTags([yield localeForTag(device.locale)]);
  setLocales(theConfig, localeList);
  setResourceLocale(configLang(theConfig), theConfig.screenLayout & 0xc0);
});
const isNight = () => (theConfig.uiMode & 0x30) === 0x20;
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
  const next = list.values.length ? list : localeList;
  if (sameTags(next, theConfig.locales)) return false;
  setLocales(theConfig, next);
  setResourceLocale(configLang(theConfig), theConfig.screenLayout & 0xc0);
  void scall("java/util/Locale", "setDefault", "(Ljava/util/Locale;)V", theConfig.locale);
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

rt.register({
  name: "android/util/AttributeSet", ctor: class extends JObj {},
});
rt.register({
  name: "android/util/Xml", ctor: class extends JObj {},
  methods: {
    // our XmlResourceParser already implements AttributeSet
    "static asAttributeSet(Lorg/xmlpull/v1/XmlPullParser;)Landroid/util/AttributeSet;": (p: unknown) => p,
    "static newPullParser()Lorg/xmlpull/v1/XmlPullParser;": () => newXmlPullParser(),
    "static newSerializer()Lorg/xmlpull/v1/XmlSerializer;": () => newXmlSerializer(),
  },
});
