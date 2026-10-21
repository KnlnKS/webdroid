// android.database.sqlite's native half (android_database_SQLiteConnection.cpp, SQLiteGlobal) and
// androidx.sqlite's bundled driver, over SQLite's C API in sql.js; SQLiteDatabase, its connection
// pool, sessions and cursors run from AOSP bytecode above them.
//
// Each connection is its own sqlite3 handle on its file's one Emscripten file, so a write on one is
// visible to the next statement on another, and what lives on a connection (the TEMP schema,
// PRAGMAs) lasts as long as it does. The file's bytes reach the VFS in debounced snapshots.
//
// The engine comes first: persistence, then connections and statements. The process boundary
// follows, where a process Worker sends each native to the broker, which runs it in that
// process's session of opaque tokens. The natives of each family close the module.

import initSqlJs from "sql.js";
import { rt, driven, awaited } from "../jvm/runtime.ts";
import { i8, u8, parseMethodDesc } from "../jvm/abi.ts";
import { vfs } from "../shell/vfs.ts";
import { handle, deref, release } from "./handles.ts";
import { NativeWindow, FIELD_INTEGER, FIELD_FLOAT, FIELD_STRING, FIELD_BLOB, sqliteException, noHandle, SQLITE_BUSY, SQLITE_LOCKED,
  SQLITE_INTERRUPT, SQLITE_CANTOPEN, SQLITE_TOOBIG, SQLITE_MISUSE, SQLITE_RANGE, SQLITE_ROW as ROW, SQLITE_DONE as DONE } from "./cursorwindow.ts";
import { callFailure, type CallFailure } from "../shell/rpc.ts";
import { javaFailure } from "../shell/broker-contract.ts";

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
/** the C API and Emscripten FS vendor/sql.js/sqljs.patch exports */
type Sql = SqlJs & {
  HEAPU8: Uint8Array;
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array; unlink(path: string): void };
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToNewUTF8(s: string): number;
  UTF8ToString(ptr: number, maxBytes?: number): string;
  addFunction(fn: (...args: number[]) => number, sig: string): number;
  _sqlite3_open(name: number, out: number): number;
  _sqlite3_close_v2(db: number): number;
  _RegisterExtensionFunctions(db: number): number;
  _sqlite3_exec(db: number, sql: number, callback: number, arg: number, error: number): number;
  _sqlite3_wal_checkpoint_v2(db: number, name: number, mode: number, log: number, checkpointed: number): number;
  _sqlite3_prepare_v2(db: number, sql: number, bytes: number, out: number, tail: number): number;
  _sqlite3_finalize(st: number): number;
  _sqlite3_reset(st: number): number;
  _sqlite3_clear_bindings(st: number): number;
  _sqlite3_step(st: number): number;
  _sqlite3_stmt_busy(st: number): number;
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
const INTEGER = 1, FLOAT = 2, TEXT = 3, BLOB = 4, UTF8 = 1, TRANSIENT = -1;

/** one database file every connection to it shares, held in the Emscripten file `name` */
type SharedDatabase = { path: string; name: string; connections: Set<Connection>; saving: ReturnType<typeof setTimeout> | null; mtime: number };
type SQLiteStore = { sql: () => Promise<SqlJs>; files: Map<string, SharedDatabase> };
let sqlReady: Promise<SqlJs> | null = null;
export let sqliteStore: SQLiteStore = { files: new Map(), sql: () => sqlReady ??= initSqlJs({ locateFile: (f: string) => "/sqljs/" + f }) };
export function useSQLiteStore(store: SQLiteStore): void { sqliteStore = store; }
let C!: Sql;
/** an 8-byte out parameter */
let out = 0;
const loadSql = async () => { C ??= await sqliteStore.sql() as Sql; out ||= C._malloc(8); };
const int32At = (at: number) => C.HEAPU8[at] | C.HEAPU8[at + 1] << 8 | C.HEAPU8[at + 2] << 16 | C.HEAPU8[at + 3] << 24;
function withUTF8<T>(s: string, f: (text: number) => T): T {
  const text = C.stringToNewUTF8(s);
  try { return f(text); } finally { C._free(text); }
}

/** what a failure raises: AOSP's SQLiteException family, or androidx's SQLException */
type Raise = (code: number, sqliteMessage: string, message?: string | null) => unknown;
class Connection {
  readonly ptr: number; readonly file: SharedDatabase | null; readonly raise: Raise;
  cancelable = false;
  canceled = false;
  closed = false;
  readonly statements = new Set<number>();
  constructor(ptr: number, file: SharedDatabase | null, raise: Raise) { this.ptr = ptr; this.file = file; this.raise = raise; }
}
const conn = (h: bigint) => deref<Connection>(h);
const statementOwners = new Map<number, Connection>();
const dbError = (c: Connection, message: string | null = null) =>
  c.raise(C._sqlite3_extended_errcode(c.ptr), C.UTF8ToString(C._sqlite3_errmsg(c.ptr)), message);
const check = (c: Connection, rc: number) => { if (rc) throw dbError(c); };

// ── persistence: the file is still the one at its path unless deleted, or replaced while no connection had it open
const isCurrent = (f: SharedDatabase | undefined): f is SharedDatabase => !!f && sqliteStore.files.get(f.path) === f && vfs.exists(f.path)
  && (f.connections.size > 0 || vfs.mtime(f.path) === f.mtime);
/** the file at `path`, its bytes copied from the VFS unless the current one still holds them; null
 *  when it does not exist and the flags or a missing directory forbid creating it */
async function sharedFile(path: string, readOnly: boolean, create: boolean): Promise<SharedDatabase | null> {
  let file = sqliteStore.files.get(path);
  if (isCurrent(file)) return file;
  const data = vfs.read(path) ?? (vfs.source(path) ? await vfs.readFile(path) : null);
  if (!data && (readOnly || !create || !vfs.isDir(path.slice(0, path.lastIndexOf("/")) || "/"))) return null;
  // another open may have loaded it while this one read
  if (isCurrent(file = sqliteStore.files.get(path))) return file;
  if (file) retire(file);
  const name = `/${crypto.randomUUID()}.db`, bytes = data ?? new Uint8Array(0);
  C.FS.writeFile(name, bytes);
  // opening creates the file, which callers chmod or stat before the first snapshot
  if (!vfs.exists(path)) vfs.write(path, bytes);
  sqliteStore.files.set(path, file = { path, name, connections: new Set(), saving: null, mtime: vfs.mtime(path) });
  return file;
}
function scheduleSave(file: SharedDatabase) {
  if (file.saving) clearTimeout(file.saving);
  file.saving = setTimeout(() => void save(file), 400);
}
/** the file's bytes, or null while an open transaction or a reader leaves them incomplete */
function snapshot(file: SharedDatabase): Uint8Array | null {
  let any: Connection | null = null;
  for (const c of file.connections) {
    // A close_v2 zombie is unusable but still owns its file until its statements finalize.
    if (c.closed) return null;
    // mid-transaction the file can hold uncommitted pages whose undo lives in a journal we do not copy
    if (!C._sqlite3_get_autocommit(c.ptr)) return null;
    any = c;
  }
  if (any) {
    // the main file alone omits WAL pages; a reader can prevent a complete checkpoint
    const rc = C._sqlite3_wal_checkpoint_v2(any.ptr, 0, 0, out, out + 4);
    if ((rc & 0xff) === SQLITE_BUSY || (rc & 0xff) === SQLITE_LOCKED || int32At(out) !== int32At(out + 4)) return null;
    check(any, rc);
  }
  return C.FS.readFile(file.name);
}
async function save(file: SharedDatabase) {
  file.saving = null;
  if (!isCurrent(file)) return;
  try {
    const bytes = snapshot(file);
    if (!bytes) return scheduleSave(file);
    vfs.write(file.path, bytes);
    file.mtime = vfs.mtime(file.path);
    await vfs.flush();
  } catch (e) { console.warn("[sqlite] persist failed", e); }
}
/** an Emscripten file no longer at its path, once its last connection closes */
function retire(file: SharedDatabase) {
  if (file.connections.size) return;
  if (file.saving) clearTimeout(file.saving);
  C.FS.unlink(file.name);
}
/** Release file ownership only after close_v2's final statement has destroyed its zombie. */
function retiredConnection(c: Connection) {
  if (!c.file) return;
  c.file.connections.delete(c);
  if (sqliteStore.files.get(c.file.path) !== c.file) retire(c.file);
}

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
  check(c, withUTF8(name, (text) => C._sqlite3_create_collation_v2(c.ptr, text, UTF8, 0, compare, 0)));
}

// ── connections: each its own sqlite3 handle on its file
/** SQLiteConnection.nativeOpen's flags: CREATE_IF_NECESSARY opens read-write whatever OPEN_READONLY says */
async function openConnection(path: string, readOnly: boolean, create: boolean, raise: Raise): Promise<Connection> {
  await loadSql();
  const file = path === ":memory:" ? undefined : await sharedFile(path, readOnly, create);
  if (file === null) throw raise(SQLITE_CANTOPEN, "unable to open database file", "Could not open database");
  const ptr = withUTF8(file?.name ?? path, (name) => { const rc = C._sqlite3_open(name, out); return rc ? -rc : int32At(out); });
  if (ptr < 0) throw raise(-ptr, "unable to open database file", "Could not open database");
  C._RegisterExtensionFunctions(ptr);
  const c = new Connection(ptr, file ?? null, raise);
  file?.connections.add(c);
  if (readOnly && file) withUTF8("PRAGMA query_only=1", (sql) => C._sqlite3_exec(ptr, sql, 0, 0, 0));
  collate(c, "UNICODE", "und", {});
  return c;
}
/** sqlite3_close_v2 leaves an unusable zombie while statements still need finalization. */
function closeConnection(h: bigint) {
  const c = conn(h);
  check(c, C._sqlite3_close_v2(c.ptr));
  c.closed = true;
  release(h);
  if (!c.statements.size) retiredConnection(c);
}

// ── statements: the long a PreparedStatement holds is the sqlite3_stmt pointer itself
const st = (h: bigint) => Number(h);
/** sqlite3_prepare_v2's statement, or the connection's exception with `message` */
function prepare(c: Connection, sql: string, message: string | null = null): bigint {
  if (withUTF8(sql, (text) => C._sqlite3_prepare_v2(c.ptr, text, -1, out, 0))) throw dbError(c, message);
  const pointer = int32At(out);
  if (pointer) { c.statements.add(pointer); statementOwners.set(pointer, c); }
  return BigInt(pointer);
}
/** finalize destroys the statement even when its result reports the previous evaluation error. */
function finalizeStatement(s: bigint) {
  const pointer = st(s), c = statementOwners.get(pointer);
  try { C._sqlite3_finalize(pointer); } finally {
    statementOwners.delete(pointer); c?.statements.delete(pointer);
    if (c?.closed && !c.statements.size) retiredConnection(c);
  }
}
const bindText = (s: number, i: number, value: string) => withUTF8(value, (text) => C._sqlite3_bind_text(s, i, text, -1, TRANSIENT));
function bindBlob(s: number, i: number, value: Int8Array): number {
  const data = C._malloc(value.length || 1);
  C.HEAPU8.set(u8(value), data);
  try { return C._sqlite3_bind_blob(s, i, data, value.length, TRANSIENT); } finally { C._free(data); }
}
/** both drivers' binders: [AOSP name, androidx name, value descriptor, bind] */
const BINDERS: [string, string, string, (s: number, i: number, v: never) => number][] = [
  ["Null", "Null", "", (s, i) => C._sqlite3_bind_blob(s, i, 0, 0, 0)],
  ["Long", "Long", "J", (s, i, v: bigint) => C._sqlite3_bind_int64(s, i, v)],
  ["Double", "Double", "D", (s, i, v: number) => C._sqlite3_bind_double(s, i, v)],
  ["String", "Text", "Ljava/lang/String;", bindText],
  ["Blob", "Blob", "[B", bindBlob],
];
function columnText(s: number, i: number): string | null {
  const text = C._sqlite3_column_text(s, i);
  return text ? C.UTF8ToString(text, C._sqlite3_column_bytes(s, i)) : null;
}
function columnBlob(s: number, i: number): Int8Array {
  const data = C._sqlite3_column_blob(s, i);
  return i8(C.HEAPU8.slice(data, data + C._sqlite3_column_bytes(s, i)));
}
const columnName = (s: number, i: number) => { const name = C._sqlite3_column_name(s, i); return name ? C.UTF8ToString(name) : null; };
/** sqlite3_step, interrupted as the progress handler interrupts a cancelled connection */
function step(c: Connection, s: number): number {
  if (c.cancelable && c.canceled) throw sqliteException(SQLITE_INTERRUPT, "interrupted");
  return C._sqlite3_step(s);
}
/** a statement that may have changed the file schedules its snapshot */
const stepped = (c: Connection, s: number) => { if (c.file && !C._sqlite3_stmt_readonly(s)) scheduleSave(c.file); };
function executeNonQuery(c: Connection, s: number, isPragma = false) {
  let rc = step(c, s);
  if (isPragma) while (rc === ROW) rc = step(c, s);
  stepped(c, s);
  if (rc === ROW) throw noHandle("Queries can be performed using SQLiteDatabase query or rawQuery methods only.");
  if (rc !== DONE) throw dbError(c);
}
function executeOneRowQuery(c: Connection, s: number): boolean {
  const rc = step(c, s);
  stepped(c, s);
  if (rc !== ROW) throw dbError(c);
  return C._sqlite3_column_count(s) >= 1;
}

/** copyRow: the statement's current row into the window's next one; false when it does not fit */
function copyRow(w: NativeWindow, s: number, cols: number): boolean {
  if (!w.allocRow()) return false;
  const row = w.rows - 1;
  for (let i = 0; i < cols; i++) {
    let fits = true;
    switch (C._sqlite3_column_type(s, i)) {
      case INTEGER: {
        const d = C._sqlite3_column_double(s, i);
        fits = w.put(row, i, FIELD_INTEGER, Number.isSafeInteger(d) ? d : C._sqlite3_column_int64(s, i));
        break;
      }
      case FLOAT: fits = w.put(row, i, FIELD_FLOAT, C._sqlite3_column_double(s, i)); break;
      case TEXT: { const text = columnText(s, i); fits = w.put(row, i, FIELD_STRING, text, C._sqlite3_column_bytes(s, i) + 1); break; }
      case BLOB: { const b = columnBlob(s, i); fits = w.put(row, i, FIELD_BLOB, b, b.length); break; }
    }
    if (!fits) { w.freeLastRow(); return false; }
  }
  return true;
}
/** nativeExecuteForCursorWindow: rows from startPos into the window, refilling from later rows when
 *  it fills before requiredPos, and counting every row on request; (startPos << 32) | totalRows */
function fillWindow(c: Connection, s: number, w: NativeWindow, startPos: number, requiredPos: number, countAllRows: number): bigint {
  if (w.readOnly) throw rt.mkThrowable("java/lang/IllegalStateException", "Failed to clear the cursor window, status=-38");
  const cols = C._sqlite3_column_count(s);
  w.clear(cols);
  let total = 0, added = 0, full = false;
  try {
    while (!full || countAllRows) {
      const rc = step(c, s);
      if (rc === DONE) break;
      if (rc !== ROW) throw dbError(c);
      if (startPos >= ++total || full) continue;
      let fits = copyRow(w, s, cols);
      if (!fits && added && startPos + added <= requiredPos) {
        // filled before the one row really wanted: start again from here
        w.clear(cols);
        startPos += added;
        added = 0;
        fits = copyRow(w, s, cols);
      }
      if (fits) added++; else full = true;
    }
  } finally {
    C._sqlite3_reset(s);
    stepped(c, s);
  }
  if (total > 0 && added === 0) throw sqliteException(SQLITE_TOOBIG, null, `Row too big to fit into CursorWindow requiredPos=${requiredPos}, totalRows=${total}`);
  return BigInt(startPos) << 32n | BigInt(total);
}

// ── the process boundary: a Worker's natives run in the broker (sqliteTransport), each process in a session
type SQLiteFamily = "platform" | "driver" | "connection" | "statement";
type SQLiteValue = number | bigint | string | null | Int8Array | void;
type WindowData = Pick<NativeWindow, "rows" | "cols" | "used" | "types" | "values">;
export type SQLiteRequest = { family: SQLiteFamily; method: string; args: SQLiteValue[];
  window?: Pick<NativeWindow, "name" | "size" | "readOnly"> };
export type SQLiteReply = { value: SQLiteValue; window?: WindowData; error?: CallFailure };
export const sqliteTransport = { call: null as ((request: SQLiteRequest) => Promise<SQLiteReply>) | null };
type NativeCall = (...args: never[]) => SQLiteValue | Promise<SQLiteValue>;
type Handle = "connection" | "statement" | "window";
/** what a native does to the handles a session keeps: opens a connection, prepares a statement, or ends either */
type Lifecycle = "open" | "prepare" | "close" | "finalize";
type Native = { call: NativeCall; arity: number; handles: Handle[]; lifecycle?: Lifecycle };
const sqliteNatives = new Map<SQLiteFamily, Map<string, Native>>();

/** Keep the owning native implementations available to the canonical service: a native's leading long arguments are
 *  the handles `handles` names in order, and `lifecycle` names those that make or end one. The client wrappers are
 *  suspending entries even for operations that are synchronous inside sql.js. */
function registerSQLite(family: SQLiteFamily, cls: string, handles: Handle[], lifecycle: Record<string, Lifecycle>, table: Record<string, NativeCall>) {
  const natives = new Map(Object.entries(table).map(([method, call]) => {
    const params = parseMethodDesc(method.slice(method.indexOf("("))).params, longs = params.findIndex(p => p !== "J");
    return [method, { call, arity: params.length, handles: handles.slice(0, longs < 0 ? params.length : longs), lifecycle: lifecycle[method] }];
  }));
  sqliteNatives.set(family, natives);
  rt.registerJnis(cls, Object.fromEntries([...natives].map(([method, { call, arity, handles }]) => {
    const at = handles.indexOf("window");
    return [method, driven(function* (...args: SQLiteValue[]) {
      args = args.slice(0, arity);
      if (!sqliteTransport.call) return yield* awaited(call(...args as never[]));
      const window = at < 0 ? null : deref<NativeWindow>(args[at] as bigint);
      const reply = yield* awaited(sqliteTransport.call({ family, method,
        args: window ? args.map((value, i) => i === at ? 0n : value) : args,
        ...(window ? { window: { name: window.name, size: window.size, readOnly: window.readOnly } } : {}) }));
      if (window && !window.readOnly && reply.window) Object.assign(window, reply.window);
      if (reply.error) throw javaFailure(reply.error);
      return reply.value;
    })];
  })));
}

let nextSQLiteToken = 1n;
/** A process owns opaque tokens, not another realm's JNI handles or SQLite pointers. */
export function createSQLiteSession() {
  const connections = new Map<bigint, bigint>();
  const statements = new Map<bigint, { pointer: bigint; connection: bigint }>();
  type Request = { request: SQLiteRequest; resolve(reply: SQLiteReply): void; reject(error: unknown): void };
  const queued: Request[] = [];
  let closed = false, active: Request | undefined, finishing = Promise.resolve();
  const dead = () => rt.mkThrowable("android/os/DeadObjectException", "SQLite session closed");
  const invalid = () => sqliteException(SQLITE_MISUSE, "Invalid SQLite session handle");
  const cleanup = () => {
    for (const [token, { pointer }] of statements) { statements.delete(token); finalizeStatement(pointer); }
    statements.clear();
    for (const h of connections.values()) closeConnection(h);
    connections.clear();
  };
  const run = async (request: SQLiteRequest): Promise<SQLiteReply> => {
    if (closed) throw dead();
    const native = sqliteNatives.get(request.family)?.get(request.method);
    if (!native) throw invalid();
    const args = [...request.args], { lifecycle } = native, finalize = lifecycle === "finalize";
    let connection: bigint | undefined, statement = 0n, window: NativeWindow | undefined, windowHandle: bigint | undefined;
    // a statement may be finalized after its connection closed
    native.handles.forEach((kind, i) => {
      const token = args[i] as bigint;
      if (kind === "connection") {
        const h = connections.get(connection = token);
        if (h === undefined && !finalize) throw invalid();
        args[i] = h ?? 0n;
      } else if (kind === "statement") {
        const owned = statements.get(statement = token);
        if (!owned || (connection === undefined ? !finalize && !connections.has(owned.connection) : owned.connection !== connection)) throw invalid();
        connection = owned.connection; args[i] = owned.pointer;
      } else {
        if (!request.window) throw invalid();
        window = new NativeWindow(request.window.name, request.window.size, request.window.readOnly);
        args[i] = windowHandle = handle(window);
      }
    });
    const windowData = (): WindowData => ({ rows: window!.rows, cols: window!.cols, used: window!.used, types: window!.types, values: window!.values });
    // Validation is complete. Ownership ends at finalize dispatch, even if it throws afterward.
    if (finalize) statements.delete(statement);
    try {
      const result = native.call(...args as never[]);
      let value = result instanceof Promise ? await result : result;
      if (lifecycle === "open") {
        if (closed) { closeConnection(value as bigint); throw dead(); }
        const token = nextSQLiteToken++;
        connections.set(token, value as bigint); value = token;
      } else if (lifecycle === "prepare" && value !== 0n) {
        const token = nextSQLiteToken++;
        statements.set(token, { pointer: value as bigint, connection: connection! }); value = token;
      } else if (lifecycle === "close") connections.delete(connection!);
      if (closed) throw dead();
      return { value, ...(window ? { window: windowData() } : {}) };
    } catch (error) {
      // Cursor filling mutates the window even when it throws (for example, an oversized row).
      if (!window) throw error;
      return { value: undefined, window: windowData(), error: callFailure(error) };
    } finally { if (windowHandle !== undefined) release(windowHandle); }
  };
  const pump = () => {
    if (closed || active) return;
    const job = queued.shift();
    if (!job) return;
    active = job;
    finishing = run(job.request).then(job.resolve, job.reject).then(() => {
      active = undefined; pump();
    });
  };
  return {
    call(request: SQLiteRequest): Promise<SQLiteReply> {
      if (closed) return Promise.reject(dead());
      return new Promise((resolve, reject) => { queued.push({ request, resolve, reject }); pump(); });
    },
    close(): Promise<void> {
      if (closed) return finishing;
      closed = true;
      active?.reject(dead());
      for (const job of queued.splice(0)) job.reject(dead());
      // An asynchronous open can still be loading its bytes; it closes its returned handle.
      // Only that in-flight operation retains its request after death.
      cleanup();
      return finishing;
    },
  };
}

// ── android.database.sqlite's natives (SQLiteConnection, SQLiteGlobal)
const OPEN_READONLY = 1, CREATE_IF_NECESSARY = 0x10000000;
registerSQLite("platform", "android/database/sqlite/SQLiteConnection", ["connection", "statement", "window"], {
  "nativeOpen(Ljava/lang/String;ILjava/lang/String;ZZII)J": "open", "nativeClose(J)V": "close",
  "nativePrepareStatement(JLjava/lang/String;)J": "prepare", "nativeFinalizeStatement(JJ)V": "finalize",
}, {
  "nativeOpen(Ljava/lang/String;ILjava/lang/String;ZZII)J": async (path: string, flags: number) => handle(await openConnection(path,
    (flags & OPEN_READONLY) !== 0 && !(flags & CREATE_IF_NECESSARY), (flags & CREATE_IF_NECESSARY) !== 0, sqliteException)),
  "nativeClose(J)V": closeConnection,
  "nativeRegisterLocalizedCollators(JLjava/lang/String;)V": (h: bigint, locale: string) =>
    collate(conn(h), "LOCALIZED", locale.replaceAll("_", "-"), { sensitivity: "base" }),
  "nativePrepareStatement(JLjava/lang/String;)J": (h: bigint, sql: string) => prepare(conn(h), sql, ", while compiling: " + sql),
  "nativeFinalizeStatement(JJ)V": (_h: bigint, s: bigint) => finalizeStatement(s),
  "nativeGetParameterCount(JJ)I": (_h: bigint, s: bigint) => C._sqlite3_bind_parameter_count(st(s)),
  "nativeIsReadOnly(JJ)Z": (_h: bigint, s: bigint) => C._sqlite3_stmt_readonly(st(s)),
  "nativeGetColumnCount(JJ)I": (_h: bigint, s: bigint) => C._sqlite3_column_count(st(s)),
  "nativeGetColumnName(JJI)Ljava/lang/String;": (_h: bigint, s: bigint, i: number) => columnName(st(s), i),
  ...Object.fromEntries(BINDERS.map(([name, , desc, bind]) =>
    [`nativeBind${name}(JJI${desc})V`, (h: bigint, s: bigint, i: number, v: never) => check(conn(h), bind(st(s), i, v))])),
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
const androidx: Raise = (code, sqliteMessage) => rt.mkThrowable("android/database/SQLException", `Error code: ${code}, message: ${sqliteMessage}`);
const owner = (s: bigint) => {
  const c = statementOwners.get(st(s));
  if (!c || c.closed) throw androidx(SQLITE_MISUSE, "statement connection is closed");
  return c;
};
/** throwIfNoRow and throwIfInvalidColumn, which guard the column getters */
function column(s: bigint, i: number, row = true): number {
  owner(s);
  const p = st(s);
  if (row && !C._sqlite3_stmt_busy(p)) throw androidx(SQLITE_MISUSE, "no row");
  if (i < 0 || i >= C._sqlite3_column_count(p)) throw androidx(SQLITE_RANGE, "column index out of range");
  return p;
}
rt.claimNativeLib("sqliteJni");
registerSQLite("driver", "androidx/sqlite/driver/bundled/BundledSQLiteDriverKt", [], { "nativeOpen(Ljava/lang/String;I)J": "open" }, {
  "nativeThreadSafeMode()I": () => 0,
  "nativeOpen(Ljava/lang/String;I)J": async (name: string, flags: number) =>
    handle(await openConnection(name || ":memory:", (flags & 3) === 1, (flags & 6) === 6, androidx)),
});
registerSQLite("connection", "androidx/sqlite/driver/bundled/BundledSQLiteConnectionKt", ["connection"],
  { "nativePrepare(JLjava/lang/String;)J": "prepare", "nativeClose(J)V": "close" }, {
  "nativePrepare(JLjava/lang/String;)J": (h: bigint, sql: string) => prepare(conn(h), sql),
  "nativeClose(J)V": closeConnection,
  "nativeInTransaction(J)Z": (h: bigint) => +!C._sqlite3_get_autocommit(conn(h).ptr),
  "nativeLoadExtension(JLjava/lang/String;Ljava/lang/String;)V": () => { throw androidx(1, "not authorized"); },
});
registerSQLite("statement", "androidx/sqlite/driver/bundled/BundledSQLiteStatementKt", ["statement"], { "nativeClose(J)V": "finalize" }, {
  ...Object.fromEntries(BINDERS.map(([, name, desc, bind]) =>
    [`nativeBind${name}(JI${desc})V`, (s: bigint, i: number, v: never) => check(owner(s), bind(st(s), i, v))])),
  "nativeClearBindings(J)V": (s: bigint) => check(owner(s), C._sqlite3_clear_bindings(st(s))),
  "nativeStep(J)Z": (s: bigint) => {
    const c = owner(s), rc = step(c, st(s));
    stepped(c, st(s));
    if (rc !== ROW && rc !== DONE) throw dbError(c);
    return +(rc === ROW);
  },
  "nativeReset(J)V": (s: bigint) => check(owner(s), C._sqlite3_reset(st(s))),
  "nativeClose(J)V": finalizeStatement,
  "nativeGetColumnCount(J)I": (s: bigint) => { owner(s); return C._sqlite3_column_count(st(s)); },
  "nativeGetColumnName(JI)Ljava/lang/String;": (s: bigint, i: number) => columnName(column(s, i, false), i),
  "nativeGetColumnType(JI)I": (s: bigint, i: number) => C._sqlite3_column_type(column(s, i), i),
  "nativeGetLong(JI)J": (s: bigint, i: number) => C._sqlite3_column_int64(column(s, i), i),
  "nativeGetDouble(JI)D": (s: bigint, i: number) => C._sqlite3_column_double(column(s, i), i),
  "nativeGetText(JI)Ljava/lang/String;": (s: bigint, i: number) => columnText(column(s, i), i) ?? "",
  "nativeGetBlob(JI)[B": (s: bigint, i: number) => columnBlob(column(s, i), i),
});
