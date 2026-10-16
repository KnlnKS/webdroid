// AOSP's Resources as the shell builds them, the way LoadedApk has ResourcesManager build an app's,
// and the device configuration they take.

import { awaited, driven, getDeclared, setDeclared, type Gen, type JObj } from "../jvm/runtime.ts";
import { newObj, vcall, scall } from "../jvm/natives/jentry.ts";
import { CONFIG_FIELDS, type JConfiguration, deviceConfiguration, javaLocales } from "./resnative.ts";
import { device } from "../shell/config.ts";

/** the device's DisplayMetrics, as Display.getMetrics fills one */
const deviceMetrics = driven(function* deviceMetrics(): Gen<JObj> {
  const dm: JObj = yield newObj("android/util/DisplayMetrics", "()V");
  yield vcall(dm, "setToDefaults", "()V");
  const { width, height } = device;
  return setDeclared(dm, "android/util/DisplayMetrics", { widthPixels: width, heightPixels: height, noncompatWidthPixels: width, noncompatHeightPixels: height });
});
/** An installed apk's Resources, as ResourcesManager builds them: its ApkAssets over the system
 *  ones in an AssetManager, under the device's configuration. */
export const loadResources = driven(function* loadResources(path: string, config: unknown): Gen<JObj> {
  const apk = yield scall("android/content/res/ApkAssets", "loadFromPath", "(Ljava/lang/String;)Landroid/content/res/ApkAssets;", path);
  const builder = yield newObj("android/content/res/AssetManager$Builder", "()V");
  yield vcall(builder, "addApkAssets", "(Landroid/content/res/ApkAssets;)Landroid/content/res/AssetManager$Builder;", apk);
  const assets = yield vcall(builder, "build", "()Landroid/content/res/AssetManager;");
  const jres: JObj = yield newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V",
    assets, yield* awaited(deviceMetrics()), config);
  built.push(new WeakRef(jres));
  return jres;
});
/** every Resources built here */
const built: WeakRef<JObj>[] = [];
/** The configuration Java sees after a device change: AOSP's resources take it as
 *  ResourcesManager.applyConfigurationToResources hands it out, the system's first, then every
 *  Resources built here. */
export const applyDeviceConfiguration = driven(function* applyDeviceConfiguration(): Gen<unknown> {
  const C = "android/content/res/Configuration";
  const config = yield* awaited(javaConfiguration(deviceConfiguration()));
  // the system Resources exist before any configuration reaches them, as the zygote preloads them
  yield scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
  yield scall("android/content/res/Resources", "updateSystemConfiguration",
    `(L${C};Landroid/util/DisplayMetrics;Landroid/content/res/CompatibilityInfo;)V`, config, yield* awaited(deviceMetrics()), null);
  for (const entry of built.slice()) {
    const jres = entry.deref();
    if (!jres) { built.splice(built.indexOf(entry), 1); continue; }
    const own = yield newObj(C, `(L${C};)V`, config);
    yield vcall(jres, "updateConfiguration", `(L${C};Landroid/util/DisplayMetrics;)V`, own, null);
  }
  return config;
});

/** a Configuration of AOSP's carrying our device configuration's values */
export const javaConfiguration = driven(function* javaConfiguration(c: JConfiguration): Gen<JObj> {
  const config: JObj = yield newObj("android/content/res/Configuration", "()V");
  yield vcall(config, "setToDefaults", "()V");
  for (const k of CONFIG_FIELDS) setDeclared(config, "android/content/res/Configuration", { [k]: c[k] });
  yield vcall(config, "setLocales", "(Landroid/os/LocaleList;)V", yield* awaited(javaLocales(c.locales)));
  // the display's window configuration, which the global configuration carries on a device
  const windowConfig = getDeclared(config, "android/content/res/Configuration", "windowConfiguration");
  const bounds = yield newObj("android/graphics/Rect", "(IIII)V", 0, 0, device.width, device.height);
  for (const set of ["setBounds", "setAppBounds", "setMaxBounds"]) yield vcall(windowConfig, set, "(Landroid/graphics/Rect;)V", bounds);
  yield vcall(windowConfig, "setWindowingMode", "(I)V", 1);
  const rotation = device.width > device.height ? 1 : 0;
  yield vcall(windowConfig, "setRotation", "(I)V", rotation);
  yield vcall(windowConfig, "setDisplayRotation", "(I)V", rotation);
  return config;
});
