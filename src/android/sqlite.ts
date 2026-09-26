import { JMap } from "../jvm/natives/jutil";
// android.database.* over sql.js, with snapshots in the shared private-file store.

import initSqlJs, { type Database, type Statement } from "sql.js";
import { i8, u8 } from "../jvm/abi";
import { vfs } from "../jvm/natives/jio";
import { rt, JObj, type NativeSpec, callSelf, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { vcall, vcallOn, callOn, curThread, type JThread, boxInt, box, JLong, JBool } from "../jvm/natives/jlang";
import { newArrayList, toJsArray } from "../jvm/natives/jutil";
import { csText } from "../jvm/natives/jchars";
import { JBundle } from "./os";

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
  scheduleSave() {
    if (this.readOnly || this.path === ":memory:") return;
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
        }
        else this.scheduleSave();
      } catch (e) {
        if (e instanceof Error && e.message.includes("locked")) this.scheduleSave();
        else console.warn("[sqlite] persist failed", e);
      }
    }, 400);
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
  let data = vfs.read(path);
  let legacy = false;
  const shared = path === ":memory:" ? undefined : sqliteStore.files.get(path);
  try {
    const raw = !data && globalThis.localStorage?.getItem("wd:db:" + path);
    if (raw) { data = unb64(raw); legacy = true; }
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
    file.transactions.add(() => connection.txDepth > 0);
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
  val(i: number): unknown { return unbox(this.rows[this.pos]?.[i] ?? null); }
}
/** a cursor over rows already in hand — the one Cursor implementation in the tree */
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
    return longValue(v);
  },
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
    if (typeof v === "number") return typeof v === "bigint" || Number.isInteger(v) ? 1 : 2;
    if (typeof v === "string") return 3;
    return 4;
  },
  "close()V": function (this: JCursor) { this.closed = true; },
  "isClosed()Z": function (this: JCursor) { return this.closed ? 1 : 0; },
  ...noops("registerContentObserver(Landroid/database/ContentObserver;)V",
    "unregisterContentObserver(Landroid/database/ContentObserver;)V",
    "registerDataSetObserver(Landroid/database/DataSetObserver;)V",
    "unregisterDataSetObserver(Landroid/database/DataSetObserver;)V",
    "setNotificationUri(Landroid/content/ContentResolver;Landroid/net/Uri;)V", "deactivate()V"),
  ...stubs(null, "getNotificationUri()Landroid/net/Uri;"),
  ...stubs(0, "getWantsAllOnMoveCalls()Z"),
  ...stubs(1, "requery()Z"),
  "getExtras()Landroid/os/Bundle;": () => new JBundle(),
  "respond(Landroid/os/Bundle;)Landroid/os/Bundle;": () => new JBundle(),
};
rt.register({ name: "android/database/Cursor", ctor: class extends JObj {}, ifaces: ["java/io/Closeable"] });
// CharArrayBuffer: the caller's reusable char[] a text column is copied into, grown when it is short
class JCharArrayBuffer extends JObj { data: Uint16Array = new Uint16Array(0); sizeCopied = 0; }
rt.register({
  name: "android/database/CharArrayBuffer", ctor: JCharArrayBuffer, fields: ["data", "sizeCopied"],
  methods: {
    "<init>(I)V": function (this: JCharArrayBuffer, n: number) { this.data = new Uint16Array(n); },
    "<init>([C)V": function (this: JCharArrayBuffer, chars: Uint16Array) { this.data = chars; },
  },
});
cursorMethods["copyStringToBuffer(ILandroid/database/CharArrayBuffer;)V"] = driven(function* (this: JCursor, i: number, buffer: JCharArrayBuffer): Gen {
  const text = (yield callSelf(cursorMethods, "getString(I)Ljava/lang/String;", this, i)) as string | null;
  if (text === null) { buffer.sizeCopied = 0; return; }
  if (buffer.data.length < text.length) buffer.data = new Uint16Array(text.length);
  for (let k = 0; k < text.length; k++) buffer.data[k] = text.charCodeAt(k);
  buffer.sizeCopied = text.length;
});
rt.register({ name: "webdroid/Cursor", ctor: JCursor, ifaces: ["android/database/Cursor"], methods: cursorMethods });
class JCursorWrapper extends JObj { cursor: unknown = null; }
const cursorWrapperMethods: NativeSpec["methods"] = {};
for (const signature of Object.keys(cursorMethods)) {
  const split = signature.indexOf("(");
  const name = signature.slice(0, split), descriptor = signature.slice(split);
  cursorWrapperMethods[signature] = function (this: JCursorWrapper, ...args: unknown[]) {
    return vcall(this.cursor, name, descriptor, ...args);
  };
}
rt.register({ name: "android/database/CursorWrapper", ctor: JCursorWrapper, ifaces: ["android/database/Cursor"], methods: {
  ...cursorWrapperMethods,
  "<init>(Landroid/database/Cursor;)V": function (this: JCursorWrapper, cursor: unknown) {
    if (!cursor) rt.npe();
    this.cursor = cursor;
  },
  "getWrappedCursor()Landroid/database/Cursor;": function (this: JCursorWrapper) { return this.cursor; },
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
rt.register({ name: "android/database/MatrixCursor", ctor: class extends JCursor {}, ifaces: ["android/database/Cursor"], methods: {
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
      "containsKey(Ljava/lang/String;)Z": function (this: JContentValues, k: string) { return this.data.m.has(k) ? 1 : 0; },
      "remove(Ljava/lang/String;)V": function (this: JContentValues, k: string) { this.data.m.delete(k); },
      "clear()V": function (this: JContentValues) { this.data.m.clear(); },
      "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JContentValues, k: string) { return this.data.m.get(k)?.v ?? null; },
      "keySet()Ljava/util/Set;": function (this: JContentValues) { return vcall(this.data, "keySet", "()Ljava/util/Set;"); },
      "valueSet()Ljava/util/Set;": function (this: JContentValues) { return vcall(this.data, "entrySet", "()Ljava/util/Set;"); },
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
        return box(JLong, typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))));
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

const dbMethods: NonNullable<NativeSpec["methods"]> = {
  "static create(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase;": () => openDatabase(":memory:"),
  "static openDatabase(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;I)Landroid/database/sqlite/SQLiteDatabase;":
    function (path: string, _factory: unknown, flags: number) { return openDatabase(path, flags); },
  "static openDatabase(Ljava/lang/String;Landroid/database/sqlite/SQLiteDatabase$CursorFactory;ILandroid/database/DatabaseErrorHandler;)Landroid/database/sqlite/SQLiteDatabase;":
    function (path: string, _factory: unknown, flags: number, _errorHandler: unknown) { return openDatabase(path, flags); },
  "execSQL(Ljava/lang/String;)V": function (this: JSQLiteDatabase, sql: string) {
    try { this.db!.exec(sql); } catch (e) { throw sqliteExc(String(e), sql); }
    this.scheduleSave();
  },
  "execSQL(Ljava/lang/String;[Ljava/lang/Object;)V": function (this: JSQLiteDatabase, sql: string, args: unknown[]) {
    try { this.db!.run(sql, bindArgs(args) as never); } catch (e) { throw sqliteExc(String(e), sql); }
    this.scheduleSave();
  },
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
  "replaceOrThrow(Ljava/lang/String;Ljava/lang/String;Landroid/content/ContentValues;)J":
    function (this: JSQLiteDatabase, table: string, nullCol: string | null, cv: JContentValues) {
      return doInsert(this, table, cv, " OR REPLACE", true);
    },
  "update(Ljava/lang/String;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I":
    function (this: JSQLiteDatabase, table: string, cv: JContentValues, where: string | null, args: unknown[] | null) {
      const sets = [...cv.data.m.keys()].map((k) => `"${k}"=?`).join(",");
      const sql = `UPDATE "${table}" SET ${sets}${where ? " WHERE " + where : ""}`;
      const vals = [...cv.data.m.values()].map((e) => unbox(e.v));
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
    const p = rt.make("android/util/Pair");
    p.first = "main"; p.second = this.path;
    return newArrayList([p]);
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
  ...noops("setMaxSqlCacheSize(I)V", "disableWriteAheadLogging()V", "setLocale(Ljava/util/Locale;)V", "setLockingEnabled(Z)V"),
  ...stubs(0, "isWriteAheadLoggingEnabled()Z", "isDbLockedByCurrentThread()Z", "enableWriteAheadLogging()Z",
    "yieldIfContendedSafely()Z", "static releaseMemory()I"),
};
function buildQuery(table: string, cols: string[] | null, sel: string | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null, distinct = false, rawTable = false): string {
  const c = cols?.length ? cols.join(",") : "*";
  let sql = `SELECT ${distinct ? "DISTINCT " : ""}${c} FROM ${rawTable ? table : `"${table}"`}`;
  if (sel) sql += " WHERE " + sel;
  if (groupBy) sql += " GROUP BY " + groupBy;
  if (having) sql += " HAVING " + having;
  if (orderBy) sql += " ORDER BY " + orderBy;
  if (limit) sql += " LIMIT " + limit;
  return sql;
}

function queryBuilderEditTable(tables: string | null): string {
  if (!tables) return rt.npe();
  return tables.split(/[\s,]/, 1)[0];
}
class JSQLiteQueryBuilder extends JObj {
  tables: string | null = null;
  projectionMap: unknown = null;
  where = "";
  distinct = false;

  async projection(columns: string[] | null): Promise<string[] | null> {
    const map = this.projectionMap;
    if (!map) return columns;
    if (columns?.length) {
      const result: string[] = [];
      for (const column of columns) {
        const mapped = await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", column);
        if (mapped !== null) result.push(String(mapped));
        else if (/\sAS\s/i.test(column)) result.push(column);
        else throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid column " + column);
      }
      return result;
    }
    const entries = await toJsArray(await vcall(map, "entrySet", "()Ljava/util/Set;"));
    const result: string[] = [];
    for (const entry of entries) {
      if (await vcall(entry, "getKey", "()Ljava/lang/Object;") === "_count") continue;
      result.push(String(await vcall(entry, "getValue", "()Ljava/lang/Object;")));
    }
    return result;
  }

  async sql(columns: string[] | null, selection: string | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null): Promise<string> {
    const where = [this.where && `(${this.where})`, selection && `(${selection})`].filter(Boolean).join(" AND ") || null;
    return buildQuery(this.tables ?? "", await this.projection(columns), where, groupBy, having, orderBy, limit, this.distinct, true);
  }
}

rt.register({ name: "android/database/sqlite/SQLiteQueryBuilder", ctor: JSQLiteQueryBuilder, methods: {
  "<init>()V": () => {},
  "setTables(Ljava/lang/String;)V": function (this: JSQLiteQueryBuilder, tables: string | null) { this.tables = tables; },
  "getTables()Ljava/lang/String;": function (this: JSQLiteQueryBuilder) { return this.tables; },
  "setProjectionMap(Ljava/util/Map;)V": function (this: JSQLiteQueryBuilder, map: unknown) { this.projectionMap = map; },
  "getProjectionMap()Ljava/util/Map;": function (this: JSQLiteQueryBuilder) { return this.projectionMap; },
  "setDistinct(Z)V": function (this: JSQLiteQueryBuilder, distinct: number) { this.distinct = !!distinct; },
  "isDistinct()Z": function (this: JSQLiteQueryBuilder) { return +this.distinct; },
  "appendWhere(Ljava/lang/CharSequence;)V": driven(function* (this: JSQLiteQueryBuilder, where: unknown): Gen { this.where += (yield csText(where)); }),
  "appendWhereStandalone(Ljava/lang/CharSequence;)V": driven(function* (this: JSQLiteQueryBuilder, where: unknown): Gen {
    this.where += (this.where ? " AND " : "") + `(${(yield csText(where))})`;
  }),
  "appendWhereEscapeString(Ljava/lang/String;)V": function (this: JSQLiteQueryBuilder, where: string) {
    this.where += "'" + where.replaceAll("'", "''") + "'";
  },
  "buildQuery([Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;":
    function (this: JSQLiteQueryBuilder, cols: string[] | null, sel: string | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null) {
      return this.sql(cols, sel, groupBy, having, orderBy, limit);
    },
  "query(Landroid/database/sqlite/SQLiteDatabase;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    driven(function* (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, cols: string[] | null, sel: string | null, args: string[] | null, groupBy: string | null, having: string | null, orderBy: string | null): Gen {
      return this.tables === null ? null : runQuery(db, (yield this.sql(cols, sel, groupBy, having, orderBy, null)), args);
    }),
  "query(Landroid/database/sqlite/SQLiteDatabase;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    driven(function* (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, cols: string[] | null, sel: string | null, args: string[] | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null): Gen {
      return this.tables === null ? null : runQuery(db, (yield this.sql(cols, sel, groupBy, having, orderBy, limit)), args);
    }),
  "update(Landroid/database/sqlite/SQLiteDatabase;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I":
    function (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, values: JContentValues, selection: string | null, args: string[] | null) {
      if (!values) rt.npe();
      const where = [this.where && `(${this.where})`, selection && `(${selection})`].filter(Boolean).join(" AND ") || null;
      return callSelf(dbMethods, "update(Ljava/lang/String;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I", db, queryBuilderEditTable(this.tables), values, where, args);
    },
  "delete(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)I":
    function (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, selection: string | null, args: string[] | null) {
      const where = [this.where && `(${this.where})`, selection && `(${selection})`].filter(Boolean).join(" AND ") || null;
      return callSelf(dbMethods, "delete(Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)I", db, queryBuilderEditTable(this.tables), where, args);
    },
} });
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
  return longValue(runQuery(jdb, "SELECT last_insert_rowid()", null).rows[0]?.[0] ?? -1);
}
class JSQLiteProgram extends JObj {
  jdb: JSQLiteDatabase | null = null;
  sql = "";
  binds: unknown[] = [];
}
rt.register({
  name: "android/database/sqlite/SQLiteProgram", ctor: JSQLiteProgram, ifaces: ["java/io/Closeable"],
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
    "execute()V": function (this: JSQLiteStatement) {
      try { this.jdb!.db!.run(this.sql, bindArgs(this.binds) as never); } catch (e) { throw sqliteExc(String(e), this.sql); }
      this.jdb!.scheduleSave();
    },
    "executeInsert()J": function (this: JSQLiteStatement) {
      try { this.jdb!.db!.run(this.sql, bindArgs(this.binds) as never); } catch (e) { throw sqliteExc(String(e), this.sql); }
      this.jdb!.scheduleSave();
      return longValue(runQuery(this.jdb!, "SELECT last_insert_rowid()", null).rows[0]?.[0] ?? -1);
    },
    "executeUpdateDelete()I": function (this: JSQLiteStatement) {
      try { this.jdb!.db!.run(this.sql, bindArgs(this.binds) as never); } catch (e) { throw sqliteExc(String(e), this.sql); }
      this.jdb!.scheduleSave();
      return this.jdb!.db!.getRowsModified();
    },
    "simpleQueryForLong()J": function (this: JSQLiteStatement) {
      const c = runQuery(this.jdb!, this.sql, this.binds);
      return c.rows.length ? longValue(c.rows[0][0]) : 0n;
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
rt.markers("android/database/sqlite/SQLiteDatabase$CursorFactory");
rt.register({ name: "android/database/ContentObserver", ctor: class extends JObj {},
  methods: {
    "<init>(Landroid/os/Handler;)V": function () {},
    "deliverSelfNotifications()Z": () => 0,
    "onChange(Z)V": () => {},
    "onChange(ZLandroid/net/Uri;)V": function (this: JObj, self: number) { return vcall(this, "onChange", "(Z)V", self); },
  } });
rt.register({ name: "android/database/DataSetObserver", ctor: class extends JObj {}, methods: { ...noops("<init>()V", "onChanged()V", "onInvalidated()V") } });
rt.register({
  name: "android/database/DatabaseUtils", ctor: class extends JObj {},
  methods: {
    "static appendEscapedSQLString(Ljava/lang/StringBuilder;Ljava/lang/String;)V": (builder: { s: string } | null, value: string | null) => {
      if (!builder) return rt.npe();
      builder.s += "'" + String(value).replaceAll("'", "''") + "'";
    },
    "static sqlEscapeString(Ljava/lang/String;)Ljava/lang/String;": (value: string | null) => "'" + String(value).replaceAll("'", "''") + "'",
    "static queryNumEntries(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;)J": (db: JSQLiteDatabase, table: string) => {
      const c = runQuery(db, `SELECT COUNT(*) FROM "${table}"`, null);
      return longValue(c.rows[0]?.[0]);
    },
    "static queryNumEntries(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)J": (db: JSQLiteDatabase, table: string, where: string | null, args: unknown[]) => {
      const c = runQuery(db, `SELECT COUNT(*) FROM "${table}"` + (where ? " WHERE " + where : ""), args);
      return longValue(c.rows[0]?.[0]);
    },
    "static longForQuery(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)J":
      (db: JSQLiteDatabase, sql: string, args: unknown[]) => {
        const c = runQuery(db, sql, args);
        return longValue(c.rows[0]?.[0]);
      },
    "static stringForQuery(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)Ljava/lang/String;":
      (db: JSQLiteDatabase, sql: string, args: unknown[]) => {
        const c = runQuery(db, sql, args);
        return c.rows.length ? String(c.rows[0][0] ?? "") : null;
      },
  },
});

// SQLiteOpenHelper: version migration flow
class JOpenParams extends JObj { flags = 0; synchronous: string | null = null; }
class JOpenParamsBuilder extends JObj { params = new JOpenParams(); }
rt.register({ name: "android/database/sqlite/SQLiteDatabase$OpenParams", ctor: JOpenParams });
rt.register({ name: "android/database/sqlite/SQLiteDatabase$OpenParams$Builder", ctor: JOpenParamsBuilder, methods: {
  "<init>()V": function () {},
  "addOpenFlags(I)Landroid/database/sqlite/SQLiteDatabase$OpenParams$Builder;": function (this: JOpenParamsBuilder, flags: number) { this.params.flags |= flags; return this; },
  "setSynchronousMode(Ljava/lang/String;)Landroid/database/sqlite/SQLiteDatabase$OpenParams$Builder;": function (this: JOpenParamsBuilder, mode: string) {
    if (mode == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "synchronousMode must not be null");
    this.params.synchronous = mode; return this;
  },
  "build()Landroid/database/sqlite/SQLiteDatabase$OpenParams;": function (this: JOpenParamsBuilder) { return Object.assign(new JOpenParams(), this.params); },
} });
class JSQLiteOpenHelper extends JObj {
  jctx: any = null;
  name: string | null = null;
  version = 1;
  jdb: JSQLiteDatabase | null = null;
  params = new JOpenParams();
  opening: { thread: JThread; ready: Promise<JSQLiteDatabase> } | null = null;
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
    "getWritableDatabase()Landroid/database/sqlite/SQLiteDatabase;": function (this: JSQLiteOpenHelper) {
      return openHelperDb(this);
    },
    "getReadableDatabase()Landroid/database/sqlite/SQLiteDatabase;": function (this: JSQLiteOpenHelper) {
      return openHelperDb(this);
    },
    "getDatabaseName()Ljava/lang/String;": function (this: JSQLiteOpenHelper) { return this.name; },
    "close()V": function (this: JSQLiteOpenHelper) { this.jdb?.scheduleSave(); },
    "setOpenParams(Landroid/database/sqlite/SQLiteDatabase$OpenParams;)V": function (this: JSQLiteOpenHelper, params: JOpenParams) {
      if (params == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "OpenParams must not be null");
      if (this.jdb) throw rt.mkThrowable("java/lang/IllegalStateException", "Database already open");
      this.params = Object.assign(new JOpenParams(), params);
    },
    ...noops("onCreate(Landroid/database/sqlite/SQLiteDatabase;)V",
      "onUpgrade(Landroid/database/sqlite/SQLiteDatabase;II)V",
      "onDowngrade(Landroid/database/sqlite/SQLiteDatabase;II)V", "onOpen(Landroid/database/sqlite/SQLiteDatabase;)V",
      "onConfigure(Landroid/database/sqlite/SQLiteDatabase;)V", "setWriteAheadLoggingEnabled(Z)V"),
  },
});
function openHelperDb(h: JSQLiteOpenHelper): Promise<JSQLiteDatabase> {
  if (h.jdb?.open) return Promise.resolve(h.jdb);
  if (h.opening) {
    if (h.opening.thread === curThread) throw rt.mkThrowable("java/lang/IllegalStateException", "getDatabase called recursively");
    return h.opening.ready;
  }
  const thread = curThread, ready = initializeHelperDb(h, thread).finally(() => { h.opening = null; });
  h.opening = { thread, ready };
  return ready;
}
async function initializeHelperDb(h: JSQLiteOpenHelper, thread: JThread): Promise<JSQLiteDatabase> {
  const pkg = h.jctx?.$host?.pkg ?? "app";
  const path = h.name ? dbPath(pkg, h.name) : ":memory:";
  const jdb = await openDatabase(path, h.params.flags | 0x10000000, true);
  if (h.params.synchronous !== null) jdb.db!.exec("PRAGMA synchronous='" + h.params.synchronous.replace(/'/g, "''") + "'");
  await vcallOn(thread, h, "onConfigure", "(Landroid/database/sqlite/SQLiteDatabase;)V", jdb);
  const cur = callSelf(dbMethods, "getVersion()I", jdb) as number;
  if (cur !== h.version) {
    await callOn(thread, () => callSelf(dbMethods, "beginTransaction()V", jdb));
    try {
      if (cur === 0) await vcallOn(thread, h, "onCreate", "(Landroid/database/sqlite/SQLiteDatabase;)V", jdb);
      else if (cur < h.version) await vcallOn(thread, h, "onUpgrade", "(Landroid/database/sqlite/SQLiteDatabase;II)V", jdb, cur, h.version);
      else await vcallOn(thread, h, "onDowngrade", "(Landroid/database/sqlite/SQLiteDatabase;II)V", jdb, cur, h.version);
      callSelf(dbMethods, "setVersion(I)V", jdb, h.version);
      callSelf(dbMethods, "setTransactionSuccessful()V", jdb);
    } finally {
      await callOn(thread, () => callSelf(dbMethods, "endTransaction()V", jdb));
    }
  }
  await vcallOn(thread, h, "onOpen", "(Landroid/database/sqlite/SQLiteDatabase;)V", jdb);
  h.jdb = jdb;
  return jdb;
}
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
jni("BundledSQLiteDriverKt", "nativeOpen(Ljava/lang/String;I)J", (async (name: string, flags: number) => {
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
}) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativePrepare(JLjava/lang/String;)J", ((db: bigint, sql: string) => {
  const conn = bConns.get(db);
  if (!conn?.jdb.db) throw rt.mkThrowable("android/database/sqlite/SQLiteException", "connection closed");
  const st = conn.db.prepare(sql);
  const h = nextHandle++;
  bStmts.set(h, { st, sql, conn, params: [], bound: false, row: null, names: st.getColumnNames() });
  return h;
}) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativeClose(J)V", ((db: bigint) => {
  const conn = bConns.get(db);
  if (!conn) return;
  for (const [handle, stmt] of bStmts) if (stmt.conn === conn) { stmt.st.free(); bStmts.delete(handle); }
  conn.db.close();
  conn.jdb.txDepth = Math.max(0, conn.jdb.txDepth - conn.tx);
  if (conn.jdb.path !== ":memory:") conn.jdb.scheduleSave();
  bConns.delete(db);
}) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativeInTransaction(J)Z", ((db: bigint) => (bConns.get(db)?.tx ? 1 : 0)) as (...a: never[]) => unknown);
jni("BundledSQLiteConnectionKt", "nativeLoadExtension(JLjava/lang/String;Ljava/lang/String;)V", (() => {
  throw rt.mkThrowable("android/database/sqlite/SQLiteException", "extensions unsupported");
}) as (...a: never[]) => unknown);
const stJni: Record<string, (...a: never[]) => unknown> = {
  "nativeBindBlob(JI[B)V": ((h: bigint, i: number, b: Int8Array) => {
    bstmt(h).params[i - 1] = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  }) as (...a: never[]) => unknown,
  "nativeBindDouble(JID)V": ((h: bigint, i: number, v: number) => { bstmt(h).params[i - 1] = v; }) as (...a: never[]) => unknown,
  "nativeBindLong(JIJ)V": ((h: bigint, i: number, v: bigint) => { bstmt(h).params[i - 1] = v; }) as (...a: never[]) => unknown,
  "nativeBindNull(JI)V": ((h: bigint, i: number) => { bstmt(h).params[i - 1] = null; }) as (...a: never[]) => unknown,
  "nativeBindText(JILjava/lang/String;)V": ((h: bigint, i: number, v: string) => { bstmt(h).params[i - 1] = v; }) as (...a: never[]) => unknown,
  "nativeClearBindings(J)V": ((h: bigint) => { const s = bstmt(h); s.params = []; s.bound = false; }) as (...a: never[]) => unknown,
  "nativeStep(J)Z": ((h: bigint) => {
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
    return typeof v === "bigint" || Number.isInteger(v) ? 1 : 2;
  }) as (...a: never[]) => unknown,
  "nativeGetLong(JI)J": ((h: bigint, i: number) => longValue(bstmt(h).row?.[i])) as (...a: never[]) => unknown,
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
