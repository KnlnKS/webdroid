// SettingsProvider, the `settings` authority, as an IContentProvider every process hosts over the
// broker's SettingsStore. AOSP's Settings, NameValueCache, Settings.Config and DeviceConfig run from
// bytecode above it; the answers follow the reference AVD's SettingsProvider.apk (call, query,
// insert, update, delete), its readable-key rules and its permission checks, which a probe app
// (targetSdk 30 and 35) reproduced on the device. NameValueCache's generation tracking is not
// offered (its MemoryIntArray is ashmem), so every read reaches the provider. A System write by an
// app holding WRITE_SETTINGS is not checked against SystemSettingsValidators, which ship in
// SettingsProvider.apk rather than on the boot class path. Answers are built in `driven`
// generators, so each Java call runs on the asking thread (see binder.ts newStub).
import { awaited, rt, driven, type JObj, type Gen } from "../jvm/runtime.ts";
import { hexBytes } from "../jvm/abi.ts";
import { vcall, scall, staticField, newObj, iof, after } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { newArrayList, toJsArray, arrayMapEntries } from "../jvm/natives/jcoll.ts";
import { unbox } from "../jvm/natives/jbox.ts";
import { once } from "../jvm/suspend.ts";
import { callingIdentity, asSystem } from "./binder.ts";
import { uriParts } from "./net.ts";
import { packages, type PackageRecord } from "./packages.ts";
import { notifyContent } from "./server/content.ts";
import { locationTransport } from "./locationmanager.ts";
import { holdsPlatformPermission } from "./permissions.ts";
import { SettingsStore, type SettingsTable, type SettingsAccess } from "../shell/settings.ts";
import { registerSystemProvider, matrixCursor } from "./systemproviders.ts";

const SETTINGS_AUTHORITY = "settings";
let store = new SettingsStore(), stopWatching = store.watch(settingsChanged);
let access: SettingsAccess = store;
/** the broker's store, shared by every process */
export function useSettingsStore(shared: SettingsStore): () => void {
  stopWatching(); store = shared; access = shared;
  return stopWatching = shared.watch(settingsChanged);
}
export const settingsStore = (): SettingsStore => store;
/** the settings this process reads: its store, or the broker's */
export const settingsAccess = (): SettingsAccess => access;
export function useSettingsAccess(shared: SettingsAccess): void {
  stopWatching(); access = shared;
}
/** SettingsProvider.notifyForSettingsChange: notifyChange(uri, null, syncToNetwork) as the system */
export function settingsChanged(table: SettingsTable, name: string): void {
  detached(() => asSystem(() => notifyContent(`content://settings/${table}/${name}`, null, false, 1)), logUncaught);
}

/** UiModeManagerService persists the device's night mode as Secure.UI_NIGHT_MODE once it is set:
 *  MODE_NIGHT_YES (2) while dark, MODE_NIGHT_NO (1) after it was dark */
export function deviceNightMode(night: boolean): void | Promise<void> {
  return after(night ? "2" : access.get("secure", "ui_night_mode"), value =>
    value === null ? undefined : after(access.put("secure", "ui_night_mode", night ? "2" : "1"), () => {}));
}

type Table = "system" | "secure" | "global";
const TABLES: Table[] = ["system", "secure", "global"];
const CLASS: Record<Table, string> = { system: "android/provider/Settings$System", secure: "android/provider/Settings$Secure", global: "android/provider/Settings$Global" };
/** DatabaseHelper's valid tables; the legacy ones answer as empty */
const LEGACY_TABLES = new Set(["bluetooth_devices", "bookmarks", "favorites", "old_favorites", "android_metadata"]);
const ALL_COLUMNS = ["_id", "name", "value", "is_preserved_in_restore"];
const FIRST_APPLICATION_UID = 10000, LOLLIPOP_MR1 = 22;
const WRITE_SETTINGS = "android.permission.WRITE_SETTINGS", WRITE_SECURE_SETTINGS = "android.permission.WRITE_SECURE_SETTINGS";
const SECURITY = "java/lang/SecurityException", ILLEGAL = "java/lang/IllegalArgumentException";
const S = "Ljava/lang/String;";
const fail = (cls: string, message: string): never => { throw rt.mkThrowable(cls, message); };
const javaStrings = (collection: unknown): Gen<Set<string>> => (function* () { return new Set((yield* awaited(toJsArray(collection))) as string[]); })();

// ── the Settings classes' own key sets (Settings.X.getPublicSettings, getMovedTo*), read once
type KeySets = { all: Set<string>; readable: Set<string>; maxTarget: Map<string, number> };
const keySets = Object.fromEntries(TABLES.map((table) => [table, once(driven(function* publicSettings$(): Gen<KeySets> {
  const all = yield newObj("java/util/HashSet", "()V"), readable = yield newObj("java/util/HashSet", "()V"), max = yield newObj("android/util/ArrayMap", "()V");
  const cls = yield scall("java/lang/Class", "forName", `(${S})Ljava/lang/Class;`, CLASS[table].replace(/\//g, "."));
  yield scall("android/provider/Settings", "getPublicSettingsForClass", "(Ljava/lang/Class;Ljava/util/Set;Ljava/util/Set;Landroid/util/ArrayMap;)V", cls, all, readable, max);
  return { all: yield* javaStrings(all), readable: yield* javaStrings(readable),
    maxTarget: new Map(arrayMapEntries(max).map(([k, v]) => [k as string, Number(unbox(v))])) };
}))])) as Record<Table, () => KeySets | Promise<KeySets>>;
/** every key the Settings class declares, those @Readable, and the target ceilings of the restricted
 *  ones (Settings.X.getPublicSettings; Global's adds Global.Wearable on a watch, which this is not) */
export const publicSettings = (table: Table): KeySets | Promise<KeySets> => keySets[table]();
const MOVES: [Table, Table][] = [["system", "secure"], ["system", "global"], ["secure", "global"], ["global", "secure"], ["global", "system"]];
const movedSets = new Map(MOVES.map(([from, to]) => [from + ">" + to, once(driven(function* moved$(): Gen<Set<string>> {
  const out = yield newObj("java/util/HashSet", "()V");
  yield scall(CLASS[from], `getMovedTo${to[0].toUpperCase()}${to.slice(1)}Settings`, "(Ljava/util/Set;)V", out);
  return yield* javaStrings(out);
}))]));
const systemSets = Object.fromEntries(["PUBLIC_SETTINGS", "PRIVATE_SETTINGS"].map((field) => [field, once(driven(function* systemSet$(): Gen<Set<string>> {
  return yield* javaStrings(yield staticField(CLASS.system, field));
}))]));

// ── the caller, as Binder.getCallingUid and the package manager see it
type Caller = { uid: number; appId: number; record: PackageRecord | null };
function caller(): Caller {
  const { uid } = callingIdentity();
  let record: PackageRecord | null = null;
  for (const r of packages.values()) if (r.uid === uid) { record = r; break; }
  return { uid, appId: uid % 100000, record };
}
const formatUid = (uid: number) => {
  const appId = uid % 100000;
  return appId >= FIRST_APPLICATION_UID ? `u${Math.floor(uid / 100000)}a${appId - FIRST_APPLICATION_UID}` : String(uid);
};
const callingRecord = (c: Caller): PackageRecord => c.record ?? fail("java/lang/IllegalStateException", "Failed to get calling package info");
/** the permissions these checks name are signature ones (WRITE_SETTINGS also appop|pre23), which the
 *  system holds and an app only as a system package or by special access */
const holds = (c: Caller, permission: string): boolean =>
  c.appId < FIRST_APPLICATION_UID || !!c.record && holdsPlatformPermission(c.record.pkg, permission);
function resolveUser(c: Caller, requested: number): void {
  if (requested === 0 || requested === -2 || requested === -3 || c.appId < FIRST_APPLICATION_UID) return;
  fail(SECURITY, `Permission Denial: get/set setting for user asks to run as user ${requested} but is calling from uid ${formatUid(c.uid)}; ` +
    "this requires android.permission.INTERACT_ACROSS_USERS_FULL or android.permission.INTERACT_ACROSS_USERS");
}

// ── reads
function* enforceReadable(c: Caller, table: Table, name: string): Gen<void> {
  if (c.appId < FIRST_APPLICATION_UID) return;
  const record = callingRecord(c);
  if (record.system) return;
  if (!record.flag(record.application, "testOnly", false)) {
    const { all, readable, maxTarget } = yield* awaited(publicSettings(table));
    if (all.has(name)) {
      if (!readable.has(name)) fail(SECURITY, `Settings key: <${name}> is not readable. From S+, settings keys annotated with @hide are restricted to system_server and system apps only, unless they are annotated with @Readable.`);
      const max = maxTarget.get(name);
      if (max !== undefined && record.sdk.target > max) fail(SECURITY, `Settings key: <${name}> is only readable to apps with targetSdkVersion lower than or equal to: ${max}`);
    }
  }
  // CompatChanges ENFORCE_READ_PERMISSION_FOR_MULTI_SIM_DATA_CALL, which the AVD enforces at targetSdk 30 and 35
  if (table === "global" && name === "multi_sim_data_call" && !holds(c, "android.permission.READ_PRIVILEGED_PHONE_STATE"))
    fail(SECURITY, `access global settings MULTI_SIM_DATA_CALL_SUBSCRIPTION: Neither user ${c.uid} nor current process has android.permission.READ_PRIVILEGED_PHONE_STATE.`);
}
/** settings whose value another owner keeps: LocationManagerService writes location_mode with the
 *  location switch, and DatabaseHelper names the device after its model until someone renames it */
const DERIVED: Partial<Record<Table, Record<string, (stored: string | null) => unknown>>> = {
  secure: { location_mode: () => after(locationTransport.enabled(), enabled => enabled ? "3" : "0") },
  global: { device_name: (stored) => stored ?? staticField("android/os/Build", "MODEL") },
};
const valueOf = (table: Table, name: string): unknown => {
  const derive = DERIVED[table]?.[name];
  return after(access.get(table, name), stored => derive ? derive(stored) : stored);
};
/** the table's settings in SettingsState order, with the derived ones */
function namesOf(table: Table): string[] | Promise<string[]> {
  return after(access.entries(table), entries => {
    const names = entries.map(([name]) => name);
    for (const name of Object.keys(DERIVED[table] ?? {})) if (!names.includes(name)) names.push(name);
    return names;
  });
}
/** a setting's value as the provider reads it for this caller */
function* readSetting(c: Caller, table: Table, name: string): Gen<string | null> {
  yield* enforceReadable(c, table, name);
  if (table === "secure") {
    // isSecureSettingAccessible: the Bluetooth address needs LOCAL_MAC_ADDRESS
    if (name === "bluetooth_address" && !holds(c, "android.permission.LOCAL_MAC_ADDRESS")) return null;
    if (name === "android_id" && c.appId >= FIRST_APPLICATION_UID) return yield* awaited(ssaid(callingRecord(c)));
  }
  return yield valueOf(table, name);
}
const ssaids = new Map<number, Promise<string>>();
/** the app's SSAID: the user key's HMAC-SHA256 over its signing certificates, each length-prefixed,
 *  as 16 hex digits (SettingsRegistry.generateSsaidLocked); stable across reinstalls with one signer */
function ssaid(record: PackageRecord): Promise<string> {
  let id = ssaids.get(record.uid);
  if (!id) ssaids.set(record.uid, id = (async () => {
    const key = await crypto.subtle.importKey("raw", hexBytes(await access.ssaidKey()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const parts: Uint8Array[] = [];
    for (const cert of await record.visibleCertificates()) {
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setInt32(0, cert.length);
      parts.push(prefix, cert);
    }
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { data.set(p, at); at += p.length; }
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
    return mac.subarray(0, 8).toHex();
  })());
  return id;
}

/** the rows a whole-table query or LIST answers: the readable, non-null settings */
function* readableRows(c: Caller, table: Table): Gen<[string, string, string][]> {
  const rows: [string, string, string][] = [];
  const names = yield* awaited(namesOf(table));
  if (table === "secure" && c.appId >= FIRST_APPLICATION_UID && !names.includes("android_id")) names.push("android_id");
  for (let i = 0; i < names.length; i++) {
    let value: string | null;
    try { value = yield* readSetting(c, table, names[i]); } catch (error) {
      if (iof(error, SECURITY)) continue;
      throw error;
    }
    if (value !== null) rows.push([String(i + 1), names[i], value]);
  }
  return rows;
}
function projectionOf(projection: string[] | null): string[] {
  if (!projection) return ALL_COLUMNS;
  for (const column of projection) if (!ALL_COLUMNS.includes(column)) fail(ILLEGAL, "Invalid column: " + column);
  return [...projection];
}
const cursorOf = (columns: string[], rows: [string, string, string][]) =>
  matrixCursor(columns, rows.map(([id, name, value]) => columns.map((column) =>
    column === "_id" ? id : column === "name" ? name : column === "value" ? value : "false")));

// ── writes
const SYSTEM_INSERT = 1, SYSTEM_DELETE = 2, SYSTEM_UPDATE = 3;
function* enforceSystemWrite(c: Caller, operation: number, name: string): Gen<void> {
  if (!holds(c, WRITE_SECURE_SETTINGS) && !holds(c, WRITE_SETTINGS))
    fail(SECURITY, `${c.record?.pkg ?? formatUid(c.uid)} was not granted  this permission: ${WRITE_SETTINGS}.`);
  // enforceRestrictedSystemSettingsMutationForCallingPackage
  if (c.appId < FIRST_APPLICATION_UID || c.appId === 2000) return;
  const publicSet = yield* awaited(systemSets.PUBLIC_SETTINGS()), privateSet = yield* awaited(systemSets.PRIVATE_SETTINGS());
  if (operation === SYSTEM_DELETE && (publicSet.has(name) || privateSet.has(name))) fail(ILLEGAL, "You cannot delete system defined secure settings.");
  if (operation !== SYSTEM_DELETE && publicSet.has(name)) return;
  const record = callingRecord(c);
  if (record.system || record.sdk.target <= LOLLIPOP_MR1) return;
  fail(ILLEGAL, privateSet.has(name) ? "You cannot change private secure settings." : "You cannot keep your settings in the secure settings.");
}
function enforceSecureWrite(c: Caller): void {
  if (!holds(c, WRITE_SECURE_SETTINGS)) fail(SECURITY, `Permission denial, must have one of: [${WRITE_SECURE_SETTINGS}]`);
}
function enforceConfigWrite(c: Caller): void {
  if (c.uid !== 0 && !holds(c, "android.permission.WRITE_DEVICE_CONFIG") && !holds(c, "android.permission.WRITE_ALLOWLISTED_DEVICE_CONFIG"))
    fail(SECURITY, "Permission denial to mutate flag, must have root, WRITE_DEVICE_CONFIG, or WRITE_ALLOWLISTED_DEVICE_CONFIG");
}
/** SettingsState rejects a key it cannot write to XML */
const validKey = (name: string | null): name is string =>
  !!name && ![...name].some((ch) => { const u = ch.charCodeAt(0); return u < 0x20 || u > 0xd7ff && u < 0xe000 || u > 0xfffd; });
function* writeSetting(c: Caller, table: Table, name: string, value: string | null, operation: number): Gen<boolean> {
  if (table === "system") yield* enforceSystemWrite(c, operation, name);
  else enforceSecureWrite(c);
  return (yield* awaited(access.put(table, name, operation === SYSTEM_DELETE ? null : value))) || operation !== SYSTEM_DELETE;
}

// ── the provider's operations
const string = (b: unknown, key: string): unknown => vcall(b, "getString", `(${S})${S}`, key);
const PUT: Record<string, string> = { String: `(${S}${S})V`, Int: `(${S}I)V`, Serializable: `(${S}Ljava/io/Serializable;)V`, StringArrayList: `(${S}Ljava/util/ArrayList;)V` };
function* bundle(entries: [string, string, unknown][]): Gen<JObj> {
  const b: JObj = yield newObj("android/os/Bundle", "()V");
  for (const [type, key, value] of entries) yield vcall(b, `put${type}`, PUT[type], key, value);
  return b;
}
const call = driven(function* call$(method: string, name: string | null, args: JObj | null): Gen<JObj | null> {
  const c = caller();
  const requested: number = args ? yield vcall(args, "getInt", `(${S}I)I`, "_user", 0) : 0;
  const table = /^(?:GET|PUT|DELETE|LIST|RESET)_(system|secure|global|config)$/.exec(method)?.[1] as Table | "config" | undefined;
  const verb = method.slice(0, method.indexOf("_")), key = name ?? "";
  if (table === "config") {
    if (verb === "GET") return yield* bundle([["String", "value", yield* awaited(access.get("config", key))]]);
    if (verb === "LIST") {
      const prefix: string | null = args ? yield string(args, "_prefix") : null;
      const map = yield newObj("java/util/HashMap", "()V");
      for (const [k, value] of yield* awaited(access.entries("config"))) if (!prefix || k.startsWith(prefix)) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", k, value);
      return yield* bundle([["Serializable", "value", map]]);
    }
    enforceConfigWrite(c);
    if (verb === "PUT") { yield* awaited(access.put("config", key, args ? yield string(args, "value") : null)); return null; }
    if (verb === "DELETE") return yield* bundle([["Int", "result_rows_deleted", (yield* awaited(access.put("config", key, null))) ? 1 : 0]]);
    return yield* reset(c, args);
  }
  if (table) {
    if (verb === "RESET") return yield* reset(c, args);
    resolveUser(c, requested);
    if (verb === "GET") return yield* bundle([["String", "value", yield* readSetting(c, table, key)]]);
    if (verb === "LIST")
      return yield* bundle([["StringArrayList", "result_settings_list", yield newArrayList((yield* readableRows(c, table)).map(([, n, v]) => `${n}=${v}`))]]);
    if (verb === "PUT") { yield* writeSetting(c, table, key, args ? yield string(args, "value") : null, SYSTEM_INSERT); return null; }
    return yield* bundle([["Int", "result_rows_deleted", (yield* writeSetting(c, table, key, null, SYSTEM_DELETE)) ? 1 : 0]]);
  }
  switch (method) {
    case "REGISTER_MONITOR_CALLBACK_config":
      if (!holds(c, "android.permission.MONITOR_DEVICE_CONFIG_ACCESS"))
        fail(SECURITY, "Permission denial: registering for config access requires: android.permission.MONITOR_DEVICE_CONFIG_ACCESS");
      return null;
    case "UNREGISTER_MONITOR_CALLBACK_config": return null;
    case "GET_SYNC_DISABLED_MODE_config": case "SET_SYNC_DISABLED_MODE_config": case "SET_ALL_config":
      if (method === "SET_ALL_config") enforceConfigWrite(c);
      else if (!holds(c, "android.permission.WRITE_DEVICE_CONFIG") && !holds(c, "android.permission.READ_WRITE_SYNC_DISABLED_MODE_CONFIG"))
        fail(SECURITY, "Permission denial, must have one of: [android.permission.WRITE_DEVICE_CONFIG, android.permission.READ_WRITE_SYNC_DISABLED_MODE_CONFIG]");
      throw rt.unimplemented("SettingsProvider." + method);
  }
  return null;
});
/** getResetModeEnforcingPermission: the trusted and untrusted resets are the system's and the shell's */
function* reset(c: Caller, args: JObj | null): Gen<never> {
  const mode: number = args ? yield vcall(args, "getInt", `(${S})I`, "_reset_mode") : 0;
  const what = ["", "reset untrusted changes", "reset to untrusted defaults", "reset to trusted defaults", "reset to trusted defaults"][mode];
  if (!what) fail(ILLEGAL, "Invalid reset mode: " + mode);
  if (c.appId !== 1000 && c.appId !== 2000 && c.uid !== 0) fail(SECURITY, `Only system, shell/root on a debuggable build can ${what}`);
  throw rt.unimplemented("SettingsProvider reset");
}

/** Arguments: content://settings/<table>[/<name>], or the table with name=? and one argument */
function* argumentsOf(uri: string, where: string | null, whereArgs: string[] | null, supportAll: boolean): Gen<{ table: string; name: string | null }> {
  const { segments } = uriParts(uri);
  let name: string | null | undefined;
  if (segments.length === 2 && where === null && whereArgs === null) name = segments[1];
  else if (segments.length === 1) {
    if (where !== null && /^\s*\(?\s*name\s*=\s*\?\s*\)?\s*$/.test(where) && whereArgs?.length === 1) name = whereArgs[0];
    else if (where !== null && /^\s*\(?\s*name\s*=\s*['"].*['"]\s*\)?\s*$/.test(where)) {
      const start = Math.max(where.indexOf("'"), where.indexOf("\"")) + 1, end = Math.max(where.lastIndexOf("'"), where.lastIndexOf("\""));
      name = where.slice(start, end);
    } else if (supportAll && where === null && whereArgs === null) name = null;
  }
  if (name === undefined) fail(ILLEGAL, "Supported SQL:\n  uri content://some_table/some_property with null where and where args\n  uri content://some_table with query name=? and single name as arg\n" +
    `  uri content://some_table with query name=some_name and null args\n  but got - uri:${uri}, where:${where} whereArgs:${whereArgs ? "[" + whereArgs.join(", ") + "]" : null}`);
  return { table: yield* tableFor(uri, name ?? null), name: name ?? null };
}
/** computeTableForSetting: a key that moved tables is answered from its new one */
function* tableFor(uri: string, name: string | null): Gen<string> {
  const table = validTable(uri);
  if (name === null || !TABLES.includes(table as Table)) return table;
  for (const [from, to] of MOVES) if (from === table && (yield* awaited(movedSets.get(from + ">" + to)!())).has(name)) return to;
  return table;
}
function validTable(uri: string): string {
  const segment = uriParts(uri).segments[0];
  if (segment === undefined) return fail(ILLEGAL, "Invalid URI:" + uri);
  if (!TABLES.includes(segment as Table) && !LEGACY_TABLES.has(segment)) fail(ILLEGAL, "Bad root path: " + segment);
  return segment;
}
const query = driven(function* query$(uri: string, projection: string[] | null, where: string | null, whereArgs: string[] | null): Gen<JObj> {
  const { table, name } = yield* argumentsOf(uri, where, whereArgs, true);
  const columns = projectionOf(projection);
  if (LEGACY_TABLES.has(table)) return yield* awaited(matrixCursor(columns, []));
  const c = caller();
  if (name === null) return yield* awaited(cursorOf(columns, yield* readableRows(c, table as Table)));
  const value = yield* readSetting(c, table as Table, name);
  const index = (yield* awaited(namesOf(table as Table))).indexOf(name);
  return yield* awaited(cursorOf(columns, value === null ? [] : [[String(index < 0 ? 0 : index + 1), name, value]]));
});
const named = (values: Map<string, unknown>): [string | null, string | null] => {
  const value = values.get("value");
  return [values.get("name") as string | null ?? null, value == null ? null : String(value)];
};
const insert = driven(function* insert$(uri: string, values: Map<string, unknown>): Gen<string | null> {
  const table = validTable(uri);
  if (LEGACY_TABLES.has(table)) return null;
  const [name, value] = named(values);
  if (!validKey(name) || !(yield* writeSetting(caller(), table as Table, name, value, SYSTEM_INSERT))) return null;
  return `content://settings/${table}/${encodeURIComponent(name)}`;
});
const update = driven(function* update$(uri: string, values: Map<string, unknown>, where: string | null, whereArgs: string[] | null): Gen<number> {
  const { table, name } = yield* argumentsOf(uri, where, whereArgs, false);
  const [key, value] = named(values);
  if (LEGACY_TABLES.has(table) || !validKey(key)) return 0;
  return (yield* writeSetting(caller(), table as Table, name ?? key, value, SYSTEM_UPDATE)) ? 1 : 0;
});
const remove = driven(function* remove$(uri: string, where: string | null, whereArgs: string[] | null): Gen<number> {
  const { table, name } = yield* argumentsOf(uri, where, whereArgs, false);
  if (LEGACY_TABLES.has(table) || !validKey(name)) return 0;
  return (yield* writeSetting(caller(), table as Table, name, null, SYSTEM_DELETE)) ? 1 : 0;
});
/** openFile serves only the default sounds' cache files, which this device has none of */
function openFile(uri: string): never {
  const cache = /^content:\/\/settings\/system\/(ringtone|notification_sound|alarm_alert)_cache$/.exec(uri)?.[1];
  return fail("java/io/FileNotFoundException", cache ? `/data/system_de/0/ringtones/${cache}_cache: open failed: ENOENT (No such file or directory)`
    : "Direct file access no longer supported; ringtone playback is available through android.media.Ringtone");
}
function mimeType(uri: string): string {
  const { segments } = uriParts(uri);
  return (segments.length > 1 ? "vnd.android.cursor.item/" : "vnd.android.cursor.dir/") + (segments[0] ?? "");
}

// FLAG_SYSTEM | FLAG_PERSISTENT; the provider is singleUser (FLAG_SINGLE_USER)
registerSystemProvider(SETTINGS_AUTHORITY, { pkg: "com.android.providers.settings", cls: "com.android.providers.settings.SettingsProvider",
  process: "system", appFlags: 0x9, flags: 0x40000000, initOrder: 100 }, {
  call, query, insert, update, delete: remove, getType: mimeType, openFile,
});
