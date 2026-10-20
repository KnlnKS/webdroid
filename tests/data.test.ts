import { webStorageTransport } from "../src/android/webstorage.ts";
import { expect, test, vi, describe, beforeAll } from "vite-plus/test";
import initSqlJs from "sql.js";
import "../src/natives.ts";
import { rt, JObj } from "../src/jvm/runtime.ts";
import { newObj, vcall, scall, vcallAsync, iof } from "../src/jvm/natives/jentry.ts";
import { strArray } from "../src/jvm/abi.ts";
import { useSQLiteStore, sqliteTransport, sqliteStore, createSQLiteSession, type SQLiteRequest, type SQLiteReply } from "../src/android/sqlite.ts";
import { attachProcessBrokerPort, closeProcessBrokerPort, createProcessEndpoint } from "../src/shell/process-endpoint.ts";
import { exitRecordTransport } from "../src/android/server/appexitinfo.ts";
import { settingsStore, useSettingsStore } from "../src/android/settings.ts";
import { serviceTransport } from "../src/android/server/activeservices.ts";
import { providerProcesses } from "../src/android/server/am.ts";
import { broadcastTransport } from "../src/android/server/broadcastqueue.ts";
import { pendingTransport } from "../src/android/pendingintent.ts";
import { activityTransport } from "../src/android/server/atm.ts";
import { newIntent } from "../src/android/intent.ts";
import { decodeIntent } from "../src/android/intentipc.ts";
import { useFocusedUid } from "../src/android/clipboard.ts";
import { binderTransport, useSystemServiceAccess } from "../src/android/binder.ts";
import { notificationTransport } from "../src/android/notification.ts";
import type { BrokerCalls } from "../src/shell/broker-contract.ts";
import { cookieManager, cookieTransport } from "../src/android/cookies.ts";
import { PermissionStore, canonicalPermissionCommands, usePermissionAccess, usePermissionStore, grantPermissions, type PermissionCalls } from "../src/android/permissions.ts";
import { PreferenceStore, preferenceStore, canonicalPreferenceCommands, usePreferenceAccess, usePreferenceStore, getPrefs, type PreferenceCalls } from "../src/android/sharedprefs.ts";
import { AccountStore, canonicalAccountCommands } from "../src/shell/accounts.ts";
import { cookieCalls, type CookieCalls } from "../src/shell/cookie-access.ts";
import { WebCookies } from "../src/shell/webcookies.ts";
import { NativeWindow } from "../src/android/cursorwindow.ts";
import { handle, release } from "../src/android/handles.ts";
import { callProxy, serveCalls } from "../src/shell/process-port.ts";
import { usePathOwner } from "../src/shell/file-path.ts";
import { notConnected } from "../src/jvm/natives/jthrowable.ts";
import { descriptorTransport } from "../src/native/process-fd.ts";
import { vfs } from "../src/shell/vfs.ts";
import { mediaInsert, mediaPath, mediaUpdate } from "../src/android/mediastore.ts";
import { mkUri } from "../src/android/net.ts";
import { bootApp, packageRecord, thrown } from "./java.ts";
import { startMainLooper } from "../src/android/mainloop.ts";

// framework.jar and a running main looper, as a booted page has them
beforeAll(startMainLooper);

let sqlReady: ReturnType<typeof initSqlJs> | undefined;
const loadSql = () => sqlReady ??= initSqlJs({ locateFile: (file) => `vendor/sql.js/dist/${file}` });
const freshSQLiteStore = () => useSQLiteStore({ files: new Map(), sql: loadSql });
/** the store's snapshot timers and clock under test control; the runtime's other scheduling stays real */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });

test("preference commands acknowledge Java-visible changes without overwriting other keys", async () => {
  const pkg = "org.webdroid.test.preferencecommands";
  await bootApp(await packageRecord(pkg));
  const original = preferenceStore, store = new PreferenceStore(), owner = canonicalPreferenceCommands(store, name => {
    if (!name.startsWith(pkg + ":")) throw new Error("foreign preference file");
  });
  const { port1, port2 } = new MessageChannel();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), blocked = new Promise<void>(resolve => release = resolve);
  const stop = serveCalls<PreferenceCalls>(port1, { ...owner,
    preferenceChange: async (name, changes) => { entered(); await blocked; return owner.preferenceChange(name, changes); },
  } as PreferenceCalls);
  const client = callProxy<PreferenceCalls>(port2, ["preferenceRead", "preferenceKeys", "preferenceChange", "preferenceFiles"]);
  usePreferenceAccess(client.endpoint);
  try {
    const prefs = getPrefs(pkg, "__system_power"), service = rt.make("webdroid/DeviceIdleController");
    const exempt = () => vcall(service, "isPowerSaveWhitelistApp", "(Ljava/lang/String;)Z", pkg);
    expect(await exempt()).toBe(0);
    let completed = false;
    const write = Promise.resolve(prefs.set("exempt", 1)).then(value => { completed = true; return value; });
    await waiting;
    expect(completed).toBe(false);
    expect(await owner.preferenceRead(prefs.name, "exempt")).toBeUndefined();
    release(); await write;
    expect(await exempt()).toBe(1);
    await Promise.all([prefs.set("__proto__", ["kept"]), prefs.set("long", 9007199254740993n)]);
    expect(await prefs.get("long")).toBe(9007199254740993n);
    const values = await prefs.get("__proto__") as string[];
    values.push("copy");
    expect(await prefs.get("__proto__")).toEqual(["kept"]);
    await prefs.remove("long");
    expect(await prefs.get("long")).toBeUndefined();
    expect(await prefs.get("exempt")).toBe(1);
    expect(await client.endpoint.preferenceChange("foreign:file", [{kind:"put",key:"x",value:1}]).then(() => null, error => error.message)).toBe("foreign preference file");
    expect(store.open("foreign:file").size).toBe(0);
  } finally { release(); client.close(); stop(); usePreferenceStore(original); }
});

test("permission checks deny pending grants and Java calls await the canonical owner", async () => {
  const pkg = "org.webdroid.test.permissioncommands", fine = "android.permission.ACCESS_FINE_LOCATION";
  await bootApp(await packageRecord(pkg, { target: 34, permissions: [fine] }));
  const store = new PermissionStore(), owner = canonicalPermissionCommands(store, target => {
    if (target !== pkg) throw rt.mkThrowable("java/lang/SecurityException", "foreign permission grant");
  });
  const { port1, port2 } = new MessageChannel();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), blocked = new Promise<void>(resolve => release = resolve);
  const stop = serveCalls<PermissionCalls>(port1, { ...owner,
    permissionGrant: async (target, names) => { entered(); await blocked; return owner.permissionGrant(target, names); },
  } as PermissionCalls);
  const client = callProxy<PermissionCalls>(port2, ["permissionCheck", "permissionGrant"]);
  usePermissionAccess(client.endpoint);
  try {
    const service = rt.make("webdroid/PermissionManagerService"), location = rt.make("webdroid/LocationManagerService");
    const check = () => vcall(service, "checkPermission", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)I", pkg, fine, pkg, 0);
    const last = () => vcall(location, "getLastLocation", "(Ljava/lang/String;Landroid/location/LastLocationRequest;Ljava/lang/String;Ljava/lang/String;)Landroid/location/Location;", null, null, pkg, null);
    expect(await check()).toBe(-1);
    expect(await thrown(last)).toContain("SecurityException");
    let completed = false;
    const grant = Promise.resolve(grantPermissions([fine])).then(value => { completed = true; return value; });
    await waiting;
    expect(completed).toBe(false);
    expect(await client.endpoint.permissionCheck(pkg, [fine])).toEqual([false]);
    release();
    expect(await grant).toEqual(Int32Array.of(0));
    expect(await check()).toBe(0);
    expect(await last()).toBeNull();
    expect(await client.endpoint.permissionGrant("foreign", [fine]).then(() => null, error => error.message)).toBe("foreign permission grant");
    expect(await owner.permissionCheck("foreign", [fine])).toEqual([false]);
  } finally { release(); client.close(); stop(); usePermissionStore(new PermissionStore()); }
});

test("account commands preserve credential ownership", async () => {
  await bootApp(await packageRecord("org.webdroid.test.accounts"));
  const store = new AccountStore(), authority = (caller: string) => ({ caller,
    authenticator: (type: string) => type === "test" ? "owner" : undefined,
    sameUid: (a: string, b: string) => a === b, known: () => true,
    denied: (): never => { throw rt.mkThrowable("java/lang/SecurityException", "account owner required"); } });
  const owner = canonicalAccountCommands(store, () => authority("owner")), key = { name: "alice", type: "test" };
  owner.accountChange({ kind: "add", account: { ...key, owner: "owner", password: "old", data: {}, tokens: { login: "old-token" }, visibility: { reader: 1 } } });
  owner.accountChange({ kind: "password", key, value: "new" });
  expect([owner.accountRead(key)?.password, store.records[0].tokens]).toEqual(["new", {}]);
  owner.accountChange({ kind: "entry", key, field: "data", name: "__proto__", value: "data" });
  owner.accountChange({ kind: "entry", key, field: "tokens", name: "login", value: "token" });
  expect([store.records[0].data.__proto__, store.records[0].tokens.login]).toEqual(["data", "token"]);
  const reader = canonicalAccountCommands(store, () => authority("reader"));
  const visible = reader.accountList({ type: null, pkg: "reader" });
  expect(Object.keys(visible[0]).sort()).toEqual(["id", "name", "owner", "type", "visibility"]);
  visible[0].visibility.reader = 4;
  expect(reader.accountCached(key, "login")?.token).toBe("token");
  expect(await thrown(() => reader.accountRead(key))).toContain("SecurityException");
  expect(await thrown(() => reader.accountChange({ kind: "entry", key, field: "tokens", name: "login", value: "foreign" }))).toContain("SecurityException");
  expect(await thrown(() => reader.accountChange({ kind: "cache", key, authenticatorType: "other", tokenType: "login", token: "foreign" }))).toContain("SecurityException");
  const held = owner.accountRead(key)!;
  held.data.__proto__ = "copy";
  expect(store.records[0].data.__proto__).toBe("data");
  owner.accountChange({ kind: "rename", key: held, name: "renamed" });
  expect(owner.accountChange({ kind: "drop", key: held })).toBe(1);
  expect(owner.accountExists({ name: "renamed", type: "test" })).toBe(false);
});

test("Worker activity commands retain local results across reentrant replies and failed launch acknowledgment", async () => {
  const owner = await packageRecord("org.webdroid.test.activitycommands");
  await bootApp(owner);
  const previousService = {...serviceTransport}, previousProvider = providerProcesses.get, previousBroadcast = broadcastTransport.send;
  const previousPending = {...pendingTransport};
  const previous = {...activityTransport}, previousExit = {...exitRecordTransport}, previousSettings = settingsStore(), previousSql = sqliteTransport.call,
    previousWebStorage = webStorageTransport.calls, previousCookies = cookieTransport.calls,
    previousPrepare = vfs.prepare, previousDescriptors = {...descriptorTransport}, previousPrefs = preferenceStore, previousBinder = binderTransport.transact, previousForeground = notificationTransport.foreground;
  type Calls = Pick<BrokerCalls,"activity"|"exitRecords">;
  const {port1,port2} = new MessageChannel();
  let entered!:()=>void, release!:()=>void, request = 0, launches = 0, completed = false;
  const waiting = new Promise<void>(resolve=>entered=resolve), blocked = new Promise<void>(resolve=>release=resolve);
  let readEntered!:()=>void, readRelease!:()=>void;
  const readWaiting = new Promise<void>(resolve=>readEntered=resolve), readBlocked = new Promise<void>(resolve=>readRelease=resolve);
  const received: unknown[] = [], results: unknown[] = [];
  const intent = await newIntent("org.webdroid.test.LAUNCH");
  const stop = serveCalls<Calls>(port1, {
    activity: { launch: async (pkg,process,component,data,id,callingClass) => {
      request=id; launches++;
      if(launches>1) throw new Error("launch denied");
      const copied = await decodeIntent(data);
      received.push(pkg,process,component,callingClass,copied===intent,await vcall(copied,"getAction","()Ljava/lang/String;"));
      entered(); await blocked;
    }, finish:async()=>{},presentation:async()=>{} },
    exitRecords:async()=>{readEntered();await readBlocked;return [{pid:71,uid:owner.uid,pkg:owner.pkg,process:owner.pkg,reason:2,status:9,importance:400,timestamp:1,description:null,state:null,tombstone:null,dialog:false}];},
  });
  attachProcessBrokerPort(port2);
  try {
    const endpoint = createProcessEndpoint(), delivery = {caller:{pkg:"org.webdroid.test.activitycommands",cls:"Caller"},deliver:(code:number,data:unknown)=>results.push([code,data])};
    const launch = activityTransport.launch!("target","target:ui","Target",intent,delivery).then(()=>completed=true);
    await waiting;
    expect(completed).toBe(false);
    expect(received).toEqual(["target","target:ui","Target","Caller",false,"org.webdroid.test.LAUNCH"]);
    // A lifecycle reply may reenter before the owner's launch acknowledgment reaches this job.
    await endpoint.activity({kind:"result",request,code:31,data:null});
    expect(results).toEqual([[31,null]]);
    await endpoint.activity({kind:"result",request,code:32,data:null});
    expect(results).toEqual([[31,null]]);
    release();await launch;expect(completed).toBe(true);
    const denied = await activityTransport.launch!("target","target:ui","Target",intent,delivery).then(()=>null,error=>error);
    expect((denied as Error).message).toBe("launch denied");
    await endpoint.activity({kind:"result",request,code:33,data:null});
    expect(results).toEqual([[31,null]]);
    let queried = false;
    const query = vcallAsync(rt.make("webdroid/ActivityManagerService"),"getHistoricalProcessExitReasons","(Ljava/lang/String;III)Landroid/content/pm/ParceledListSlice;",owner.pkg,0,1,0).then(value=>{queried=true;return value;});
    await readWaiting;expect(queried).toBe(false);readRelease();
    const rows = await vcall(await query,"getList","()Ljava/util/List;"), info = await vcall(rows,"get","(I)Ljava/lang/Object;",0);
    expect(await vcall(info,"getPid","()I")).toBe(71);
    expect(await vcall(info,"getReason","()I")).toBe(2);
  } finally {
    release();readRelease();closeProcessBrokerPort();stop();
    for(const key of Object.keys(activityTransport)) Reflect.deleteProperty(activityTransport,key);
    for(const key of Object.keys(exitRecordTransport)) Reflect.deleteProperty(exitRecordTransport,key);
    Object.assign(exitRecordTransport,previousExit);useSettingsStore(previousSettings);
    Object.assign(activityTransport,previous);sqliteTransport.call=previousSql;cookieTransport.calls=previousCookies;webStorageTransport.calls=previousWebStorage;
    Object.assign(serviceTransport,previousService); providerProcesses.get=previousProvider; broadcastTransport.send=previousBroadcast;
    Object.assign(pendingTransport,previousPending);
    useSystemServiceAccess([]); binderTransport.transact=previousBinder; notificationTransport.foreground=previousForeground;
    usePathOwner(null); for(const key of Object.keys(descriptorTransport))Reflect.deleteProperty(descriptorTransport,key); Object.assign(descriptorTransport,previousDescriptors); vfs.prepare = previousPrepare;
    usePermissionStore(new PermissionStore()); usePreferenceStore(previousPrefs);
  }
});

test("ClipboardService keeps one clip, which only the focused uid reads", async () => {
  await bootApp(await packageRecord("org.webdroid.test.clipboard"));
  const service = rt.make("webdroid/ClipboardService"), P = "Ljava/lang/String;Ljava/lang/String;II", caller = ["org.webdroid.test.clipboard",null,0,0];
  let focused: number | undefined;
  useFocusedUid(() => focused);
  try {
    const source = await scall("android/content/ClipData", "newPlainText", "(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/content/ClipData;", "label", "copied");
    await vcall(service, "setPrimaryClip", `(Landroid/content/ClipData;${P})V`, source, ...caller);
    expect(await vcall(service, "hasPrimaryClip", `(${P})Z`, ...caller)).toBe(0);
    expect(await vcall(service, "getPrimaryClip", `(${P})Landroid/content/ClipData;`, ...caller)).toBeNull();
    focused = (await import("../src/android/os.ts")).PROCESS_UID;
    expect(await vcall(service, "hasClipboardText", `(${P})Z`, ...caller)).toBe(1);
    const read = await vcall(service, "getPrimaryClip", `(${P})Landroid/content/ClipData;`, ...caller);
    expect(await vcall(await vcall(read,"getItemAt","(I)Landroid/content/ClipData$Item;",0),"getText","()Ljava/lang/CharSequence;")).toBe("copied");
    await vcall(service, "clearPrimaryClip", `(${P})V`, ...caller);
    expect(await vcall(service, "hasPrimaryClip", `(${P})Z`, ...caller)).toBe(0);
  } finally { useFocusedUid(() => undefined); }
});

test("CookieManager waits for canonical mutation before its main-looper callback", async () => {
  await bootApp(await packageRecord("org.webdroid.test.cookies"));
  const jar = new WebCookies("org.webdroid.test.cookies"), previous = cookieTransport.calls;
  let entered!: () => void, release!: () => void, received!: (value: JObj) => void, called = false;
  const waiting = new Promise<void>(resolve => entered = resolve), blocked = new Promise<void>(resolve => release = resolve);
  const callback = new Promise<JObj>(resolve => received = resolve);
  rt.register({ name: "test/CookieValueCallback", ctor: class extends JObj {}, ifaces: ["android/webkit/ValueCallback"], methods: {
    "onReceiveValue(Ljava/lang/Object;)V": (value: JObj) => { called = true; received(value); },
  } });
  const { port1, port2 } = new MessageChannel();
  const stop = serveCalls<CookieCalls>(port1, cookieCalls(async () => { entered(); await blocked; return jar; }));
  const client = callProxy<CookieCalls>(port2, ["cookieGet", "cookieSet", "cookieAccept", "cookieHas", "cookieRemove", "cookieFlush"]);
  cookieTransport.calls = () => client.endpoint;
  try {
    const manager = cookieManager(), url = "https://cookies.example/";
    const write = vcallAsync(manager, "setCookie", "(Ljava/lang/String;Ljava/lang/String;Landroid/webkit/ValueCallback;)V",
      url, "a=one; Path=/", rt.make("test/CookieValueCallback"));
    await waiting;
    expect(called).toBe(false); expect(jar.get(url)).toBe("");
    release(); await write;
    expect(await vcall(await callback, "booleanValue", "()Z")).toBe(1);
    expect(await vcall(manager, "getCookie", "(Ljava/lang/String;)Ljava/lang/String;", url)).toBe("a=one");
    await vcall(manager, "setAcceptCookie", "(Z)V", 0);
    expect(await vcall(manager, "acceptCookie", "()Z")).toBe(0);
    await vcall(manager, "setCookie", "(Ljava/lang/String;Ljava/lang/String;)V", url, "denied=two");
    expect(jar.get(url)).toBe("a=one");
    await vcall(manager, "removeAllCookie", "()V");
    expect(await vcall(manager, "hasCookies", "()Z")).toBe(0);
    expect(await vcall(manager, "getCookie", "(Ljava/lang/String;)Ljava/lang/String;", url)).toBeNull();
  } finally { release(); cookieTransport.calls = previous; client.close(); stop(); jar.remove(); jar.forget(); }
});

describe("cursorwindow", () => {
  test("CursorWindow preserves absolute rows and typed fields through a parcel", async () => {
    await bootApp(await packageRecord("org.webdroid.test.sqlite"));
    const window = await newObj("android/database/CursorWindow", "(Ljava/lang/String;)V", "results");
    expect(await vcall(window, "setNumColumns", "(I)Z", 3)).toBe(1);
    await vcall(window, "setStartPosition", "(I)V", 8);
    expect(await vcall(window, "allocRow", "()Z")).toBe(1);
    expect(await vcall(window, "putLong", "(JII)Z", 9007199254740993n, 8, 0)).toBe(1);
    expect(await vcall(window, "putString", "(Ljava/lang/String;II)Z", "hello", 8, 1)).toBe(1);
    expect(await vcall(window, "putBlob", "([BII)Z", new Int8Array([1, -1]), 8, 2)).toBe(1);

    const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(window, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await scall("android/database/CursorWindow", "newFromParcel", "(Landroid/os/Parcel;)Landroid/database/CursorWindow;", parcel);
    expect(await vcall(restored, "getStartPosition", "()I")).toBe(8);
    expect(await vcall(restored, "getLong", "(II)J", 8, 0)).toBe(9007199254740993n);
    expect(await vcall(restored, "getString", "(II)Ljava/lang/String;", 8, 1)).toBe("hello");
    expect(Array.from(await vcall(restored, "getBlob", "(II)[B", 8, 2) as Int8Array)).toEqual([1, -1]);
    expect(await vcall(restored, "putNull", "(II)Z", 8, 1)).toBe(0);
  });
});

describe("sax", () => {
  // libcore's ExpatParser over our expat natives: namespaces, entities, CDATA and well-formedness
  test("libcore's SAX parser reports what expat reports", async () => {
    const events: string[] = [];
    rt.register({ name: "test/SaxEvents", ctor: class extends JObj {}, ifaces: ["org/xml/sax/ContentHandler"], methods: {
      ...Object.fromEntries(["setDocumentLocator(Lorg/xml/sax/Locator;)V", "startDocument()V", "endDocument()V", "endPrefixMapping(Ljava/lang/String;)V",
        "ignorableWhitespace([CII)V", "skippedEntity(Ljava/lang/String;)V", "processingInstruction(Ljava/lang/String;Ljava/lang/String;)V"].map((sig) => [sig, () => {}])),
      "startPrefixMapping(Ljava/lang/String;Ljava/lang/String;)V": (prefix: string, uri: string) => { events.push(`ns ${prefix}=${uri}`); },
      "startElement(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Lorg/xml/sax/Attributes;)V": async (uri: string, local: string, _q: string, attributes: unknown) =>
        { events.push(`<${uri}|${local} ${await vcall(attributes, "getValue", "(Ljava/lang/String;)Ljava/lang/String;", "b:k")}`); },
      "endElement(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": (_u: string, local: string) => { events.push(`/${local}`); },
      "characters([CII)V": (text: Uint16Array, start: number, length: number) => { events.push(String.fromCharCode(...text.subarray(start, start + length))); },
    } });
    const parse = async (xml: string) => {
      const f = await scall("javax/xml/parsers/SAXParserFactory", "newInstance", "()Ljavax/xml/parsers/SAXParserFactory;");
      await vcall(f, "setNamespaceAware", "(Z)V", 1);
      const reader = await vcall(await vcall(f, "newSAXParser", "()Ljavax/xml/parsers/SAXParser;"), "getXMLReader", "()Lorg/xml/sax/XMLReader;");
      await vcall(reader, "setContentHandler", "(Lorg/xml/sax/ContentHandler;)V", rt.make("test/SaxEvents"));
      await vcallAsync(reader, "parse", "(Lorg/xml/sax/InputSource;)V",
        await newObj("org/xml/sax/InputSource", "(Ljava/io/Reader;)V", await newObj("java/io/StringReader", "(Ljava/lang/String;)V", xml)));
    };
    await parse('<!DOCTYPE r [<!ENTITY who "world">]><r xmlns="urn:a" xmlns:b="urn:b" b:k="v&amp;w"><b:c>hi &who;</b:c><![CDATA[<x>]]></r>');
    expect(events).toEqual(["ns =urn:a", "ns b=urn:b", "<urn:a|r v&w", "<urn:b|c null", "hi world", "/c", "<x>", "/r"]);
    const error = await parse("<a><b></a>").catch((e) => e);
    expect(iof(error, "org/xml/sax/SAXParseException")).toBe(true);
  });
});

describe("sqlite", () => {
  const S = "Ljava/lang/String;", DB = "Landroid/database/sqlite/SQLiteDatabase;";
  const open = (path: string) => scall("android/database/sqlite/SQLiteDatabase", "openDatabase",
    `(${S}Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)${DB}`, path, null, 0x10000000);
  const exec = (db: unknown, sql: string) => vcall(db, "execSQL", `(${S})V`, sql);
  const long = (db: unknown, sql: string) => scall("android/database/DatabaseUtils", "longForQuery", `(${DB}${S}[${S})J`, db, sql, null);

  test("SQLite service ports preserve canonical transactions, TEMP state and copied cursor values", async () => {
    freshSQLiteStore();
    await bootApp(await packageRecord("org.webdroid.test.sqlite"));
    vfs.mkdir("/data/data/test.sqlite/databases");
    const path = "/data/data/test.sqlite/databases/service.db", session = createSQLiteSession();
    type Calls = { sqlite(request: SQLiteRequest): Promise<SQLiteReply> };
    const ports = new MessageChannel();
    const stop = serveCalls<Calls>(ports.port1, { sqlite: request => session.call(request) });
    const proxy = callProxy<Calls>(ports.port2, ["sqlite"], [], error => rt.mkThrowable(error.javaClass ?? "java/lang/RuntimeException", error.message));
    sqliteTransport.call = request => proxy.endpoint.sqlite(request);
    let first: unknown, second: unknown;
    try {
      first = await open(path); second = await open(path);
      await exec(first, "CREATE TABLE t (big INTEGER, value BLOB)");
      await exec(first, "INSERT INTO t VALUES (9007199254740993, x'01ff')");
      await exec(first, "CREATE TEMP TABLE marker (id INTEGER)");
      expect(await long(second, "SELECT big FROM t")).toBe(9007199254740993n);
      expect(await long(first, "SELECT count(*) FROM sqlite_temp_master")).toBe(1n);
      expect(await long(second, "SELECT count(*) FROM sqlite_temp_master")).toBe(0n);
      await vcall(first, "beginTransactionNonExclusive", "()V");
      await exec(first, "INSERT INTO t VALUES (7, x'02')");
      expect(await long(second, "SELECT count(*) FROM t")).toBe(1n);
      await vcall(first, "endTransaction", "()V");
      expect(await long(second, "SELECT count(*) FROM t")).toBe(1n);
      expect(await thrown(() => exec(first, "INSERT INTO absent VALUES (1)"))).toMatch(/^android\/database\/sqlite\/SQLiteException: /);
      const cursor = await vcall(second, "rawQuery", `(${S}[${S})Landroid/database/Cursor;`, "SELECT big, value FROM t", null);
      try {
        expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
        expect(await vcall(cursor, "getLong", "(I)J", 0)).toBe(9007199254740993n);
        const bytes = await vcall(cursor, "getBlob", "(I)[B", 1) as Int8Array;
        expect(bytes).toEqual(Int8Array.of(1, -1)); bytes[0] = 9;
        expect(await long(first, "SELECT hex(value) = '01FF' FROM t")).toBe(1n);
      } finally { await vcall(cursor, "close", "()V"); }
      expect(sqliteStore.files.get(path)!.connections.size).toBeGreaterThanOrEqual(2);
    } finally {
      if (first) await vcall(first, "close", "()V");
      if (second) await vcall(second, "close", "()V");
      sqliteTransport.call = null; session.close(); stop(); proxy.close(); vfs.delete(path);
    }
    expect(sqliteStore.files.get(path)!.connections.size).toBe(0);
  });

  test("SQLite service death rejects late opens and owns statement tokens across sessions", async () => {
    freshSQLiteStore();
    const first = createSQLiteSession(), second = createSQLiteSession();
    const call = async (session: typeof first, method: string, ...args: SQLiteRequest["args"]) =>
      (await session.call({ family: "platform", method, args })).value;
    const openMethod = "nativeOpen(Ljava/lang/String;ILjava/lang/String;ZZII)J";
    try {
      const a = await call(first, openMethod, ":memory:", 0x10000000) as bigint;
      const b = await call(second, openMethod, ":memory:", 0x10000000) as bigint;
      const st = await call(first, "nativePrepareStatement(JLjava/lang/String;)J", a, "SELECT 42") as bigint;
      expect(await thrown(() => call(second, "nativeExecuteForLong(JJ)J", b, st))).toMatch(/^android\/database\/sqlite\/SQLiteMisuseException: /);
      const tiny = await call(first, "nativePrepareStatement(JLjava/lang/String;)J", a, "SELECT 1, 2") as bigint;
      const failedWindow = await first.call({ family: "platform", method: "nativeExecuteForCursorWindow(JJJIIZ)J",
        args: [a, tiny, 0n, 0, 0, 1], window: { name: "tiny", size: 16, readOnly: false } });
      expect(failedWindow.error?.javaClass).toBe("android/database/sqlite/SQLiteBlobTooBigException");
      expect(failedWindow.window).toMatchObject({ rows: 0, cols: 2, used: 0 });
      const readOnly = new NativeWindow("imported", 1024, true);
      Object.assign(readOnly, { rows: 1, cols: 1, used: 16, types: [1], values: [42] });
      const windowHandle = handle(readOnly);
      sqliteTransport.call = request => first.call(request);
      try {
        const fill = rt.jniFn("android/database/sqlite/SQLiteConnection", "nativeExecuteForCursorWindow(JJJIIZ)J")! as (...args: unknown[]) => unknown;
        expect(await thrown(() => fill(a, tiny, windowHandle, 0, 0, 1))).toMatch(/^java\/lang\/IllegalStateException: /);
        expect(readOnly.values).toEqual([42]); expect(readOnly.rows).toBe(1);
      } finally { sqliteTransport.call = null; release(windowHandle); }
      first.close(); first.close();
      expect(await thrown(() => call(first, "nativeExecuteForLong(JJ)J", a, st))).toMatch(/^android\/os\/DeadObjectException: /);
      const live = await call(second, "nativePrepareStatement(JLjava/lang/String;)J", b, "SELECT 7") as bigint;
      expect(await call(second, "nativeExecuteForLong(JJ)J", b, live)).toBe(7n);
      const bundled = async (family: SQLiteRequest["family"], method: string, ...args: SQLiteRequest["args"]) =>
        (await second.call({ family, method, args })).value;
      const driver = await bundled("driver", "nativeOpen(Ljava/lang/String;I)J", ":memory:", 6) as bigint;
      const query = await bundled("connection", "nativePrepare(JLjava/lang/String;)J", driver, "SELECT 9007199254740993, x'01ff'") as bigint;
      expect(await bundled("statement", "nativeStep(J)Z", query)).toBe(1);
      expect(await bundled("statement", "nativeGetLong(JI)J", query, 0)).toBe(9007199254740993n);
      expect(await bundled("statement", "nativeGetBlob(JI)[B", query, 1)).toEqual(Int8Array.of(1, -1));
      await bundled("statement", "nativeClose(J)V", query);
      await bundled("connection", "nativeClose(J)V", driver);
      const path = "/data/data/test.sqlite/databases/late-open.db", sql = await loadSql(), seed = new sql.Database();
      seed.exec("CREATE TABLE marker (id INTEGER)");
      const bytes = seed.export(); seed.close();
      let unblock!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => unblock = resolve), reading = new Promise<void>(resolve => entered = resolve);
      vfs.mount(path, { size: bytes.length, read: async (offset, length) => { entered(); await gate; return bytes.slice(offset, offset + length); } });
      const dying = createSQLiteSession(), pending = thrown(() => call(dying, openMethod, path, 0x10000000));
      await reading;
      const queued = thrown(() => call(dying, openMethod, ":memory:", 0x10000000));
      const closing = dying.close();
      expect(await pending).toMatch(/^android\/os\/DeadObjectException: /);
      expect(await queued).toMatch(/^android\/os\/DeadObjectException: /);
      unblock(); await closing;
      expect(sqliteStore.files.get(path)!.connections.size).toBe(0);
      vfs.delete(path);
    } finally { first.close(); second.close(); }
  });

  test("SQLite service retires finalizers on errors and permits only release on closed connections", async () => {
    freshSQLiteStore(); vfs.mkdir("/data/local/tmp");
    const sql = await loadSql() as Awaited<ReturnType<typeof initSqlJs>> & { _sqlite3_finalize(pointer: number): number };
    for (const family of ["platform", "driver"] as const) {
      const session = createSQLiteSession(), path = `/data/local/tmp/sqlite-finalizer-${family}.db`;
      let activeSession = session;
      const call = async (kind: SQLiteRequest["family"], method: string, ...args: SQLiteRequest["args"]) =>
        (await activeSession.call({ family: kind, method, args })).value;
      const openConnection = () => family === "platform"
        ? call(family, "nativeOpen(Ljava/lang/String;ILjava/lang/String;ZZII)J", path, 0x10000000)
        : call(family, "nativeOpen(Ljava/lang/String;I)J", path, 6);
      const prepareStatement = (c: bigint, text: string) => family === "platform"
        ? call(family, "nativePrepareStatement(JLjava/lang/String;)J", c, text)
        : call("connection", "nativePrepare(JLjava/lang/String;)J", c, text);
      const execute = (c: bigint, s: bigint) => family === "platform"
        ? call(family, "nativeExecute(JJZ)V", c, s, 0) : call("statement", "nativeStep(J)Z", s);
      const finalize = (c: bigint, s: bigint) => family === "platform"
        ? call(family, "nativeFinalizeStatement(JJ)V", c, s) : call("statement", "nativeClose(J)V", s);
      const closeConnection = (c: bigint) => call(family === "platform" ? family : "connection", "nativeClose(J)V", c);
      const original = sql._sqlite3_finalize;
      try {
        const c = await openConnection() as bigint;
        for (const text of ["CREATE TABLE t(v INTEGER UNIQUE)", "INSERT INTO t VALUES (1)"]) {
          const s = await prepareStatement(c, text) as bigint;
          await execute(c, s); await finalize(c, s);
        }
        const failed = await prepareStatement(c, "INSERT INTO t VALUES (1)") as bigint;
        await prepareStatement(c, "SELECT 7");
        expect(await thrown(() => execute(c, failed))).toContain(family === "platform" ? "SQLiteConstraintException" : "SQLException");
        const calls = new Map<number, number>(); let firstPointer: number | undefined, code = 0;
        sql._sqlite3_finalize = pointer => {
          const count = (calls.get(pointer) ?? 0) + 1; calls.set(pointer, count);
          // Detect a repeated destruction before invoking undefined native behavior in the test.
          if (count > 1) throw new Error("Repeated finalized pointer");
          const rc = original(pointer);
          if (firstPointer === undefined) {
            firstPointer = pointer; code = rc;
            throw rt.mkThrowable("java/lang/RuntimeException", "post-finalize diagnostic");
          }
          return rc;
        };
        expect(await thrown(() => finalize(c, failed))).toBe("java/lang/RuntimeException: post-finalize diagnostic");
        expect(code & 255).toBe(19); // SQLite reports the prior constraint failure after destroying the statement.
        expect(await thrown(() => execute(c, failed))).toContain("SQLiteMisuseException");
        await session.close();
        expect(calls.get(firstPointer!)).toBe(1); expect(calls.size).toBe(2);
        expect(sqliteStore.files.get(path)!.connections.size).toBe(0);
        sql._sqlite3_finalize = original;
        const zombie = activeSession = createSQLiteSession();
        try {
          const z = await openConnection() as bigint, s = await prepareStatement(z, "SELECT 7") as bigint;
          await closeConnection(z);
          expect(sqliteStore.files.get(path)!.connections.size).toBe(1);
          expect(await thrown(() => execute(z, s))).toContain("SQLiteMisuseException");
          await finalize(z, s);
          expect(sqliteStore.files.get(path)!.connections.size).toBe(0);
        } finally { await zombie.close(); }
      } finally { sql._sqlite3_finalize = original; await session.close(); vfs.delete(path); }
    }
  });

  test("connections to one file share its writes, keep their own TEMP schema, and raise AOSP's exceptions", async () => {
    freshSQLiteStore();
    await bootApp(await packageRecord("org.webdroid.test.sqlite"));
    vfs.mkdir("/data/data/test.sqlite/databases");
    const path = "/data/data/test.sqlite/databases/shared.db", first = await open(path), second = await open(path);
    await exec(first, "CREATE TABLE t (id INTEGER PRIMARY KEY, big INTEGER)");
    await exec(first, "INSERT INTO t VALUES (1, 9007199254740993)");
    expect(await long(second, "SELECT big FROM t")).toBe(9007199254740993n);
    await exec(first, "CREATE TEMP TABLE marker (id INTEGER)");
    expect(await long(first, "SELECT count(*) FROM sqlite_temp_master")).toBe(1n);
    expect(await long(second, "SELECT count(*) FROM sqlite_temp_master")).toBe(0n);
    expect(await thrown(() => exec(second, "INSERT INTO t VALUES (1, 0)"))).toMatch(/^android\/database\/sqlite\/SQLiteConstraintException: /);
    expect(await thrown(() => long(second, "SELECT big FROM t WHERE id = 2"))).toMatch(/^android\/database\/sqlite\/SQLiteDoneException: /);
    const cursor = await vcall(second, "rawQuery", `(${S}[${S})Landroid/database/Cursor;`, "SELECT big, 1.5 FROM t", null);
    expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
    expect([await vcall(cursor, "getString", `(I)${S}`, 0), await vcall(cursor, "getString", `(I)${S}`, 1)]).toEqual(["9007199254740993", "1.5"]);
  });

  test("SQLite binary snapshots preserve large files and live connection-local state", async () => {
    const sql = await loadSql();
    const path = "/data/data/test.sqlite/databases/large.db", seed = new sql.Database();
    seed.exec("CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(6 * 1024 * 1024))");
    vfs.write(path, seed.export()); seed.close();
    const db = await open(path);
    await exec(db, "CREATE TEMP TABLE changes(n)");
    await exec(db, "CREATE TEMP TRIGGER track AFTER INSERT ON payload BEGIN INSERT INTO changes VALUES (1); END");
    fakeTimers();
    try {
      await exec(db, "INSERT INTO payload VALUES (x'010203')");
      vi.runOnlyPendingTimers();
    } finally { vi.useRealTimers(); }
    const saved = new sql.Database(vfs.read(path)!);
    expect(saved.exec("SELECT length(value) FROM payload")[0].values).toEqual([[6 * 1024 * 1024], [3]]);
    expect(await long(db, "SELECT count(*) FROM changes")).toBe(1n);
    await exec(db, "INSERT INTO payload VALUES (x'04')");
    expect(await long(db, "SELECT count(*) FROM changes")).toBe(2n);
    saved.close(); vfs.delete(path);
  });

  test("a snapshot waits for an open transaction, and leaves a file replaced after its connections close", async () => {
    freshSQLiteStore();
    const sql = await loadSql(), path = "/data/data/test.sqlite/databases/restore.db", backup = new sql.Database();
    backup.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7)");
    const restored = backup.export(); backup.close();
    fakeTimers();
    try {
      const db = await open(path);
      await exec(db, "CREATE TABLE t (v INTEGER)");
      vi.runOnlyPendingTimers();
      await vcall(db, "beginTransaction", "()V");
      await exec(db, "INSERT INTO t VALUES (1)");
      const before = vfs.mtime(path);
      vi.advanceTimersByTime(1000);
      expect(vfs.mtime(path)).toBe(before);
      await vcall(db, "setTransactionSuccessful", "()V");
      await vcall(db, "endTransaction", "()V");
      vi.advanceTimersByTime(1000);
      expect(vfs.mtime(path)).toBeGreaterThan(before);
      await exec(db, "INSERT INTO t VALUES (2)");
      await vcall(db, "close", "()V");
      vi.advanceTimersByTime(1);
      vfs.write(path, restored);
      vi.runOnlyPendingTimers();
    } finally { vi.useRealTimers(); }
    expect(vfs.read(path)).toEqual(restored);
    expect(await long(await open(path), "SELECT sum(v) FROM t")).toBe(7n);
  });

  test("a cursor refills its window from later rows until it holds the row it moved to", async () => {
    freshSQLiteStore();
    const db = await open(":memory:");
    await exec(db, "CREATE TABLE t (id INTEGER, payload BLOB)");
    await exec(db, "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 999) INSERT INTO t SELECT x, CASE WHEN x < 500 THEN NULL ELSE zeroblob(200) END FROM n");
    const cursor = await vcall(db, "rawQuery", `(${S}[${S})Landroid/database/Cursor;`, "SELECT id, payload FROM t", null);
    await vcall(cursor, "setWindow", "(Landroid/database/CursorWindow;)V", await newObj("android/database/CursorWindow", `(${S}J)V`, "small", 8192n));
    expect(await vcall(cursor, "getCount", "()I")).toBe(1000);
    expect(await vcall(cursor, "moveToPosition", "(I)Z", 900)).toBe(1);
    expect(await vcall(cursor, "getLong", "(I)J", 0)).toBe(900n);
  });

  test("androidx's bundled driver binds, steps and reads columns, guarding the row and column", async () => {
    const jni = (cls: string, sig: string) => rt.jniFn("androidx/sqlite/driver/bundled/" + cls, sig) as (...a: unknown[]) => unknown;
    const connection = await jni("BundledSQLiteDriverKt", "nativeOpen(Ljava/lang/String;I)J")("", 6) as bigint;
    const prepare = (sql: string) => jni("BundledSQLiteConnectionKt", "nativePrepare(JLjava/lang/String;)J")(connection, sql) as bigint;
    const call = (name: string, statement: bigint, ...args: unknown[]) => jni("BundledSQLiteStatementKt", name)(statement, ...args);
    const message = (f: () => unknown) => Promise.resolve().then(f).then(() => null, (e) => vcall(e, "getMessage", `()${S}`));
    const create = prepare("CREATE TABLE t (id INTEGER, name TEXT)");
    call("nativeStep(J)Z", create);
    call("nativeClose(J)V", create);
    const insert = prepare("INSERT INTO t VALUES (?, ?)");
    call("nativeBindLong(JIJ)V", insert, 1, 9007199254740993n);
    call("nativeBindText(JILjava/lang/String;)V", insert, 2, "hello");
    expect(call("nativeStep(J)Z", insert)).toBe(0);
    call("nativeClose(J)V", insert);
    const query = prepare("SELECT id, name FROM t");
    expect(call("nativeGetColumnName(JI)Ljava/lang/String;", query, 1)).toBe("name");
    expect(await message(() => call("nativeGetLong(JI)J", query, 0))).toContain("Error code: 21, message: no row");
    expect(call("nativeStep(J)Z", query)).toBe(1);
    expect([call("nativeGetLong(JI)J", query, 0), call("nativeGetText(JI)Ljava/lang/String;", query, 1)]).toEqual([9007199254740993n, "hello"]);
    expect(await message(() => call("nativeGetLong(JI)J", query, 2))).toContain("Error code: 25, message: column index out of range");
    jni("BundledSQLiteConnectionKt", "nativeClose(J)V")(connection);
    call("nativeClose(J)V", query);
  });
});

describe("mediastore", () => {
  test("an update renames or moves the file under the same id, and unhandled columns change nothing", async () => {
    freshSQLiteStore();
    const uri = (await mediaInsert("content://media/external/images/media", new Map<string, unknown>([["_display_name", "a"], ["mime_type", "image/jpeg"]])))!;
    expect(await mediaPath(uri)).toBe("/sdcard/Pictures/a.jpg");
    expect(await mediaUpdate(uri, new Map([["title", "x"]]), null, null)).toBe(0);
    expect(await mediaUpdate(uri, new Map([["_display_name", "b"], ["relative_path", "DCIM/Camera/"]]), null, null)).toBe(1);
    expect(await mediaPath(uri)).toBe("/sdcard/DCIM/Camera/b.jpg");
    expect(vfs.exists("/sdcard/Pictures/a.jpg")).toBe(false);
  });

  test("an app's ContentResolver inserts, writes and queries through the hosted MediaProvider", async () => {
    freshSQLiteStore();
    const context = await bootApp(await packageRecord("org.webdroid.test.sqlite"));
    const cr = await vcall(context, "getContentResolver", "()Landroid/content/ContentResolver;");
    const values = await newObj("android/content/ContentValues", "()V");
    await vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "_display_name", "resolved");
    await vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "mime_type", "image/png");
    const uri = await vcall(cr, "insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;", await mkUri("content://media/external/images/media"), values);
    const out = await vcall(cr, "openOutputStream", "(Landroid/net/Uri;)Ljava/io/OutputStream;", uri);
    await vcall(out, "write", "([B)V", new Int8Array([1, 2, 3]));
    await vcall(out, "close", "()V");
    expect(await vcall(cr, "getType", "(Landroid/net/Uri;)Ljava/lang/String;", uri)).toBe("image/png");
    const cursor = await vcall(cr, "query", "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
      await mkUri("content://media/external/images/media"), strArray(["_data", "_size"]), "_display_name = ?", strArray(["resolved.png"]), "_id");
    expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
    expect([await vcall(cursor, "getString", "(I)Ljava/lang/String;", 0), await vcall(cursor, "getInt", "(I)I", 1)]).toEqual(["/sdcard/Pictures/resolved.png", 3]);
  });

  test("a row's dates are its file's: DATE_MODIFIED follows its modification time, DATE_ADDED stays as it changes", async () => {
    freshSQLiteStore();
    const context = await bootApp(await packageRecord("org.webdroid.test.sqlite"));
    const cr = await vcall(context, "getContentResolver", "()Landroid/content/ContentResolver;");
    const path = "/sdcard/Pictures/dated.png";
    const dates = async () => {
      const cursor = await vcall(cr, "query", "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        await mkUri("content://media/external/images/media"), strArray(["date_added", "date_modified", "datetaken"]), "_data = ?", strArray([path]), null);
      expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
      const row: unknown[] = [];
      for (let i = 0; i < 3; i++) row.push(await vcall(cursor, "getLong", "(I)J", i));
      return row;
    };
    try {
      vfs.write(path, new Uint8Array([1]));
      vfs.mtimes.set(path, 1_600_000_000_500);
      expect(await dates()).toEqual([1_600_000_000n, 1_600_000_000n, 1_600_000_000_500n]);
      vfs.write(path, new Uint8Array([1, 2]));
      vfs.mtimes.set(path, 1_700_000_000_000);
      expect(await dates()).toEqual([1_600_000_000n, 1_700_000_000n, 1_700_000_000_000n]);
    } finally { vfs.delete(path); }
  });
});

test("libcore directory operations await their canonical owner and observe peer metadata", async () => {
  const {onMain}=await import("../src/android/mainloop.ts");
  const {canonicalFilePaths} = await import("../src/shell/file-path.ts");
  const owner=canonicalFilePaths(()=>0),root="/data/data/org.webdroid.test.pathowner",path=root+"/created";
  const {vfs}=await import("../src/shell/vfs.ts");vfs.mkdir(root);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  usePathOwner({descriptors:{fileDescriptor:notConnected},files:{fileSetAttributes:async(p,c)=>owner.fileSetAttributes(p,c),fileStat:async p=>owner.fileStat(p),fileList:async p=>owner.fileList(p),
    fileRename:async(a,b)=>owner.fileRename(a,b),fileRemove:async p=>owner.fileRemove(p),fileCreate:async p=>owner.fileCreate(p),fileFifo:async p=>owner.fileFifo(p),
    fileAccess:async(p,mode)=>owner.fileAccess(p,mode),fileMkdir:async p=>{await gate;return owner.fileMkdir(p);}}});
  try {
    const file=await onMain(()=>newObj("java/io/File","(Ljava/lang/String;)V",path));
    let finished=false;
    const made=onMain(()=>vcall(file,"mkdir","()Z")).then(value=>{finished=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,0));expect(finished).toBe(false);expect(vfs.isDir(path)).toBe(false);
    release();expect(await made).toBe(1);
    expect(await onMain(()=>vcall(file,"isDirectory","()Z"))).toBe(1);
    expect(await onMain(()=>vcall(file,"mkdir","()Z"))).toBe(0);
    const parent=await onMain(()=>newObj("java/io/File","(Ljava/lang/String;)V",root));
    expect([...await onMain(()=>vcall(parent,"list","()[Ljava/lang/String;"))]).toEqual(["created"]);
  }finally{release();usePathOwner(null);vfs.rmdir(path);vfs.rmdir(root);}
});

test("queued IME edits retain their editor generation through the Java main queue", async () => {
  const { serveInput, showInput, imeInput, imeState, imeTransport } = await import("../src/android/ime.ts");
  const { onMain } = await import("../src/android/mainloop.ts");
  const first = await newObj("android/view/inputmethod/BaseInputConnection", "(Landroid/view/inputmethod/InputMethodManager;Z)V", null, 1);
  const second = await newObj("android/view/inputmethod/BaseInputConnection", "(Landroid/view/inputmethod/InputMethodManager;Z)V", null, 1);
  const session = (connection: JObj) => ({text:"",offset:0,start:0,end:0,compStart:-1,compEnd:-1,imeOptions:1,actionId:0,
    call:(name:string,args:string,...values:unknown[]) => vcall(connection,name,`(${args})Z`,...values)});
  const previous = imeTransport.changed, states: ReturnType<typeof imeState>[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let blocker: Promise<void> | undefined;
  try {
    imeTransport.changed = state => states.push(state);
    serveInput(session(first)); showInput(true);
    const generation = imeState().generation;
    blocker = onMain(() => {entered.resolve();return release.promise;});
    await entered.promise;
    const edit = imeInput("stale",5,5,false,generation);
    serveInput(session(second));
    release.resolve(); await blocker; await edit;
    const text = async (connection:JObj) => vcall(await vcall(connection,"getEditable","()Landroid/text/Editable;"),"toString","()Ljava/lang/String;");
    expect(await text(first)).toBe(""); expect(await text(second)).toBe("");
    await imeInput("owned",5,5,false,imeState().generation);
    expect(await text(second)).toBe("owned"); expect(imeState().text).toBe("owned");
    expect(states.at(-1)?.generation).not.toBe(generation);
    expect(states.at(-1)?.text).toBe("owned");
  } finally { release.resolve(); await blocker; serveInput(null); showInput(false); imeTransport.changed=previous; }
});

test("late partial extracted-text reports use the last reported baseline, not the optimistic edit", async () => {
  const {serveInput,imeInput,imeState,extractedInput}=await import("../src/android/ime.ts");
  const {declaredField}=await import("../src/jvm/runtime.ts");
  const {csText}=await import("../src/jvm/natives/jchars.ts");
  const connection=await newObj("android/view/inputmethod/BaseInputConnection","(Landroid/view/inputmethod/InputMethodManager;Z)V",null,1);
  const session={text:"",offset:0,start:0,end:0,compStart:-1,compEnd:-1,imeOptions:1,actionId:0,
    call:(name:string,args:string,...values:unknown[])=>vcall(connection,name,`(${args})Z`,...values)};
  const report=async(text:string,start:number,end:number,selection:number)=>{
    const value=await newObj("android/view/inputmethod/ExtractedText");
    const fields={text,startOffset:0,partialStartOffset:start,partialEndOffset:end,selectionStart:selection,selectionEnd:selection};
    for(const [name,content] of Object.entries(fields))Reflect.set(value,declaredField("android/view/inputmethod/ExtractedText",name),content);
    await extractedInput(session,value);
  };
  try {
    serveInput(session);
    await imeInput("60");
    await report("60",0,0,2);
    expect(imeState().text).toBe("60");
    expect(await csText(await vcall(connection,"getEditable","()Landroid/text/Editable;"))).toBe("60");
    await imeInput("65");await report("5",1,2,2);
    expect(imeState().text).toBe("65");
    expect(await csText(await vcall(connection,"getEditable","()Landroid/text/Editable;"))).toBe("65");
  }finally{serveInput(null);}
});
