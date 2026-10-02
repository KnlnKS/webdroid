// Content providers system packages publish (SettingsProvider, ExternalStorageProvider, MediaProvider),
// which no app's manifest declares: ActivityManagerService hands their binders out of getContentProvider.
import { rt, JObj, setDeclared, driven, type Gen, type NativeSpec } from "../jvm/runtime";
import { construct, newObj, scall, vcall } from "../jvm/natives/jlang";
import { once } from "../jvm/suspend";
import type { JBundle } from "./os";
import { toJsArray } from "../jvm/natives/jcoll";
import { unbox } from "../jvm/natives/jbox";
import { newStub } from "./binder";
import { uriText, type JUri } from "./net";

export const AS = "Landroid/content/AttributionSource;", URI = "Landroid/net/Uri;", B = "Landroid/os/Bundle;",
  CV = "Landroid/content/ContentValues;", SIGNAL = "Landroid/os/ICancellationSignal;";
const S = "Ljava/lang/String;", AFD = "android/content/res/AssetFileDescriptor", PFD = "Landroid/os/ParcelFileDescriptor;";
const OPEN_FILE = `(${AS}${URI}${S}${SIGNAL})${PFD}`, OPEN_ASSET = `(${AS}${URI}${S}${SIGNAL})L${AFD};`;

/** ContentProvider.Transport's *Async calls, which ContentResolver.getType and canonicalize make: the
 *  synchronous call's answer, or its exception, as ContentResolver.REMOTE_CALLBACK_RESULT/_ERROR */
const viaCallback = (name: string, desc: string, put: string, putDesc: string) =>
  driven(function* (this: JObj, source: JObj, uri: JObj, callback: JObj): Gen<void> {
    const result = yield newObj("android/os/Bundle", "()V");
    try { yield vcall(result, put, putDesc, "result", yield vcall(this, name, desc, source, uri)); }
    catch (e) {
      if (!rt.iof(e, "java/lang/Throwable")) throw e;
      yield vcall(result, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "error", yield newObj("android/os/ParcelableException", "(Ljava/lang/Throwable;)V", e));
    }
    yield vcall(callback, "sendResult", "(Landroid/os/Bundle;)V", result);
  });
/** the hosted providers' base, with ContentProvider's defaults over the calls each provider answers
 *  (openFile, getType, insert), as ContentProvider.Transport reaches them */
class JSystemContentProvider extends JObj {}
rt.register({ name: "webdroid/SystemContentProvider", ctor: JSystemContentProvider, sup: "android/content/ContentProviderNative", methods: {
  [`getTypeAsync(${AS}${URI}Landroid/os/RemoteCallback;)V`]: viaCallback("getType", `(${AS}${URI})${S}`, "putString", `(${S}${S})V`),
  ...Object.fromEntries(["canonicalize", "uncanonicalize"].map((name) => [`${name}Async(${AS}${URI}Landroid/os/RemoteCallback;)V`,
    viaCallback(name, `(${AS}${URI})${URI}`, "putParcelable", `(${S}Landroid/os/Parcelable;)V`)])),
  [`canonicalize(${AS}${URI})${URI}`]: () => null,
  [`uncanonicalize(${AS}${URI})${URI}`]: (_source: unknown, uri: JUri) => uri,
  [`createCancellationSignal()${SIGNAL}`]: () => scall("android/os/CancellationSignal", "createTransport", `()${SIGNAL}`),
  // the whole file openFile opens, of unknown length
  [`openAssetFile${OPEN_ASSET}`]: driven(function* openAssetFile$(this: JObj, source: JObj, uri: JUri, mode: string, signal: JObj | null): Gen {
    const fd: JObj | null = yield vcall(this, "openFile", OPEN_FILE, source, uri, mode, signal);
    return fd && newObj(AFD, `(${PFD}JJ)V`, fd, 0n, -1n);
  }),
  // the item itself when getType's answer matches the filter
  [`openTypedAssetFile(${AS}${URI}${S}${B}${SIGNAL})L${AFD};`]: driven(function* openTypedAssetFile$(this: JObj, source: JObj, uri: JUri, filter: string, _opts: unknown, signal: JObj | null): Gen {
    if (filter !== "*/*") {
      const type: string | null = yield vcall(this, "getType", `(${AS}${URI})${S}`, source, uri);
      if (type === null || !(yield scall("android/content/ClipDescription", "compareMimeTypes", `(${S}${S})Z`, type, filter)))
        throw rt.mkThrowable("java/io/FileNotFoundException", `Can't open ${yield uriText(uri)} as type ${filter}`);
    }
    return yield vcall(this, "openAssetFile", OPEN_ASSET, source, uri, "r", signal);
  }),
  // the hosted providers count the rows inserted, as SettingsProvider and MediaProvider do
  [`bulkInsert(${AS}${URI}[${CV})I`]: driven(function* bulkInsert$(this: JObj, source: JObj, uri: JUri, values: JObj[]): Gen<number> {
    let inserted = 0;
    for (const value of values) if (yield vcall(this, "insert", `(${AS}${URI}${CV}${B})${URI}`, source, uri, value, null)) inserted++;
    return inserted;
  }),
} });

/** a query, update or delete Bundle's arguments by key (ContentResolver.QUERY_ARG_*) */
export const queryArgs = driven(function* queryArgs$(extras: JBundle | null): Gen<Map<string, unknown>> {
  const args = new Map<string, unknown>();
  if (extras) for (const k of (yield toJsArray(yield vcall(extras, "keySet", "()Ljava/util/Set;"))) as string[]) {
    const v = yield vcall(extras, "get", `(${S})Ljava/lang/Object;`, k);
    args.set(k, unbox(v) ?? v);
  }
  return args;
});
/** the SQL selection and its arguments among a Bundle's */
export const selectionOf = (args: Map<string, unknown>) => [(args.get("android:query-arg-sql-selection") ?? null) as string | null,
  (args.get("android:query-arg-sql-selection-args") ?? null) as string[] | null] as const;

interface SystemProvider {
  pkg: string; cls: string; process: string;
  /** ApplicationInfo.flags and ProviderInfo.flags as the reference AVD reports them */
  appFlags: number; flags: number; initOrder: number;
  grantUriPermissions?: boolean;
  /** the action its intent filter answers, which queryIntentContentProviders matches */
  action?: string;
  binder: () => JObj | Promise<JObj>;
}
/** DocumentsContract.PROVIDER_INTERFACE: the action a documents provider's intent filter answers */
export const DOCUMENTS_PROVIDER = "android.content.action.DOCUMENTS_PROVIDER";
const providers = new Map<string, SystemProvider>();
/** a system provider answering `methods` (IContentProvider's) over the base's defaults */
export function registerSystemProvider(authority: string, provider: Omit<SystemProvider, "binder"> & { methods: NativeSpec["methods"] }): void {
  const { methods, ...p } = provider, name = "webdroid/" + p.cls.slice(p.cls.lastIndexOf(".") + 1);
  rt.register({ name, ctor: class extends JSystemContentProvider {}, sup: "webdroid/SystemContentProvider",
    methods: { [`getProviderName()${S}`]: () => p.cls, ...methods } });
  providers.set(authority, { ...p, binder: once(() => newStub(name)) });
}
/** the system providers by authority, which the package manager lists before the installed ones */
export const systemProviders: ReadonlyMap<string, Readonly<SystemProvider>> = providers;

/** a system provider's IContentProvider by its authority */
export const systemProvider = (authority: string | null): JObj | Promise<JObj> | null =>
  authority === null ? null : providers.get(authority)?.binder() ?? null;

/** a system provider's ProviderInfo, as the package manager and getContentProvider report it */
export function* systemProviderInfo$(authority: string): Gen<JObj | null> {
  const p = providers.get(authority);
  if (!p) return null;
  const app: JObj = yield construct("android/content/pm/ApplicationInfo", "()V"), info: JObj = yield construct("android/content/pm/ProviderInfo", "()V");
  setDeclared(app, "android/content/pm/ApplicationInfo", { packageName: p.pkg, processName: p.process, uid: 1000, flags: p.appFlags });
  return setDeclared(info, "android/content/pm/ProviderInfo", { authority, initOrder: p.initOrder, flags: p.flags,
    grantUriPermissions: p.grantUriPermissions ? 1 : 0, applicationInfo: app, processName: p.process, exported: 1, name: p.cls, packageName: p.pkg });
}
/** ActivityManagerService.getContentProvider's holder for a system provider: its ProviderInfo, its
 *  binder, and no reference to release */
export const systemProviderHolder = driven(function* systemProviderHolder$(authority: string): Gen<JObj | null> {
  const info: JObj | null = yield* systemProviderInfo$(authority);
  if (!info) return null;
  const holder: JObj = yield construct("android/app/ContentProviderHolder", "(Landroid/content/pm/ProviderInfo;)V", info);
  return setDeclared(holder, "android/app/ContentProviderHolder", { provider: yield providers.get(authority)!.binder(), noReleaseNeeded: 1 });
});
