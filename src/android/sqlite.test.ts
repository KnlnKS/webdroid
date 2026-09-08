import { beforeAll, expect, test } from "bun:test";
import initSqlJs from "sql.js";
import "../natives";
import { JObj, rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { newObj, vcall } from "../jvm/natives/jlang";

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

test("WAL persistence includes committed pages and defers raw SQL transactions without losing TEMP state", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), saved = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  const db = await open(prefix + "-wal", 0x10000000), key = "wd:db:" + db.path;
  const sql = await initSqlJs();
  const waitSave = () => new Promise((resolve) => setTimeout(resolve, 450));
  const restored = () => new sql.Database(Uint8Array.from(atob(saved.get(key)!), (c) => c.charCodeAt(0)));
  try {
    await exec(db, "PRAGMA journal_mode=WAL; CREATE TABLE items(value); INSERT INTO items VALUES(1); PRAGMA user_version=5; CREATE TEMP TABLE changes(n); INSERT INTO changes VALUES(0); CREATE TEMP TRIGGER changed AFTER INSERT ON items BEGIN UPDATE changes SET n=n+1; END");
    const statement = db.db.prepare("SELECT n FROM changes");
    await waitSave();
    const first = saved.get(key), snapshot = restored();
    expect(snapshot.exec("PRAGMA user_version")[0].values).toEqual([[5]]);
    expect(snapshot.exec("SELECT * FROM items")[0].values).toEqual([[1]]);
    snapshot.close();
    await exec(db, "BEGIN IMMEDIATE; INSERT INTO items VALUES(2); PRAGMA user_version=6");
    await waitSave();
    expect(saved.get(key)).toBe(first);
    await exec(db, "COMMIT");
    await waitSave();
    const committed = restored();
    expect(committed.exec("PRAGMA user_version")[0].values).toEqual([[6]]);
    expect(committed.exec("SELECT * FROM items")[0].values).toEqual([[1], [2]]);
    committed.close();
    expect(statement.step()).toBe(true);
    expect(statement.get()).toEqual([1]);
    statement.free();
  } finally {
    if (db.saveTimer) clearTimeout(db.saveTimer);
    if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("cursor factories bind typed SQLiteQuery arguments before creating the returned cursor", async () => {
  const db = await open(prefix + "-factory", 0x10000000);
  let calls = 0;
  rt.register({ name: "test/TypedCursorFactory", ctor: class extends JObj {}, ifaces: ["android/database/sqlite/SQLiteDatabase$CursorFactory"], methods: {
    "newCursor(Landroid/database/sqlite/SQLiteDatabase;Landroid/database/sqlite/SQLiteCursorDriver;Ljava/lang/String;Landroid/database/sqlite/SQLiteQuery;)Landroid/database/Cursor;": async (database: unknown, driver: unknown, table: string, query: unknown) => {
      calls++; expect(database).toBe(db); expect(table).toBe("items");
      await vcall(query, "bindLong", "(IJ)V", 1, 42n);
      await vcall(query, "bindDouble", "(ID)V", 2, 1.25);
      await vcall(query, "bindString", "(ILjava/lang/String;)V", 3, "bound");
      await vcall(query, "bindBlob", "(I[B)V", 4, new Int8Array([1, -1]));
      await vcall(query, "bindNull", "(I)V", 5);
      return newObj("android/database/sqlite/SQLiteCursor", "(Landroid/database/sqlite/SQLiteCursorDriver;Ljava/lang/String;Landroid/database/sqlite/SQLiteQuery;)V", driver, table, query);
    },
  } });
  const factory = new (rt.link("test/TypedCursorFactory").ctor)();
  const cursor = await vcall(db, "rawQueryWithFactory", "(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;", factory, "SELECT ? AS i,? AS d,? AS s,? AS b,? AS n", [], "items");
  expect(calls).toBe(1);
  expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
  expect(await vcall(cursor, "getLong", "(I)J", 0)).toBe(42n);
  expect(await vcall(cursor, "getDouble", "(I)D", 1)).toBe(1.25);
  expect(await vcall(cursor, "getString", "(I)Ljava/lang/String;", 2)).toBe("bound");
  expect(await vcall(cursor, "getBlob", "(I)[B", 3)).toEqual(new Int8Array([1, -1]));
  expect(await vcall(cursor, "isNull", "(I)Z", 4)).toBe(1);
  await vcall(cursor, "close", "()V");
});

function native(owner: string, signature: string, ...args: unknown[]): unknown {
  const method = rt.jni.get("androidx/sqlite/driver/bundled/" + owner + "|" + signature);
  if (!method) throw new Error(signature);
  return Reflect.apply(method, null, args);
}
const nativeOpen = (path: string, flags = 6) => native("BundledSQLiteDriverKt", "nativeOpen(Ljava/lang/String;I)J", path, flags);
const nativeClose = (db: unknown) => native("BundledSQLiteConnectionKt", "nativeClose(J)V", db);
async function nativeSql(db: unknown, sql: string): Promise<bigint[]> {
  const stmt = native("BundledSQLiteConnectionKt", "nativePrepare(JLjava/lang/String;)J", db, sql), rows: bigint[] = [];
  try {
    while (await native("BundledSQLiteStatementKt", "nativeStep(J)Z", stmt)) {
      const value = native("BundledSQLiteStatementKt", "nativeGetLong(JI)J", stmt, 0);
      if (typeof value !== "bigint") throw new Error("Expected integer column");
      rows.push(value);
    }
    return rows;
  } finally { native("BundledSQLiteStatementKt", "nativeClose(J)V", stmt); }
}

test("native SQLite opens own separate connections over one live database file", async () => {
  const path = prefix + "-native", first = await nativeOpen(path), second = await nativeOpen(path, 2);
  try {
    await nativeSql(first, "CREATE TABLE items(value INTEGER)");
    await nativeSql(first, "INSERT INTO items VALUES(1)");
    await nativeSql(first, "CREATE TEMP TABLE local(value INTEGER)");
    await expect(nativeSql(second, "SELECT value FROM local")).rejects.toThrow("no such table");
    await nativeSql(first, "BEGIN IMMEDIATE");
    await nativeSql(first, "INSERT INTO items VALUES(2)");
    expect(await nativeSql(second, "SELECT value FROM items")).toEqual([1n]);
    await expect(nativeSql(second, "BEGIN IMMEDIATE")).rejects.toThrow("database is locked");
    await nativeSql(first, "COMMIT");
    expect(await nativeSql(second, "SELECT value FROM items")).toEqual([1n, 2n]);
    const reader = await nativeOpen(path, 1);
    try { await expect(nativeSql(reader, "INSERT INTO items VALUES(3)")).rejects.toThrow("readonly"); }
    finally { nativeClose(reader); }
    nativeClose(first);
    expect(await nativeSql(second, "SELECT value FROM items")).toEqual([1n, 2n]);
    await nativeSql(second, "BEGIN IMMEDIATE");
    await nativeSql(second, "INSERT INTO items VALUES(4)");
  } finally { nativeClose(first); nativeClose(second); }
  expect(await value(await open(path, 0), "SELECT sum(value) FROM items")).toBe(3n);
  await expect(nativeOpen(prefix + "-native-missing", 2)).rejects.toBeTruthy();
});

test("native SQLite memory databases are independent for every open", async () => {
  const first = await nativeOpen(":memory:"), second = await nativeOpen(":memory:");
  try {
    await nativeSql(first, "CREATE TABLE private(value INTEGER)");
    await expect(nativeSql(second, "SELECT value FROM private")).rejects.toThrow("no such table");
  } finally { nativeClose(first); nativeClose(second); }
});
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
