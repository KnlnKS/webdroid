// AOSP's Resources, Theme and XmlBlock as our own stack meets them. The view stack still reads
// resources below the Java line (res.ts), so it reaches the native state behind a Java object
// here; and the shell builds an app's Resources the way LoadedApk has ResourcesManager build it.

import { rt, driven, type Gen, type JObj } from "../jvm/runtime";
import { newObj, vcall, scall } from "../jvm/natives/jlang";
import { isBytecode } from "../jvm/provenance";
import { Resources, JTheme, nativeTheme } from "./res";
import { JDisplayMetrics } from "./util";
import { CONFIG_FIELDS, type JConfiguration, mkJResources, deviceConfiguration } from "./resnative";
import { registerApk } from "./assetmanager";

/** AOSP's android.content.res classes answer, not our specs (src/jvm/provenance.ts) */
export function aospResources(): boolean { return isBytecode("android/content/res/Resources"); }

/** An installed apk's Resources, as ResourcesManager builds them: its ApkAssets over the system
 *  ones in an AssetManager, under the device's configuration. */
export const loadResources = driven(function* loadResources(path: string, config: unknown): Gen<JObj> {
  const apk = yield scall("android/content/res/ApkAssets", "loadFromPath", "(Ljava/lang/String;)Landroid/content/res/ApkAssets;", path);
  const builder = yield newObj("android/content/res/AssetManager$Builder", "()V");
  yield vcall(builder, "addApkAssets", "(Landroid/content/res/ApkAssets;)Landroid/content/res/AssetManager$Builder;", apk);
  const assets = yield vcall(builder, "build", "()Landroid/content/res/AssetManager;");
  const jres: JObj = yield newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V",
    assets, new JDisplayMetrics(), config);
  apkPaths.set(jres, path);
  built.push({ jres: new WeakRef(jres), override: null });
  return jres;
});
const apkPaths = new WeakMap<object, string>();
/** every Resources built here, with the override configuration it was created under */
const built: { jres: WeakRef<JObj>; override: unknown }[] = [];
/** Context.createConfigurationContext's Resources: the same apk under the configuration
 *  `override` is applied to, with an AssetManager of its own as ResourcesManager gives each */
export const configuredResources = driven(function* configuredResources(jres: JObj, override: unknown): Gen<JObj> {
  const C = "android/content/res/Configuration";
  const config = yield newObj(C, `(L${C};)V`, yield vcall(jres, "getConfiguration", `()L${C};`));
  yield vcall(config, "updateFrom", `(L${C};)I`, override);
  const scoped: JObj = yield loadResources(apkPaths.get(jres)!, config);
  built[built.length - 1].override = override;
  return scoped;
});
/** The configuration Java sees after a device change: AOSP's resources take it as
 *  ResourcesManager.applyConfigurationToResources hands it out, the system's first, then every
 *  Resources with its own override applied over it. */
export const applyDeviceConfiguration = driven(function* applyDeviceConfiguration(): Gen<unknown> {
  if (!aospResources()) return deviceConfiguration();
  const C = "android/content/res/Configuration";
  const config = yield javaConfiguration(deviceConfiguration());
  yield scall("android/content/res/Resources", "updateSystemConfiguration",
    `(L${C};Landroid/util/DisplayMetrics;Landroid/content/res/CompatibilityInfo;)V`, config, new JDisplayMetrics(), null);
  for (const entry of built.slice()) {
    const jres = entry.jres.deref();
    if (!jres) { built.splice(built.indexOf(entry), 1); continue; }
    const own = yield newObj(C, `(L${C};)V`, config);
    if (entry.override) yield vcall(own, "updateFrom", `(L${C};)I`, entry.override);
    yield vcall(jres, "updateConfiguration", `(L${C};Landroid/util/DisplayMetrics;)V`, own, null);
  }
  return config;
});
/** the android.content.res.Resources over a package's tables, installed at `path` */
export const javaResources = driven(function* javaResources(res: Resources, path: string): Gen<JObj> {
  if (res.jobj) return res.jobj;
  if (!aospResources()) return mkJResources(res, false);
  registerApk(path, res);
  return res.jobj = yield loadResources(path, yield javaConfiguration(deviceConfiguration()));
});

/** A theme over `jres`: `base`'s styles, then `styleId` forced over them, as setTheme and
 *  ContextThemeWrapper layer a style. Our own stack keeps the native half; the Java half is
 *  its `jobj`. */
export function newTheme(res: Resources, jres: unknown, base: JTheme | null, styleId: number): JTheme | Promise<JTheme> {
  if (!aospResources()) {
    const t = new JTheme();
    t.res = res;
    if (base) t.setTo(base);
    if (styleId) t.apply(styleId);
    return t;
  }
  return (async () => {
    const t = await vcall(jres, "newTheme", "()Landroid/content/res/Resources$Theme;");
    if (base?.jobj) await vcall(t, "setTo", "(Landroid/content/res/Resources$Theme;)V", base.jobj);
    if (styleId) await vcall(t, "applyStyle", "(IZ)V", styleId, 1);
    return nativeTheme(t)!;
  })();
}
/** the Java object a context hands out for its theme */
export const javaTheme = (t: JTheme | null): unknown => (t && aospResources() ? t.jobj : t);

/** a Configuration of AOSP's carrying our device configuration's values */
export const javaConfiguration = driven(function* javaConfiguration(c: JConfiguration): Gen<unknown> {
  const config = yield newObj("android/content/res/Configuration", "()V");
  yield vcall(config, "setToDefaults", "()V");
  for (const k of CONFIG_FIELDS) (config as Record<string, number>)[rt.fieldProp("android/content/res/Configuration", k)!] = c[k];
  yield vcall(config, "setLocales", "(Landroid/os/LocaleList;)V", c.locales);
  return config;
});
