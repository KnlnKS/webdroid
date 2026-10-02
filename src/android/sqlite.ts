// android.database.sqlite's native half (android_database_SQLiteConnection.cpp, SQLiteGlobal) and
// androidx.sqlite's bundled driver, over SQLite's C API in sql.js; SQLiteDatabase, its connection
// pool, sessions and cursors run from AOSP bytecode above them.
//
// Each connection is its own sqlite3 handle on its file's one Emscripten file, so a write on one is
// visible to the next statement on another, and what lives on a connection (the TEMP schema,
// PRAGMAs) lasts as long as it does. The file's bytes reach the VFS in debounced snapshots.

import initSqlJs, { type Database } from "sql.js";
import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { i8, u8, mangleField, jarray, strArray } from "../jvm/abi";
import { vfs } from "../shell/vfs";
import { newObj, vcall } from "../jvm/natives/jlang";
import { unbox, boxLong, boxDouble } from "../jvm/natives/jbox";
import { arrayMapEntries } from "../jvm/natives/jcoll";
import { handle, deref, release } from "./handles";
import { type NativeWindow, FIELD_INTEGER, FIELD_FLOAT, FIELD_STRING, FIELD_BLOB, integer } from "./cursorwindow";

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
/** the C API vendor/sql.js/sqljs.patch exports */
type Sql = SqlJs & {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToNewUTF8(s: string): number;
  UTF8ToString(ptr: number, maxBytes?: number): string;
  addFunction(fn: (...args: number[]) => number, sig: string): number;
  _sqlite3_prepare_v2(db: number, sql: number, bytes: number, out: number, tail: number): number;
  _sqlite3_finalize(st: number): number;
  _sqlite3_reset(st: number): number;
  _sqlite3_clear_bindings(st: number): number;
  _sqlite3_step(st: number): number;
  _sqlite3_bind_text(st: number, i: number, text: number, bytes: number, destructor: number): number;
  _sqlite3_bind_blob(st: number, i: number, data: number, bytes: number, destructor: number): number;
  _sqlite3_bind_double(st: number, i: number, v: number): number;
  _sqlite3_bind_int64(st: number, i: number, v: bigint): number;
  _sqlite3_bind_parameter_count(st: number): number;
  _sqlite3_stmt_readonly(st: number): number;
  _sqlite3_column_count(st: number): number;
  _sqlite3_column_name(st: number, i: number): number;
  _sqlite3_column_type(st: number, i: number): number;
  _sqlite3_column_int64(st: number, i: number): bigint;
  _sqlite3_column_double(st: number, i: number): number;
  _sqlite3_column_text(st: number, i: number): number;
  _sqlite3_column_blob(st: number, i: number): number;
  _sqlite3_column_bytes(st: number, i: number): number;
  _sqlite3_changes(db: number): number;
  _sqlite3_total_changes(db: number): number;
  _sqlite3_last_insert_rowid(db: number): bigint;
  _sqlite3_get_autocommit(db: number): number;
  _sqlite3_extended_errcode(db: number): number;
  _sqlite3_errmsg(db: number): number;
  _sqlite3_create_collation_v2(db: number, name: number, encoding: number, arg: number, compare: number, destroy: number): number;
};
const ROW = 100, DONE = 101, INTEGER = 1, FLOAT = 2, TEXT = 3, BLOB = 4, UTF8 = 1, TRANSIENT = -1;

/** one database file every connection to it shares; `db` holds the Emscripten file and takes the snapshots */
type SharedDatabase = { path: string; db: Database; connections: Set<Connection>; saving: ReturnType<typeof setTimeout> | null; mtime: number };
type SQLiteStore = { sql: () => Promise<SqlJs>; files: Map<string, SharedDatabase> };
let sqlReady: Promise<SqlJs> | null = null;
export let sqliteStore: SQLiteStore = { files: new Map(), sql: () => sqlReady ??= initSqlJs({ locateFile: (f: string) => "/sqljs/" + f }) };
export function useSQLiteStore(store: SQLiteStore): void { sqliteStore = store; }
let C!: Sql;
const loadSql = async () => C ??= await sqliteStore.sql() as Sql;

/** sql.js keeps each Database's bytes in an Emscripten VFS file; @types/sql.js omits the name. */
const named = (db: Database) => db as Database & { filename: string; db: number };
// sql.js's Database.export() CLOSES and re-opens the connection, which destroys everything that lives
// on a connection rather than in the file: the TEMP schema, the PRAGMAs, and every live prepared
// statement. Snapshot the file through a THROWAWAY connection instead: point its filename at ours so
// its export() reads our bytes while closing only its own handle, then restore the name so its
// close() unlinks its own file.
function snapshotBytes(db: Database): Uint8Array | null {
  // The main file alone omits WAL pages; a reader can prevent a complete checkpoint.
  const checkpoint = db.exec("PRAGMA wal_checkpoint(PASSIVE)")[0]?.values[0];
  if (checkpoint && (checkpoint[0] || checkpoint[1] !== checkpoint[2])) return null;
  const shadow = named(new C.Database()), own = shadow.filename;
  shadow.filename = named(db).filename;
  try {
    return shadow.export();
  } finally {
    shadow.filename = own;
    try { shadow.close(); } catch { /* */ }
  }
}
/** another sqlite3 handle on `source`'s file: export() re-opens under the borrowed name */
function sharedConnection(source: Database): Database {
  const db = named(new C.Database()), own = db.filename;
  db.filename = named(source).filename;
  try { db.export(); } catch (e) { db.filename = own; db.close(); throw e; }
  const close = db.close.bind(db);
  db.close = () => { db.filename = own; close(); };
  return db;
}

function scheduleSave(file: SharedDatabase) {
  if (file.saving) clearTimeout(file.saving);
  file.saving = setTimeout(() => void save(file), 400);
}
async function save(file: SharedDatabase) {
  file.saving = null;
  // unlinked (deleteDatabase) or replaced by a newer file at the path: nothing to persist
  if (sqliteStore.files.get(file.path) !== file || !vfs.exists(file.path)) return;
  // mid-transaction the file can hold uncommitted pages whose undo lives in a journal we do not copy
  for (const c of file.connections) if (!C._sqlite3_get_autocommit(c.ptr)) return scheduleSave(file);
  try {
    const bytes = snapshotBytes(file.db);
    if (!bytes) return scheduleSave(file);
    vfs.write(file.path, bytes);
    file.mtime = vfs.mtime(file.path);
    await vfs.flush();
    globalThis.localStorage?.removeItem("wd:db:" + file.path);
  } catch (e) {
    if (e instanceof Error && e.message.includes("locked")) scheduleSave(file);
    else console.warn("[sqlite] persist failed", e);
  }
}
/** a snapshot an older build kept in localStorage */
function legacySnapshot(path: string): Uint8Array | null {
  try {
    const raw = globalThis.localStorage?.getItem("wd:db:" + path);
    return raw ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) : null;
  } catch { return null; }
}

class Connection {
  readonly ptr: number;
  cancelable = false;
  canceled = false;
  constructor(readonly db: Database, readonly file: SharedDatabase | null) { this.ptr = named(db).db; }
}
const conn = (h: bigint) => deref<Connection>(h);

// ── errors, as android_database_SQLiteCommon.cpp's throw_sqlite3_exception raises them
const CODES = ["OK", "ERROR", "INTERNAL", "PERM", "ABORT", "BUSY", "LOCKED", "NOMEM", "READONLY", "INTERRUPT", "IOERR", "CORRUPT",
  "NOTFOUND", "FULL", "CANTOPEN", "PROTOCOL", "EMPTY", "SCHEMA", "TOOBIG", "CONSTRAINT", "MISMATCH", "MISUSE", "NOLFS", "AUTH",
  "FORMAT", "RANGE", "NOTADB", "NOTICE", "WARNING"];
const CONSTRAINTS = ["", "CHECK", "COMMITHOOK", "FOREIGNKEY", "FUNCTION", "NOTNULL", "PRIMARYKEY", "TRIGGER", "UNIQUE", "VTAB", "ROWID", "PINNED", "DATATYPE"];
const EXCEPTIONS: Record<number, string> = {
  3: "SQLiteAccessPermException", 4: "SQLiteAbortException", 5: "SQLiteDatabaseLockedException", 6: "SQLiteTableLockedException",
  7: "SQLiteOutOfMemoryException", 8: "SQLiteReadOnlyDatabaseException", 10: "SQLiteDiskIOException", 11: "SQLiteDatabaseCorruptException",
  13: "SQLiteFullException", 14: "SQLiteCantOpenDatabaseException", 18: "SQLiteBlobTooBigException", 19: "SQLiteConstraintException",
  20: "SQLiteDatatypeMismatchException", 21: "SQLiteMisuseException", 25: "SQLiteBindOrColumnIndexOutOfRangeException",
  26: "SQLiteDatabaseCorruptException", 101: "SQLiteDoneException",
};
function codeName(code: number): string {
  const primary = code & 0xff, name = primary === ROW ? "ROW" : primary === DONE ? "DONE" : CODES[primary] ?? "UNKNOWN";
  return `SQLITE_${name}${primary === 19 && code >> 8 ? "_" + CONSTRAINTS[code >> 8] : ""}[${code}]`;
}
function sqliteException(code: number, sqliteMessage: string | null, message: string | null = null): unknown {
  const primary = code & 0xff;
  const cls = primary === 9 ? "android/os/OperationCanceledException" : "android/database/sqlite/" + (EXCEPTIONS[primary] ?? "SQLiteException");
  return rt.mkThrowable(cls, sqliteMessage === null || primary === DONE ? message
    : `${sqliteMessage} (code ${code} ${codeName(code)})${message ? ": " + message : ""}`);
}
const dbException = (c: Connection, message: string | null = null) =>
  sqliteException(C._sqlite3_extended_errcode(c.ptr), C.UTF8ToString(C._sqlite3_errmsg(c.ptr)), message);
const check = (c: Connection, rc: number) => { if (rc) throw dbException(c); };
const noHandle = (message: string) => sqliteException(0, "unknown error", message);

// ── collations: register_android_functions' UNICODE and register_localized_collators' LOCALIZED (ICU, primary strength)
const collators = new Map<string, number>();
function collate(c: Connection, name: string, locale: string, options: Intl.CollatorOptions) {
  const key = `${name}:${locale}`;
  let compare = collators.get(key);
  if (compare === undefined) {
    let collator: Intl.Collator;
    try { collator = new Intl.Collator(locale, options); } catch { collator = new Intl.Collator("und", options); }
    compare = C.addFunction((_arg, n1, p1, n2, p2) => collator.compare(C.UTF8ToString(p1, n1), C.UTF8ToString(p2, n2)), "iiiiii");
    collators.set(key, compare);
  }
  const text = C.stringToNewUTF8(name);
  try { check(c, C._sqlite3_create_collation_v2(c.ptr, text, UTF8, 0, compare, 0)); } finally { C._free(text); }
}

/** SQLiteConnection.nativeOpen's flags: CREATE_IF_NECESSARY opens read-write whatever OPEN_READONLY says */
async function openConnection(path: string, readOnly: boolean, create: boolean): Promise<Connection> {
  await loadSql();
  let c: Connection;
  if (path === ":memory:") c = new Connection(new C.Database(), null);
  else {
    // a file deleted, or replaced while no connection had it open, is read afresh
    const current = (f: SharedDatabase | undefined) => !!f && vfs.exists(path) && (f.connections.size > 0 || vfs.mtime(path) === f.mtime);
    let file = sqliteStore.files.get(path);
    if (!current(file)) {
      const data = vfs.read(path) ?? (vfs.source(path) ? await vfs.readFile(path) : null) ?? legacySnapshot(path);
      const cantOpen = !data && (readOnly || !create || !vfs.isDir(path.slice(0, path.lastIndexOf("/")) || "/"));
      if (cantOpen) throw sqliteException(14, "unable to open database file", "Could not open database");
      file = sqliteStore.files.get(path);
      if (!current(file)) {
        if (file && !file.connections.size) file.db.close();
        file = { path, db: new C.Database(data), connections: new Set(), saving: null, mtime: 0 };
        sqliteStore.files.set(path, file);
        // opening creates the (empty) file, which callers chmod or stat before the first snapshot
        if (!data) vfs.write(path, new Uint8Array(0));
        else if (!vfs.exists(path)) scheduleSave(file);
        file.mtime = vfs.mtime(path);
      }
    }
    c = new Connection(sharedConnection(file!.db), file!);
    file!.connections.add(c);
    if (readOnly) c.db.exec("PRAGMA query_only=1");
  }
  collate(c, "UNICODE", "und", {});
  return c;
}
function closeConnection(c: Connection) {
  c.db.close();
  c.file?.connections.delete(c);
}

// ── statements: the long a PreparedStatement holds is the sqlite3_stmt pointer itself
let out = 0;
/** sqlite3_prepare_v2's statement, or `error`'s exception */
function prepare(c: Connection, sql: string, error: () => unknown): number {
  const text = C.stringToNewUTF8(sql), at = out ||= C._malloc(4);
  try {
    if (C._sqlite3_prepare_v2(c.ptr, text, -1, at, 0)) throw error();
    return C.HEAPU8[at] | C.HEAPU8[at + 1] << 8 | C.HEAPU8[at + 2] << 16 | C.HEAPU8[at + 3] << 24;
  } finally { C._free(text); }
}
function bindText(st: number, i: number, value: string): number {
  const text = C.stringToNewUTF8(value);
  try { return C._sqlite3_bind_text(st, i, text, -1, TRANSIENT); } finally { C._free(text); }
}
function bindBlob(st: number, i: number, value: Int8Array): number {
  const data = C._malloc(value.length || 1);
  C.HEAPU8.set(u8(value), data);
  try { return C._sqlite3_bind_blob(st, i, data, value.length, TRANSIENT); } finally { C._free(data); }
}
const bindNull = (st: number, i: number) => C._sqlite3_bind_blob(st, i, 0, 0, 0);
function columnText(st: number, i: number): string | null {
  const text = C._sqlite3_column_text(st, i);
  return text ? C.UTF8ToString(text, C._sqlite3_column_bytes(st, i)) : null;
}
function columnBlob(st: number, i: number): Int8Array {
  const data = C._sqlite3_column_blob(st, i);
  return i8(C.HEAPU8.slice(data, data + C._sqlite3_column_bytes(st, i)));
}
const columnName = (st: number, i: number) => { const name = C._sqlite3_column_name(st, i); return name ? C.UTF8ToString(name) : null; };
/** sqlite3_step, interrupted as the progress handler interrupts a cancelled connection */
function step(c: Connection, st: number): number {
  if (c.cancelable && c.canceled) throw sqliteException(9, "interrupted");
  return C._sqlite3_step(st);
}
/** a statement that may have changed the file schedules its snapshot */
const stepped = (c: Connection, st: number) => { if (c.file && !C._sqlite3_stmt_readonly(st)) scheduleSave(c.file); };
function executeNonQuery(c: Connection, st: number, isPragma = false) {
  let rc = step(c, st);
  if (isPragma) while (rc === ROW) rc = step(c, st);
  stepped(c, st);
  if (rc === ROW) throw noHandle("Queries can be performed using SQLiteDatabase query or rawQuery methods only.");
  if (rc !== DONE) throw dbException(c);
}
function executeOneRowQuery(c: Connection, st: number): boolean {
  const rc = step(c, st);
  stepped(c, st);
  if (rc !== ROW) throw dbException(c);
  return C._sqlite3_column_count(st) >= 1;
}

/** copyRow: the statement's current row into the window's next one; false when it does not fit */
function copyRow(w: NativeWindow, st: number, cols: number): boolean {
  if (!w.allocRow()) return false;
  const row = w.rows - 1;
  for (let i = 0; i < cols; i++) {
    let fits = true;
    switch (C._sqlite3_column_type(st, i)) {
      case INTEGER: {
        const d = C._sqlite3_column_double(st, i);
        fits = w.put(row, i, FIELD_INTEGER, Number.isSafeInteger(d) ? d : integer(C._sqlite3_column_int64(st, i)));
        break;
      }
      case FLOAT: fits = w.put(row, i, FIELD_FLOAT, C._sqlite3_column_double(st, i)); break;
      case TEXT: {
        const text = C._sqlite3_column_text(st, i), n = C._sqlite3_column_bytes(st, i);
        fits = w.put(row, i, FIELD_STRING, C.UTF8ToString(text, n), n + 1);
        break;
      }
      case BLOB: { const b = columnBlob(st, i); fits = w.put(row, i, FIELD_BLOB, b, b.length); break; }
    }
    if (!fits) { w.freeLastRow(); return false; }
  }
  return true;
}
/** nativeExecuteForCursorWindow: rows from startPos into the window, refilling from later rows when
 *  it fills before requiredPos, and counting every row on request; (startPos << 32) | totalRows */
function fillWindow(c: Connection, st: number, w: NativeWindow, startPos: number, requiredPos: number, countAllRows: number): bigint {
  if (w.readOnly) throw rt.mkThrowable("java/lang/IllegalStateException", "Failed to clear the cursor window, status=-38");
  w.clear();
  const cols = w.cols = C._sqlite3_column_count(st);
  let total = 0, added = 0, full = false;
  try {
    while (!full || countAllRows) {
      const rc = step(c, st);
      if (rc === DONE) break;
      if (rc !== ROW) throw dbException(c);
      if (startPos >= ++total || full) continue;
      let fits = copyRow(w, st, cols);
      if (!fits && added && startPos + added <= requiredPos) {
        // filled before the one row really wanted: start again from here
        w.clear();
        w.cols = cols;
        startPos += added;
        added = 0;
        fits = copyRow(w, st, cols);
      }
      if (fits) added++; else full = true;
    }
  } finally {
    C._sqlite3_reset(st);
    stepped(c, st);
  }
  if (total > 0 && added === 0) throw sqliteException(18, null, `Row too big to fit into CursorWindow requiredPos=${requiredPos}, totalRows=${total}`);
  return BigInt(startPos) << 32n | BigInt(total);
}

const OPEN_READONLY = 1, CREATE_IF_NECESSARY = 0x10000000;
const st = (h: bigint) => Number(h);
rt.registerJnis("android/database/sqlite/SQLiteConnection", {
  "nativeOpen(Ljava/lang/String;ILjava/lang/String;ZZII)J": async (path: string, flags: number) =>
    handle(await openConnection(path, (flags & OPEN_READONLY) !== 0 && !(flags & CREATE_IF_NECESSARY), (flags & CREATE_IF_NECESSARY) !== 0)),
  "nativeClose(J)V": (h: bigint) => { closeConnection(conn(h)); release(h); },
  "nativeRegisterLocalizedCollators(JLjava/lang/String;)V": (h: bigint, locale: string) =>
    collate(conn(h), "LOCALIZED", locale.replaceAll("_", "-"), { sensitivity: "base" }),
  "nativePrepareStatement(JLjava/lang/String;)J": (h: bigint, sql: string) => {
    const c = conn(h);
    return BigInt(prepare(c, sql, () => dbException(c, ", while compiling: " + sql)));
  },
  "nativeFinalizeStatement(JJ)V": (_h: bigint, s: bigint) => { C._sqlite3_finalize(st(s)); },
  "nativeGetParameterCount(JJ)I": (_h: bigint, s: bigint) => C._sqlite3_bind_parameter_count(st(s)),
  "nativeIsReadOnly(JJ)Z": (_h: bigint, s: bigint) => C._sqlite3_stmt_readonly(st(s)),
  "nativeGetColumnCount(JJ)I": (_h: bigint, s: bigint) => C._sqlite3_column_count(st(s)),
  "nativeGetColumnName(JJI)Ljava/lang/String;": (_h: bigint, s: bigint, i: number) => columnName(st(s), i),
  "nativeBindNull(JJI)V": (h: bigint, s: bigint, i: number) => check(conn(h), bindNull(st(s), i)),
  "nativeBindLong(JJIJ)V": (h: bigint, s: bigint, i: number, v: bigint) => check(conn(h), C._sqlite3_bind_int64(st(s), i, v)),
  "nativeBindDouble(JJID)V": (h: bigint, s: bigint, i: number, v: number) => check(conn(h), C._sqlite3_bind_double(st(s), i, v)),
  "nativeBindString(JJILjava/lang/String;)V": (h: bigint, s: bigint, i: number, v: string) => check(conn(h), bindText(st(s), i, v)),
  "nativeBindBlob(JJI[B)V": (h: bigint, s: bigint, i: number, v: Int8Array) => check(conn(h), bindBlob(st(s), i, v)),
  "nativeResetStatementAndClearBindings(JJ)V": (h: bigint, s: bigint) => {
    const rc = C._sqlite3_reset(st(s));
    check(conn(h), rc || C._sqlite3_clear_bindings(st(s)));
  },
  "nativeExecute(JJZ)V": (h: bigint, s: bigint, isPragma: number) => executeNonQuery(conn(h), st(s), !!isPragma),
  "nativeExecuteForChangedRowCount(JJ)I": (h: bigint, s: bigint) => {
    const c = conn(h);
    executeNonQuery(c, st(s));
    return C._sqlite3_changes(c.ptr);
  },
  "nativeExecuteForLastInsertedRowId(JJ)J": (h: bigint, s: bigint) => {
    const c = conn(h);
    executeNonQuery(c, st(s));
    return C._sqlite3_changes(c.ptr) > 0 ? C._sqlite3_last_insert_rowid(c.ptr) : -1n;
  },
  "nativeExecuteForLong(JJ)J": (h: bigint, s: bigint) => executeOneRowQuery(conn(h), st(s)) ? C._sqlite3_column_int64(st(s), 0) : -1n,
  "nativeExecuteForString(JJ)Ljava/lang/String;": (h: bigint, s: bigint) => executeOneRowQuery(conn(h), st(s)) ? columnText(st(s), 0) : null,
  "nativeExecuteForCursorWindow(JJJIIZ)J": (h: bigint, s: bigint, w: bigint, startPos: number, requiredPos: number, countAllRows: number) =>
    fillWindow(conn(h), st(s), deref<NativeWindow>(w), startPos, requiredPos, countAllRows),
  "nativeChanges(J)J": (h: bigint) => BigInt(C._sqlite3_changes(conn(h).ptr)),
  "nativeTotalChanges(J)J": (h: bigint) => BigInt(C._sqlite3_total_changes(conn(h).ptr)),
  "nativeLastInsertRowId(J)I": (h: bigint) => Number(BigInt.asIntN(32, C._sqlite3_last_insert_rowid(conn(h).ptr))),
  "nativeCancel(J)V": (h: bigint) => { conn(h).canceled = true; },
  "nativeResetCancel(JZ)V": (h: bigint, cancelable: number) => { const c = conn(h); c.canceled = false; c.cancelable = !!cancelable; },
});
// sqlite3_release_memory frees nothing without SQLITE_ENABLE_MEMORY_MANAGEMENT, which sql.js does not define
rt.registerJni("android/database/sqlite/SQLiteGlobal", "nativeReleaseMemory()I", () => 0);

// ── androidx.sqlite's bundled driver (libsqliteJni): its statement natives name only the statement
const bundled = new Map<number, Connection>();
const bundledConn = (s: bigint) => bundled.get(st(s)) ?? rt.npe();
const bundledError = (c: Connection) =>
  rt.mkThrowable("android/database/SQLException", `Error code: ${C._sqlite3_extended_errcode(c.ptr)}, message: ${C.UTF8ToString(C._sqlite3_errmsg(c.ptr))}`);
const bundledCheck = (c: Connection, rc: number) => { if (rc) throw bundledError(c); };
rt.claimNativeLib("sqliteJni");
rt.registerJnis("androidx/sqlite/driver/bundled/BundledSQLiteDriverKt", {
  "nativeThreadSafeMode()I": () => 0,
  "nativeOpen(Ljava/lang/String;I)J": async (name: string, flags: number) =>
    handle(await openConnection(name || ":memory:", (flags & 3) === 1, (flags & 6) === 6)),
});
rt.registerJnis("androidx/sqlite/driver/bundled/BundledSQLiteConnectionKt", {
  "nativePrepare(JLjava/lang/String;)J": (h: bigint, sql: string) => {
    const c = conn(h), s = prepare(c, sql, () => bundledError(c));
    bundled.set(s, c);
    return BigInt(s);
  },
  "nativeClose(J)V": (h: bigint) => {
    const c = conn(h);
    for (const [s, owner] of bundled) if (owner === c) { C._sqlite3_finalize(s); bundled.delete(s); }
    closeConnection(c);
    release(h);
  },
  "nativeInTransaction(J)Z": (h: bigint) => +!C._sqlite3_get_autocommit(conn(h).ptr),
  "nativeLoadExtension(JLjava/lang/String;Ljava/lang/String;)V": () => {
    throw rt.mkThrowable("android/database/SQLException", "Error code: 1, message: not authorized");
  },
});
rt.registerJnis("androidx/sqlite/driver/bundled/BundledSQLiteStatementKt", {
  "nativeBindBlob(JI[B)V": (s: bigint, i: number, v: Int8Array) => bundledCheck(bundledConn(s), bindBlob(st(s), i, v)),
  "nativeBindDouble(JID)V": (s: bigint, i: number, v: number) => bundledCheck(bundledConn(s), C._sqlite3_bind_double(st(s), i, v)),
  "nativeBindLong(JIJ)V": (s: bigint, i: number, v: bigint) => bundledCheck(bundledConn(s), C._sqlite3_bind_int64(st(s), i, v)),
  "nativeBindNull(JI)V": (s: bigint, i: number) => bundledCheck(bundledConn(s), bindNull(st(s), i)),
  "nativeBindText(JILjava/lang/String;)V": (s: bigint, i: number, v: string) => bundledCheck(bundledConn(s), bindText(st(s), i, v)),
  "nativeClearBindings(J)V": (s: bigint) => bundledCheck(bundledConn(s), C._sqlite3_clear_bindings(st(s))),
  "nativeStep(J)Z": (s: bigint) => {
    const c = bundledConn(s), rc = step(c, st(s));
    stepped(c, st(s));
    if (rc === ROW) return 1;
    if (rc === DONE) return 0;
    return bundledCheck(c, rc), 0;
  },
  "nativeReset(J)V": (s: bigint) => bundledCheck(bundledConn(s), C._sqlite3_reset(st(s))),
  "nativeClose(J)V": (s: bigint) => { if (bundled.delete(st(s))) C._sqlite3_finalize(st(s)); },
  "nativeGetColumnCount(J)I": (s: bigint) => C._sqlite3_column_count(st(s)),
  "nativeGetColumnName(JI)Ljava/lang/String;": (s: bigint, i: number) => columnName(st(s), i),
  "nativeGetColumnType(JI)I": (s: bigint, i: number) => C._sqlite3_column_type(st(s), i),
  "nativeGetLong(JI)J": (s: bigint, i: number) => C._sqlite3_column_int64(st(s), i),
  "nativeGetDouble(JI)D": (s: bigint, i: number) => C._sqlite3_column_double(st(s), i),
  "nativeGetText(JI)Ljava/lang/String;": (s: bigint, i: number) => columnText(st(s), i) ?? "",
  "nativeGetBlob(JI)[B": (s: bigint, i: number) => columnBlob(st(s), i),
});

// ── the hosted system providers' side of android.database
const CV_MAP = mangleField("android/content/ContentValues", "mMap");
/** a ContentValues' entries, with boxed numbers unwrapped */
export const contentValues = (values: JObj): Map<string, unknown> =>
  new Map(arrayMapEntries((values as unknown as Record<string, JObj>)[CV_MAP]).map(([k, v]) => [k as string, unbox(v) ?? v]));
/** a SQLite value as MatrixCursor holds it: INTEGER a Long, REAL a Double */
const cell = (v: unknown) => typeof v === "number" ? Number.isInteger(v) ? boxLong(BigInt(v)) : boxDouble(v)
  : typeof v === "bigint" ? boxLong(v) : v instanceof Uint8Array ? i8(v.slice()) : v;
/** a MatrixCursor over rows in hand */
export const matrixCursor = driven(function* matrixCursor(columns: string[], rows: unknown[][]): Gen<JObj> {
  const cursor: JObj = yield newObj("android/database/MatrixCursor", "([Ljava/lang/String;I)V", strArray(columns), rows.length);
  for (const row of rows) yield vcall(cursor, "addRow", "([Ljava/lang/Object;)V", jarray(row.map(cell)));
  return cursor;
});
