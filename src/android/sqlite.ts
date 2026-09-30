// android.database.* over sql.js, with snapshots in the shared private-file store.

import initSqlJs, { type Database, type Statement } from "sql.js";
import { i8, u8 } from "../jvm/abi";
import { vfs } from "../shell/vfs";
import { rt, JObj, type NativeSpec, callSelf, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { vcall, boxInt, box, JLong, JBool, newObj } from "../jvm/natives/jlang";
import { JMap, newArrayList } from "../jvm/natives/jutil";
import { pathOf } from "../jvm/natives/jio";
import { JAbstractCursor } from "./abstractcursor";

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
let SQL: SqlJs | null = null;
type SharedDatabase = { db: Database; transactions: Set<() => boolean> };
type SQLiteStore = { sql: () => Promise<NonNullable<typeof SQL>>; files: Map<string, SharedDatabase> };
let sqlReady: Promise<SqlJs> | null = null;
export let sqliteStore: SQLiteStore = { files: new Map(), sql: () => sqlReady ??= initSqlJs({ locateFile: (f: string) => "/sqljs/" + f }) };
export function useSQLiteStore(store: SQLiteStore): void { sqliteStore = store; }
async function ensureSql(): Promise<NonNullable<typeof SQL>> {
  if (!SQL) SQL = await sqliteStore.sql();
  return SQL;
}

/** sql.js keeps each Database's bytes in an Emscripten VFS file; @types/sql.js omits the name. */
function vfsDb(db: Database): Database & { filename: string } {
  if (!("filename" in db) || typeof db.filename !== "string") throw new Error("sql.js database filename unavailable");
  return Object.assign(db, { filename: db.filename });
}
// sql.js's Database.export() CLOSES and re-opens the connection (its own doc says so), which
// destroys everything that lives on a connection rather than in the file: the TEMP schema, the
// PRAGMAs, and every live prepared statement. A debounced save therefore deleted Room's TEMP
// room_table_modification_log and its triggers moments after Room created them, and a save
// landing inside a transaction rolled that transaction back. Snapshot the file through a
// THROWAWAY connection instead: point its filename at ours so its export() reads our bytes
// while closing only its own handle, then restore the name so its close() unlinks its own file.
function snapshotBytes(sql: NonNullable<typeof SQL>, db: Database): Uint8Array | null {
  // The main file alone omits WAL pages; a reader can prevent a complete checkpoint.
  const checkpoint = db.exec("PRAGMA wal_checkpoint(PASSIVE)")[0]?.values[0];
  if (checkpoint && (checkpoint[0] || checkpoint[1] !== checkpoint[2])) return null;
  const shadow = vfsDb(new sql.Database());
  const own = shadow.filename;
  shadow.filename = vfsDb(db).filename;
  try {
    return shadow.export();
  } finally {
    shadow.filename = own;
    try { shadow.close(); } catch { /* */ }
  }
}

class JSQLiteDatabase extends JObj {
  db: Database | null = null;
  path = ":memory:";
  version = 0;
  open = true;
  readOnly = false;
  txDepth = 0;
  txOk = false;
  txListener: unknown = null;
  saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** a connection of its own (SQLiteOpenHelper's) rather than the path's shared one, so close() closes it */
  separate = false;
  txActive: (() => boolean) | null = null;
  scheduleSave() {
    if (this.readOnly || this.path === ":memory:") { this.release(); return; }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      // Mid-transaction the file can hold spilled uncommitted pages whose undo lives in the
      // journal we do not copy; wait for the commit instead of persisting a torn snapshot.
      if (this.txDepth > 0 || [...sqliteStore.files.get(this.path)?.transactions ?? []].some((active) => active())) { this.scheduleSave(); return; }
      if (!SQL || !this.db) return;
      try {
        const bytes = snapshotBytes(SQL, this.db);
        if (bytes) {
          vfs.write(this.path, bytes);
          await vfs.flush();
          globalThis.localStorage?.removeItem("wd:db:" + this.path);
          this.release();
        }
        else this.scheduleSave();
      } catch (e) {
        if (e instanceof Error && e.message.includes("locked")) this.scheduleSave();
        else { console.warn("[sqlite] persist failed", e); this.release(); }
      }
    }, 400);
  }
  /** a closed connection's handle goes once its last snapshot is taken */
  release() {
    if (this.open || !this.db) return;
    if (this.txActive) sqliteStore.files.get(this.path)?.transactions.delete(this.txActive);
    this.db.close();
    this.db = null;
  }
}
const dbCache = new Map<string, JSQLiteDatabase>();
const readOnlyCache = new Map<string, JSQLiteDatabase>();
function sharedConnection(sql: NonNullable<typeof SQL>, source: Database): Database {
  const db = vfsDb(new sql.Database()), own = db.filename;
  db.filename = vfsDb(source).filename;
  try { db.export(); }
  catch (e) { db.filename = own; db.close(); throw e; }
  const close = db.close.bind(db);
  db.close = () => { db.filename = own; close(); };
  return db;
}
function readOnlyConnection(sql: NonNullable<typeof SQL>, source: Database): Database {
  const db = sharedConnection(sql, source);
  const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
  const protect = (stmt: Statement): Statement => {
    const step = stmt.step.bind(stmt), reset = stmt.reset.bind(stmt);
    let fresh = true;
    stmt.reset = () => { fresh = true; return reset(); };
    stmt.step = () => {
      if (!fresh) { const more = step(); fresh = !more; return more; }
      exec("PRAGMA query_only=ON");
      try { const more = step(); fresh = !more; return more; } finally { exec("PRAGMA query_only=ON"); }
    };
    exec("PRAGMA query_only=ON");
    return stmt;
  };
  db.prepare = (text, args) => {
    exec("PRAGMA query_only=ON");
    try { return protect(prepare(text, args)); } finally { exec("PRAGMA query_only=ON"); }
  };
  db.exec = (text, args) => {
    exec("PRAGMA query_only=ON");
    const out: ReturnType<Database["exec"]> = [], statements = db.iterateStatements(text);
    try {
      for (const stmt of statements) {
        protect(stmt);
        if (args) stmt.bind(args);
        let result: ReturnType<Database["exec"]>[number] | null = null;
        while (stmt.step()) {
          if (!result) out.push(result = { columns: stmt.getColumnNames(), values: [] });
          result.values.push(stmt.get());
        }
      }
      return out;
    } finally {
      // sql.js's iterator has no return(); drain it to release its SQL buffer after a failed step.
      try { while (!statements.next().done) exec("PRAGMA query_only=ON"); } catch { /* */ }
      exec("PRAGMA query_only=ON");
    }
  };
  db.run = (text, args) => { db.exec(text, args); return db; };
  exec("PRAGMA query_only=ON");
  return db;
}
/** ContextImpl.getDatabasePath: an absolute name is the path itself (Room/WorkManager hand
 *  over `<noBackupFilesDir>/x.db`); a relative one lives in databases/ and may not contain '/' */
export function dbPath(pkg: string, name: string): string {
  if (name.startsWith("/")) return name;
  if (name.includes("/")) throw rt.mkThrowable("java/lang/IllegalArgumentException", `File ${name} contains a path separator`);
  return `/data/data/${pkg}/databases/${name}`;
}
export async function openDatabase(path: string, flags = 0x10000000, separate = false): Promise<JSQLiteDatabase> {
  if (!path) throw rt.mkThrowable("java/lang/IllegalArgumentException", "path must not be empty");
  const readOnly = (flags & 1) !== 0;
  const sql = await ensureSql();
  let jdb = path === ":memory:" || separate ? undefined : dbCache.get(path);
  if (readOnly) {
    const writer = await openDatabase(path, flags & ~1 & ~0x10000000);
    const cached = readOnlyCache.get(path);
    if (cached?.open) return cached;
    const reader = new JSQLiteDatabase();
    reader.path = path; reader.readOnly = true;
    reader.db = readOnlyConnection(sql, writer.db!);
    readOnlyCache.set(path, reader);
    return reader;
  }
  if (jdb?.open) return jdb;
  jdb = new JSQLiteDatabase();
  jdb.path = path;
  jdb.separate = separate;
  // a database the app streamed in may be disk-backed
  let data = vfs.read(path) ?? (vfs.source(path) ? await vfs.readFile(path) : null);
  let legacy = false;
  const shared = path === ":memory:" ? undefined : sqliteStore.files.get(path);
  try {
    const raw = !data && globalThis.localStorage?.getItem("wd:db:" + path);
    if (raw) { data = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); legacy = true; }
  } catch { /* */ }
  if (!shared && !data && path !== ":memory:" && !(flags & 0x10000000)) {
    throw rt.mkThrowable("android/database/sqlite/SQLiteCantOpenDatabaseException", "Database does not exist: " + path);
  }
  if (path === ":memory:") jdb.db = new sql.Database();
  else {
    const file = shared ?? { db: data ? new sql.Database(data) : new sql.Database(), transactions: new Set<() => boolean>() };
    sqliteStore.files.set(path, file);
    jdb.db = sharedConnection(sql, file.db);
    const connection = jdb;
    file.transactions.add(jdb.txActive = () => connection.txDepth > 0);
    // opening creates the (empty) file, which callers chmod or stat before the first snapshot
    if (!shared && !data) {
      vfs.mkdir(path.slice(0, path.lastIndexOf("/")));
      vfs.write(path, new Uint8Array(0));
    }
  }
  jdb.db.exec("PRAGMA user_version");
  if (path !== ":memory:" && !separate) dbCache.set(path, jdb);
  if (legacy) jdb.scheduleSave();
  return jdb;
}

function bindArgs(args: unknown[] | null): (string | number | bigint | Uint8Array | null)[] {
  if (!args) return [];
  return args.map((a) => {
    if (a === null || a === undefined) return null;
    if (typeof a === "bigint") return a;
    if (typeof a === "number" || typeof a === "string") return a;
    if (a instanceof Int8Array) return u8(a);
    if (typeof a === "object" && "v" in (a as object)) {
      const v = (a as { v: unknown }).v;
      return v as number | bigint;
    }
    return String(a);
  });
}

/** a cursor over rows already in hand; MatrixCursor and every in-process query result */
class JCursor extends JAbstractCursor {
  cols: string[] = [];
  rows: unknown[][] = [];
  val(i: number): unknown { return unbox(this.rows[this.mPos]?.[i] ?? null); }
}
export function mkCursor(cols: string[], rows: unknown[][]): JCursor {
  rt.link("webdroid/Cursor");
  const c = new JCursor();
  c.cols = cols;
  c.rows = rows;
  return c;
}
function integerRow(stmt: Statement): unknown[] {
  const row = stmt.get();
  if (!row.some((v) => typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER)) return row;
  return (stmt.get as (params: undefined, config: { useBigInt: boolean }) => unknown[])(undefined, { useBigInt: true });
}
const longValue = (v: unknown): bigint => typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v ?? 0)));
function runQuery(jdb: JSQLiteDatabase, sqlStr: string, args: unknown[] | null): JCursor {
  const c = mkCursor([], []);
  try {
    const stmt = jdb.db!.prepare(sqlStr);
    try {
      stmt.bind(bindArgs(args) as never);
      c.cols = stmt.getColumnNames();
      while (stmt.step()) c.rows.push(integerRow(stmt));
    } finally { stmt.free(); }
  } catch (e) {
    throw sqliteExc(String(e), sqlStr);
  }
  return c;
}
function sqliteExc(msg: string, sql: string): unknown {
  console.warn("[sqlite]", msg, "SQL:", sql.slice(0, 200));
  return rt.mkThrowable("android/database/sqlite/" + (msg.includes("readonly") ? "SQLiteReadOnlyDatabaseException" : "SQLiteException"), msg + " while executing: " + sql.slice(0, 120));
}
/** run a modifying statement, then schedule the snapshot it dirtied */
function runWrite(jdb: JSQLiteDatabase, sql: string, args: unknown[] | null): void {
  try { jdb.db!.run(sql, bindArgs(args) as never); } catch (e) { throw sqliteExc(String(e), sql); }
  jdb.scheduleSave();
}
const lastInsertRowId = (jdb: JSQLiteDatabase) => longValue(runQuery(jdb, "SELECT last_insert_rowid()", null).rows[0]?.[0] ?? -1);
/** the first column of a query's first row, as simpleQueryForLong/longForQuery read it */
const firstLong = (c: JCursor) => longValue(c.rows[0]?.[0]);
const firstString = (c: JCursor) => c.rows.length ? String(c.rows[0][0] ?? "") : null;

const cursorMethods: NativeSpec["methods"] = {
  "getCount()I": function (this: JCursor) { return this.rows.length; },
  "getColumnNames()[Ljava/lang/String;": function (this: JCursor) {
    (this.cols as { $t?: string }).$t ??= "Ljava/lang/String;";
    return this.cols;
  },
  "getString(I)Ljava/lang/String;": function (this: JCursor, i: number) {
    const v = this.val(i);
    return v === null ? null : String(v);
  },
  "getInt(I)I": function (this: JCursor, i: number) { return Math.trunc(Number(this.val(i) ?? 0)) | 0; },
  "getLong(I)J": function (this: JCursor, i: number) { return longValue(this.val(i)); },
  "getDouble(I)D": function (this: JCursor, i: number) { return Number(this.val(i) ?? 0); },
  "getFloat(I)F": function (this: JCursor, i: number) { return Math.fround(Number(this.val(i) ?? 0)); },
  "getShort(I)S": function (this: JCursor, i: number) { return (Number(this.val(i) ?? 0) << 16) >> 16; },
  "getBlob(I)[B": function (this: JCursor, i: number) {
    const v = this.val(i);
    if (v instanceof Uint8Array) return i8(v);
    return v === null ? null : new Int8Array(0);
  },
  "isNull(I)Z": function (this: JCursor, i: number) { return this.val(i) === null ? 1 : 0; },
  "getType(I)I": function (this: JCursor, i: number) {
    const v = this.val(i);
    if (v === null) return 0;
    if (typeof v === "bigint") return 1;
    if (typeof v === "number") return Number.isInteger(v) ? 1 : 2;
    if (typeof v === "string") return 3;
    return 4;
  },
};
rt.register({ name: "android/database/Cursor", ctor: class extends JObj {}, ifaces: ["java/io/Closeable"] });
const ABSTRACT_CURSOR = "android/database/AbstractCursor";
rt.register({ name: "webdroid/Cursor", ctor: JCursor, sup: ABSTRACT_CURSOR, methods: {
  ...cursorMethods,
  // row iteration's hot path; nothing subclasses this class, so no getCount/onMove override can intervene
  "moveToNext()Z": function (this: JCursor) {
    if (this.mPos + 1 < this.rows.length) { this.mPos++; return 1; }
    this.mPos = this.rows.length;
    return 0;
  },
} });
class JRowBuilder extends JObj { cursor!: JCursor; row!: unknown[]; index = 0; }
rt.register({ name: "android/database/MatrixCursor$RowBuilder", ctor: JRowBuilder, methods: {
  "add(Ljava/lang/Object;)Landroid/database/MatrixCursor$RowBuilder;": function (this: JRowBuilder, value: unknown) {
    if (this.index === this.row.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", "No more columns left");
    this.row[this.index++] = value; return this;
  },
  "add(Ljava/lang/String;Ljava/lang/Object;)Landroid/database/MatrixCursor$RowBuilder;": function (this: JRowBuilder, name: string, value: unknown) {
    for (let i = 0; i < this.cursor.cols.length; i++) if (this.cursor.cols[i] === name) this.row[i] = value;
    return this;
  },
} });
rt.register({ name: "android/database/MatrixCursor", ctor: class extends JCursor {}, sup: ABSTRACT_CURSOR, methods: {
  ...cursorMethods,
  "<init>([Ljava/lang/String;)V": function (this: JCursor, cols: string[]) { this.cols = cols; },
  "<init>([Ljava/lang/String;I)V": function (this: JCursor, cols: string[]) { this.cols = cols; },
  "newRow()Landroid/database/MatrixCursor$RowBuilder;": function (this: JCursor) {
    rt.link("android/database/MatrixCursor$RowBuilder");
    const builder = new JRowBuilder(); builder.cursor = this; builder.row = Array(this.cols.length).fill(null);
    this.rows.push(builder.row); return builder;
  },
  "addRow([Ljava/lang/Object;)V": function (this: JCursor, row: unknown[]) {
    if (row.length !== this.cols.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "columnNames.length != columnValues.length");
    this.rows.push(row.slice());
  },
} });

export class JContentValues extends JObj {
  data = new JMap();
}
/** a ContentValues' entries with boxed numbers unwrapped */
export const contentValues = (values: JContentValues): Map<string, unknown> => new Map([...values.data.m.values()].map((e) => [e.k as string, unbox(e.v)]));
rt.register({
  name: "android/content/ContentValues", ctor: JContentValues, ifaces: ["android/os/Parcelable"],
  methods: (() => {
    const m: NativeSpec["methods"] = {
      "<init>()V": function () {},
      "<init>(I)V": function (capacity: number) { if (capacity < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative capacity"); },
      "<init>(Landroid/content/ContentValues;)V": function (this: JContentValues, o: JContentValues) {
        if (o) this.data.m = new Map([...o.data.m].map(([k, e]) => [k, { ...e }]));
      },
      "putAll(Landroid/content/ContentValues;)V": function (this: JContentValues, other: JContentValues) {
        if (!other) throw rt.mkThrowable("java/lang/NullPointerException", "other");
        for (const [k, e] of other.data.m) this.data.m.set(k, e);
      },
      "putNull(Ljava/lang/String;)V": function (this: JContentValues, k: string) { this.data.m.set(k, { k, v: null }); },
      "size()I": function (this: JContentValues) { return this.data.m.size; },
      "isEmpty()Z": function (this: JContentValues) { return this.data.m.size ? 0 : 1; },
      "containsKey(Ljava/lang/String;)Z": function (this: JContentValues, k: string) { return this.data.m.has(k) ? 1 : 0; },
      "remove(Ljava/lang/String;)V": function (this: JContentValues, k: string) { this.data.m.delete(k); },
      "clear()V": function (this: JContentValues) { this.data.m.clear(); },
      "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JContentValues, k: string) { return this.data.m.get(k)?.v ?? null; },
      "keySet()Ljava/util/Set;": function (this: JContentValues) { return vcall(this.data, "keySet", "()Ljava/util/Set;"); },
      "valueSet()Ljava/util/Set;": function (this: JContentValues) { return vcall(this.data, "entrySet", "()Ljava/util/Set;"); },
      // live over the same entries, as AOSP hands out its mMap
      "getValues()Landroid/util/ArrayMap;": function (this: JContentValues) {
        const map: JMap = rt.make("android/util/ArrayMap");
        map.m = this.data.m;
        return map;
      },
      "getAsBoolean(Ljava/lang/String;)Ljava/lang/Boolean;": function (this: JContentValues, k: string) {
        const v = unbox(this.data.m.get(k)?.v);
        if (v === null || v === undefined) return null;
        return box(JBool, typeof v === "string" ? (v.toLowerCase() === "true" || v === "1" ? 1 : 0) : v ? 1 : 0);
      },
      "getAsString(Ljava/lang/String;)Ljava/lang/String;": function (this: JContentValues, k: string) {
        const v = this.data.m.get(k)?.v;
        return v === null || v === undefined ? null : String(unbox(v));
      },
      "getAsLong(Ljava/lang/String;)Ljava/lang/Long;": function (this: JContentValues, k: string) {
        const v = unbox(this.data.m.get(k)?.v);
        if (v === null || v === undefined) return null;
        return box(JLong, longValue(v));
      },
      "getAsInteger(Ljava/lang/String;)Ljava/lang/Integer;": function (this: JContentValues, k: string) {
        const v = unbox(this.data.m.get(k)?.v);
        if (v === null || v === undefined) return null;
        return boxInt(Math.trunc(Number(v)) | 0);
      },
    };
    for (const t of ["Ljava/lang/String;", "Ljava/lang/Byte;", "Ljava/lang/Short;", "Ljava/lang/Integer;", "Ljava/lang/Long;",
      "Ljava/lang/Float;", "Ljava/lang/Double;", "Ljava/lang/Boolean;", "[B"]) {
      m[`put(Ljava/lang/String;${t})V`] = function (this: JContentValues, k: string, v: unknown) { this.data.m.set(k, { k, v }); };
    }
    return m;
  })(),
});
function unbox(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "v" in (v as object)) return (v as { v: unknown }).v;
  return v;
}

/** SQLiteDatabase.query, with or without its trailing limit */
function tableQuery(this: JSQLiteDatabase, table: string, cols: string[] | null, sel: string | null, selArgs: unknown[] | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null = null) {
  return runQuery(this, buildQuery(table, cols, sel, groupBy, having, orderBy, limit), selArgs);
}
const dbMethods: NonNullable<NativeSpec["methods"]> = {
  "static create(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase;": () => openDatabase(":memory:"),
  // AOSP's SQLiteOpenHelper opens through these: each call a connection of its own
  "static createInMemory(Landroid/database/sqlite/SQLiteDatabase$OpenParams;)Landroid/database/sqlite/SQLiteDatabase;":
    (params: JObj) => openWithParams(":memory:", params),
  "static openDatabase(Ljava/io/File;Landroid/database/sqlite/SQLiteDatabase$OpenParams;)Landroid/database/sqlite/SQLiteDatabase;":
    (file: JObj, params: JObj) => openWithParams(pathOf(file), params),
  "static deleteDatabase(Ljava/io/File;)Z": (file: JObj) => {
    const path = pathOf(file);
    sqliteStore.files.delete(path);
    const deleted = vfs.delete(path);
    for (const suffix of ["-journal", "-shm", "-wal"]) vfs.delete(path + suffix);
    if (dbCache.get(path)?.open === false) dbCache.delete(path);
    return deleted ? 1 : 0;
  },
  "reopenReadWrite()V": function (this: JSQLiteDatabase) {
    const file = sqliteStore.files.get(this.path);
    if (!this.readOnly || !this.open || !file || !SQL) return;
    if (readOnlyCache.get(this.path) === this) readOnlyCache.delete(this.path);
    this.db!.close();
    this.db = sharedConnection(SQL, file.db);
    this.readOnly = false;
    this.separate = true;
    file.transactions.add(this.txActive = () => this.txDepth > 0);
  },
  "static openDatabase(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)Landroid/database/sqlite/SQLiteDatabase;":
    function (path: string, _factory: unknown, flags: number) { return openDatabase(path, flags); },
  "static openDatabase(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;ILandroid/database/DatabaseErrorHandler;)Landroid/database/sqlite/SQLiteDatabase;":
    function (path: string, _factory: unknown, flags: number, _errorHandler: unknown) { return openDatabase(path, flags); },
  "execSQL(Ljava/lang/String;)V": function (this: JSQLiteDatabase, sql: string) {
    try { this.db!.exec(sql); } catch (e) { throw sqliteExc(String(e), sql); }
    this.scheduleSave();
  },
  "execSQL(Ljava/lang/String;[Ljava/lang/Object;)V": function (this: JSQLiteDatabase, sql: string, args: unknown[]) { runWrite(this, sql, args); },
  "rawQueryWithFactory(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    function (this: JSQLiteDatabase, factory: unknown, sql: string, args: unknown[] | null, editTable: string | null) {
      if (!factory) return runQuery(this, sql, args);
      rt.link("android/database/sqlite/SQLiteQuery");
      rt.link("android/database/sqlite/SQLiteDirectCursorDriver");
      const query = new JSQLiteQuery(), driver = new JSQLiteCursorDriver();
      query.jdb = this; query.sql = sql; query.binds = args?.slice() ?? []; driver.query = query;
      return vcall(factory, "newCursor", "(Landroid/database/sqlite/SQLiteDatabase;Landroid/database/sqlite/SQLiteCursorDriver;Ljava/lang/String;Landroid/database/sqlite/SQLiteQuery;)Landroid/database/Cursor;", this, driver, editTable, query);
    },
  "rawQueryWithFactory(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;":
    driven(function* (this: JSQLiteDatabase, factory: unknown, sql: string, args: unknown[] | null, editTable: string | null, signal: unknown): Gen {
      if (signal) yield vcall(signal, "throwIfCanceled", "()V");
      return callSelf(dbMethods,
        "rawQueryWithFactory(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        this, factory, sql, args, editTable);
    }),
  "rawQuery(Ljava/lang/String;[Ljava/lang/String;)Landroid/database/Cursor;": function (this: JSQLiteDatabase, sql: string, args: unknown[] | null) {
    return runQuery(this, sql, args);
  },
  "rawQuery(Ljava/lang/String;[Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;": driven(function* (this: JSQLiteDatabase, sql: string, args: unknown[] | null, signal: unknown): Gen {
    if (signal) yield vcall(signal, "throwIfCanceled", "()V");
    return runQuery(this, sql, args);
  }),
  "query(Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;": tableQuery,
  "query(Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;": tableQuery,
  "insert(Ljava/lang/String;Ljava/lang/String;Landroid/content/ContentValues;)J":
    function (this: JSQLiteDatabase, table: string, nullCol: string | null, cv: JContentValues) {
      return doInsert(this, table, cv, "");
    },
  "insertOrThrow(Ljava/lang/String;Ljava/lang/String;Landroid/content/ContentValues;)J":
    function (this: JSQLiteDatabase, table: string, nullCol: string | null, cv: JContentValues) {
      return doInsert(this, table, cv, "", true);
    },
  "insertWithOnConflict(Ljava/lang/String;Ljava/lang/String;Landroid/content/ContentValues;I)J":
    function (this: JSQLiteDatabase, table: string, nullCol: string | null, cv: JContentValues, conflict: number) {
      const or = ["", "", "", "", " OR IGNORE", " OR REPLACE"][conflict] ?? "";
      return doInsert(this, table, cv, or);
    },
  "replace(Ljava/lang/String;Ljava/lang/String;Landroid/content/ContentValues;)J":
    function (this: JSQLiteDatabase, table: string, nullCol: string | null, cv: JContentValues) {
      return doInsert(this, table, cv, " OR REPLACE");
    },
  "replaceOrThrow(Ljava/lang/String;Ljava/lang/String;Landroid/content/ContentValues;)J":
    function (this: JSQLiteDatabase, table: string, nullCol: string | null, cv: JContentValues) {
      return doInsert(this, table, cv, " OR REPLACE", true);
    },
  "update(Ljava/lang/String;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I":
    function (this: JSQLiteDatabase, table: string, cv: JContentValues, where: string | null, args: unknown[] | null) {
      const sets = [...cv.data.m.keys()].map((k) => `"${k}"=?`).join(",");
      const sql = `UPDATE "${table}" SET ${sets}${where ? " WHERE " + where : ""}`;
      const vals = [...cv.data.m.values()].map((e) => unbox(e.v));
      runWrite(this, sql, [...vals, ...(args ?? [])]);
      return this.db!.getRowsModified();
    },
  "delete(Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)I":
    function (this: JSQLiteDatabase, table: string, where: string | null, args: unknown[] | null) {
      runWrite(this, `DELETE FROM "${table}"${where ? " WHERE " + where : ""}`, args);
      return this.db!.getRowsModified();
    },
  "beginTransaction()V": function (this: JSQLiteDatabase) {
    if (this.txDepth === 0) this.db!.exec("BEGIN");
    this.txDepth++;
    this.txOk = false;
  },
  "beginTransactionNonExclusive()V": function (this: JSQLiteDatabase) {
    callSelf(dbMethods, "beginTransaction()V", this);
  },
  "beginTransactionWithListener(Landroid/database/sqlite/SQLiteTransactionListener;)V": function (this: JSQLiteDatabase, listener: unknown) {
    if (listener === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "transactionListener must not be null");
    callSelf(dbMethods, "beginTransaction()V", this);
    if (this.txDepth === 1) this.txListener = listener;
    return vcall(listener, "onBegin", "()V");
  },
  "beginTransactionWithListenerNonExclusive(Landroid/database/sqlite/SQLiteTransactionListener;)V": function (this: JSQLiteDatabase, listener: unknown) {
    return callSelf(dbMethods, "beginTransactionWithListener(Landroid/database/sqlite/SQLiteTransactionListener;)V", this, listener);
  },
  "setTransactionSuccessful()V": function (this: JSQLiteDatabase) { this.txOk = true; },
  "endTransaction()V": function (this: JSQLiteDatabase) {
    this.txDepth--;
    if (this.txDepth <= 0) {
      this.txDepth = 0;
      const successful = this.txOk, listener = this.txListener;
      this.txListener = null;
      const finish = (commit: boolean) => {
        try { this.db!.exec(commit ? "COMMIT" : "ROLLBACK"); } catch { /* */ }
        this.scheduleSave();
      };
      if (!listener) { finish(successful); return; }
      return Promise.resolve(vcall(listener, successful ? "onCommit" : "onRollback", "()V")).then(
        () => finish(successful),
        (error) => { finish(false); throw error; },
      );
    }
  },
  "inTransaction()Z": function (this: JSQLiteDatabase) { return this.txDepth > 0 ? 1 : 0; },
  "isOpen()Z": function (this: JSQLiteDatabase) { return this.open ? 1 : 0; },
  "close()V": function (this: JSQLiteDatabase) {
    if (this.readOnly) { if (this.open) this.db!.close(); this.open = false; return; }
    if (this.separate && this.open) {
      this.open = false;
      if (this.txDepth > 0) { this.txDepth = 0; try { this.db!.exec("ROLLBACK"); } catch { /* */ } }
    }
    this.scheduleSave();
  },
  "getVersion()I": function (this: JSQLiteDatabase) {
    const r = this.db!.exec("PRAGMA user_version");
    return Number(r[0]?.values[0]?.[0] ?? 0);
  },
  "setVersion(I)V": function (this: JSQLiteDatabase, v: number) {
    this.db!.exec("PRAGMA user_version = " + v);
    this.scheduleSave();
  },
  "getPath()Ljava/lang/String;": function (this: JSQLiteDatabase) { return this.path; },
  "static findEditTable(Ljava/lang/String;)Ljava/lang/String;": (tables: string | null) => {
    if (!tables) throw rt.mkThrowable("java/lang/IllegalStateException", "Invalid tables");
    const space = tables.indexOf(" "), comma = tables.indexOf(",");
    if (space > 0 && (space < comma || comma < 0)) return tables.slice(0, space);
    if (comma > 0 && (comma < space || space < 0)) return tables.slice(0, comma);
    return tables;
  },
  "validateSql(Ljava/lang/String;Landroid/os/CancellationSignal;)V": driven(function* (this: JSQLiteDatabase, sql: string, signal: unknown): Gen {
    if (signal) yield vcall(signal, "throwIfCanceled", "()V");
    try { this.db!.prepare(sql).free(); } catch (e) { throw sqliteExc(String(e), sql); }
  }),
  "getAttachedDbs()Ljava/util/List;": async function (this: JSQLiteDatabase) {
    return newArrayList([await newObj("android/util/Pair", "(Ljava/lang/Object;Ljava/lang/Object;)V", "main", this.path)]);
  },
  "isReadOnly()Z": function (this: JSQLiteDatabase) { return this.readOnly ? 1 : 0; },
  "setForeignKeyConstraintsEnabled(Z)V": function (this: JSQLiteDatabase, on: number) {
    this.db!.exec("PRAGMA foreign_keys = " + (on ? "ON" : "OFF"));
  },
  "setMaximumSize(J)J": (v: bigint) => v,
  "compileStatement(Ljava/lang/String;)Landroid/database/sqlite/SQLiteStatement;": function (this: JSQLiteDatabase, sql: string) {
    rt.link("android/database/sqlite/SQLiteStatement");
    const st = new JSQLiteStatement();
    st.jdb = this;
    st.sql = sql;
    return st;
  },
  ...noops("setMaxSqlCacheSize(I)V", "disableWriteAheadLogging()V", "setLocale(Ljava/util/Locale;)V"),
  ...stubs(0, "isWriteAheadLoggingEnabled()Z", "isDbLockedByCurrentThread()Z", "enableWriteAheadLogging()Z",
    "yieldIfContendedSafely()Z", "static releaseMemory()I"),
};
function buildQuery(table: string, cols: string[] | null, sel: string | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null): string {
  const c = cols?.length ? cols.join(",") : "*";
  let sql = `SELECT ${c} FROM "${table}"`;
  if (sel) sql += " WHERE " + sel;
  if (groupBy) sql += " GROUP BY " + groupBy;
  if (having) sql += " HAVING " + having;
  if (orderBy) sql += " ORDER BY " + orderBy;
  if (limit) sql += " LIMIT " + limit;
  return sql;
}
function doInsert(jdb: JSQLiteDatabase, table: string, cv: JContentValues, or: string, doThrow = false): bigint {
  const keys = [...cv.data.m.keys()];
  const sql = keys.length
    ? `INSERT${or} INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`
    : `INSERT${or} INTO "${table}" DEFAULT VALUES`;
  try {
    jdb.db!.run(sql, bindArgs([...cv.data.m.values()].map((e) => unbox(e.v))) as never);
  } catch (e) {
    if (doThrow) throw sqliteExc(String(e), sql);
    console.warn("[sqlite insert]", e);
    return -1n;
  }
  jdb.scheduleSave();
  return lastInsertRowId(jdb);
}
class JSQLiteProgram extends JObj {
  jdb: JSQLiteDatabase | null = null;
  sql = "";
  binds: unknown[] = [];
}
rt.register({
  name: "android/database/sqlite/SQLiteProgram", ctor: JSQLiteProgram, ifaces: ["java/io/Closeable"], fields: { mSql: "sql" },
  methods: {
    "bindString(ILjava/lang/String;)V": function (this: JSQLiteProgram, i: number, v: string) { this.binds[i - 1] = v; },
    "bindLong(IJ)V": function (this: JSQLiteProgram, i: number, v: bigint) { this.binds[i - 1] = v; },
    "bindDouble(ID)V": function (this: JSQLiteProgram, i: number, v: number) { this.binds[i - 1] = v; },
    "bindNull(I)V": function (this: JSQLiteProgram, i: number) { this.binds[i - 1] = null; },
    "bindBlob(I[B)V": function (this: JSQLiteProgram, i: number, v: Int8Array) { this.binds[i - 1] = v; },
    "clearBindings()V": function (this: JSQLiteProgram) { this.binds = []; },
    "close()V": () => {},
  },
});
class JSQLiteQuery extends JSQLiteProgram {}
class JSQLiteCursorDriver extends JObj { query: JSQLiteQuery | null = null; }
rt.register({ name: "android/database/sqlite/SQLiteQuery", ctor: JSQLiteQuery, sup: "android/database/sqlite/SQLiteProgram" });
rt.markers("android/database/sqlite/SQLiteCursorDriver");
rt.register({ name: "android/database/sqlite/SQLiteDirectCursorDriver", ctor: JSQLiteCursorDriver, ifaces: ["android/database/sqlite/SQLiteCursorDriver"], methods: {
  "setBindArguments([Ljava/lang/String;)V": function (this: JSQLiteCursorDriver, args: string[]) { if (this.query) this.query.binds = args.slice(); },
} });
rt.register({ name: "android/database/sqlite/SQLiteCursor", ctor: class extends JCursor {}, ifaces: ["android/database/Cursor"], methods: {
  ...cursorMethods,
  "<init>(Landroid/database/sqlite/SQLiteCursorDriver;Ljava/lang/String;Landroid/database/sqlite/SQLiteQuery;)V": function (this: JCursor, _driver: unknown, _editTable: string | null, query: JSQLiteQuery) {
    const cursor = runQuery(query.jdb!, query.sql, query.binds);
    this.cols = cursor.cols; this.rows = cursor.rows;
  },
} });
class JSQLiteStatement extends JSQLiteProgram {}
rt.register({
  name: "android/database/sqlite/SQLiteStatement", ctor: JSQLiteStatement, sup: "android/database/sqlite/SQLiteProgram",
  methods: {
    "execute()V": function (this: JSQLiteStatement) { runWrite(this.jdb!, this.sql, this.binds); },
    "executeInsert()J": function (this: JSQLiteStatement) {
      runWrite(this.jdb!, this.sql, this.binds);
      return lastInsertRowId(this.jdb!);
    },
    "executeUpdateDelete()I": function (this: JSQLiteStatement) {
      runWrite(this.jdb!, this.sql, this.binds);
      return this.jdb!.db!.getRowsModified();
    },
    "simpleQueryForLong()J": function (this: JSQLiteStatement) { return firstLong(runQuery(this.jdb!, this.sql, this.binds)); },
    "simpleQueryForString()Ljava/lang/String;": function (this: JSQLiteStatement) { return firstString(runQuery(this.jdb!, this.sql, this.binds)); },
    "close()V": () => {},
  },
});
rt.register({ name: "android/database/sqlite/SQLiteDatabase", ctor: JSQLiteDatabase, ifaces: ["java/io/Closeable"],
  statics: { OPEN_READONLY: 1, OPEN_READWRITE: 0, CREATE_IF_NECESSARY: 0x10000000, ENABLE_WRITE_AHEAD_LOGGING: 0x20000000, NO_LOCALIZED_COLLATORS: 0x10, CONFLICT_NONE: 0, CONFLICT_ROLLBACK: 1, CONFLICT_ABORT: 2, CONFLICT_FAIL: 3, CONFLICT_IGNORE: 4, CONFLICT_REPLACE: 5 },
  methods: dbMethods });
{
  const p = rt.link("java/lang/RuntimeException").ctor;
  rt.register({ name: "android/database/SQLException", ctor: class extends p {}, sup: "java/lang/RuntimeException" });
}
{
  const p = rt.link("android/database/SQLException").ctor;
  rt.register({ name: "android/database/sqlite/SQLiteException", ctor: class extends p {}, sup: "android/database/SQLException" });
}
{
  const p = rt.link("android/database/sqlite/SQLiteException").ctor;
  for (const n of ["SQLiteConstraintException", "SQLiteDatabaseLockedException", "SQLiteFullException", "SQLiteAbortException", "SQLiteCantOpenDatabaseException", "SQLiteReadOnlyDatabaseException"]) {
    rt.register({ name: "android/database/sqlite/" + n, ctor: class extends p {}, sup: "android/database/sqlite/SQLiteException" });
  }
}
rt.markers("android/database/sqlite/SQLiteDatabase$CursorFactory");
// DatabaseUtils.getSqlStatementType: AOSP classifies by the first three letters
const STATEMENT_TYPES: Record<string, number> = {
  SEL: 1, INS: 2, UPD: 2, REP: 2, DEL: 2, ATT: 3, BEG: 4, COM: 5, END: 5, ROL: 6, PRA: 7, CRE: 8, DRO: 8, ALT: 8, ANA: 9, DET: 9,
};
function sqlStatementType(sql: string | null): number {
  if (sql === null) return rt.npe();
  const text = sql.trim().toUpperCase(), type = text.length < 3 ? 99 : STATEMENT_TYPES[text.slice(0, 3)] ?? 99;
  return type === 6 && text.includes(" TO ") ? 99 : type; // ROLLBACK TO a savepoint is not an abort
}
rt.register({
  name: "android/database/DatabaseUtils", ctor: class extends JObj {},
  statics: { STATEMENT_SELECT: 1, STATEMENT_UPDATE: 2, STATEMENT_ATTACH: 3, STATEMENT_BEGIN: 4, STATEMENT_COMMIT: 5,
    STATEMENT_ABORT: 6, STATEMENT_PRAGMA: 7, STATEMENT_DDL: 8, STATEMENT_UNPREPARED: 9, STATEMENT_OTHER: 99 },
  methods: {
    "static getSqlStatementType(Ljava/lang/String;)I": sqlStatementType,
    "static appendEscapedSQLString(Ljava/lang/StringBuilder;Ljava/lang/String;)V": (builder: { s: string } | null, value: string | null) => {
      if (!builder) return rt.npe();
      builder.s += "'" + String(value).replaceAll("'", "''") + "'";
    },
    "static sqlEscapeString(Ljava/lang/String;)Ljava/lang/String;": (value: string | null) => "'" + String(value).replaceAll("'", "''") + "'",
    "static queryNumEntries(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;)J": (db: JSQLiteDatabase, table: string) =>
      firstLong(runQuery(db, `SELECT COUNT(*) FROM "${table}"`, null)),
    "static queryNumEntries(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)J": (db: JSQLiteDatabase, table: string, where: string | null, args: unknown[]) =>
      firstLong(runQuery(db, `SELECT COUNT(*) FROM "${table}"` + (where ? " WHERE " + where : ""), args)),
    "static longForQuery(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)J":
      (db: JSQLiteDatabase, sql: string, args: unknown[]) => firstLong(runQuery(db, sql, args)),
    "static stringForQuery(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)Ljava/lang/String;":
      (db: JSQLiteDatabase, sql: string, args: unknown[]) => firstString(runQuery(db, sql, args)),
    "static executeInsert(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/Object;)J":
      (db: JSQLiteDatabase, sql: string, args: unknown[] | null) => { runWrite(db, sql, args); return db.db!.getRowsModified() > 0 ? lastInsertRowId(db) : -1n; },
    "static executeUpdateDelete(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/Object;)I":
      (db: JSQLiteDatabase, sql: string, args: unknown[] | null) => { runWrite(db, sql, args); return db.db!.getRowsModified(); },
  },
});

/** SQLiteDatabase.openDatabase(File, OpenParams), read through AOSP's OpenParams getters */
const openWithParams = driven(function* (path: string, params: JObj | null): Gen {
  if (!params) return rt.npe();
  const flags = (yield vcall(params, "getOpenFlags", "()I")) as number;
  const synchronous = (yield vcall(params, "getSynchronousMode", "()Ljava/lang/String;")) as string | null;
  const jdb = (yield openDatabase(path, flags, true)) as JSQLiteDatabase;
  if (synchronous !== null) jdb.db!.exec("PRAGMA synchronous='" + synchronous.replace(/'/g, "''") + "'");
  return jdb;
});
rt.markers("android/database/DatabaseErrorHandler");
rt.markers("android/database/sqlite/SQLiteTransactionListener");

// ── androidx.sqlite bundled driver (libsqliteJni) over sql.js; handles are opaque bigints.
interface BStmt {
  st: import("sql.js").Statement;
  sql: string;
  conn: BConn;
  params: (string | number | bigint | Uint8Array | null)[];
  bound: boolean;
  row: unknown[] | null;
  names: string[];
}
interface BConn { jdb: JSQLiteDatabase; db: Database; tx: number; }
let nextHandle = 1n;
const bConns = new Map<bigint, BConn>();
const bStmts = new Map<bigint, BStmt>();
const bstmt = (h: bigint): BStmt => {
  const st = bStmts.get(h);
  if (!st) throw rt.mkThrowable("android/database/sqlite/SQLiteException", "bad stmt handle");
  return st;
};
const jni = (cls: string, sig: string, fn: (...a: never[]) => unknown) =>
  rt.registerJni("androidx/sqlite/driver/bundled/" + cls, sig, fn);
rt.claimNativeLib("sqliteJni");
jni("BundledSQLiteDriverKt", "nativeThreadSafeMode()I", () => 0);
jni("BundledSQLiteDriverKt", "nativeOpen(Ljava/lang/String;I)J", async (name: string, flags: number) => {
  const mode = flags & 3;
  if (mode !== 1 && mode !== 2) throw rt.mkThrowable("android/database/sqlite/SQLiteCantOpenDatabaseException", "Invalid SQLite open flags");
  const sql = await ensureSql();
  let jdb: JSQLiteDatabase, db: Database;
  if (!name || name === ":memory:") {
    jdb = new JSQLiteDatabase(); jdb.db = db = new sql.Database();
  } else {
    jdb = await openDatabase(name, mode === 2 && flags & 4 ? 0x10000000 : 0);
    db = mode === 1 ? readOnlyConnection(sql, jdb.db!) : sharedConnection(sql, jdb.db!);
  }
  const h = nextHandle++;
  bConns.set(h, { jdb, db, tx: 0 });
  return h;
});
jni("BundledSQLiteConnectionKt", "nativePrepare(JLjava/lang/String;)J", (db: bigint, sql: string) => {
  const conn = bConns.get(db);
  if (!conn?.jdb.db) throw rt.mkThrowable("android/database/sqlite/SQLiteException", "connection closed");
  const st = conn.db.prepare(sql);
  const h = nextHandle++;
  bStmts.set(h, { st, sql, conn, params: [], bound: false, row: null, names: st.getColumnNames() });
  return h;
});
jni("BundledSQLiteConnectionKt", "nativeClose(J)V", (db: bigint) => {
  const conn = bConns.get(db);
  if (!conn) return;
  for (const [handle, stmt] of bStmts) if (stmt.conn === conn) { stmt.st.free(); bStmts.delete(handle); }
  conn.db.close();
  conn.jdb.txDepth = Math.max(0, conn.jdb.txDepth - conn.tx);
  if (conn.jdb.path !== ":memory:") conn.jdb.scheduleSave();
  bConns.delete(db);
});
jni("BundledSQLiteConnectionKt", "nativeInTransaction(J)Z", (db: bigint) => (bConns.get(db)?.tx ? 1 : 0));
jni("BundledSQLiteConnectionKt", "nativeLoadExtension(JLjava/lang/String;Ljava/lang/String;)V", () => {
  throw rt.mkThrowable("android/database/sqlite/SQLiteException", "extensions unsupported");
});
const stJni: Record<string, (...a: never[]) => unknown> = {
  "nativeBindBlob(JI[B)V": (h: bigint, i: number, b: Int8Array) => {
    bstmt(h).params[i - 1] = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  },
  "nativeBindDouble(JID)V": (h: bigint, i: number, v: number) => { bstmt(h).params[i - 1] = v; },
  "nativeBindLong(JIJ)V": (h: bigint, i: number, v: bigint) => { bstmt(h).params[i - 1] = v; },
  "nativeBindNull(JI)V": (h: bigint, i: number) => { bstmt(h).params[i - 1] = null; },
  "nativeBindText(JILjava/lang/String;)V": (h: bigint, i: number, v: string) => { bstmt(h).params[i - 1] = v; },
  "nativeClearBindings(J)V": (h: bigint) => { const s = bstmt(h); s.params = []; s.bound = false; },
  "nativeStep(J)Z": (h: bigint) => {
    const s = bstmt(h);
    if (!s.bound) {
      if (s.params.length) s.st.bind(s.params.map((p) => p === undefined ? null : p) as never);
      s.bound = true;
    }
    const has = s.st.step();
    s.row = has ? integerRow(s.st) : null;
    if (!has) {
      const head = s.sql.trimStart().slice(0, 8).toUpperCase();
      // txDepth on the JSQLiteDatabase is what gates persistence; every path that opens a
      // transaction on the shared connection has to keep it up to date.
      if (head.startsWith("BEGIN")) { s.conn.tx++; s.conn.jdb.txDepth++; }
      else if (head.startsWith("COMMIT") || head.startsWith("ROLLBACK") || head.startsWith("END")) {
        s.conn.tx = Math.max(0, s.conn.tx - 1);
        s.conn.jdb.txDepth = Math.max(0, s.conn.jdb.txDepth - 1);
      }
      s.conn.jdb.scheduleSave();
    }
    return has ? 1 : 0;
  },
  "nativeReset(J)V": (h: bigint) => { const s = bstmt(h); s.st.reset(); s.bound = false; s.row = null; },
  "nativeClose(J)V": (h: bigint) => { const s = bStmts.get(h); if (s) { try { s.st.free(); } catch { /* */ } bStmts.delete(h); } },
  "nativeGetColumnCount(J)I": (h: bigint) => bstmt(h).names.length,
  "nativeGetColumnName(JI)Ljava/lang/String;": (h: bigint, i: number) => bstmt(h).names[i] ?? "",
  "nativeGetColumnType(JI)I": (h: bigint, i: number) => {
    const v = bstmt(h).row?.[i];
    if (v === null || v === undefined) return 5;
    if (v instanceof Uint8Array) return 4;
    if (typeof v === "string") return 3;
    return typeof v === "bigint" || Number.isInteger(v) ? 1 : 2;
  },
  "nativeGetLong(JI)J": (h: bigint, i: number) => longValue(bstmt(h).row?.[i]),
  "nativeGetDouble(JI)D": (h: bigint, i: number) => Number(bstmt(h).row?.[i] ?? 0),
  "nativeGetText(JI)Ljava/lang/String;": (h: bigint, i: number) => {
    const v = bstmt(h).row?.[i];
    return v === null || v === undefined ? "" : String(v);
  },
  "nativeGetBlob(JI)[B": (h: bigint, i: number) => {
    const v = bstmt(h).row?.[i];
    const u = v instanceof Uint8Array ? v : new Uint8Array(0);
    return new Int8Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.length));
  },
};
for (const [sig, fn] of Object.entries(stJni)) jni("BundledSQLiteStatementKt", sig, fn);
