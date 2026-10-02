import { expect, test, jest, describe, beforeAll } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync, JThread, curThread, vcallOn } from "../src/jvm/natives/jlang";
import { strArray } from "../src/jvm/abi";
import { openDatabase, useSQLiteStore } from "../src/android/sqlite";
import { vfs } from "../src/shell/vfs";
import { mediaInsert, mediaPath, mediaUpdate } from "../src/android/mediastore";
import { mkUri } from "../src/android/net";
import { loadLibcore, loadFrameworkJar, bootApp, packageRecord } from "./java";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);

rt.linkNatives();
const loadSql = () => initSqlJs({ locateFile: (file) => `vendor/sql.js/dist/${file}` });
const freshSQLiteStore = () => useSQLiteStore({ files: new Map(), sql: loadSql });

describe("cursorwindow", () => {
  test("CursorWindow preserves absolute rows and typed fields through a parcel", async () => {
    const window = await newObj("android/database/CursorWindow", "(Ljava/lang/String;)V", "results");
    expect(await vcall(window, "setNumColumns", "(I)Z", 3)).toBe(1);
    await vcall(window, "setStartPosition", "(I)V", 8);
    expect(await vcall(window, "allocRow", "()Z")).toBe(1);
    expect(await vcall(window, "putLong", "(JII)Z", 9007199254740993n, 8, 0)).toBe(1);
    expect(await vcall(window, "putString", "(Ljava/lang/String;II)Z", "hello", 8, 1)).toBe(1);
    expect(await vcall(window, "putBlob", "([BII)Z", new Int8Array([1, -1]), 8, 2)).toBe(1);

    const parcel = rt.make("android/os/Parcel");
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

describe("sqlite-query-builder", () => {
  test("DatabaseUtils appends a quoted SQL string", async () => {
    const builder = await newObj("java/lang/StringBuilder", "(Ljava/lang/String;)V", "name = ");
    await vcall(rt.link("android/database/DatabaseUtils").ctor, "appendEscapedSQLString", "(Ljava/lang/StringBuilder;Ljava/lang/String;)V", builder, "O'Brien");
    expect(await vcall(builder, "toString", "()Ljava/lang/String;")).toBe("name = 'O''Brien'");
  });

  test("SQLiteQueryBuilder applies mapped projections and appended filters to reads and updates", async () => {
    freshSQLiteStore();
    const db = await openDatabase(":memory:");
    db.db!.exec("CREATE TABLE records (id INTEGER, label TEXT); INSERT INTO records VALUES (1, 'first'), (2, 'second')");
    const builder = await newObj("android/database/sqlite/SQLiteQueryBuilder", "()V");
    await vcall(builder, "setTables", "(Ljava/lang/String;)V", "records");
    const projection = await newObj("java/util/HashMap", "()V");
    await vcall(projection, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "name", "label AS name");
    await vcall(builder, "setProjectionMap", "(Ljava/util/Map;)V", projection);
    await vcall(builder, "appendWhere", "(Ljava/lang/CharSequence;)V", "id > 1");
    const cursor = await vcall(builder, "query", "(Landroid/database/sqlite/SQLiteDatabase;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
      db, ["name"], null, null, null, null, null);
    expect(await vcall(cursor, "getCount", "()I")).toBe(1);
    expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
    expect(await vcall(cursor, "getString", "(I)Ljava/lang/String;", 0)).toBe("second");

    const values = await newObj("android/content/ContentValues", "()V");
    await vcall(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", "label", "updated");
    expect(await vcall(builder, "update", "(Landroid/database/sqlite/SQLiteDatabase;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I", db, values, null, null)).toBe(1);
    expect(db.db!.exec("SELECT label FROM records ORDER BY id")[0].values).toEqual([["first"], ["updated"]]);
  });
});

describe("sqlite-transaction-listener", () => {
  class TransactionListener extends JObj { events: string[] = []; }
  rt.register({
    name: "test/TransactionListener", ctor: TransactionListener, ifaces: ["android/database/sqlite/SQLiteTransactionListener"],
    methods: {
      "onBegin()V": function (this: TransactionListener) { this.events.push("begin"); },
      "onCommit()V": function (this: TransactionListener) { this.events.push("commit"); },
      "onRollback()V": function (this: TransactionListener) { this.events.push("rollback"); },
    },
  });

  test("SQLite helpers publish only initialized databases and keep memory databases separate", async () => {
    freshSQLiteStore();
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const owner = new JThread(), waiter = new JThread();
    class Helper extends rt.link("android/database/sqlite/SQLiteOpenHelper").ctor {}
    rt.register({ name: "test/InitializingDbHelper", ctor: Helper, sup: "android/database/sqlite/SQLiteOpenHelper", methods: {
      "onCreate(Landroid/database/sqlite/SQLiteDatabase;)V": async function (db: unknown) {
        expect(curThread).toBe(owner);
        entered.resolve(); await finish.promise;
        await vcallOn(owner, db, "execSQL", "(Ljava/lang/String;)V", "CREATE TABLE ready (id INTEGER)");
      },
    } });
    const helper = await newObj("test/InitializingDbHelper", "(Landroid/content/Context;Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)V", null, null, null, 1);
    const first = vcallOn(owner, helper, "getWritableDatabase", "()Landroid/database/sqlite/SQLiteDatabase;");
    await entered.promise;
    let published = false;
    const second = Promise.resolve(vcallOn(waiter, helper, "getWritableDatabase", "()Landroid/database/sqlite/SQLiteDatabase;")).then(db => { published = true; return db; });
    await Promise.resolve(); expect(published).toBe(false);
    finish.resolve();
    const db = await first;
    expect(await second).toBe(db);
    const cursor = await vcall(db, "rawQuery", "(Ljava/lang/String;[Ljava/lang/String;)Landroid/database/Cursor;", "SELECT * FROM ready", null);
    expect(await vcall(cursor, "getCount", "()I")).toBe(0);
    const separate = await openDatabase(":memory:");
    expect(separate).not.toBe(db);
    expect(separate.db!.exec("SELECT name FROM sqlite_master")).toEqual([]);
  });
  rt.linkNatives();

  test("separate SQLite helpers keep their TEMP schemas on separate connections", async () => {
    freshSQLiteStore();
    class Helper extends rt.link("android/database/sqlite/SQLiteOpenHelper").ctor {}
    rt.register({ name: "test/TempTableHelper", ctor: Helper, sup: "android/database/sqlite/SQLiteOpenHelper", methods: {
      "onCreate(Landroid/database/sqlite/SQLiteDatabase;)V": () => {},
      "onUpgrade(Landroid/database/sqlite/SQLiteDatabase;II)V": () => {},
      "onOpen(Landroid/database/sqlite/SQLiteDatabase;)V": (db: unknown) =>
        vcall(db, "execSQL", "(Ljava/lang/String;)V", "CREATE TEMP TABLE temp_marker (id INTEGER)"),
    } });
    const context = await bootApp(await packageRecord("org.webdroid.test.sqlite"));
    const make = () => newObj("test/TempTableHelper", "(Landroid/content/Context;Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)V", context, "temp-isolation.db", null, 1);
    const first = await vcall(await make(), "getWritableDatabase", "()Landroid/database/sqlite/SQLiteDatabase;");
    const second = await vcall(await make(), "getWritableDatabase", "()Landroid/database/sqlite/SQLiteDatabase;");
    expect(first).not.toBe(second);
    expect(first.db!.exec("SELECT name FROM sqlite_temp_master WHERE name='temp_marker'")[0]?.values).toEqual([["temp_marker"]]);
    expect(second.db!.exec("SELECT name FROM sqlite_temp_master WHERE name='temp_marker'")[0]?.values).toEqual([["temp_marker"]]);
  });

  test("SQLite transaction listeners receive begin and completion callbacks", async () => {
    freshSQLiteStore();
    const db = await openDatabase(":memory:");
    const committed = new TransactionListener();
    await vcall(db, "beginTransactionWithListener", "(Landroid/database/sqlite/SQLiteTransactionListener;)V", committed);
    await vcall(db, "setTransactionSuccessful", "()V");
    await vcall(db, "endTransaction", "()V");
    expect(committed.events).toEqual(["begin", "commit"]);
    const rolledBack = new TransactionListener();
    await vcall(db, "beginTransactionWithListener", "(Landroid/database/sqlite/SQLiteTransactionListener;)V", rolledBack);
    await vcall(db, "endTransaction", "()V");
    expect(rolledBack.events).toEqual(["begin", "rollback"]);
  });

  test("SQLite binary snapshots preserve large files and live connection-local state", async () => {
    const sql = await loadSql();
    const path = "/data/data/test.sqlite/databases/large.db", seed = new sql.Database();
    seed.exec("CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(6 * 1024 * 1024))");
    vfs.write(path, seed.export()); seed.close();
    const db = await openDatabase(path, 0);
    db.db!.exec("CREATE TEMP TABLE changes(n); CREATE TEMP TRIGGER track AFTER INSERT ON payload BEGIN INSERT INTO changes VALUES (1); END");
    jest.useFakeTimers();
    try {
      await vcall(db, "execSQL", "(Ljava/lang/String;)V", "INSERT INTO payload VALUES (x'010203')");
      jest.runOnlyPendingTimers();
    } finally { jest.useRealTimers(); }
    const saved = new sql.Database(vfs.read(path)!);
    expect(saved.exec("SELECT length(value) FROM payload")[0].values).toEqual([[6 * 1024 * 1024], [3]]);
    expect(db.db!.exec("SELECT count(*) FROM changes")[0].values).toEqual([[1]]);
    db.db!.exec("INSERT INTO payload VALUES (x'04')");
    expect(db.db!.exec("SELECT count(*) FROM changes")[0].values).toEqual([[2]]);
    saved.close(); vfs.delete(path);
  });
});

describe("mediastore", () => {
  test("an update renames or moves the file under the same id, and unhandled columns change nothing", async () => {
    freshSQLiteStore();
    const uri = (await mediaInsert(mkUri("content://media/external/images/media"), new Map<string, unknown>([["_display_name", "a"], ["mime_type", "image/jpeg"]])))!;
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
    const uri = await vcall(cr, "insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;", mkUri("content://media/external/images/media"), values);
    const out = await vcall(cr, "openOutputStream", "(Landroid/net/Uri;)Ljava/io/OutputStream;", uri);
    await vcall(out, "write", "([B)V", new Int8Array([1, 2, 3]));
    await vcall(out, "close", "()V");
    expect(await vcall(cr, "getType", "(Landroid/net/Uri;)Ljava/lang/String;", uri)).toBe("image/png");
    const cursor = await vcall(cr, "query", "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
      mkUri("content://media/external/images/media"), strArray(["_data", "_size"]), "_display_name = ?", strArray(["resolved.png"]), "_id");
    expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
    expect([await vcall(cursor, "getString", "(I)Ljava/lang/String;", 0), await vcall(cursor, "getInt", "(I)I", 1)]).toEqual(["/sdcard/Pictures/resolved.png", 3]);
  });
});
