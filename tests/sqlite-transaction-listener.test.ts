import { expect, test } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
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
