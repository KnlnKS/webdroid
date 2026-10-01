import { services, type JContext } from "./context";
import { rt, type NativeSpec, JObj, stubs, driven, type Gen } from "../jvm/runtime";
import { appHost, type AppHost } from "./apphost";
import { type JUri, mkUri, uriParts, uriDecode } from "./net";
import {
  isDocsUri, documentId, docRead, docWrite, docInputStream, docOutputStream, docRow, isChildrenUri, docChildren,
  DOC_COLUMNS, docCells, docDelete
} from "./documents";
import { mkPfd, pfdBackingBytes, PROCESS_NAME, PROCESS_UID, type JBundle, unparcel } from "./os";
import { newFile, streamOf } from "../jvm/natives/jio";
import { mkAssetFd, rawResourceBytes } from "./resnative";
import { newObj, defineException, vcall, vcallOn, callOn, mainThread } from "../jvm/natives/jlang";
import { mkCursor, contentValues } from "./sqlite";
import { newArrayList } from "../jvm/natives/jcoll";
import { resolveProvider, javaProviderInfo, componentProcess, authoritiesOf, type Component } from "./pm";
import { locationTransport } from "./locationmanager";
import { inMainJob, onMain } from "./mainloop";
import { packages } from "./packages";
import { isMediaUri, mediaDelete, mediaInsert, mediaMime, mediaPath, mediaQuery, mediaUpdate } from "./mediastore";

export const providerTransport: { acquire: (provider: Component) => Promise<unknown> } = { acquire: async () => null };
const providers = new WeakMap<AppHost, Map<string, Promise<unknown>>>();
/** ActivityThread.installProvider: the provider's instance in this process, attached to its ProviderInfo */
export function attachProvider(ctx: JContext, component: Component): Promise<unknown> {
  let local = providers.get(ctx.$host);
  if (!local) providers.set(ctx.$host, local = new Map());
  const authorities = authoritiesOf(component.node);
  const existing = local.get(authorities[0]);
  if (existing) return existing;
  const create = async () => {
    const provider = await callOn(mainThread, () => newObj(component.name.replace(/\./g, "/")));
    await vcallOn(mainThread, provider, "attachInfo", "(Landroid/content/Context;Landroid/content/pm/ProviderInfo;)V", ctx, await javaProviderInfo(component));
    return provider;
  };
  const ready = (inMainJob() ? create() : onMain(create)).catch((error) => {
    for (const authority of authorities) local.delete(authority);
    throw error;
  });
  for (const authority of authorities) local.set(authority, ready);
  return ready;
}
async function contentProvider(uri: JUri): Promise<unknown> {
  const authority = /^content:\/\/([^/?#]+)/.exec(uri.uri)?.[1];
  if (!authority || !appHost?.application) return null;
  const existing = providers.get(appHost)?.get(authority);
  if (existing) return existing;
  const component = resolveProvider(authority);
  if (!component) return null;
  return component.owner.pkg === appHost.pkg && componentProcess(component) === (PROCESS_NAME || appHost.pkg)
    ? attachProvider(appHost.application, component) : providerTransport.acquire(component);
}

export const providerOperations = {
  openFile: "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
  query: "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
  insert: "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
  bulkInsert: "(Landroid/net/Uri;[Landroid/content/ContentValues;)I",
  update: "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
  delete: "(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I",
  getType: "(Landroid/net/Uri;)Ljava/lang/String;",
  call: "(Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;",
};
/** query(..., CancellationSignal): the signal is checked once, then the plain query answers */
const cancellableQuery = driven(function* (this: JObj, u: JUri, projection: unknown, selection: unknown, args: unknown, sort: unknown, cancellation: unknown): Gen {
  if (cancellation) yield vcall(cancellation, "throwIfCanceled", "()V");
  return vcall(this, "query", providerOperations.query, u, projection, selection, args, sort);
});
class JProviderClient extends JObj { provider: unknown = null; closed = false; }
function releaseClient(this: JProviderClient): number {
  if (this.closed) return 0;
  this.closed = true; this.provider = null; return 1;
}
async function acquireClient(uri: JUri): Promise<JProviderClient | null> {
  const provider = await contentProvider(uri);
  if (!provider) return null;
  rt.link("android/content/ContentProviderClient");
  const client = new JProviderClient(); client.provider = provider; return client;
}
rt.register({ name: "android/content/ContentProviderClient", ctor: JProviderClient, ifaces: ["java/lang/AutoCloseable"], methods: {
  "query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;": cancellableQuery,
  "release()Z": releaseClient,
  "close()V": function (this: JProviderClient) { releaseClient.call(this); },
  "getLocalContentProvider()Landroid/content/ContentProvider;": function (this: JProviderClient) {
    return rt.iof(this.provider, "android/content/ContentProvider") ? this.provider : null;
  },
  ...Object.fromEntries(Object.entries(providerOperations).map(([name, desc]) => [name + desc,
    async function (this: JProviderClient, ...args: unknown[]) {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "ContentProviderClient is closed");
      return vcall(this.provider, name, desc, ...args);
    },
  ])),
} });

export function contentResolver(): unknown {
  let s = services.get("$content");
  if (!s) {
    const info = rt.link("android/content/ContentResolver");
    s = new info.ctor();
    services.set("$content", s);
  }
  return s;
}
type PersistedUriGrant = { uri: string; flags: number; time: number };
const PREFIX_GRANT = 0x80, PERSISTABLE_GRANT = 0x40;
/** A persistable grant is app state that survives a reboot, so it lives with the install. */
const uriGrants = {
  key: () => "wd:install:" + (appHost?.pkg ?? "") + ":uriperms",
  all(): PersistedUriGrant[] {
    try {
      const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(this.key()) ?? "[]");
      if (!Array.isArray(saved)) return [];
      return saved.flatMap((entry) => {
        if (typeof entry === "string") return [{ uri: entry, flags: 3 | (entry.includes("/tree/") ? PREFIX_GRANT : 0), time: 0 }];
        if (entry && typeof entry === "object" && "uri" in entry && typeof entry.uri === "string" &&
          "flags" in entry && typeof entry.flags === "number")
          return [{ uri: entry.uri, flags: entry.flags, time: "time" in entry && typeof entry.time === "number" ? entry.time : 0 }];
        return [];
      });
    } catch { return []; }
  },
  set(v: PersistedUriGrant[]) { try { globalThis.localStorage?.setItem(this.key(), JSON.stringify(v)); } catch { /* private mode */ } },
};
const transientUriGrants = new Map<string, Map<string, number>>();
const grantedUri = (target: string, granted: string, flags: number) =>
  target === granted || ((flags & PREFIX_GRANT) !== 0 && target.startsWith(granted + "/"));
function transientFlags(pkg: string, uri: JUri): number {
  let flags = 0;
  for (const [granted, mode] of transientUriGrants.get(pkg) ?? []) {
    if (grantedUri(uri.uri, granted, mode)) flags |= mode;
  }
  return flags;
}
export function grantUriPermission(pkg: string, uri: JUri, modes: number): void {
  if (!pkg || !uri) rt.npe();
  if (!(modes & 3)) return;
  let grants = transientUriGrants.get(pkg);
  if (!grants) transientUriGrants.set(pkg, grants = new Map());
  grants.set(uri.uri, (grants.get(uri.uri) ?? 0) | (modes & (3 | PREFIX_GRANT | PERSISTABLE_GRANT)));
}
export function revokeUriPermission(uri: JUri, modes: number): void {
  if (!uri) rt.npe();
  for (const grants of transientUriGrants.values()) {
    const remaining = (grants.get(uri.uri) ?? 0) & ~(modes & 3);
    if (remaining & 3) grants.set(uri.uri, remaining);
    else grants.delete(uri.uri);
  }
}
export function checkUriPermission(u: JUri, _pid: number, uid: number, modes: number): number {
  if (!u) rt.npe();
  if (uid === 0) return 0;
  const requested = modes & 3;
  if (!requested) return -1;
  if (uid === PROCESS_UID && uriGrants.all().some((grant) =>
    grantedUri(u.uri, grant.uri, grant.flags) && (grant.flags & requested) === requested)) return 0;
  for (const pkg of transientUriGrants.keys()) {
    if (packages.get(pkg)?.uid !== uid) continue;
    if ((transientFlags(pkg, u) & requested) === requested) return 0;
  }
  return -1;
}
/** ContentResolver.getResourceId: android.resource://pkg/id or android.resource://pkg/type/name */
function resourceBytes(u: JUri): Uint8Array {
  const { authority, path } = uriParts(u), res = authority === appHost?.pkg ? appHost.res : null;
  if (!res) throw rt.mkThrowable("java/io/FileNotFoundException", "No package found for authority: " + u.uri);
  const segments = (path ?? "").split("/").filter(Boolean).map((s) => uriDecode(s) ?? "");
  const id = segments.length === 1 ? Number(segments[0]) : segments.length === 2 ? res.idFor(segments[0], segments[1], authority!) : NaN;
  if (!id) throw rt.mkThrowable("java/io/FileNotFoundException", "No resource found for: " + u.uri);
  try { return rawResourceBytes(res, id); }
  catch { throw rt.mkThrowable("java/io/FileNotFoundException", "Resource does not exist: " + u.uri); }
}
const isResourceUri = (u: JUri) => uriParts(u).scheme === "android.resource";
function fileOf(u: JUri): string {
  const parts = uriParts(u);
  if (parts.scheme !== "file") throw rt.mkThrowable("java/io/FileNotFoundException", u.uri);
  return uriDecode(parts.path) ?? "";
}
/** A descriptor carries the document's current bytes and writes them back when it is closed. */
async function openFilePfd(path: string, mode: string) {
  const cls = rt.link("android/os/ParcelFileDescriptor").ctor;
  return vcall(cls, "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;", await newFile(path),
    await vcall(cls, "parseMode", "(Ljava/lang/String;)I", mode));
}
export async function openPfd(u: JUri, mode: string) {
  if (isMediaUri(u)) {
    const path = await mediaPath(u);
    if (!path) throw rt.mkThrowable("java/io/FileNotFoundException", u.uri);
    return openFilePfd(path, mode);
  }
  if (!isDocsUri(u)) {
    const provider = await contentProvider(u);
    if (provider) return vcall(provider, "openFile", providerOperations.openFile, u, mode);
    if (u.uri.startsWith("content:")) throw rt.mkThrowable("java/io/FileNotFoundException", u.uri);
    return openFilePfd(fileOf(u), mode);
  }
  const id = documentId(u, true);
  const write = (mode ?? "r").includes("w");
  const bytes = await pfdBackingBytes(id) ?? (write && (mode ?? "").includes("t") ? new Uint8Array(0) : await docRead(id));
  return mkPfd(bytes, write ? (b) => docWrite(id, b) : null, id);
}
const openOutputStream = driven(function* (u: JUri, mode: string): Gen {
  if (isDocsUri(u)) return docOutputStream(documentId(u, true), mode.includes("a"));
  if (u.uri.startsWith("content:") && !isMediaUri(u))
    return newObj("android/os/ParcelFileDescriptor$AutoCloseOutputStream", "(Landroid/os/ParcelFileDescriptor;)V", yield openPfd(u, mode));
  const path = isMediaUri(u) ? yield mediaPath(u) : fileOf(u);
  if (!path) throw rt.mkThrowable("java/io/FileNotFoundException", u.uri);
  return newObj("java/io/FileOutputStream", "(Ljava/lang/String;Z)V", path, mode.includes("a") ? 1 : 0);
});
const openAfd = async (u: JUri, mode: string) => {
  if (isResourceUri(u)) return mkAssetFd(resourceBytes(u));
  const pfd = await openPfd(u, mode);
  return mkAssetFd(pfd.bytes, pfd);
};
const contentObservers = new Set<{ uri: string; descendants: boolean; observer: unknown }>();
/** `flags` is NOTIFY_*; the boolean overload's syncToNetwork is NOTIFY_SYNC_TO_NETWORK (1) */
async function notifyContentObservers(uri: JUri, origin: unknown, flags = 0): Promise<void> {
  if (!uri) rt.npe();
  for (const entry of [...contentObservers]) {
    if (entry.uri !== uri.uri && !(entry.descendants && uri.uri.startsWith(entry.uri.replace(/\/$/, "") + "/"))) continue;
    const self = entry.observer === origin;
    if (self && !await vcall(entry.observer, "deliverSelfNotifications", "()Z")) continue;
    await vcall(entry.observer, "dispatchChange", "(ZLandroid/net/Uri;I)V", self ? 1 : 0, uri, flags);
  }
}
/** the ContentResolver.QUERY_ARG_* keys the Bundle form of query understands */
const QUERY_ARGS = new Set(["android:query-arg-sql-selection", "android:query-arg-sql-selection-args", "android:query-arg-sql-sort-order",
  "android:query-arg-sort-columns", "android:query-arg-sort-direction", "android:query-arg-limit",
  "android:query-arg-match-trashed", "android:query-arg-match-pending", "android:query-arg-match-favorite"]);
const resolverMethods: NativeSpec["methods"] = {
  ...Object.fromEntries(["acquireContentProviderClient", "acquireUnstableContentProviderClient"].flatMap((name) => [
    [name + "(Landroid/net/Uri;)Landroid/content/ContentProviderClient;", acquireClient],
    [name + "(Ljava/lang/String;)Landroid/content/ContentProviderClient;", async (authority: string) => acquireClient(mkUri("content://" + authority))],
  ])),
  "notifyChange(Landroid/net/Uri;Landroid/database/ContentObserver;)V": notifyContentObservers,
  "notifyChange(Landroid/net/Uri;Landroid/database/ContentObserver;Z)V": notifyContentObservers,
  "notifyChange(Landroid/net/Uri;Landroid/database/ContentObserver;I)V": notifyContentObservers,
  "registerContentObserver(Landroid/net/Uri;ZLandroid/database/ContentObserver;)V": (uri: JUri, descendants: number, observer: unknown) => {
    if (!uri || !observer) rt.npe();
    contentObservers.add({ uri: uri.uri, descendants: !!descendants, observer });
  },
  "unregisterContentObserver(Landroid/database/ContentObserver;)V": (observer: unknown) => {
    if (!observer) rt.npe();
    for (const entry of contentObservers) if (entry.observer === observer) contentObservers.delete(entry);
  },
  "openInputStream(Landroid/net/Uri;)Ljava/io/InputStream;": driven(function* (u: JUri): Gen {
    return isDocsUri(u) ? docInputStream(documentId(u, true))
      : isResourceUri(u) ? streamOf(resourceBytes(u))
      : u.uri.startsWith("content:") ? newObj("android/os/ParcelFileDescriptor$AutoCloseInputStream", "(Landroid/os/ParcelFileDescriptor;)V", yield openPfd(u, "r"))
      : newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", fileOf(u));
  }),
  "openOutputStream(Landroid/net/Uri;)Ljava/io/OutputStream;": (u: JUri) => openOutputStream(u, "w"),
  // AOSP's modes: "w" truncates, "wa" appends, "rw"/"rwt" keep or truncate in place.
  "openOutputStream(Landroid/net/Uri;Ljava/lang/String;)Ljava/io/OutputStream;": (u: JUri, mode: string) => openOutputStream(u, mode ?? "w"),
  "getType(Landroid/net/Uri;)Ljava/lang/String;": driven(function* (u: JUri): Gen {
    if (isDocsUri(u)) return (yield docRow(documentId(u, true)))?.mime ?? null;
    if (isMediaUri(u)) return mediaMime(u);
    const provider = yield contentProvider(u);
    return provider ? vcall(provider, "getType", providerOperations.getType, u) : null;
  }),
  "query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    driven(function* (u: JUri, proj: string[] | null, selection: string | null, args: string[] | null, sort: string | null): Gen {
      if (isMediaUri(u)) return mediaQuery(u, proj, selection, args, sort);
      if (!isDocsUri(u)) {
        const provider = yield contentProvider(u);
        return provider ? vcall(provider, "query", providerOperations.query, u, proj, selection, args, sort) : null;
      }
      const id = documentId(u, true);
      const row = isChildrenUri(u) ? null : yield docRow(id);
      const rows = isChildrenUri(u) ? yield docChildren(id) : row ? [row] : [];
      const cols = proj?.length ? [...proj] : DOC_COLUMNS;
      return mkCursor(cols, rows.map((r: Parameters<typeof docCells>[0]) => {
        const cells = docCells(r);
        return cols.map((c) => cells[DOC_COLUMNS.indexOf(c)] ?? null);
      }));
    }),
  "query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;": cancellableQuery,
  "query(Landroid/net/Uri;[Ljava/lang/String;Landroid/os/Bundle;Landroid/os/CancellationSignal;)Landroid/database/Cursor;":
    driven(function* (this: JObj, u: JUri, proj: string[] | null, queryArgs: JBundle | null, cancellation: unknown): Gen {
      if (cancellation) yield vcall(cancellation, "throwIfCanceled", "()V");
      if (queryArgs) yield unparcel(queryArgs);
      const values = queryArgs?.map;
      const selection = values?.get("android:query-arg-sql-selection") as string | null | undefined;
      const args = values?.get("android:query-arg-sql-selection-args") as string[] | null | undefined;
      const columns = values?.get("android:query-arg-sort-columns") as string[] | null | undefined;
      const direction = values?.get("android:query-arg-sort-direction") as number | undefined;
      const sort = values?.get("android:query-arg-sql-sort-order") as string | null | undefined ??
        (columns?.length ? columns.map((column) => column + (direction === 1 ? " DESC" : " ASC")).join(", ") : null);
      const limit = values?.get("android:query-arg-limit") as number | undefined;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
        throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid query limit");
      if (values) for (const key of values.keys()) if (!QUERY_ARGS.has(key)) throw rt.unimplemented(`ContentResolver.query argument ${key}`);
      if (!isDocsUri(u) && limit !== undefined && !sort)
        throw rt.unimplemented("ContentResolver.query provider limit without sort order");
      const limited = limit === undefined || isDocsUri(u) ? sort : sort ? `${sort} LIMIT ${limit}` : null;
      if (isMediaUri(u)) {
        const match = (key: string) => values?.get("android:query-arg-match-" + key) as number | undefined;
        return mediaQuery(u, proj, selection ?? null, args ?? null, limited ?? null, { trashed: match("trashed"), pending: match("pending"), favorite: match("favorite") });
      }
      const cursor = yield vcall(this, "query", providerOperations.query, u, proj, selection ?? null, args ?? null, limited);
      if (cursor && isDocsUri(u)) {
        const rows = cursor.rows as unknown[][];
        if (columns?.length) rows.sort((left, right) => {
          for (const column of columns) {
            const index = cursor.cols.indexOf(column);
            if (index < 0) continue;
            const a = left[index], b = right[index];
            const cmp = typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""));
            if (cmp) return direction === 1 ? -cmp : cmp;
          }
          return 0;
        });
      }
      if (cursor && isDocsUri(u) && limit !== undefined) cursor.rows.length = Math.min(cursor.rows.length, limit);
      return cursor;
    }),
  "call(Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;": driven(function* (u: JUri, method: string, arg: string | null, extras: unknown): Gen {
    if (u === null) throw rt.mkThrowable("java/lang/NullPointerException", "uri");
    if (method === null) throw rt.mkThrowable("java/lang/NullPointerException", "method");
    const provider = yield contentProvider(u);
    if (!provider) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown authority " + u.uri);
    return vcall(provider, "call", providerOperations.call, method, arg, extras);
  }),
  "call(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;": function (this: JObj, authority: string, method: string, arg: string | null, extras: unknown) {
    if (authority === null) throw rt.mkThrowable("java/lang/NullPointerException", "authority");
    return vcall(this, "call", "(Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;", mkUri("content://" + authority), method, arg, extras);
  },
  "openFileDescriptor(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;": openPfd,
  "openFileDescriptor(Landroid/net/Uri;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/os/ParcelFileDescriptor;": openPfd,
  "openAssetFileDescriptor(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;": openAfd,
  "openTypedAssetFile(Landroid/net/Uri;Ljava/lang/String;Landroid/os/Bundle;Landroid/os/CancellationSignal;)Landroid/content/res/AssetFileDescriptor;": openAfd,
  "insert(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;": driven(function* (u: JUri, values: JObj | null): Gen {
    if (isMediaUri(u)) return mediaInsert(u, values ? contentValues(values) : new Map());
    const provider = yield contentProvider(u);
    return provider ? vcall(provider, "insert", providerOperations.insert, u, values) : null;
  }),
  "bulkInsert(Landroid/net/Uri;[Landroid/content/ContentValues;)I": driven(function* (u: JUri, values: unknown[] | null): Gen {
    if (!u || !values) rt.npe();
    const provider = yield contentProvider(u);
    return provider ? vcall(provider, "bulkInsert", providerOperations.bulkInsert, u, values) : 0;
  }),
  "update(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I": driven(function* (u: JUri, values: JObj | null, where: string | null, args: string[] | null): Gen {
    if (isMediaUri(u)) return mediaUpdate(u, values ? contentValues(values) : new Map(), where, args);
    const provider = yield contentProvider(u);
    return provider ? vcall(provider, "update", providerOperations.update, u, values, where, args) : 0;
  }),
  "delete(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I": driven(function* (u: JUri, where: string | null, args: string[] | null): Gen {
    if (isDocsUri(u)) return (yield docDelete(documentId(u, true))) ? 1 : 0;
    if (isMediaUri(u)) return mediaDelete(u, where, args);
    const provider = yield contentProvider(u);
    return provider ? vcall(provider, "delete", providerOperations.delete, u, where, args) : 0;
  }),
  "takePersistableUriPermission(Landroid/net/Uri;I)V": (u: JUri, modes: number) => {
    if (!u) rt.npe();
    const requested = modes & 3;
    if (!requested) return;
    const all = uriGrants.all();
    const old = all.find((grant) => grant.uri === u.uri);
    const offered = transientFlags(appHost?.pkg ?? "", u);
    if ((offered & (requested | PERSISTABLE_GRANT)) !== (requested | PERSISTABLE_GRANT) &&
      (!old || (old.flags & requested) !== requested))
      throw rt.mkThrowable("java/lang/SecurityException", "No persistable URI permission for " + u.uri);
    const flags = (old?.flags ?? 0) | requested | (offered & PREFIX_GRANT);
    uriGrants.set([...all.filter((grant) => grant.uri !== u.uri), { uri: u.uri, flags, time: Date.now() }]);
  },
  "releasePersistableUriPermission(Landroid/net/Uri;I)V": (u: JUri, modes: number) => {
    if (!u) rt.npe();
    uriGrants.set(uriGrants.all().flatMap((grant) => {
      if (grant.uri !== u.uri) return [grant];
      const flags = grant.flags & ~(modes & 3);
      return flags & 3 ? [{ ...grant, flags }] : [];
    }));
  },
  "getPersistedUriPermissions()Ljava/util/List;": () =>
    newArrayList(uriGrants.all().map((grant) => Object.assign(new JUriPermission(), { uriStr: grant.uri, flags: grant.flags, time: grant.time }))),
};
rt.register({ name: "android/content/ContentResolver", ctor: class extends JObj {}, methods: resolverMethods });
class JUriPermission extends JObj { uriStr = ""; flags = 0; time = 0; }
rt.register({
  name: "android/content/UriPermission", ctor: JUriPermission,
  methods: {
    "getUri()Landroid/net/Uri;": function (this: JUriPermission) { return mkUri(this.uriStr); },
    "isReadPermission()Z": function (this: JUriPermission) { return +(!!(this.flags & 1)); },
    "isWritePermission()Z": function (this: JUriPermission) { return +(!!(this.flags & 2)); },
    "getPersistedTime()J": function (this: JUriPermission) { return BigInt(this.time); },
  },
});

// android.provider.Settings — a read-only device with everything at its documented default.
// Reads go through a ContentResolver on a real device; nothing here is writable, so every
// getter simply hands back the caller's own default. AOSP splits the same table three ways.
const settingsUri = (table: string, name: string) => mkUri(`content://settings/${table}/${name}`);
defineException("android/provider/Settings$SettingNotFoundException", "java/lang/Exception");
/** ANDROID_ID: 64 random bits minted on first ask and kept for the install, as the platform does */
function androidId(): string {
  const store = typeof localStorage === "undefined" ? null : localStorage;
  let id = store?.getItem("wd:android_id") ?? null;
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    store?.setItem("wd:android_id", id);
  }
  return id;
}
// Secure.LOCATION_MODE and LOCATION_PROVIDERS_ALLOWED are the device's location switch: an app
// that reads them before asking for fixes (ResyLocationManager.isLocationEnabled) sees the same
// answer the LocationManager gives.
function intSetting(table: string, name: string): number | null {
  if (table === "secure" && name === "location_mode") return locationTransport.enabled() ? 3 : 0;
  return null;
}
function stringSetting(table: string, name: string): string | null {
  if (name === "android_id") return androidId();
  if (name === "device_name") return "webdroid";
  if (table === "secure" && name === "location_providers_allowed") return locationTransport.enabled() ? "gps,network" : "";
  return null;
}
const settingNotFound = (_r: unknown, n: string) => { throw rt.mkThrowable("android/provider/Settings$SettingNotFoundException", n); };
for (const [cls, table] of [["Global", "global"], ["Secure", "secure"], ["System", "system"]] as const) {
  rt.register({
    name: `android/provider/Settings$${cls}`, ctor: class extends JObj {},
    statics: {
      ...(cls === "System" ? { SCREEN_BRIGHTNESS: "screen_brightness", RINGTONE: "ringtone", NOTIFICATION_SOUND: "notification_sound", ALARM_ALERT: "alarm_alert",
        DEFAULT_RINGTONE_URI: settingsUri(table, "ringtone"), DEFAULT_NOTIFICATION_URI: settingsUri(table, "notification_sound"),
        DEFAULT_ALARM_ALERT_URI: settingsUri(table, "alarm_alert") } : {}),
      ...(cls === "Global" ? { ADB_ENABLED: "adb_enabled", ADB_WIFI_ENABLED: "adb_wifi_enabled" } : {}),
      ANIMATOR_DURATION_SCALE: "animator_duration_scale",
      TRANSITION_ANIMATION_SCALE: "transition_animation_scale",
      WINDOW_ANIMATION_SCALE: "window_animation_scale",
      ACCESSIBILITY_ENABLED: "accessibility_enabled",
      AIRPLANE_MODE_ON: "airplane_mode_on",
      DEVELOPMENT_SETTINGS_ENABLED: "development_settings_enabled",
      TEXT_SHOW_PASSWORD: "show_password",
      FONT_SCALE: "font_scale",
      ANDROID_ID: "android_id", DEVICE_NAME: "device_name",
      LOCATION_MODE: "location_mode", LOCATION_PROVIDERS_ALLOWED: "location_providers_allowed",
      LOCATION_MODE_OFF: 0, LOCATION_MODE_SENSORS_ONLY: 1, LOCATION_MODE_BATTERY_SAVING: 2, LOCATION_MODE_HIGH_ACCURACY: 3,
      CONTENT_URI: mkUri(`content://settings/${table}`),
    },
    methods: {
      "static getFloat(Landroid/content/ContentResolver;Ljava/lang/String;F)F": (_r: unknown, _n: string, d: number) => d,
      "static getFloat(Landroid/content/ContentResolver;Ljava/lang/String;)F": settingNotFound,
      "static getLong(Landroid/content/ContentResolver;Ljava/lang/String;)J": settingNotFound,
      "static getInt(Landroid/content/ContentResolver;Ljava/lang/String;I)I": (_r: unknown, n: string, d: number) => intSetting(table, n) ?? d,
      "static getInt(Landroid/content/ContentResolver;Ljava/lang/String;)I": (_r: unknown, n: string) => {
        const value = intSetting(table, n);
        return value === null ? settingNotFound(_r, n) : value;
      },
      "static getLong(Landroid/content/ContentResolver;Ljava/lang/String;J)J": (_r: unknown, _n: string, d: bigint) => d,
      "static getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;": (_r: unknown, n: string) => stringSetting(table, n),
      // the framework's per-user reads; this device has the one user
      "static getStringForUser(Landroid/content/ContentResolver;Ljava/lang/String;I)Ljava/lang/String;": (_r: unknown, n: string) => stringSetting(table, n),
      ...(cls === "Global" ? {} : {
        "static getIntForUser(Landroid/content/ContentResolver;Ljava/lang/String;II)I": (_r: unknown, n: string, d: number) => intSetting(table, n) ?? d,
        "static getIntForUser(Landroid/content/ContentResolver;Ljava/lang/String;I)I": (_r: unknown, n: string) => intSetting(table, n) ?? settingNotFound(_r, n),
        "static getLongForUser(Landroid/content/ContentResolver;Ljava/lang/String;JI)J": (_r: unknown, _n: string, d: bigint) => d,
        "static getFloatForUser(Landroid/content/ContentResolver;Ljava/lang/String;FI)F": (_r: unknown, _n: string, d: number) => d,
      }),
      "static getUriFor(Ljava/lang/String;)Landroid/net/Uri;": (n: string) => settingsUri(table, n),
      ...stubs(0, "static putFloat(Landroid/content/ContentResolver;Ljava/lang/String;F)Z", "static putInt(Landroid/content/ContentResolver;Ljava/lang/String;I)Z",
        "static putLong(Landroid/content/ContentResolver;Ljava/lang/String;J)Z", "static putString(Landroid/content/ContentResolver;Ljava/lang/String;Ljava/lang/String;)Z"),
    },
  });
}
// the column-name interface every provider contract extends
rt.register({ name: "android/provider/BaseColumns", ctor: class extends JObj {}, statics: { _ID: "_id", _COUNT: "_count" } });
rt.register({ name: "android/provider/Settings", ctor: class extends JObj {},
  methods: {
    "static isInSystemServer()Z": () => 0,
    "static canDrawOverlays(Landroid/content/Context;)Z": (context: unknown) => {
      if (!context) rt.npe();
      return 0;
    },
  },
  statics: { ACTION_APPLICATION_DETAILS_SETTINGS: "android.settings.APPLICATION_DETAILS_SETTINGS",
             ACTION_MANAGE_OVERLAY_PERMISSION: "android.settings.action.MANAGE_OVERLAY_PERMISSION",
             ACTION_SETTINGS: "android.settings.SETTINGS" } });
