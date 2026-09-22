import { expect, test } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall, vcallOn, curThread, JThread, newObj } from "../src/jvm/natives/jlang";
import { openDatabase, useSQLiteStore } from "../src/android/sqlite";

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
