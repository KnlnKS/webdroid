import { expect, test } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
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
