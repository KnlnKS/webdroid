import { expect, test, jest, describe } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, boxInt, vcallAsync, JThread, curThread, mainThread, setCurThread, vcallOn } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { newStringSet, toJsArray } from "../src/jvm/natives/jutil";
import { getPrefs, movePrefs } from "../src/android/sharedprefs";
import { openDatabase, useSQLiteStore } from "../src/android/sqlite";
import { vfs } from "../src/jvm/natives/jio";
import { newXmlSerializer } from "../src/android/xmlpull";

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

describe("json-array", () => {
  const wrap = (value: unknown) =>
    (rt.link("org/json/JSONObject").ctor as unknown as Record<string, (value: unknown) => unknown>)[mangleMethod("wrap", "(Ljava/lang/Object;)Ljava/lang/Object;")](value);
  rt.linkNatives();

  test("JSONArray indexed primitive puts pad and replace", async () => {
    const array = await newObj("org/json/JSONArray");
    await vcall(array, "put", "(II)Lorg/json/JSONArray;", 2, 7);
    await vcall(array, "put", "(IZ)Lorg/json/JSONArray;", 0, 1);
    expect(await vcall(array, "toString", "()Ljava/lang/String;")).toBe("[true,null,7]");
    await expect(vcallAsync(array, "put", "(II)Lorg/json/JSONArray;", -1, 0)).rejects.toMatchObject({
      constructor: rt.link("org/json/JSONException").ctor,
    });
  });

  test("JSONObject.wrap preserves JSON values and converts containers", async () => {
    const boxed = boxInt(7);
    expect(await wrap(boxed)).toBe(boxed);
    expect(await wrap("text")).toBe("text");

    const list = await newObj("java/util/ArrayList");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "first");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", boxed);
    expect(await vcall(await wrap(list), "toString", "()Ljava/lang/String;")).toBe('["first",7]');
    expect(await vcall(await wrap(Int32Array.of(2, 3)), "toString", "()Ljava/lang/String;")).toBe("[2,3]");

    const map = await newObj("java/util/HashMap");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "answer", boxed);
    expect(await vcall(await wrap(map), "toString", "()Ljava/lang/String;")).toBe('{"answer":7}');
    const object = await newObj("org/json/JSONObject");
    await vcall(object, "put", "(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;", "raw", map);
    expect(await vcall(object, "optJSONObject", "(Ljava/lang/String;)Lorg/json/JSONObject;", "raw")).toBeNull();
    await expect(vcallAsync(object, "getJSONObject", "(Ljava/lang/String;)Lorg/json/JSONObject;", "raw")).rejects.toMatchObject({
      constructor: rt.link("org/json/JSONException").ctor,
    });
    await vcall(list, "add", "(Ljava/lang/Object;)Z", map);
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "nested", await wrap(list));
    const nested = await vcall(await wrap(map), "getJSONArray", "(Ljava/lang/String;)Lorg/json/JSONArray;", "nested");
    const child = await vcall(nested, "getJSONObject", "(I)Lorg/json/JSONObject;", 2);
    expect(await vcall(child, "getInt", "(Ljava/lang/String;)I", "answer")).toBe(7);
    await expect(vcallAsync(nested, "getJSONObject", "(I)Lorg/json/JSONObject;", 0)).rejects.toMatchObject({
      constructor: rt.link("org/json/JSONException").ctor,
    });
    expect(await wrap(new JObj())).toBeNull();
  });

  test("JSONObject serializes Java values through toString", async () => {
    const uuid = await newObj("java/util/UUID", "(JJ)V", 1n, 2n);
    const object = await newObj("org/json/JSONObject");
    await vcall(object, "put", "(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;", "uuid", uuid);
    expect(await vcall(object, "toString", "()Ljava/lang/String;")).toBe('{"uuid":"00000000-0000-0001-0000-000000000002"}');
    expect(await vcall(object, "get", "(Ljava/lang/String;)Ljava/lang/Object;", "uuid")).toBe(uuid);
  });

  test("JSON numeric tokens preserve integer, long and decimal boxes", async () => {
    const object = await newObj("org/json/JSONObject", "(Ljava/lang/String;)V", '{"int":1,"long":9007199254740993,"decimal":1.0}');
    expect(rt.iof(await vcall(object, "get", "(Ljava/lang/String;)Ljava/lang/Object;", "int"), "java/lang/Integer")).toBeTruthy();
    expect(rt.iof(await vcall(object, "get", "(Ljava/lang/String;)Ljava/lang/Object;", "long"), "java/lang/Long")).toBeTruthy();
    expect(rt.iof(await vcall(object, "get", "(Ljava/lang/String;)Ljava/lang/Object;", "decimal"), "java/lang/Double")).toBeTruthy();
    expect(await vcall(object, "getLong", "(Ljava/lang/String;)J", "long")).toBe(9007199254740993n);
    expect(await vcall(object, "getDouble", "(Ljava/lang/String;)D", "decimal")).toBe(1);
  });
});

describe("jsonstringer", () => {
  rt.linkNatives();
  const open = (writer: unknown, method: string) => vcall(writer, method, "()Lorg/json/JSONStringer;");
  const key = (writer: unknown, name: string) => vcall(writer, "key", "(Ljava/lang/String;)Lorg/json/JSONStringer;", name);
  const text = (writer: unknown) => vcall(writer, "toString", "()Ljava/lang/String;");

  test("JSONStringer preserves nesting, escaping, duplicate keys and long precision", async () => {
    const writer = await newObj("org/json/JSONStringer");
    expect(await text(writer)).toBeNull();
    await open(writer, "object"); await key(writer, "x"); await open(writer, "array");
    await vcall(writer, "value", "(J)Lorg/json/JSONStringer;", 9223372036854775807n);
    await vcall(writer, "value", "(Ljava/lang/Object;)Lorg/json/JSONStringer;", "a/\n\"");
    await open(writer, "endArray"); await key(writer, "x");
    await vcall(writer, "value", "(Z)Lorg/json/JSONStringer;", 1);
    await open(writer, "endObject");
    expect(await text(writer)).toBe('{"x":[9223372036854775807,"a\\/\\n\\\""],"x":true}');
  });

  test("JSONStringer rejects invalid nesting and nonfinite numeric values", async () => {
    const writer = await newObj("org/json/JSONStringer");
    for (const action of [() => key(writer, "x"), () => open(writer, "endArray")]) {
      const error = await Promise.resolve().then(action).then(() => null, e => e);
      expect(rt.iof(error, "org/json/JSONException")).toBeTruthy();
    }
    await open(writer, "object"); await key(writer, "x");
    const error = await vcallAsync(writer, "value", "(D)Lorg/json/JSONStringer;", NaN).then(() => null, e => e);
    expect(rt.iof(error, "org/json/JSONException")).toBeTruthy();
  });

  test("JSONStringer writes nested JSONObject and JSONArray values", async () => {
    const object = await newObj("org/json/JSONObject", "(Ljava/lang/String;)V", '{"items":[null,true,"a/b"]}');
    const writer = await newObj("org/json/JSONStringer");
    await open(writer, "array");
    await vcall(writer, "value", "(Ljava/lang/Object;)Lorg/json/JSONStringer;", object);
    await open(writer, "endArray");
    expect(await text(writer)).toBe('[{"items":[null,true,"a\\/b"]}]');
  });

  test("Long unsigned formatting handles the sign bit and invalid radices", async () => {
    const long = rt.link("java/lang/Long").ctor;
    expect(await vcall(long, "toUnsignedString", "(J)Ljava/lang/String;", -1n)).toBe("18446744073709551615");
    expect(await vcall(long, "toUnsignedString", "(JI)Ljava/lang/String;", -1n, 16)).toBe("ffffffffffffffff");
    expect(await vcall(long, "toUnsignedString", "(JI)Ljava/lang/String;", -9223372036854775808n, 1)).toBe("9223372036854775808");
  });
});

describe("sax-features", () => {
  rt.linkNatives();

  test("SAX factory passes namespace-prefixes through to its reader", async () => {
    const factory = rt.make("javax/xml/parsers/SAXParserFactory");
    const feature = "http://xml.org/sax/features/namespace-prefixes";
    await vcall(factory, "setFeature", "(Ljava/lang/String;Z)V", feature, 1);
    expect(await vcall(factory, "getFeature", "(Ljava/lang/String;)Z", feature)).toBe(1);
    const parser = await vcall(factory, "newSAXParser", "()Ljavax/xml/parsers/SAXParser;");
    const reader = await vcall(parser, "getXMLReader", "()Lorg/xml/sax/XMLReader;");
    expect(await vcall(reader, "getFeature", "(Ljava/lang/String;)Z", feature)).toBe(1);
  });
});

describe("sharedprefs", () => {
  rt.linkNatives();

  test("string preference getters throw on a stored value of the wrong type", async () => {
    const prefs = getPrefs("test.preferences", "strings");
    const editor = await vcall(prefs, "edit", "()Landroid/content/SharedPreferences$Editor;");
    await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "string", "one");
    await vcall(editor, "putStringSet", "(Ljava/lang/String;Ljava/util/Set;)Landroid/content/SharedPreferences$Editor;", "set", newStringSet(["one", "two"]));
    await vcall(editor, "commit", "()Z");
    for (const [method, type, key] of [["getString", "Ljava/lang/String;", "set"], ["getStringSet", "Ljava/util/Set;", "string"]]) {
      const error = await vcallAsync(prefs, method, `(Ljava/lang/String;${type})${type}`, key, null).catch(error => error);
      expect(rt.iof(error, "java/lang/ClassCastException")).toBe(1);
    }
    expect(await vcall(prefs, "getString", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "string", null)).toBe("one");
    expect(await toJsArray(await vcall(prefs, "getStringSet", "(Ljava/lang/String;Ljava/util/Set;)Ljava/util/Set;", "set", null))).toEqual(["one", "two"]);
    expect(await vcall(prefs, "getString", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "missing", "default")).toBe("default");
    const fallback = newStringSet(["fallback"]);
    expect(await vcall(prefs, "getStringSet", "(Ljava/lang/String;Ljava/util/Set;)Ljava/util/Set;", "missing", fallback)).toBe(fallback);
  });

  test("preference files move between context packages and leave no source file", async () => {
    const source = getPrefs("test.preferences.source", "account");
    const editor = await vcall(source, "edit", "()Landroid/content/SharedPreferences$Editor;");
    await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "token", "value");
    expect(await vcall(editor, "commit", "()Z")).toBe(1);

    expect(movePrefs("test.preferences.source", "test.preferences.target", "account")).toBe(true);
    expect(await vcall(getPrefs("test.preferences.target", "account"), "getString", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "token", null)).toBe("value");
    expect(await vcall(getPrefs("test.preferences.source", "account"), "contains", "(Ljava/lang/String;)Z", "token")).toBe(0);
    expect(movePrefs("test.preferences.missing", "test.preferences.target", "missing")).toBe(true);
  });

  test("preference notifications retain the main thread after a suspending listener", async () => {
    const { mangleMethod } = await import("../src/jvm/abi");
    const { onMain } = await import("../src/android/mainloop");
    const prefs = getPrefs("test.preferences", "listener-thread"), worker = new JThread();
    const observed: boolean[] = [];
    const listener = {
      [mangleMethod("onSharedPreferenceChanged", "(Landroid/content/SharedPreferences;Ljava/lang/String;)V")]: async () => {
        observed.push(curThread === mainThread);
        await Promise.resolve();
        setCurThread(worker);
      },
    };
    await vcall(prefs, "registerOnSharedPreferenceChangeListener", "(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V", listener);
    const editor = await vcall(prefs, "edit", "()Landroid/content/SharedPreferences$Editor;");
    await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "first", "1");
    await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "second", "2");
    try {
      await vcall(editor, "commit", "()Z");
      await onMain(() => {});
      expect(observed).toEqual([true, true]);
    } finally {
      setCurThread(mainThread);
      await vcall(prefs, "unregisterOnSharedPreferenceChangeListener", "(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V", listener);
    }
  });
});

describe("sqlite-query-builder", () => {
  test("DatabaseUtils appends a quoted SQL string", async () => {
    const builder = await newObj("java/lang/StringBuilder", "(Ljava/lang/String;)V", "name = ");
    await vcall(rt.link("android/database/DatabaseUtils").ctor, "appendEscapedSQLString", "(Ljava/lang/StringBuilder;Ljava/lang/String;)V", builder, "O'Brien");
    expect(await vcall(builder, "toString", "()Ljava/lang/String;")).toBe("name = 'O''Brien'");
  });

  test("SQLiteQueryBuilder applies mapped projections and appended filters to reads and updates", async () => {
    useSQLiteStore({ files: new Map(), sql: () => initSqlJs({ locateFile: file => `vendor/sql.js/dist/${file}` }) });
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
    useSQLiteStore({ files: new Map(), sql: () => initSqlJs({ locateFile: (file) => `vendor/sql.js/dist/${file}` }) });
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
    useSQLiteStore({ files: new Map(), sql: () => initSqlJs({ locateFile: (file) => `vendor/sql.js/dist/${file}` }) });
    class Helper extends rt.link("android/database/sqlite/SQLiteOpenHelper").ctor {}
    rt.register({ name: "test/TempTableHelper", ctor: Helper, sup: "android/database/sqlite/SQLiteOpenHelper", methods: {
      "onOpen(Landroid/database/sqlite/SQLiteDatabase;)V": (db: unknown) =>
        vcall(db, "execSQL", "(Ljava/lang/String;)V", "CREATE TEMP TABLE temp_marker (id INTEGER)"),
    } });
    const make = () => newObj("test/TempTableHelper", "(Landroid/content/Context;Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)V", null, "temp-isolation.db", null, 1);
    const first = await vcall(await make(), "getWritableDatabase", "()Landroid/database/sqlite/SQLiteDatabase;");
    const second = await vcall(await make(), "getWritableDatabase", "()Landroid/database/sqlite/SQLiteDatabase;");
    expect(first).not.toBe(second);
    expect(first.db!.exec("SELECT name FROM sqlite_temp_master WHERE name='temp_marker'")[0]?.values).toEqual([["temp_marker"]]);
    expect(second.db!.exec("SELECT name FROM sqlite_temp_master WHERE name='temp_marker'")[0]?.values).toEqual([["temp_marker"]]);
  });

  test("SQLite transaction listeners receive begin and completion callbacks", async () => {
    useSQLiteStore({ files: new Map(), sql: () => initSqlJs({ locateFile: (file) => `vendor/sql.js/dist/${file}` }) });
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
    const sql = await initSqlJs({ locateFile: (file) => `vendor/sql.js/dist/${file}` });
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

describe("xml-serializer", () => {
  rt.linkNatives();

  test("XmlSerializer escapes content and writes each flush once", async () => {
    const out = await newObj("java/io/ByteArrayOutputStream", "()V");
    const xml = newXmlSerializer();
    await vcall(xml, "setOutput", "(Ljava/io/OutputStream;Ljava/lang/String;)V", out, "UTF-8");
    await vcall(xml, "startDocument", "(Ljava/lang/String;Ljava/lang/Boolean;)V", "UTF-8", null);
    await vcall(xml, "startTag", "(Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "", "root");
    await vcall(xml, "attribute", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "", "title", 'a&"b');
    await vcall(xml, "flush", "()V");
    await vcall(xml, "text", "(Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "<x>&");
    await vcall(xml, "endTag", "(Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "", "root");
    await vcall(xml, "endDocument", "()V");
    const bytes = await vcall(out, "toByteArray", "()[B") as Int8Array;
    expect(new TextDecoder().decode(bytes)).toBe('<?xml version="1.0" encoding="UTF-8"?><root title="a&amp;&quot;b">&lt;x&gt;&amp;</root>');
  });
});
