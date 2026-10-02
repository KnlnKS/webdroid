// Content providers system packages publish (SettingsProvider, ExternalStorageProvider, MediaProvider),
// which no app's manifest declares: ActivityManagerService hands their binders out of getContentProvider.
import { rt, JObj, setDeclared, driven, type Gen } from "../jvm/runtime";
import { construct, newObj, vcall } from "../jvm/natives/jlang";

/** ContentProvider.Transport's *Async calls, which ContentResolver.getType and canonicalize make: the
 *  synchronous call's answer, or its exception, as ContentResolver.REMOTE_CALLBACK_RESULT/_ERROR */
const AS = "Landroid/content/AttributionSource;", URI = "Landroid/net/Uri;", CALLBACK = "Landroid/os/RemoteCallback;";
const viaCallback = (name: string, desc: string, put: string, putDesc: string) =>
  async function (this: JObj, source: JObj, uri: JObj, callback: JObj): Promise<void> {
    const result = await newObj("android/os/Bundle", "()V");
    try { await vcall(result, put, putDesc, "result", await vcall(this, name, desc, source, uri)); }
    catch (e) {
      if (!rt.iof(e, "java/lang/Throwable")) throw e;
      await vcall(result, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "error", await newObj("android/os/ParcelableException", "(Ljava/lang/Throwable;)V", e));
    }
    await vcall(callback, "sendResult", "(Landroid/os/Bundle;)V", result);
  };
/** the hosted providers' base: their specs' classes extend it, as it extends ContentProviderNative */
export class JSystemContentProvider extends JObj {}
rt.register({ name: "webdroid/SystemContentProvider", ctor: JSystemContentProvider, sup: "android/content/ContentProviderNative", methods: {
  [`getTypeAsync(${AS}${URI}${CALLBACK})V`]: viaCallback("getType", `(${AS}${URI})Ljava/lang/String;`, "putString", "(Ljava/lang/String;Ljava/lang/String;)V"),
  ...Object.fromEntries(["canonicalize", "uncanonicalize"].map((name) => [`${name}Async(${AS}${URI}${CALLBACK})V`,
    viaCallback(name, `(${AS}${URI})${URI}`, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V")])),
} });

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

/** ActivityManagerService.getContentProvider's holder for a system provider: its ProviderInfo, its
 *  binder, and no reference to release */
export const systemProviderHolder = driven(function* systemProviderHolder$(authority: string): Gen<JObj | null> {
  const p = providers.get(authority);
  if (!p) return null;
  const app: JObj = yield construct("android/content/pm/ApplicationInfo", "()V"), info: JObj = yield construct("android/content/pm/ProviderInfo", "()V");
  setDeclared(app, "android/content/pm/ApplicationInfo", { packageName: p.pkg, processName: p.process, uid: 1000, flags: p.appFlags });
  setDeclared(info, "android/content/pm/ProviderInfo", { authority, initOrder: p.initOrder, flags: p.flags });
  setDeclared(info, "android/content/pm/ComponentInfo", { applicationInfo: app, processName: p.process, exported: 1 });
  setDeclared(info, "android/content/pm/PackageItemInfo", { name: p.cls, packageName: p.pkg });
  const holder: JObj = yield construct("android/app/ContentProviderHolder", "(Landroid/content/pm/ProviderInfo;)V", info);
  setDeclared(holder, "android/app/ContentProviderHolder", { provider: yield p.binder(), noReleaseNeeded: 1 });
  return holder;
});
