import { newStringSet } from "../jvm/natives/jutil";
// android.database.* over sql.js (in-memory, persisted to localStorage per db).

import initSqlJs, { type Database, type Statement } from "sql.js";
import { mangleMethod, charsToString } from "../jvm/abi";
import { rt, JObj, type NativeSpec, callSelf } from "../jvm/runtime";
import { vcall, boxInt, box, JLong } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jutil";
import { JBundle } from "./os";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function ensureSql(): Promise<NonNullable<typeof SQL>> {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: (f: string) => "/sqljs/" + f });
  }
  return SQL;
}

function b64(bytes: Uint8Array): string {
  const s = charsToString(bytes, 0, bytes.length);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
function snapshotBytes(sql: NonNullable<typeof SQL>, db: Database): Uint8Array {
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
  saveTimer: ReturnType<typeof setTimeout> | null = null;
  scheduleSave() {
    if (this.readOnly || this.path === ":memory:") return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Mid-transaction the file can hold spilled uncommitted pages whose undo lives in the
      // journal we do not copy; wait for the commit instead of persisting a torn snapshot.
      if (this.txDepth > 0) { this.scheduleSave(); return; }
      if (!SQL || !this.db) return;
      try {
        globalThis.localStorage?.setItem("wd:db:" + this.path, b64(snapshotBytes(SQL, this.db)));
      } catch (e) { console.warn("[sqlite] persist failed", e); }
    }, 400);
  }
}
const dbCache = new Map<string, JSQLiteDatabase>();
const readOnlyCache = new Map<string, JSQLiteDatabase>();
function readOnlyConnection(sql: NonNullable<typeof SQL>, source: Database): Database {
  const db = vfsDb(new sql.Database()), own = db.filename;
  db.filename = vfsDb(source).filename;
  try { db.export(); }
  catch (e) { db.filename = own; db.close(); throw e; }
  finally { db.filename = own; }
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
export async function openDatabase(path: string, flags = 0x10000000): Promise<JSQLiteDatabase> {
  if (!path) throw rt.mkThrowable("java/lang/IllegalArgumentException", "path must not be empty");
  const readOnly = (flags & 1) !== 0;
  const sql = await ensureSql();
  let jdb = dbCache.get(path);
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
  let data: Uint8Array | null = null;
  try {
    const raw = globalThis.localStorage?.getItem("wd:db:" + path);
    if (raw) data = unb64(raw);
  } catch { /* */ }
  if (!data && path !== ":memory:" && !(flags & 0x10000000)) {
    throw rt.mkThrowable("android/database/sqlite/SQLiteCantOpenDatabaseException", "Database does not exist: " + path);
  }
  jdb.db = data ? new sql.Database(data) : new sql.Database();
  jdb.db.exec("PRAGMA user_version");
  dbCache.set(path, jdb);
  return jdb;
}

function bindArgs(args: unknown[] | null): (string | number | Uint8Array | null)[] {
  if (!args) return [];
  return args.map((a) => {
    if (a === null || a === undefined) return null;
    if (typeof a === "bigint") return Number(a);
    if (typeof a === "number" || typeof a === "string") return a;
    if (a instanceof Int8Array) return new Uint8Array(a.buffer, a.byteOffset, a.length);
    if (typeof a === "object" && "v" in (a as object)) {
      const v = (a as { v: unknown }).v;
      return typeof v === "bigint" ? Number(v) : (v as number);
    }
    return String(a);
  });
}

class JCursor extends JObj {
  cols: string[] = [];
  rows: unknown[][] = [];
  pos = -1;
  closed = false;
  colIndex(name: string): number {
    let i = this.cols.indexOf(name);
    if (i < 0) i = this.cols.findIndex((c) => c.toLowerCase() === name?.toLowerCase());
    return i;
  }
  val(i: number): unknown { return this.rows[this.pos]?.[i] ?? null; }
}
/** a cursor over rows already in hand — the one Cursor implementation in the tree */
export function mkCursor(cols: string[], rows: unknown[][]): JCursor {
  rt.link("webdroid/Cursor");
  const c = new JCursor();
  c.cols = cols;
  c.rows = rows;
  return c;
}
function runQuery(jdb: JSQLiteDatabase, sqlStr: string, args: unknown[] | null): JCursor {
  const c = mkCursor([], []);
  try {
    const stmt = jdb.db!.prepare(sqlStr);
    try {
      stmt.bind(bindArgs(args) as never);
      c.cols = stmt.getColumnNames();
      while (stmt.step()) c.rows.push(stmt.get());
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

const cursorMethods: NativeSpec["methods"] = {
  "getCount()I": function (this: JCursor) { return this.rows.length; },
  "getPosition()I": function (this: JCursor) { return this.pos; },
  "moveToFirst()Z": function (this: JCursor) { this.pos = 0; return this.rows.length ? 1 : 0; },
  "moveToLast()Z": function (this: JCursor) { this.pos = this.rows.length - 1; return this.rows.length ? 1 : 0; },
  "moveToNext()Z": function (this: JCursor) {
    this.pos++;
    return this.pos < this.rows.length ? 1 : 0;
  },
  "moveToPrevious()Z": function (this: JCursor) { this.pos--; return this.pos >= 0 ? 1 : 0; },
  "moveToPosition(I)Z": function (this: JCursor, p: number) {
    this.pos = p;
    return p >= 0 && p < this.rows.length ? 1 : 0;
  },
  "isAfterLast()Z": function (this: JCursor) { return this.pos >= this.rows.length ? 1 : 0; },
  "isBeforeFirst()Z": function (this: JCursor) { return this.pos < 0 ? 1 : 0; },
  "isFirst()Z": function (this: JCursor) { return this.pos === 0 ? 1 : 0; },
  "isLast()Z": function (this: JCursor) { return this.pos === this.rows.length - 1 ? 1 : 0; },
  "getColumnIndex(Ljava/lang/String;)I": function (this: JCursor, n: string) { return this.colIndex(n); },
  "getColumnIndexOrThrow(Ljava/lang/String;)I": function (this: JCursor, n: string) {
    const i = this.colIndex(n);
    if (i < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "column '" + n + "' does not exist");
    return i;
  },
  "getColumnName(I)Ljava/lang/String;": function (this: JCursor, i: number) { return this.cols[i] ?? null; },
  "getColumnNames()[Ljava/lang/String;": function (this: JCursor) {
    const a = this.cols.slice();
    (a as any).$t = "Ljava/lang/String;";
    return a;
  },
  "getColumnCount()I": function (this: JCursor) { return this.cols.length; },
  "getString(I)Ljava/lang/String;": function (this: JCursor, i: number) {
    const v = this.val(i);
    return v === null ? null : String(v);
  },
  "getInt(I)I": function (this: JCursor, i: number) { return Math.trunc(Number(this.val(i) ?? 0)) | 0; },
  "getLong(I)J": function (this: JCursor, i: number) {
    const v = this.val(i);
    return typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v ?? 0)));
  },
  "getDouble(I)D": function (this: JCursor, i: number) { return Number(this.val(i) ?? 0); },
  "getFloat(I)F": function (this: JCursor, i: number) { return Math.fround(Number(this.val(i) ?? 0)); },
  "getShort(I)S": function (this: JCursor, i: number) { return (Number(this.val(i) ?? 0) << 16) >> 16; },
  "getBlob(I)[B": function (this: JCursor, i: number) {
    const v = this.val(i);
    if (v instanceof Uint8Array) return new Int8Array(v.buffer, v.byteOffset, v.length);
    return v === null ? null : new Int8Array(0);
  },
  "isNull(I)Z": function (this: JCursor, i: number) { return this.val(i) === null ? 1 : 0; },
  "getType(I)I": function (this: JCursor, i: number) {
    const v = this.val(i);
    if (v === null) return 0;
    if (typeof v === "number") return Number.isInteger(v) ? 1 : 2;
    if (typeof v === "string") return 3;
    return 4;
  },
  "close()V": function (this: JCursor) { this.closed = true; },
  "isClosed()Z": function (this: JCursor) { return this.closed ? 1 : 0; },
  "registerContentObserver(Landroid/database/ContentObserver;)V": () => {},
  "unregisterContentObserver(Landroid/database/ContentObserver;)V": () => {},
  "registerDataSetObserver(Landroid/database/DataSetObserver;)V": () => {},
  "unregisterDataSetObserver(Landroid/database/DataSetObserver;)V": () => {},
  "setNotificationUri(Landroid/content/ContentResolver;Landroid/net/Uri;)V": () => {},
  "getNotificationUri()Landroid/net/Uri;": () => null,
  "getWantsAllOnMoveCalls()Z": () => 0,
  "deactivate()V": () => {},
  "requery()Z": () => 1,
  "getExtras()Landroid/os/Bundle;": () => new JBundle(),
  "respond(Landroid/os/Bundle;)Landroid/os/Bundle;": () => new JBundle(),
};
rt.register({ name: "android/database/Cursor", ctor: class extends JObj {} });
rt.register({ name: "webdroid/Cursor", ctor: JCursor, ifaces: ["android/database/Cursor", "java/io/Closeable"], methods: cursorMethods });

class JContentValues extends JObj {
  map = new Map<string, unknown>();
}
rt.register({
  name: "android/content/ContentValues", ctor: JContentValues, ifaces: ["android/os/Parcelable"],
  methods: (() => {
    const m: NativeSpec["methods"] = {
      "<init>()V": function () {},
      "<init>(Landroid/content/ContentValues;)V": function (this: JContentValues, o: JContentValues) {
        if (o) this.map = new Map(o.map);
      },
      "putNull(Ljava/lang/String;)V": function (this: JContentValues, k: string) { this.map.set(k, null); },
      "size()I": function (this: JContentValues) { return this.map.size; },
      "containsKey(Ljava/lang/String;)Z": function (this: JContentValues, k: string) { return this.map.has(k) ? 1 : 0; },
      "remove(Ljava/lang/String;)V": function (this: JContentValues, k: string) { this.map.delete(k); },
      "clear()V": function (this: JContentValues) { this.map.clear(); },
      "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JContentValues, k: string) { return this.map.get(k) ?? null; },
      "keySet()Ljava/util/Set;": function (this: JContentValues) {
        return newStringSet(this.map.keys());
      },
      "getAsString(Ljava/lang/String;)Ljava/lang/String;": function (this: JContentValues, k: string) {
        const v = this.map.get(k);
        return v === null || v === undefined ? null : String(unbox(v));
      },
      "getAsLong(Ljava/lang/String;)Ljava/lang/Long;": function (this: JContentValues, k: string) {
        const v = unbox(this.map.get(k));
        if (v === null || v === undefined) return null;
        return box(JLong, typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))));
      },
      "getAsInteger(Ljava/lang/String;)Ljava/lang/Integer;": async function (this: JContentValues, k: string) {
        const v = unbox(this.map.get(k));
        if (v === null || v === undefined) return null;
        return boxInt(Math.trunc(Number(v)) | 0);
      },
    };
    for (const t of ["Ljava/lang/String;", "Ljava/lang/Byte;", "Ljava/lang/Short;", "Ljava/lang/Integer;", "Ljava/lang/Long;",
      "Ljava/lang/Float;", "Ljava/lang/Double;", "Ljava/lang/Boolean;", "[B"]) {
      m[`put(Ljava/lang/String;${t})V`] = function (this: JContentValues, k: string, v: unknown) { this.map.set(k, v); };
    }
    return m;
  })(),
});
function unbox(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "v" in (v as object)) return (v as { v: unknown }).v;
  return v;
}

const dbMethods: NonNullable<NativeSpec["methods"]> = {
  "static openDatabase(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)Landroid/database/sqlite/SQLiteDatabase;":
    async (path: string, _factory: unknown, flags: number) => openDatabase(path, flags),
  "static openDatabase(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;ILandroid/database/DatabaseErrorHandler;)Landroid/database/sqlite/SQLiteDatabase;":
    async (path: string, _factory: unknown, flags: number, _errorHandler: unknown) => openDatabase(path, flags),
  "execSQL(Ljava/lang/String;)V": function (this: JSQLiteDatabase, sql: string) {
    try { this.db!.exec(sql); } catch (e) { throw sqliteExc(String(e), sql); }
    this.scheduleSave();
  },
  "execSQL(Ljava/lang/String;[Ljava/lang/Object;)V": function (this: JSQLiteDatabase, sql: string, args: unknown[]) {
    try { this.db!.run(sql, bindArgs(args) as never); } catch (e) { throw sqliteExc(String(e), sql); }
    this.scheduleSave();
  },
  "rawQueryWithFactory(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    function (this: JSQLiteDatabase, _f: unknown, sql: string, args: unknown[] | null) {
      return (this as any)[mangleMethod("rawQuery", "(Ljava/lang/String;[Ljava/lang/String;)Landroid/database/Cursor;")](sql, args);
    },
  "setMaxSqlCacheSize(I)V": () => {},
  "isWriteAheadLoggingEnabled()Z": () => 0,
  "rawQuery(Ljava/lang/String;[Ljava/lang/String;)Landroid/database/Cursor;": function (this: JSQLiteDatabase, sql: string, args: unknown[] | null) {
    return runQuery(this, sql, args);
  },
  "query(Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    function (this: JSQLiteDatabase, table: string, cols: string[] | null, sel: string | null, selArgs: unknown[] | null, groupBy: string | null, having: string | null, orderBy: string | null) {
      const sql = buildQuery(table, cols, sel, groupBy, having, orderBy, null);
      return runQuery(this, sql, selArgs);
    },
  "query(Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    function (this: JSQLiteDatabase, table: string, cols: string[] | null, sel: string | null, selArgs: unknown[] | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null) {
      const sql = buildQuery(table, cols, sel, groupBy, having, orderBy, limit);
      return runQuery(this, sql, selArgs);
    },
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
  "update(Ljava/lang/String;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I":
    function (this: JSQLiteDatabase, table: string, cv: JContentValues, where: string | null, args: unknown[] | null) {
      const sets = [...cv.map.keys()].map((k) => `"${k}"=?`).join(",");
      const sql = `UPDATE "${table}" SET ${sets}${where ? " WHERE " + where : ""}`;
      const vals = [...cv.map.values()].map(unbox);
      try {
        this.db!.run(sql, bindArgs([...vals, ...(args ?? [])]) as never);
      } catch (e) { throw sqliteExc(String(e), sql); }
      this.scheduleSave();
      return this.db!.getRowsModified();
    },
  "delete(Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)I":
    function (this: JSQLiteDatabase, table: string, where: string | null, args: unknown[] | null) {
      const sql = `DELETE FROM "${table}"${where ? " WHERE " + where : ""}`;
      try { this.db!.run(sql, bindArgs(args ?? []) as never); } catch (e) { throw sqliteExc(String(e), sql); }
      this.scheduleSave();
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
  "setTransactionSuccessful()V": function (this: JSQLiteDatabase) { this.txOk = true; },
  "endTransaction()V": function (this: JSQLiteDatabase) {
    this.txDepth--;
    if (this.txDepth <= 0) {
      this.txDepth = 0;
      try { this.db!.exec(this.txOk ? "COMMIT" : "ROLLBACK"); } catch { /* */ }
      this.scheduleSave();
    }
  },
  "inTransaction()Z": function (this: JSQLiteDatabase) { return this.txDepth > 0 ? 1 : 0; },
  "isOpen()Z": function (this: JSQLiteDatabase) { return this.open ? 1 : 0; },
  "close()V": function (this: JSQLiteDatabase) {
    if (this.readOnly) { if (this.open) this.db!.close(); this.open = false; }
    else this.scheduleSave();
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
  "getAttachedDbs()Ljava/util/List;": function (this: JSQLiteDatabase) {
    const p = new (rt.link("android/util/Pair").ctor)();
    p.first = "main"; p.second = this.path;
    return newArrayList([p]);
  },
  "isReadOnly()Z": function (this: JSQLiteDatabase) { return this.readOnly ? 1 : 0; },
  "isDbLockedByCurrentThread()Z": () => 0,
  "setForeignKeyConstraintsEnabled(Z)V": function (this: JSQLiteDatabase, on: number) {
    this.db!.exec("PRAGMA foreign_keys = " + (on ? "ON" : "OFF"));
  },
  "enableWriteAheadLogging()Z": () => 0,
  "disableWriteAheadLogging()V": () => {},
  "setLocale(Ljava/util/Locale;)V": () => {},
  "setMaximumSize(J)J": (v: bigint) => v,
  "compileStatement(Ljava/lang/String;)Landroid/database/sqlite/SQLiteStatement;": function (this: JSQLiteDatabase, sql: string) {
    rt.link("android/database/sqlite/SQLiteStatement");
    const st = new JSQLiteStatement();
    st.jdb = this;
    st.sql = sql;
    return st;
  },
  "yieldIfContendedSafely()Z": () => 0,
  "static releaseMemory()I": () => 0,
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
  const keys = [...cv.map.keys()];
  const sql = keys.length
    ? `INSERT${or} INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`
    : `INSERT${or} INTO "${table}" DEFAULT VALUES`;
  try {
    jdb.db!.run(sql, bindArgs([...cv.map.values()].map(unbox)) as never);
  } catch (e) {
    if (doThrow) throw sqliteExc(String(e), sql);
    console.warn("[sqlite insert]", e);
    return -1n;
  }
  jdb.scheduleSave();
  const r = jdb.db!.exec("SELECT last_insert_rowid()");
  return BigInt(Number(r[0]?.values[0]?.[0] ?? -1));
}
class JSQLiteStatement extends JObj {
  jdb: JSQLiteDatabase | null = null;
  sql = "";
  binds: unknown[] = [];
}
rt.register({
  name: "android/database/sqlite/SQLiteStatement", ctor: JSQLiteStatement,
  methods: {
    "bindString(ILjava/lang/String;)V": function (this: JSQLiteStatement, i: number, v: string) { this.binds[i - 1] = v; },
    "bindLong(IJ)V": function (this: JSQLiteStatement, i: number, v: bigint) { this.binds[i - 1] = v; },
    "bindDouble(ID)V": function (this: JSQLiteStatement, i: number, v: number) { this.binds[i - 1] = v; },
    "bindNull(I)V": function (this: JSQLiteStatement, i: number) { this.binds[i - 1] = null; },
    "bindBlob(I[B)V": function (this: JSQLiteStatement, i: number, v: Int8Array) { this.binds[i - 1] = v; },
    "clearBindings()V": function (this: JSQLiteStatement) { this.binds = []; },
    "execute()V": function (this: JSQLiteStatement) {
      try { this.jdb!.db!.run(this.sql, bindArgs(this.binds) as never); } catch (e) { throw sqliteExc(String(e), this.sql); }
      this.jdb!.scheduleSave();
    },
    "executeInsert()J": function (this: JSQLiteStatement) {
      try { this.jdb!.db!.run(this.sql, bindArgs(this.binds) as never); } catch (e) { throw sqliteExc(String(e), this.sql); }
      this.jdb!.scheduleSave();
      const r = this.jdb!.db!.exec("SELECT last_insert_rowid()");
      return BigInt(Number(r[0]?.values[0]?.[0] ?? -1));
    },
    "executeUpdateDelete()I": function (this: JSQLiteStatement) {
      try { this.jdb!.db!.run(this.sql, bindArgs(this.binds) as never); } catch (e) { throw sqliteExc(String(e), this.sql); }
      this.jdb!.scheduleSave();
      return this.jdb!.db!.getRowsModified();
    },
    "simpleQueryForLong()J": function (this: JSQLiteStatement) {
      const c = runQuery(this.jdb!, this.sql, this.binds);
      return c.rows.length ? BigInt(Math.trunc(Number(c.rows[0][0] ?? 0))) : 0n;
    },
    "simpleQueryForString()Ljava/lang/String;": function (this: JSQLiteStatement) {
      const c = runQuery(this.jdb!, this.sql, this.binds);
      return c.rows.length ? String(c.rows[0][0] ?? "") : null;
    },
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
rt.register({ name: "android/database/sqlite/SQLiteDatabase$CursorFactory", ctor: class extends JObj {} });
rt.register({ name: "android/database/ContentObserver", ctor: class extends JObj {},
  methods: { "<init>(Landroid/os/Handler;)V": function () {} } });
rt.register({ name: "android/database/DataSetObserver", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
rt.register({
  name: "android/database/DatabaseUtils", ctor: class extends JObj {},
  methods: {
    "static queryNumEntries(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;)J": (db: JSQLiteDatabase, table: string) => {
      const c = runQuery(db, `SELECT COUNT(*) FROM "${table}"`, null);
      return BigInt(Number(c.rows[0]?.[0] ?? 0));
    },
    "static longForQuery(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)J":
      (db: JSQLiteDatabase, sql: string, args: unknown[]) => {
        const c = runQuery(db, sql, args);
        return BigInt(Math.trunc(Number(c.rows[0]?.[0] ?? 0)));
      },
    "static stringForQuery(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)Ljava/lang/String;":
      (db: JSQLiteDatabase, sql: string, args: unknown[]) => {
        const c = runQuery(db, sql, args);
        return c.rows.length ? String(c.rows[0][0] ?? "") : null;
      },
  },
});

// SQLiteOpenHelper: version migration flow
class JSQLiteOpenHelper extends JObj {
  jctx: any = null;
  name: string | null = null;
  version = 1;
  jdb: JSQLiteDatabase | null = null;
  opening = false;
}
rt.register({
  name: "android/database/sqlite/SQLiteOpenHelper", ctor: JSQLiteOpenHelper,
  methods: {
    "<init>(Landroid/content/Context;Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)V":
      function (this: JSQLiteOpenHelper, ctx: unknown, name: string | null, cf: unknown, version: number) {
        this.jctx = ctx;
        this.name = name;
        this.version = version;
      },
    "<init>(Landroid/content/Context;Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;ILandroid/database/DatabaseErrorHandler;)V":
      function (this: JSQLiteOpenHelper, ctx: unknown, name: string | null, cf: unknown, version: number) {
        this.jctx = ctx;
        this.name = name;
        this.version = version;
      },
    "getWritableDatabase()Landroid/database/sqlite/SQLiteDatabase;": async function (this: JSQLiteOpenHelper) {
      return openHelperDb(this);
    },
    "getReadableDatabase()Landroid/database/sqlite/SQLiteDatabase;": async function (this: JSQLiteOpenHelper) {
      return openHelperDb(this);
    },
    "getDatabaseName()Ljava/lang/String;": function (this: JSQLiteOpenHelper) { return this.name; },
    "onCreate(Landroid/database/sqlite/SQLiteDatabase;)V": function () {},
    "onUpgrade(Landroid/database/sqlite/SQLiteDatabase;II)V": function () {},
    "onDowngrade(Landroid/database/sqlite/SQLiteDatabase;II)V": function () {},
    "onOpen(Landroid/database/sqlite/SQLiteDatabase;)V": function () {},
    "onConfigure(Landroid/database/sqlite/SQLiteDatabase;)V": function () {},
    "close()V": function (this: JSQLiteOpenHelper) { this.jdb?.scheduleSave(); },
    "setWriteAheadLoggingEnabled(Z)V": () => {},
  },
});
async function openHelperDb(h: JSQLiteOpenHelper): Promise<JSQLiteDatabase> {
  if (h.jdb) return h.jdb;
  const pkg = h.jctx?.$host?.pkg ?? "app";
  const path = h.name ? dbPath(pkg, h.name) : ":memory:";
  const jdb = await openDatabase(path);
  h.jdb = jdb;
  await vcall(h, "onConfigure", "(Landroid/database/sqlite/SQLiteDatabase;)V", jdb);
  const cur = callSelf(dbMethods, "getVersion()I", jdb) as number;
  if (cur !== h.version) {
    callSelf(dbMethods, "beginTransaction()V", jdb);
    try {
      if (cur === 0) await vcall(h, "onCreate", "(Landroid/database/sqlite/SQLiteDatabase;)V", jdb);
      else if (cur < h.version) await vcall(h, "onUpgrade", "(Landroid/database/sqlite/SQLiteDatabase;II)V", jdb, cur, h.version);
      else await vcall(h, "onDowngrade", "(Landroid/database/sqlite/SQLiteDatabase;II)V", jdb, cur, h.version);
      callSelf(dbMethods, "setVersion(I)V", jdb, h.version);
      callSelf(dbMethods, "setTransactionSuccessful()V", jdb);
    } finally {
      callSelf(dbMethods, "endTransaction()V", jdb);
    }
  }
  await vcall(h, "onOpen", "(Landroid/database/sqlite/SQLiteDatabase;)V", jdb);
  return jdb;
}
rt.register({ name: "android/database/DatabaseErrorHandler", ctor: class extends JObj {} });

// ── androidx.sqlite bundled driver (libsqliteJni) over sql.js. Mihon's SQLDelight/Room
// stack drives the DB through these statics; handles are opaque bigints.
interface BStmt {
  st: import("sql.js").Statement;
  sql: string;
  conn: BConn;
  params: (string | number | Uint8Array | null)[];
  bound: boolean;
  row: unknown[] | null;
  names: string[];
}
interface BConn { jdb: JSQLiteDatabase; tx: number; }
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
jni("BundledSQLiteDriverKt", "nativeOpen(Ljava/lang/String;I)J", (async (name: string) => {
  const jdb = await openDatabase(name && name !== ":memory:" ? name : ":memory:");
  const h = nextHandle++;
  bConns.set(h, { jdb, tx: 0 });
  return h;
}) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativePrepare(JLjava/lang/String;)J", ((db: bigint, sql: string) => {
  const conn = bConns.get(db);
  if (!conn?.jdb.db) throw rt.mkThrowable("android/database/sqlite/SQLiteException", "connection closed");
  const st = conn.jdb.db.prepare(sql);
  const h = nextHandle++;
  bStmts.set(h, { st, sql, conn, params: [], bound: false, row: null, names: st.getColumnNames() });
  return h;
}) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativeClose(J)V", ((db: bigint) => { bConns.delete(db); }) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativeInTransaction(J)Z", ((db: bigint) => (bConns.get(db)?.tx ? 1 : 0)) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativeLoadExtension(JLjava/lang/String;Ljava/lang/String;)V", (() => {
  throw rt.mkThrowable("android/database/sqlite/SQLiteException", "extensions unsupported");
}) as (...a: never[]) => unknown);
const stJni: Record<string, (...a: never[]) => unknown> = {
  "nativeBindBlob(JI[B)V": ((h: bigint, i: number, b: Int8Array) => {
    bstmt(h).params[i - 1] = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  }) as (...a: never[]) => unknown,
  "nativeBindDouble(JID)V": ((h: bigint, i: number, v: number) => { bstmt(h).params[i - 1] = v; }) as (...a: never[]) => unknown,
  "nativeBindLong(JIJ)V": ((h: bigint, i: number, v: bigint) => { bstmt(h).params[i - 1] = Number(v); }) as (...a: never[]) => unknown,
  "nativeBindNull(JI)V": ((h: bigint, i: number) => { bstmt(h).params[i - 1] = null; }) as (...a: never[]) => unknown,
  "nativeBindText(JILjava/lang/String;)V": ((h: bigint, i: number, v: string) => { bstmt(h).params[i - 1] = v; }) as (...a: never[]) => unknown,
  "nativeClearBindings(J)V": ((h: bigint) => { const s = bstmt(h); s.params = []; s.bound = false; }) as (...a: never[]) => unknown,
  "nativeStep(J)Z": ((h: bigint) => {
    const s = bstmt(h);
    if (!s.bound) {
      if (s.params.length) s.st.bind(s.params.map((p) => p === undefined ? null : p));
      s.bound = true;
    }
    const has = s.st.step();
    s.row = has ? s.st.get() : null;
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
  }) as (...a: never[]) => unknown,
  "nativeReset(J)V": ((h: bigint) => { const s = bstmt(h); s.st.reset(); s.bound = false; s.row = null; }) as (...a: never[]) => unknown,
  "nativeClose(J)V": ((h: bigint) => { const s = bStmts.get(h); if (s) { try { s.st.free(); } catch { /* */ } bStmts.delete(h); } }) as (...a: never[]) => unknown,
  "nativeGetColumnCount(J)I": ((h: bigint) => bstmt(h).names.length) as (...a: never[]) => unknown,
  "nativeGetColumnName(JI)Ljava/lang/String;": ((h: bigint, i: number) => bstmt(h).names[i] ?? "") as (...a: never[]) => unknown,
  "nativeGetColumnType(JI)I": ((h: bigint, i: number) => {
    const v = bstmt(h).row?.[i];
    if (v === null || v === undefined) return 5;
    if (v instanceof Uint8Array) return 4;
    if (typeof v === "string") return 3;
    return Number.isInteger(v) ? 1 : 2;
  }) as (...a: never[]) => unknown,
  "nativeGetLong(JI)J": ((h: bigint, i: number) => BigInt(Math.trunc(Number(bstmt(h).row?.[i] ?? 0)))) as (...a: never[]) => unknown,
  "nativeGetDouble(JI)D": ((h: bigint, i: number) => Number(bstmt(h).row?.[i] ?? 0)) as (...a: never[]) => unknown,
  "nativeGetText(JI)Ljava/lang/String;": ((h: bigint, i: number) => {
    const v = bstmt(h).row?.[i];
    return v === null || v === undefined ? "" : String(v);
  }) as (...a: never[]) => unknown,
  "nativeGetBlob(JI)[B": ((h: bigint, i: number) => {
    const v = bstmt(h).row?.[i];
    const u = v instanceof Uint8Array ? v : new Uint8Array(0);
    return new Int8Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.length));
  }) as (...a: never[]) => unknown,
};
for (const [sig, fn] of Object.entries(stJni)) jni("BundledSQLiteStatementKt", sig, fn);
