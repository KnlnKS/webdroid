// The device configuration and its languages: the values AOSP's Configuration and LocaleList
// are built from (resources.ts), LocaleManager, and android.util.Xml.

import { awaited, rt, JObj, driven, type Gen } from "../jvm/runtime.ts";
import { device } from "../shell/config.ts";
import { setResourceLocale, setResourceNight, setResourceOrientation } from "./res.ts";
import { sizeClass } from "./arsc.ts";
import { vcall, after, scall, newObj } from "../jvm/natives/jentry.ts";
import { jarray } from "../jvm/abi.ts";
import { type JLocale, localeTag, localeForTag, tagDirection } from "../jvm/natives/jvalues.ts";
import { mkPfd } from "./os.ts";
import { appHost } from "./apphost.ts";
import { hostStub } from "./binder.ts";
import { detached } from "../jvm/natives/jthrowable.ts";

/** framework-res's `type`/`name` as Resources.getSystem() reads it with `read`, or its id without one */
export const systemResource = driven(function* systemResource$(type: string, name: string, read?: string, desc?: string, ...args: unknown[]): Gen<unknown> {
  const res = yield scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
  const id: number = yield vcall(res, "getIdentifier", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", name, type, "android");
  return read ? yield vcall(res, read, desc!, id, ...args) : id;
});
/** an AssetFileDescriptor over bytes, the whole of a ParcelFileDescriptor served over them */
export const mkAssetFd = (bytes: Uint8Array, pfd: unknown = null): unknown => after(pfd ?? mkPfd(bytes),
  (fd) => newObj("android/content/res/AssetFileDescriptor", "(Landroid/os/ParcelFileDescriptor;JJ)V", fd, 0n, BigInt(bytes.length)));
/** Locales with their tags, which configuration comparisons and resource selection read */
export type Locales = { values: JLocale[]; tags: string[] };
const emptyLocales: Locales = { values: [], tags: [] };
/** the device's languages, from boot (initDeviceLocales) */
let localeList = emptyLocales;
function withTags(values: JLocale[]): Locales | Promise<Locales> {
  const tags = values.map(localeTag), list = (tags: string[]) => ({ values, tags });
  return tags.some((tag) => tag instanceof Promise) ? Promise.all(tags).then(list) : list(tags as string[]);
}
const sameTags = (a: Locales, b: Locales) => a.tags.length === b.tags.length && a.tags.every((tag, i) => tag === b.tags[i]);
/** an android.os.LocaleList of them */
export const javaLocales = (l: Locales): JObj | Promise<JObj> => newObj("android/os/LocaleList", "([Ljava/util/Locale;)V", jarray(l.values, "Ljava/util/Locale;"));
/** the Locales of an android.os.LocaleList */
const localesOf = driven(function* localesOf(list: JObj): Gen<Locales> {
  const values: JLocale[] = [];
  for (let i = 0, n: number = yield vcall(list, "size", "()I"); i < n; i++) values.push(yield vcall(list, "get", "(I)Ljava/util/Locale;", i));
  return yield* awaited(withTags(values));
});
/** the resource qualifier language of a configuration's first locale */
const configLang = (c: JConfiguration) => { const lang = c.locales.tags[0]?.split("-")[0] ?? ""; return lang === "und" ? "" : lang; };
function setLocales(c: JConfiguration, list: Locales): void {
  c.locales = list;
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
  locales = emptyLocales;
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
let appLocales = emptyLocales;
// ILocaleManager, under AOSP's LocaleManager: an app reads and sets its own languages; another
// app's need READ_APP_SPECIFIC_LOCALES or CHANGE_CONFIGURATION, which no app holds here
const ownLocales = (pkg: string | null, permission: string) => {
  if (pkg !== appHost?.pkg) throw rt.mkThrowable("java/lang/SecurityException", `Caller must be ${pkg} or hold ${permission}`);
};
rt.register({ name: "webdroid/LocaleManagerService", ctor: class extends JObj {}, sup: "android/app/ILocaleManager$Stub", methods: {
  "getApplicationLocales(Ljava/lang/String;I)Landroid/os/LocaleList;": (pkg: string | null) => {
    ownLocales(pkg, "android.permission.READ_APP_SPECIFIC_LOCALES");
    return javaLocales(appLocales);
  },
  "setApplicationLocales(Ljava/lang/String;ILandroid/os/LocaleList;Z)V": (pkg: string | null, _user: number, list: JObj | null) => {
    ownLocales(pkg, "android.permission.CHANGE_CONFIGURATION");
    return after(localesOf(list ?? rt.npe()), (locales) => appHost?.setApplicationLocales(locales));
  },
  "getSystemLocales()Landroid/os/LocaleList;": () => javaLocales(localeList),
  // no app has an override of its LocaleConfig
  "getOverrideLocaleConfig(Ljava/lang/String;I)Landroid/app/LocaleConfig;": () => null,
} });
hostStub("locale", "webdroid/LocaleManagerService");
/**
 * The device's configuration. AOSP's Resources take it as a Configuration of their own
 * (resources.ts javaConfiguration) at boot and on every change the shell delivers; night mode,
 * orientation and locales are device state kept here.
 */
const theConfig = new JConfiguration();
/** the device's languages as Locales, once libcore can build them */
export const initDeviceLocales = driven(function* initDeviceLocales(): Gen {
  localeList = yield* awaited(withTags([yield* awaited(localeForTag(device.locale))]));
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
export function applyApplicationLocales(list: Locales): boolean {
  appLocales = list;
  const next = list.values.length ? list : localeList;
  if (sameTags(next, theConfig.locales)) return false;
  setLocales(theConfig, next);
  setResourceLocale(configLang(theConfig), theConfig.screenLayout & 0xc0);
  detached(() => scall("java/util/Locale", "setDefault", "(Ljava/util/Locale;)V", theConfig.locale));
  return true;
}
export const localesFromTags = driven(function* localesFromTags(tags: string): Gen<Locales> {
  const values: JLocale[] = [];
  for (const t of tags.split(",").filter(Boolean)) values.push(yield* awaited(localeForTag(t.trim())));
  return yield* awaited(withTags(values));
});
/** The device's own night setting changed. Returns whether anything moved. */
export function setDeviceNight(night: boolean): boolean {
  if (night === isNight()) return false;
  theConfig.uiMode = (theConfig.uiMode & ~0x30) | (night ? 0x20 : 0x10);
  setResourceNight(night);
  return true;
}


