import { beforeAll, expect, test } from "bun:test";
import initSqlJs from "sql.js";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";

beforeAll(async () => {
  await initSqlJs({ locateFile: () => new URL("../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname });
});
const databaseClass = () => rt.link("android/database/sqlite/SQLiteDatabase").ctor;
const open = (path: string, flags: number) => databaseClass()[mangleMethod("openDatabase", "(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)Landroid/database/sqlite/SQLiteDatabase;")](path, null, flags);
const read = (path: string) => databaseClass()[mangleMethod("openDatabase", "(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;ILandroid/database/DatabaseErrorHandler;)Landroid/database/sqlite/SQLiteDatabase;")](path, null, 1, null);
const exec = (db: unknown, sql: string) => vcall(db, "execSQL", "(Ljava/lang/String;)V", sql);
async function value(db: unknown, sql: string) {
  const cursor = await vcall(db, "rawQuery", "(Ljava/lang/String;[Ljava/lang/String;)Landroid/database/Cursor;", sql, null);
  await vcall(cursor, "moveToFirst", "()Z");
  return vcall(cursor, "getLong", "(I)J", 0);
}

const prefix = "/data/data/sqlite-test/" + crypto.randomUUID();
test("openDatabase flags distinguish existing databases from create requests", async () => {
  const error = rt.link("android/database/sqlite/SQLiteCantOpenDatabaseException").ctor;
  await expect(open(prefix + "-missing", 0)).rejects.toBeInstanceOf(error);
  await expect(read(prefix + "-missing")).rejects.toBeInstanceOf(error);
  const db = await open(prefix + "-create", 0x30000000);
  expect(await open(prefix + "-create", 0)).toBe(db);
  expect(await vcall(db, "isReadOnly", "()Z")).toBe(0);
});

test("read-only handles follow committed writes without disturbing writer TEMP state or statements", async () => {
  const path = prefix + "-live", writer = await open(path, 0x10000000);
  await exec(writer, "CREATE TABLE items(value); INSERT INTO items VALUES(1); CREATE TEMP TABLE changes(n); INSERT INTO changes VALUES(0); CREATE TEMP TRIGGER changed AFTER INSERT ON items BEGIN UPDATE changes SET n=n+1; END");
  const prepared = writer.db.prepare("SELECT n FROM changes");
  const [reader, concurrent] = await Promise.all([read(path), read(path)]);
  expect(concurrent).toBe(reader);
  expect(reader).not.toBe(writer);
  expect(await vcall(reader, "isReadOnly", "()Z")).toBe(1);
  expect(await value(reader, "SELECT sum(value) FROM items")).toBe(1n);
  await exec(writer, "INSERT INTO items VALUES(2)");
  expect(await value(reader, "SELECT sum(value) FROM items")).toBe(3n);
  expect(prepared.step()).toBe(true);
  expect(prepared.get()).toEqual([1]);
  prepared.free();
  await vcall(reader, "close", "()V");
  expect(await vcall(reader, "isOpen", "()Z")).toBe(0);
  await exec(writer, "INSERT INTO items VALUES(4)");
  const reopened = await read(path);
  expect(await value(reopened, "SELECT sum(value) FROM items")).toBe(7n);
  expect(await value(writer, "SELECT n FROM changes")).toBe(2n);
  await vcall(reopened, "close", "()V");
});

test("read-only enforcement survives pragma resets and multi-statement SQL", async () => {
  const path = prefix + "-guard", writer = await open(path, 0x10000000);
  await exec(writer, "CREATE TABLE items(value); INSERT INTO items VALUES(1)");
  const reader = await read(path), error = rt.link("android/database/sqlite/SQLiteReadOnlyDatabaseException").ctor;
  await expect(exec(reader, "INSERT INTO items VALUES(9)")).rejects.toBeInstanceOf(error);
  await expect(exec(reader, "PRAGMA query_only=OFF; INSERT INTO items VALUES(9)")).rejects.toBeInstanceOf(error);
  await value(reader, "PRAGMA query_only=OFF");
  await expect(exec(reader, "INSERT INTO items VALUES(9)")).rejects.toBeInstanceOf(error);
  const stmt = await vcall(reader, "compileStatement", "(Ljava/lang/String;)Landroid/database/sqlite/SQLiteStatement;", "INSERT INTO items VALUES(?)");
  await vcall(stmt, "bindLong", "(IJ)V", 1, 9n);
  await expect(vcall(stmt, "executeInsert", "()J")).rejects.toBeInstanceOf(error);
  expect(await value(reader, "SELECT sum(value) FROM items")).toBe(1n);
  expect(await value(writer, "SELECT sum(value) FROM items")).toBe(1n);
  await vcall(reader, "close", "()V");
});
