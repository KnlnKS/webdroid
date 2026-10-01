// Content providers system packages publish (SettingsProvider, ExternalStorageProvider), which no
// app's manifest declares: ActivityManagerService hands their binders out of getContentProvider.
import { JObj, declaredField, driven, type Gen } from "../jvm/runtime";
import { construct } from "../jvm/natives/jlang";

interface SystemProvider {
  pkg: string; cls: string; process: string;
  /** ApplicationInfo.flags and ProviderInfo.flags as the reference AVD reports them */
  appFlags: number; flags: number; initOrder: number;
  binder: () => JObj | Promise<JObj>;
}
const providers = new Map<string, SystemProvider>();
export function registerSystemProvider(authority: string, provider: SystemProvider): void { providers.set(authority, provider); }

/** a system provider's IContentProvider by its authority */
export const systemProvider = (authority: string | null): JObj | Promise<JObj> | null =>
  authority === null ? null : providers.get(authority)?.binder() ?? null;

const set = (o: JObj, cls: string, values: Record<string, unknown>) => {
  for (const [name, value] of Object.entries(values)) {
    const field = declaredField(cls, name);
    if (!field) throw new Error(`${cls} has no field ${name}`);
    (o as unknown as Record<string, unknown>)[field] = value;
  }
};
/** ActivityManagerService.getContentProvider's holder for a system provider: its ProviderInfo, its
 *  binder, and no reference to release */
export const systemProviderHolder = driven(function* systemProviderHolder$(authority: string): Gen<JObj | null> {
  const p = providers.get(authority);
  if (!p) return null;
  const app: JObj = yield construct("android/content/pm/ApplicationInfo", "()V"), info: JObj = yield construct("android/content/pm/ProviderInfo", "()V");
  set(app, "android/content/pm/ApplicationInfo", { packageName: p.pkg, processName: p.process, uid: 1000, flags: p.appFlags });
  set(info, "android/content/pm/ProviderInfo", { authority, initOrder: p.initOrder, flags: p.flags });
  set(info, "android/content/pm/ComponentInfo", { applicationInfo: app, processName: p.process, exported: 1 });
  set(info, "android/content/pm/PackageItemInfo", { name: p.cls, packageName: p.pkg });
  const holder: JObj = yield construct("android/app/ContentProviderHolder", "(Landroid/content/pm/ProviderInfo;)V", info);
  set(holder, "android/app/ContentProviderHolder", { provider: yield p.binder(), noReleaseNeeded: 1 });
  return holder;
});
