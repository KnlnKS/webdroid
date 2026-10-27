// Content providers system packages publish (SettingsProvider, ExternalStorageProvider, MediaProvider),
// which no app's manifest declares: ActivityManagerService hands their binders out of getContentProvider.
import { awaited, rt, JObj, setDeclared, getDeclared, driven, type Gen, type NativeSpec } from "../jvm/runtime.ts";
import { newObj, scall, vcall, after, iof } from "../jvm/natives/jentry.ts";
import { once } from "../jvm/suspend.ts";
import { arrayMapEntries } from "../jvm/natives/jcoll.ts";
import { unbox, boxLong, boxDouble } from "../jvm/natives/jbox.ts";
import { i8, jarray, strArray } from "../jvm/abi.ts";
import { newStub, importBinder } from "./binder.ts";
import { broker, remoteSystem } from "../shell/broker-access.ts";
import { mkUri, uriText, type JUri } from "./net.ts";

const AS = "Landroid/content/AttributionSource;", URI = "Landroid/net/Uri;", B = "Landroid/os/Bundle;",
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
      if (!iof(e, "java/lang/Throwable")) throw e;
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
        throw rt.mkThrowable("java/io/FileNotFoundException", `Can't open ${yield* awaited(uriText(uri))} as type ${filter}`);
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

/** the SQL selection and its arguments a query, update or delete Bundle carries (ContentResolver.QUERY_ARG_SQL_*) */
function* selectionOf(extras: JObj | null): Gen<[string | null, string[] | null]> {
  return extras ? [yield vcall(extras, "getString", `(${S})${S}`, "android:query-arg-sql-selection"),
    yield vcall(extras, "getStringArray", `(${S})[${S}`, "android:query-arg-sql-selection-args")] : [null, null];
}
/** a ContentValues' entries, with boxed numbers unwrapped */
export const contentValues = (values: JObj | null): Map<string, unknown> => new Map(values === null ? [] :
  arrayMapEntries(getDeclared(values, "android/content/ContentValues", "mMap")).map(([k, v]) => [k as string, unbox(v) ?? v]));
/** a SQLite value as MatrixCursor holds it: INTEGER a Long, REAL a Double */
const cell = (v: unknown) => typeof v === "number" ? Number.isInteger(v) ? boxLong(BigInt(v)) : boxDouble(v)
  : typeof v === "bigint" ? boxLong(v) : v instanceof Uint8Array ? i8(v.slice()) : v;
/** a MatrixCursor over rows in hand: each one's cells in `columns` order, or a record of them by
 *  column, which a projection picks from as RowBuilder.add does (a column it lacks is null) */
export const matrixCursor = driven(function* matrixCursor(columns: string[], rows: readonly (readonly unknown[] | Readonly<Record<string, unknown>>)[]): Gen<JObj> {
  const cursor: JObj = yield newObj("android/database/MatrixCursor", "([Ljava/lang/String;I)V", strArray(columns), rows.length);
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : columns.map((column) => (Object.hasOwn(row, column) ? (row as Record<string, unknown>)[column] : null));
    yield vcall(cursor, "addRow", "([Ljava/lang/Object;)V", jarray(cells.map(cell)));
  }
  return cursor;
});
/** a Bundle holding one Uri, as a call answers a document or a scanned file */
export const uriBundle = driven(function* uriBundle$(key: string, uri: string | null): Gen<JObj> {
  const out: JObj = yield newObj("android/os/Bundle", "()V");
  yield vcall(out, "putParcelable", `(${S}Landroid/os/Parcelable;)V`, key, uri === null ? null : yield* awaited(mkUri(uri)));
  return out;
});

type Maybe<T> = PromiseOrVal<T>;
/** the IContentProvider calls a hosted provider answers, over uri strings, ContentValues' entries
 *  and the Bundle's selection; ContentProvider's defaults stand for those it leaves out */
interface ProviderOps {
  query?(uri: string, projection: string[] | null, selection: string | null, selectionArgs: string[] | null, extras: JObj | null): Maybe<JObj | null>;
  insert?(uri: string, values: Map<string, unknown>): Maybe<string | null>;
  update?(uri: string, values: Map<string, unknown>, selection: string | null, selectionArgs: string[] | null): Maybe<number>;
  delete?(uri: string, selection: string | null, selectionArgs: string[] | null): Maybe<number>;
  getType?(uri: string): Maybe<string | null>;
  openFile?(uri: string, mode: string): Maybe<JObj | null>;
  call?(method: string, arg: string | null, extras: JObj | null): Maybe<JObj | null>;
}
/** IContentProvider's methods over a provider's operations */
function transport(ops: ProviderOps): NativeSpec["methods"] {
  const methods: NativeSpec["methods"] = {};
  const { query, insert, update, delete: remove, getType, openFile, call } = ops;
  if (query) methods[`query(${AS}${URI}[${S}${B}${SIGNAL})Landroid/database/Cursor;`] = driven(function* (_source: unknown, uri: JUri | null, projection: string[] | null, extras: JObj | null): Gen {
    return yield* awaited(query(yield* awaited(uriText(uri)), projection, ...(yield* selectionOf(extras)), extras));
  });
  if (insert) methods[`insert(${AS}${URI}${CV}${B})${URI}`] = driven(function* (_source: unknown, uri: JUri | null, values: JObj | null): Gen {
    const inserted = yield* awaited(insert(yield* awaited(uriText(uri)), contentValues(values)));
    return inserted === null ? null : yield* awaited(mkUri(inserted));
  });
  if (update) methods[`update(${AS}${URI}${CV}${B})I`] = driven(function* (_source: unknown, uri: JUri | null, values: JObj | null, extras: JObj | null): Gen {
    return yield* awaited(update(yield* awaited(uriText(uri)), contentValues(values), ...(yield* selectionOf(extras))));
  });
  if (remove) methods[`delete(${AS}${URI}${B})I`] = driven(function* (_source: unknown, uri: JUri | null, extras: JObj | null): Gen {
    return yield* awaited(remove(yield* awaited(uriText(uri)), ...(yield* selectionOf(extras))));
  });
  if (getType) methods[`getType(${AS}${URI})${S}`] = (_source: unknown, uri: JUri | null) => after(uriText(uri), getType);
  if (openFile) methods[`openFile${OPEN_FILE}`] = (_source: unknown, uri: JUri | null, mode: string) => after(uriText(uri), (u) => openFile(u, mode));
  if (call) methods[`call(${AS}${S}${S}${S}${B})${B}`] = (_source: unknown, _authority: string, method: string, arg: string | null, extras: JObj | null) => call(method, arg, extras);
  return methods;
}

interface SystemProvider {
  pkg: string; cls: string; process: string;
  /** ApplicationInfo.flags and ProviderInfo.flags as the reference AVD reports them */
  appFlags: number; flags: number; initOrder: number;
  grantUriPermissions?: boolean;
  /** the action its intent filter answers, which queryIntentContentProviders matches */
  action?: string;
  /** its state (files, index) lives in system_server's realm, which another realm's process reaches over the broker */
  systemRealm?: boolean;
  binder: () => PromiseOrVal<JObj>;
}
/** DocumentsContract.PROVIDER_INTERFACE: the action a documents provider's intent filter answers */
export const DOCUMENTS_PROVIDER = "android.content.action.DOCUMENTS_PROVIDER";
const providers = new Map<string, SystemProvider>();
/** a system provider answering `ops` over the base's defaults */
export function registerSystemProvider(authority: string, p: Omit<SystemProvider, "binder">, ops: ProviderOps): void {
  const name = "webdroid/" + p.cls.slice(p.cls.lastIndexOf(".") + 1);
  rt.register({ name, ctor: class extends JSystemContentProvider {}, sup: "webdroid/SystemContentProvider",
    methods: { [`getProviderName()${S}`]: () => p.cls, ...transport(ops) } });
  providers.set(authority, { ...p, binder: once(() => newStub(name)) });
}
/** the system providers by authority, which the package manager lists before the installed ones */
export const systemProviders: ReadonlyMap<string, Readonly<SystemProvider>> = providers;

/** this realm's binder for a system provider, or system_server's when its state lives there */
function* providerBinder$(authority: string, p: SystemProvider): Gen<JObj> {
  if (!p.systemRealm || !remoteSystem()) return yield* awaited(p.binder());
  const binder = yield* awaited(importBinder(yield* awaited(broker().systemProvider(authority))));
  return yield scall("android/content/ContentProviderNative", "asInterface", "(Landroid/os/IBinder;)Landroid/content/IContentProvider;", binder);
}

/** a system provider's IContentProvider by its authority */
export const systemProvider = (authority: string | null): PromiseOrVal<JObj> | null =>
  authority === null ? null : providers.get(authority)?.binder() ?? null;

/** a system provider's ProviderInfo, as the package manager and getContentProvider report it */
export function* systemProviderInfo$(authority: string): Gen<JObj | null> {
  const p = providers.get(authority);
  if (!p) return null;
  const app: JObj = yield newObj("android/content/pm/ApplicationInfo", "()V"), info: JObj = yield newObj("android/content/pm/ProviderInfo", "()V");
  setDeclared(app, "android/content/pm/ApplicationInfo", { packageName: p.pkg, processName: p.process, uid: 1000, flags: p.appFlags });
  return setDeclared(info, "android/content/pm/ProviderInfo", { authority, initOrder: p.initOrder, flags: p.flags,
    grantUriPermissions: p.grantUriPermissions ? 1 : 0, applicationInfo: app, processName: p.process, exported: 1, name: p.cls, packageName: p.pkg });
}
/** ActivityManagerService.getContentProvider's holder for a system provider: its ProviderInfo, its
 *  binder, and no reference to release */
export const systemProviderHolder = driven(function* systemProviderHolder$(authority: string): Gen<JObj | null> {
  const info: JObj | null = yield* systemProviderInfo$(authority);
  if (!info) return null;
  const holder: JObj = yield newObj("android/app/ContentProviderHolder", "(Landroid/content/pm/ProviderInfo;)V", info);
  return setDeclared(holder, "android/app/ContentProviderHolder", { provider: yield* providerBinder$(authority, providers.get(authority)!), noReleaseNeeded: 1 });
});
