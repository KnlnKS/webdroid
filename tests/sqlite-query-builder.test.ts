import { expect, test } from "bun:test";
import initSqlJs from "sql.js";
import "../src/natives";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { openDatabase, useSQLiteStore } from "../src/android/sqlite";

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
