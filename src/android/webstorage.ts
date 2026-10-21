// A WebView's data directory: the renderer origins its pages kept storage on, WebStorage over them,
// and WebViewDatabase's HTTP auth credentials. Each web origin of an app's install renders on its own
// renderer origin, whose storage lives in the browser; a browser enumerates and clears an origin's
// storage only from inside it, so the app notes each origin its WebViews create, and a hidden frame
// on that origin reports or deletes what it holds.
import { rt, JObj, driven, type Gen } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, vcall, scall } from "../jvm/natives/jentry.ts";
import { boxLong } from "../jvm/natives/jbox.ts";
import { installTime } from "./packages.ts";
import { onMain } from "./mainloop.ts";
import { rendererOrigin, rendererStorage } from "../shell/webrenderer.ts";
import type { StorageOp } from "../shell/webpage/protocol.ts";
import type { PackageState } from "../shell/packagedata.ts";
import { persisted } from "../shell/device-storage.ts";

/** kept with the install */
const savedOrigins = persisted("wd:install:", (saved) => Array.isArray(saved) ? saved.filter((o): o is string => typeof o === "string") : null);
const originsKey = (pkg: string) => pkg + ":webview";
/** the web origins `pkg`'s WebViews have rendered */
export const webOrigins = (pkg: string): string[] => savedOrigins.get(originsKey(pkg)) ?? [];
/** the renderer origin `pkg`'s pages of `webOrigin` render on. The install time is part of it, so a
 *  reinstall starts on origins of its own. */
const rendererOf = (pkg: string, webOrigin: string) => rendererOrigin(`${pkg} ${installTime(pkg)} ${webOrigin}`);
/** the renderer origin of `pkg`'s pages of `webOrigin`, noted among those its data holds */
function localWebRenderer(pkg: string, webOrigin: string): Promise<string> {
  const known = webOrigins(pkg);
  if (!known.includes(webOrigin)) savedOrigins.set(originsKey(pkg), [...known, webOrigin]);
  return rendererOf(pkg, webOrigin);
}

export type WebStorageCalls = {
  webRenderer(origin: string): Promise<string>;
  webStorage(op: StorageOp, origin?: string): Promise<[string, {usage:number;quota:number}|null][]>;
};
/** the package's WebView data, which the broker holds */
export const webStorageTransport: { calls: () => WebStorageCalls } = {
  calls: () => { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); },
};
/** Bound to the registered process package, never an identity supplied by a renderer. */
export function canonicalWebStorage(pkg:string): WebStorageCalls {
  return {
    webRenderer:origin=>localWebRenderer(pkg,origin),
    webStorage:(op,origin)=>inOrder(async () => {
      if (!["usage","origin","data","all"].includes(op)) throw new Error("invalid WebStorage operation");
      const parsed = origin === undefined ? undefined : URL.parse(origin)?.origin;
      const known = webOrigins(pkg);
      const selected = origin === undefined ? known : [known.find(o=>o===parsed || o===origin) ?? (op === "usage" && parsed !== "null" ? parsed : undefined)].filter((o):o is string=>o!==undefined);
      return Promise.all(selected.filter(o=>op!=="usage" || origin!==undefined || /^(https?|file):/.test(o)).map(async o=>[o,await storageOf(pkg,o,op)] as [string,{usage:number;quota:number}|null]));
    }),
  };
}
const storageCalls = () => webStorageTransport.calls();
/** the renderer origin this process's pages of `webOrigin` render on */
export const webRenderer = (webOrigin: string): Promise<string> => storageCalls().webRenderer(webOrigin);

// the quota manager runs its tasks in order: a query after a delete sees it done
let lane: Promise<unknown> = Promise.resolve();
function inOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = lane.then(task);
  lane = run.catch(() => {});
  return run;
}
const storageOf = (pkg: string, webOrigin: string, op: StorageOp) => rendererOf(pkg, webOrigin).then((origin) => rendererStorage(origin, op));

/** everything `pkg`'s WebViews stored on their renderer origins, as clearing its data or uninstalling
 *  it removes its WebView data directory (the cookie jar's owner clears that) */
export const webData: PackageState = {
  clear: (pkg) => inOrder(async () => {
    await Promise.all(webOrigins(pkg).map((o) => storageOf(pkg, o, "all")));
    savedOrigins.remove(originsKey(pkg));
  }),
};

// ── WebStorage, as AwQuotaManagerBridge answers it over the noted origins
const answer = (callback: JObj | null, value: () => unknown) => {
  if (callback) void onMain(() => rt.drive(function* (): Gen { yield vcall(callback, "onReceiveValue", "(Ljava/lang/Object;)V", yield value()); }()));
};
/** usage and quota of an origin; the quota manager answers an origin without data with no usage */
const usageAndQuota = async (origin:string) => (await storageCalls().webStorage("usage",origin))[0]?.[1] ?? null;
rt.register({
  name: "webdroid/WebStorage", ctor: class extends JObj {}, sup: "android/webkit/WebStorage",
  methods: {
    // GetAllStorageKeys: the origins holding quota-managed data, each named by its URL spec
    "getOrigins(Landroid/webkit/ValueCallback;)V": (callback: JObj | null) => {
      void storageCalls().webStorage("usage")
        .then((usages) => answer(callback, driven(function* (): Gen {
          const map: JObj = yield newObj("java/util/HashMap");
          for (const [o, u] of usages) {
            if (!u?.usage) continue;
            const spec = o === "file://" ? "file:///" : o + "/";
            yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", spec,
              yield newObj("android/webkit/WebStorage$Origin", "(Ljava/lang/String;JJ)V", spec, BigInt(u.quota), BigInt(u.usage)));
          }
          return map;
        })));
    },
    "getUsageForOrigin(Ljava/lang/String;Landroid/webkit/ValueCallback;)V": (origin: string, callback: JObj | null) => {
      void usageAndQuota(origin).then((u) => answer(callback, () => boxLong(BigInt(u?.usage ?? 0))));
    },
    "getQuotaForOrigin(Ljava/lang/String;Landroid/webkit/ValueCallback;)V": (origin: string, callback: JObj | null) => {
      void usageAndQuota(origin).then((u) => answer(callback, () => boxLong(BigInt(u?.quota ?? 0))));
    },
    // DeleteOriginFramework: its file systems and IndexedDB
    "deleteOrigin(Ljava/lang/String;)V": (origin: string) => {
      void storageCalls().webStorage("origin",origin);
    },
    // DeleteAllDataFramework: every origin's file systems, IndexedDB and localStorage
    "deleteAllData()V": () => { void storageCalls().webStorage("data"); },
  },
});

// ── WebViewDatabase: Chromium keeps HTTP auth credentials in the app's http_auth.db (HttpAuthDatabase);
// form data and website passwords are no longer kept (hasFormData answers false)
let authDb: JObj | null = null;
function* database(): Gen<JObj> {
  if (authDb) return authDb;
  const context: JObj = yield scall("android/app/ActivityThread", "currentApplication", "()Landroid/app/Application;");
  const db: JObj = yield vcall(context, "openOrCreateDatabase", "(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase;", "http_auth.db", 0, null);
  yield vcall(db, "execSQL", "(Ljava/lang/String;)V", "CREATE TABLE IF NOT EXISTS httpauth (_id INTEGER PRIMARY KEY, host TEXT, realm TEXT, username TEXT, password TEXT, UNIQUE (host, realm) ON CONFLICT REPLACE);");
  return authDb ??= db;
}
/** the rows of `sql` over `args`, each its columns as strings */
const query = driven(function* (sql: string, args: string[]): Gen<(string | null)[][]> {
  const cursor: JObj = yield vcall(yield* database(), "rawQuery", "(Ljava/lang/String;[Ljava/lang/String;)Landroid/database/Cursor;", sql, jarray(args, "Ljava/lang/String;"));
  const rows: (string | null)[][] = [];
  try {
    const columns: number = yield vcall(cursor, "getColumnCount", "()I");
    while (yield vcall(cursor, "moveToNext", "()Z")) {
      const row: (string | null)[] = [];
      for (let i = 0; i < columns; i++) row.push(yield vcall(cursor, "getString", "(I)Ljava/lang/String;", i));
      rows.push(row);
    }
  } finally { yield vcall(cursor, "close", "()V"); }
  return rows;
});
const exec = driven(function* (sql: string, args: unknown[]): Gen {
  yield vcall(yield* database(), "execSQL", "(Ljava/lang/String;[Ljava/lang/Object;)V", sql, jarray(args, "Ljava/lang/Object;"));
});
rt.register({
  name: "webdroid/WebViewDatabase", ctor: class extends JObj {}, sup: "android/webkit/WebViewDatabase",
  methods: {
    "hasHttpAuthUsernamePassword()Z": driven(function* (): Gen { return (yield query("SELECT _id FROM httpauth LIMIT 1", [])).length ? 1 : 0; }),
    "clearHttpAuthUsernamePassword()V": () => exec("DELETE FROM httpauth", []),
    "setHttpAuthUsernamePassword(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      (host: string | null, realm: string | null, username: string | null, password: string | null) =>
        host === null || realm === null ? undefined : exec("INSERT INTO httpauth (host, realm, username, password) VALUES (?, ?, ?, ?)", [host, realm, username, password]),
    "getHttpAuthUsernamePassword(Ljava/lang/String;Ljava/lang/String;)[Ljava/lang/String;": driven(function* (host: string | null, realm: string | null): Gen {
      if (host === null || realm === null) return null;
      const [row] = yield query("SELECT username, password FROM httpauth WHERE host = ? AND realm = ?", [host, realm]);
      return row ? jarray(row, "Ljava/lang/String;") : null;
    }),
    // deprecated: intentional no-ops in Chromium
    "hasUsernamePassword()Z": () => 0,
    "clearUsernamePassword()V": () => {},
    "hasFormData()Z": () => 0,
    "clearFormData()V": () => {},
  },
});
