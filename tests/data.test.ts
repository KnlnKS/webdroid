import { expect, test, jest, describe, beforeAll } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, scall, vcallAsync } from "../src/jvm/natives/jlang";
import { strArray } from "../src/jvm/abi";
import { useSQLiteStore } from "../src/android/sqlite";
import { vfs } from "../src/shell/vfs";
import { mediaInsert, mediaPath, mediaUpdate } from "../src/android/mediastore";
import { mkUri } from "../src/android/net";
import { loadLibcore, loadFrameworkJar, bootApp, packageRecord, thrown } from "./java";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);

rt.linkNatives();
const loadSql = () => initSqlJs({ locateFile: (file) => `vendor/sql.js/dist/${file}` });
const freshSQLiteStore = () => useSQLiteStore({ files: new Map(), sql: loadSql });

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
    const restored = await vcall(rt.link("android/database/CursorWindow").ctor, "newFromParcel", "(Landroid/os/Parcel;)Landroid/database/CursorWindow;", parcel);
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
    await loadLibcore();
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
      const factory = rt.link("javax/xml/parsers/SAXParserFactory");
      await rt.initClass(factory);
      const f = await vcall(factory.ctor, "newInstance", "()Ljavax/xml/parsers/SAXParserFactory;");
      await vcall(f, "setNamespaceAware", "(Z)V", 1);
      const reader = await vcall(await vcall(f, "newSAXParser", "()Ljavax/xml/parsers/SAXParser;"), "getXMLReader", "()Lorg/xml/sax/XMLReader;");
      await vcall(reader, "setContentHandler", "(Lorg/xml/sax/ContentHandler;)V", rt.make("test/SaxEvents"));
      await vcallAsync(reader, "parse", "(Lorg/xml/sax/InputSource;)V",
        await newObj("org/xml/sax/InputSource", "(Ljava/io/Reader;)V", await newObj("java/io/StringReader", "(Ljava/lang/String;)V", xml)));
    };
    await parse('<!DOCTYPE r [<!ENTITY who "world">]><r xmlns="urn:a" xmlns:b="urn:b" b:k="v&amp;w"><b:c>hi &who;</b:c><![CDATA[<x>]]></r>');
    expect(events).toEqual(["ns =urn:a", "ns b=urn:b", "<urn:a|r v&w", "<urn:b|c null", "hi world", "/c", "<x>", "/r"]);
    const error = await parse("<a><b></a>").catch((e) => e);
    expect(rt.iof(error, "org/xml/sax/SAXParseException")).toBe(1);
  });
});

describe("sqlite", () => {
  const S = "Ljava/lang/String;", DB = "Landroid/database/sqlite/SQLiteDatabase;";
  const open = (path: string) => scall("android/database/sqlite/SQLiteDatabase", "openDatabase",
    `(${S}Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)${DB}`, path, null, 0x10000000);
  const exec = (db: unknown, sql: string) => vcall(db, "execSQL", `(${S})V`, sql);
  const long = (db: unknown, sql: string) => scall("android/database/DatabaseUtils", "longForQuery", `(${DB}${S}[${S})J`, db, sql, null);

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
    expect(await thrown(() => exec(second, "INSERT INTO t VALUES (1, 0)"))).toStartWith("android/database/sqlite/SQLiteConstraintException: ");
    expect(await thrown(() => long(second, "SELECT big FROM t WHERE id = 2"))).toStartWith("android/database/sqlite/SQLiteDoneException: ");
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
    jest.useFakeTimers();
    try {
      await exec(db, "INSERT INTO payload VALUES (x'010203')");
      jest.runOnlyPendingTimers();
    } finally { jest.useRealTimers(); }
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
    jest.useFakeTimers();
    try {
      const db = await open(path);
      await exec(db, "CREATE TABLE t (v INTEGER)");
      jest.runOnlyPendingTimers();
      await vcall(db, "beginTransaction", "()V");
      await exec(db, "INSERT INTO t VALUES (1)");
      const before = vfs.mtime(path);
      jest.advanceTimersByTime(1000);
      expect(vfs.mtime(path)).toBe(before);
      await vcall(db, "setTransactionSuccessful", "()V");
      await vcall(db, "endTransaction", "()V");
      jest.advanceTimersByTime(1000);
      expect(vfs.mtime(path)).toBeGreaterThan(before);
      await exec(db, "INSERT INTO t VALUES (2)");
      await vcall(db, "close", "()V");
      jest.advanceTimersByTime(1);
      vfs.write(path, restored);
      jest.runOnlyPendingTimers();
    } finally { jest.useRealTimers(); }
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
});
