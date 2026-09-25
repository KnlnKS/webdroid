import { expect, test } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall, vcallOn, curThread, JThread, newObj } from "../src/jvm/natives/jlang";
import { openDatabase, useSQLiteStore } from "../src/android/sqlite";
import { vfs } from "../src/jvm/natives/jio";

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
  await vcall(db, "execSQL", "(Ljava/lang/String;)V", "INSERT INTO payload VALUES (x'010203')");
  await Bun.sleep(500);
  const saved = new sql.Database(vfs.read(path)!);
  expect(saved.exec("SELECT length(value) FROM payload")[0].values).toEqual([[6 * 1024 * 1024], [3]]);
  expect(db.db!.exec("SELECT count(*) FROM changes")[0].values).toEqual([[1]]);
  db.db!.exec("INSERT INTO payload VALUES (x'04')");
  expect(db.db!.exec("SELECT count(*) FROM changes")[0].values).toEqual([[2]]);
  saved.close(); vfs.delete(path);
});
