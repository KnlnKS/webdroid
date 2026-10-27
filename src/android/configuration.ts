// The device's configuration and its languages: the record AOSP's Configuration and LocaleList are
// built from, and the resource qualifiers it selects under. It hosts no service, so the package
// registry can select under it without joining binder's import cycle.

import { awaited, driven, getDeclared, setDeclared, type JObj, type Gen } from "../jvm/runtime.ts";
import { device } from "../shell/config.ts";
import { sizeClass, qualifiers, type Qualifiers } from "./arsc.ts";
import { vcall, scall, newObj } from "../jvm/natives/jentry.ts";
import { jarray } from "../jvm/abi.ts";
import { type JLocale, localeTag, localeForTag, tagDirection } from "../jvm/natives/jvalues.ts";
import { detached } from "../jvm/natives/jthrowable.ts";

/** framework-res's `type`/`name` as Resources.getSystem() reads it with `read`, or its id without one */
export const systemResource = driven(function* systemResource$(type: string, name: string, read?: string, desc?: string, ...args: unknown[]): Gen<unknown> {
  const res = yield scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
  const id: number = yield vcall(res, "getIdentifier", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", name, type, "android");
  return read ? yield vcall(res, read, desc!, id, ...args) : id;
});
/** Locales with their tags, which configuration comparisons and resource selection read */
export type Locales = { values: JLocale[]; tags: string[] };
const emptyLocales: Locales = { values: [], tags: [] };
/** the device's languages, from boot (initDeviceLocales); until libcore can build its Locale, its tag */
let localeList: Locales = { values: [], tags: [device.locale] };
function withTags(values: JLocale[]): PromiseOrVal<Locales> {
  const tags = values.map(localeTag), list = (tags: string[]) => ({ values, tags });
  return tags.some((tag) => tag instanceof Promise) ? Promise.all(tags).then(list) : list(tags as string[]);
}
const sameTags = (a: Locales, b: Locales) => a.tags.length === b.tags.length && a.tags.every((tag, i) => tag === b.tags[i]);
/** an android.os.LocaleList of them */
export const javaLocales = (l: Locales): PromiseOrVal<JObj> => newObj("android/os/LocaleList", "([Ljava/util/Locale;)V", jarray(l.values, "Ljava/util/Locale;"));
/** the Locales of an android.os.LocaleList */
export const localesOf = driven(function* localesOf(list: JObj): Gen<Locales> {
  const values: JLocale[] = [];
  for (let i = 0, n: number = yield vcall(list, "size", "()I"); i < n; i++) values.push(yield vcall(list, "get", "(I)Ljava/util/Locale;", i));
  return yield* awaited(withTags(values));
});

/**
 * The device's configuration: the fields of AOSP's Configuration (javaConfiguration copies them)
 * and its locales. Orientation follows the display; night mode and the locales are device state
 * kept here.
 */
const theConfig = {
  orientation: device.orientation as number,
  screenWidthDp: device.widthDp, screenHeightDp: device.heightDp,
  smallestScreenWidthDp: device.smallestWidthDp,
  densityDpi: device.densityDpi,
  fontScale: 1,
  // UI_MODE_TYPE_NORMAL | the device's night bit
  uiMode: 0x01 | (device.night ? 0x20 : 0x10),
  mcc: 0, mnc: 0, touchscreen: 3, keyboard: 1, keyboardHidden: 2, navigation: 1,
  navigationHidden: 2, hardKeyboardHidden: 2, screenLayout: 0x10 | sizeClass(device.smallestWidthDp), // SCREENLAYOUT_LONG_NO
  fontWeightAdjustment: 0,  // accessibility "bold text" is off, so no weight is added
  colorMode: 1 | 4,         // WIDE_COLOR_GAMUT_NO | HDR_NO: a plain sRGB canvas
  locales: emptyLocales,
};
export type DeviceConfig = typeof theConfig;
export const deviceConfiguration = (): Readonly<DeviceConfig> => theConfig;
let selected: Qualifiers | null = null;
/** the qualifiers the configuration selects resources under, as AssetManager.setConfiguration
 *  reads them: a new object after every change */
export const deviceQualifiers = (): Qualifiers => selected ??= qualifiers(theConfig.locales.tags[0] ?? null, theConfig.orientation,
  theConfig.densityDpi, theConfig.smallestScreenWidthDp, theConfig.screenWidthDp, theConfig.screenHeightDp, theConfig.screenLayout, theConfig.uiMode, device.sdk);
function setLocales(list: Locales): void {
  theConfig.locales = list;
  theConfig.screenLayout = (theConfig.screenLayout & ~0xc0) | (((list.tags[0] ? tagDirection(list.tags[0]) : 0) + 1) << 6);
  selected = null;
}
setLocales(localeList);

// API 33 per-app languages: the app's own list, empty to follow the system's. The host persists
// it and delivers the configuration change; adopting it is applyApplicationLocales below.
let appLocales = emptyLocales;
export const applicationLocales = (): Locales => appLocales;
export const deviceLocales = (): Locales => localeList;
/** the device's languages as Locales, once libcore can build them */
export const initDeviceLocales = driven(function* initDeviceLocales(): Gen {
  localeList = yield* awaited(withTags([yield* awaited(localeForTag(device.locale))]));
  setLocales(localeList);
});
const isNight = () => (theConfig.uiMode & 0x30) === 0x20;
/** Keep Configuration and resource qualifiers in step with the shell framebuffer. */
export function syncDeviceOrientation(): void {
  theConfig.orientation = device.orientation;
  theConfig.screenWidthDp = device.widthDp;
  theConfig.screenHeightDp = device.heightDp;
  theConfig.smallestScreenWidthDp = device.smallestWidthDp;
  selected = null;
}
/** Adopt the app's language list (empty: the system's) as the platform's configuration change
 *  does: Configuration, resource selection and the default Locale follow it. Returns whether
 *  the effective locales moved. */
export function applyApplicationLocales(list: Locales): boolean {
  appLocales = list;
  const next = list.values.length ? list : localeList;
  if (sameTags(next, theConfig.locales)) return false;
  setLocales(next);
  detached(() => scall("java/util/Locale", "setDefault", "(Ljava/util/Locale;)V", theConfig.locales.values[0] ?? null));
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
  selected = null;
  return true;
}

/** a Configuration of AOSP's carrying the device's configuration */
export const javaConfiguration = driven(function* javaConfiguration(): Gen<JObj> {
  const C = "android/content/res/Configuration";
  const config: JObj = yield newObj(C, "()V");
  yield vcall(config, "setToDefaults", "()V");
  const { locales, ...fields } = theConfig;
  setDeclared(config, C, fields);
  yield vcall(config, "setLocales", "(Landroid/os/LocaleList;)V", yield* awaited(javaLocales(locales)));
  // the display's window configuration, which the global configuration carries on a device
  const windowConfig = getDeclared(config, C, "windowConfiguration");
  const bounds = yield newObj("android/graphics/Rect", "(IIII)V", 0, 0, device.width, device.height);
  for (const set of ["setBounds", "setAppBounds", "setMaxBounds"]) yield vcall(windowConfig, set, "(Landroid/graphics/Rect;)V", bounds);
  yield vcall(windowConfig, "setWindowingMode", "(I)V", 1);
  const rotation = device.width > device.height ? 1 : 0;
  yield vcall(windowConfig, "setRotation", "(I)V", rotation);
  yield vcall(windowConfig, "setDisplayRotation", "(I)V", rotation);
  return config;
});
/** the device's DisplayMetrics, as Display.getMetrics fills one */
const deviceMetrics = driven(function* deviceMetrics(): Gen<JObj> {
  const dm: JObj = yield newObj("android/util/DisplayMetrics", "()V");
  yield vcall(dm, "setToDefaults", "()V");
  const { width, height } = device;
  return setDeclared(dm, "android/util/DisplayMetrics", { widthPixels: width, heightPixels: height, noncompatWidthPixels: width, noncompatHeightPixels: height });
});
/** The configuration Java sees after a device change, which the system Resources take first, as
 *  ResourcesManager.applyConfigurationToResources hands it out. */
export const applyDeviceConfiguration = driven(function* applyDeviceConfiguration(): Gen<unknown> {
  const C = "android/content/res/Configuration";
  const config = yield* awaited(javaConfiguration());
  // the system Resources exist before any configuration reaches them, as the zygote preloads them
  yield scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
  yield scall("android/content/res/Resources", "updateSystemConfiguration",
    `(L${C};Landroid/util/DisplayMetrics;Landroid/content/res/CompatibilityInfo;)V`, config, yield* awaited(deviceMetrics()), null);
  return config;
});
