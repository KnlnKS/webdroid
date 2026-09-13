import { services, type JContext } from "./context";
import { rt, type NativeSpec, JObj, stubs, noops } from "../jvm/runtime";
import { appHost, type AppHost } from "./apphost";
import { type JUri, mkUri } from "./net";
import {
  isDocsUri, documentId, docRead, docWrite, docInputStream, docOutputStream, docRow, isChildrenUri, docChildren,
  DOC_COLUMNS, docCells, docDelete
} from "./documents";
import { mkPfd } from "./os";
import { vfs } from "../jvm/natives/jio";
import { mkAssetFd } from "./resnative";
import { newObj, defineException, vcall } from "../jvm/natives/jlang";
import { mkCursor } from "./sqlite";
import { newArrayList } from "../jvm/natives/jutil";
import { getPM } from "./pm";
import { locationTransport } from "./locationmanager";
import { inMainJob, onMain } from "./mainloop";
import { PROCESS_NAME } from "./os";

type ProviderInfo = { name: string; authority: string; packageName: string; processName?: string };
export const providerTransport: { acquire: (info: ProviderInfo) => Promise<unknown> } = { acquire: async () => null };
const providers = new WeakMap<AppHost, Map<string, Promise<unknown>>>();
export function attachProvider(ctx: JContext, info: ProviderInfo): Promise<unknown> {
  let local = providers.get(ctx.$host);
  if (!local) providers.set(ctx.$host, local = new Map());
  const authorities = info.authority.split(";");
  const existing = local.get(authorities[0]);
  if (existing) return existing;
  const create = async () => {
    const provider = await newObj(info.name.replace(/\./g, "/"));
    await vcall(provider, "attachInfo", "(Landroid/content/Context;Landroid/content/pm/ProviderInfo;)V", ctx, info);
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
  const info: ProviderInfo | null = await vcall(getPM(), "resolveContentProvider", "(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;", authority, 128);
  if (!info) return null;
  return info.packageName === appHost.pkg && (!info.processName || info.processName === (PROCESS_NAME || appHost.pkg))
    ? attachProvider(appHost.application, info) : providerTransport.acquire(info);
}

export const providerOperations = {
  query: "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
  insert: "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
  update: "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
  delete: "(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I",
  getType: "(Landroid/net/Uri;)Ljava/lang/String;",
  call: "(Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;",
};
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
  "query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;":
    async function (this: JProviderClient, ...args: unknown[]) {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "ContentProviderClient is closed");
      return vcall(this.provider, "query", providerOperations.query, ...args.slice(0, 5));
    },
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
/** A persistable grant is app state that survives a reboot, so it lives with the install. */
const uriGrants = {
  key: () => "wd:install:" + (appHost?.pkg ?? "") + ":uriperms",
  all(): string[] { try { return JSON.parse(globalThis.localStorage?.getItem(this.key()) ?? "[]"); } catch { return []; } },
  set(v: string[]) { try { globalThis.localStorage?.setItem(this.key(), JSON.stringify(v)); } catch { /* private mode */ } },
};
const fileOf = (u: JUri) => u.uri.replace(/^file:\/\//, "");
/** A descriptor carries the document's current bytes and writes them back when it is closed. */
async function openPfd(u: JUri, mode: string) {
  if (!isDocsUri(u)) {
    const provider = await contentProvider(u);
    if (provider) return vcall(provider, "openFile", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", u, mode);
    if (u.uri.startsWith("content:")) throw rt.mkThrowable("java/io/FileNotFoundException", u.uri);
    return mkPfd(vfs.read(fileOf(u)) ?? new Uint8Array(0), (b) => vfs.write(fileOf(u), b));
  }
  const id = documentId(u, true);
  const write = (mode ?? "r").includes("w");
  return mkPfd(write && (mode ?? "").includes("t") ? new Uint8Array(0) : await docRead(id),
    write ? (b) => docWrite(id, b) : null);
}
const openAfd = async (u: JUri, mode: string) => {
  const pfd = await openPfd(u, mode);
  return mkAssetFd(pfd.bytes, pfd);
};
const resolverMethods: NativeSpec["methods"] = {
  ...Object.fromEntries(["acquireContentProviderClient", "acquireUnstableContentProviderClient"].flatMap((name) => [
    [name + "(Landroid/net/Uri;)Landroid/content/ContentProviderClient;", acquireClient],
    [name + "(Ljava/lang/String;)Landroid/content/ContentProviderClient;", async (authority: string) => acquireClient(mkUri("content://" + authority))],
  ])),
  "notifyChange(Landroid/net/Uri;Landroid/database/ContentObserver;)V": () => {},
  "registerContentObserver(Landroid/net/Uri;ZLandroid/database/ContentObserver;)V": () => {},
  "unregisterContentObserver(Landroid/database/ContentObserver;)V": () => {},
  "openInputStream(Landroid/net/Uri;)Ljava/io/InputStream;": async (u: JUri) =>
    isDocsUri(u) ? docInputStream(documentId(u, true))
      : u.uri.startsWith("content:") ? newObj("android/os/ParcelFileDescriptor$AutoCloseInputStream", "(Landroid/os/ParcelFileDescriptor;)V", await openPfd(u, "r"))
      : newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", fileOf(u)),
  "openOutputStream(Landroid/net/Uri;)Ljava/io/OutputStream;": (u: JUri) =>
    isDocsUri(u) ? docOutputStream(documentId(u, true), false)
      : newObj("java/io/FileOutputStream", "(Ljava/lang/String;)V", fileOf(u)),
  // AOSP's modes: "w" truncates, "wa" appends, "rw"/"rwt" keep or truncate in place.
  "openOutputStream(Landroid/net/Uri;Ljava/lang/String;)Ljava/io/OutputStream;": (u: JUri, mode: string) =>
    isDocsUri(u) ? docOutputStream(documentId(u, true), (mode ?? "w").includes("a"))
      : newObj("java/io/FileOutputStream", "(Ljava/lang/String;Z)V", fileOf(u), (mode ?? "w").includes("a") ? 1 : 0),
  "getType(Landroid/net/Uri;)Ljava/lang/String;": async (u: JUri) => {
    if (isDocsUri(u)) return (await docRow(documentId(u, true)))?.mime ?? null;
    const provider = await contentProvider(u);
    return provider ? vcall(provider, "getType", "(Landroid/net/Uri;)Ljava/lang/String;", u) : null;
  },
  "query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    async (u: JUri, proj: string[] | null, selection: string | null, args: string[] | null, sort: string | null) => {
      if (!isDocsUri(u)) {
        const provider = await contentProvider(u);
        return provider ? vcall(provider, "query", "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;", u, proj, selection, args, sort) : null;
      }
      const id = documentId(u, true);
      const row = isChildrenUri(u) ? null : await docRow(id);
      const rows = isChildrenUri(u) ? await docChildren(id) : row ? [row] : [];
      const cols = proj?.length ? [...proj] : DOC_COLUMNS;
      return mkCursor(cols, rows.map((r) => {
        const cells = docCells(r);
        return cols.map((c) => cells[DOC_COLUMNS.indexOf(c)] ?? null);
      }));
    },
  "query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;":
    function (this: JObj, u: JUri, proj: string[] | null, selection: string | null, args: string[] | null, sort: string | null) {
      return vcall(this, "query", providerOperations.query, u, proj, selection, args, sort);
    },
  "call(Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;": async (u: JUri, method: string, arg: string | null, extras: unknown) => {
    if (u === null) throw rt.mkThrowable("java/lang/NullPointerException", "uri");
    if (method === null) throw rt.mkThrowable("java/lang/NullPointerException", "method");
    const provider = await contentProvider(u);
    if (!provider) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown authority " + u.uri);
    return vcall(provider, "call", providerOperations.call, method, arg, extras);
  },
  "call(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;": function (this: JObj, authority: string, method: string, arg: string | null, extras: unknown) {
    if (authority === null) throw rt.mkThrowable("java/lang/NullPointerException", "authority");
    return vcall(this, "call", "(Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;", mkUri("content://" + authority), method, arg, extras);
  },
  "openFileDescriptor(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;": openPfd,
  "openFileDescriptor(Landroid/net/Uri;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/os/ParcelFileDescriptor;": openPfd,
  "openAssetFileDescriptor(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;": openAfd,
  "openTypedAssetFile(Landroid/net/Uri;Ljava/lang/String;Landroid/os/Bundle;Landroid/os/CancellationSignal;)Landroid/content/res/AssetFileDescriptor;": openAfd,
  "insert(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;": async (u: JUri, values: unknown) => {
    const provider = await contentProvider(u);
    return provider ? vcall(provider, "insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;", u, values) : null;
  },
  "update(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I": async (u: JUri, values: unknown, where: string | null, args: string[] | null) => {
    const provider = await contentProvider(u);
    return provider ? vcall(provider, "update", "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I", u, values, where, args) : 0;
  },
  "delete(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I": async (u: JUri, where: string | null, args: string[] | null) => {
    if (isDocsUri(u)) return await docDelete(documentId(u, true)) ? 1 : 0;
    const provider = await contentProvider(u);
    return provider ? vcall(provider, "delete", "(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I", u, where, args) : 0;
  },
  // A grant we cannot refuse: nothing here revokes URI access, so the app keeps what it took.
  "takePersistableUriPermission(Landroid/net/Uri;I)V": (u: JUri) => {
    const all = uriGrants.all();
    if (!all.includes(u.uri)) uriGrants.set([...all, u.uri]);
  },
  "releasePersistableUriPermission(Landroid/net/Uri;I)V": (u: JUri) =>
    uriGrants.set(uriGrants.all().filter((s) => s !== u.uri)),
  "getPersistedUriPermissions()Ljava/util/List;": () =>
    newArrayList(uriGrants.all().map((s) => { const p = new JUriPermission(); p.uriStr = s; return p; })),
};
rt.register({ name: "android/content/ContentResolver", ctor: class extends JObj {}, methods: resolverMethods });
class JUriPermission extends JObj { uriStr = ""; }
rt.register({
  name: "android/content/UriPermission", ctor: JUriPermission,
  methods: {
    "getUri()Landroid/net/Uri;": function (this: JUriPermission) { return mkUri(this.uriStr); },
    ...noops("<init>()V"),
    ...stubs(1, "isReadPermission()Z", "isWritePermission()Z"),
    ...stubs(0n, "getPersistedTime()J"),
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
for (const [cls, table] of [["Global", "global"], ["Secure", "secure"], ["System", "system"]] as const) {
  rt.register({
    name: `android/provider/Settings$${cls}`, ctor: class extends JObj {},
    statics: {
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
      "static getFloat(Landroid/content/ContentResolver;Ljava/lang/String;)F": (_r: unknown, n: string) => {
        throw rt.mkThrowable("android/provider/Settings$SettingNotFoundException", n);
      },
      "static getLong(Landroid/content/ContentResolver;Ljava/lang/String;)J": (_r: unknown, n: string) => {
        throw rt.mkThrowable("android/provider/Settings$SettingNotFoundException", n);
      },
      "static getInt(Landroid/content/ContentResolver;Ljava/lang/String;I)I": (_r: unknown, n: string, d: number) => intSetting(table, n) ?? d,
      "static getInt(Landroid/content/ContentResolver;Ljava/lang/String;)I": (_r: unknown, n: string) => {
        const value = intSetting(table, n);
        if (value === null) throw rt.mkThrowable("android/provider/Settings$SettingNotFoundException", n);
        return value;
      },
      "static getLong(Landroid/content/ContentResolver;Ljava/lang/String;J)J": (_r: unknown, _n: string, d: bigint) => d,
      "static getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;": (_r: unknown, n: string) => stringSetting(table, n),
      "static getUriFor(Ljava/lang/String;)Landroid/net/Uri;": (n: string) => settingsUri(table, n),
      "static putFloat(Landroid/content/ContentResolver;Ljava/lang/String;F)Z": () => 0,
      "static putInt(Landroid/content/ContentResolver;Ljava/lang/String;I)Z": () => 0,
      "static putLong(Landroid/content/ContentResolver;Ljava/lang/String;J)Z": () => 0,
      "static putString(Landroid/content/ContentResolver;Ljava/lang/String;Ljava/lang/String;)Z": () => 0,
    },
  });
}
// the column-name interface every provider contract extends
rt.register({ name: "android/provider/BaseColumns", ctor: class extends JObj {}, statics: { _ID: "_id", _COUNT: "_count" } });
rt.register({ name: "android/provider/Settings", ctor: class extends JObj {},
  methods: {
    "static canDrawOverlays(Landroid/content/Context;)Z": (context: unknown) => {
      if (!context) rt.npe();
      return 0;
    },
  },
  statics: { ACTION_APPLICATION_DETAILS_SETTINGS: "android.settings.APPLICATION_DETAILS_SETTINGS",
             ACTION_MANAGE_OVERLAY_PERMISSION: "android.settings.action.MANAGE_OVERLAY_PERMISSION",
             ACTION_SETTINGS: "android.settings.SETTINGS" } });
