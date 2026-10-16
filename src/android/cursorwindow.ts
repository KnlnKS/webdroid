// android.database.CursorWindow's native half (android_database_CursorWindow.cpp): a window of
// typed fields behind the long in mWindowPtr, filled by SQLiteConnection.nativeExecuteForCursorWindow
// or the Java putters, and serialized into a Parcel in our own layout (both ends are ours); and the
// SQLiteException mapping both share (android_database_SQLiteCommon.cpp).

import { rt, declaredField, type JObj } from "../jvm/runtime.ts";
import { utf8, utf8Length } from "../jvm/abi.ts";
import { ownedHandle, deref, release } from "./handles.ts";
import { readInt, readLong, readDouble, readString, writeInt, writeLong, writeDouble, writeString, writeByteArray, createByteArray, nativeParcel, outOfLine,
  type NativeParcel } from "./parcel.ts";

// ── errors, as throw_sqlite3_exception raises them
export const SQLITE_BUSY = 5, SQLITE_LOCKED = 6, SQLITE_INTERRUPT = 9, SQLITE_CANTOPEN = 14, SQLITE_TOOBIG = 18, SQLITE_CONSTRAINT = 19,
  SQLITE_MISUSE = 21, SQLITE_RANGE = 25, SQLITE_ROW = 100, SQLITE_DONE = 101;
const CODES = ["OK", "ERROR", "INTERNAL", "PERM", "ABORT", "BUSY", "LOCKED", "NOMEM", "READONLY", "INTERRUPT", "IOERR", "CORRUPT",
  "NOTFOUND", "FULL", "CANTOPEN", "PROTOCOL", "EMPTY", "SCHEMA", "TOOBIG", "CONSTRAINT", "MISMATCH", "MISUSE", "NOLFS", "AUTH",
  "FORMAT", "RANGE", "NOTADB", "NOTICE", "WARNING"];
const CONSTRAINTS = ["", "CHECK", "COMMITHOOK", "FOREIGNKEY", "FUNCTION", "NOTNULL", "PRIMARYKEY", "TRIGGER", "UNIQUE", "VTAB", "ROWID", "PINNED", "DATATYPE"];
const SQL = "android/database/sqlite/";
const EXCEPTIONS: Record<string, string> = {
  PERM: SQL + "SQLiteAccessPermException", ABORT: SQL + "SQLiteAbortException", BUSY: SQL + "SQLiteDatabaseLockedException",
  LOCKED: SQL + "SQLiteTableLockedException", NOMEM: SQL + "SQLiteOutOfMemoryException", READONLY: SQL + "SQLiteReadOnlyDatabaseException",
  INTERRUPT: "android/os/OperationCanceledException", IOERR: SQL + "SQLiteDiskIOException", CORRUPT: SQL + "SQLiteDatabaseCorruptException",
  FULL: SQL + "SQLiteFullException", CANTOPEN: SQL + "SQLiteCantOpenDatabaseException", TOOBIG: SQL + "SQLiteBlobTooBigException",
  CONSTRAINT: SQL + "SQLiteConstraintException", MISMATCH: SQL + "SQLiteDatatypeMismatchException", MISUSE: SQL + "SQLiteMisuseException",
  RANGE: SQL + "SQLiteBindOrColumnIndexOutOfRangeException", NOTADB: SQL + "SQLiteDatabaseCorruptException", DONE: SQL + "SQLiteDoneException",
};
export function sqliteException(code: number, sqliteMessage: string | null, message: string | null = null): unknown {
  const primary = code & 0xff, name = primary === SQLITE_ROW ? "ROW" : primary === SQLITE_DONE ? "DONE" : CODES[primary] ?? "UNKNOWN";
  const constraint = primary === SQLITE_CONSTRAINT && code >> 8 ? "_" + CONSTRAINTS[code >> 8] : "";
  return rt.mkThrowable(EXCEPTIONS[name] ?? SQL + "SQLiteException", sqliteMessage === null || primary === SQLITE_DONE ? message
    : `${sqliteMessage} (code ${code} SQLITE_${name}${constraint}[${code}])${message ? ": " + message : ""}`);
}
/** throw_sqlite3_exception without a database handle */
export const noHandle = (message: string) => sqliteException(0, "unknown error", message);

const FIELD_NULL = 0;
export const FIELD_INTEGER = 1, FIELD_FLOAT = 2, FIELD_STRING = 3, FIELD_BLOB = 4;
/** an INTEGER field holds a number while it is exact, else the bigint */
type Value = null | number | bigint | string | Int8Array;
// CursorWindow.cpp's accounting: a 16-byte field slot per column per row, values over the 8 inline bytes out of line
const SLOT = 16, INLINE = 8;

export class NativeWindow {
  readonly name: string; readonly size: number; readonly readOnly;
  rows = 0;
  cols = 0;
  used = 0;
  types: number[] = [];
  values: Value[] = [];
  constructor(name: string, size: number, readOnly = false) { this.name = name; this.size = size; this.readOnly = readOnly; }
  clear(cols = 0) { this.rows = this.used = 0; this.cols = cols; this.types.length = this.values.length = 0; }
  allocRow(): boolean {
    const used = this.used + this.cols * SLOT;
    if (this.readOnly || used > this.size) return false;
    this.used = used;
    for (let i = 0; i < this.cols; i++) { this.types.push(FIELD_NULL); this.values.push(null); }
    this.rows++;
    return true;
  }
  freeLastRow() {
    if (this.readOnly || !this.rows) return;
    this.rows--;
    this.types.length = this.values.length = this.rows * this.cols;
  }
  /** store a field of `bytes` out-of-line bytes; false when the window is full */
  put(row: number, col: number, type: number, value: Value, bytes = 0): boolean {
    if (this.readOnly || row < 0 || row >= this.rows || col < 0 || col >= this.cols) return false;
    if (bytes > INLINE) {
      if (this.used + bytes > this.size) return false;
      this.used += bytes;
    }
    const i = row * this.cols + col;
    this.types[i] = type;
    this.values[i] = value;
    return true;
  }
  /** the field's index, or the IllegalStateException a missing slot throws */
  slot(row: number, col: number): number {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) throw rt.mkThrowable("java/lang/IllegalStateException",
      `Couldn't read row ${row}, col ${col} from CursorWindow.  Make sure the Cursor is initialized correctly before accessing data from it.`);
    return row * this.cols + col;
  }
  writeTo(p: NativeParcel) {
    const at = p.pos;
    writeString(p, this.name);
    for (const n of [this.size, this.used, this.rows, this.cols]) writeInt(p, n);
    for (let i = 0; i < this.types.length; i++) {
      const type = this.types[i], v = this.values[i];
      writeInt(p, type);
      if (type === FIELD_INTEGER) writeLong(p, BigInt(v as number | bigint));
      else if (type === FIELD_FLOAT) writeDouble(p, v as number);
      else if (type === FIELD_STRING) writeString(p, v as string);
      else if (type === FIELD_BLOB) writeByteArray(p, v as Int8Array);
    }
    outOfLine(p, at);
  }
  static fromParcel(p: NativeParcel): NativeWindow {
    const w = new NativeWindow(readString(p) ?? "", readInt(p), true);
    w.used = readInt(p);
    w.rows = readInt(p);
    w.cols = readInt(p);
    if (w.rows < 0 || w.cols < 0) throw rt.mkThrowable("android/os/BadParcelableException", "Invalid CursorWindow dimensions");
    for (let i = w.rows * w.cols; i > 0; i--) {
      const type = readInt(p);
      w.types.push(type);
      w.values.push(type === FIELD_INTEGER ? integer(readLong(p)) : type === FIELD_FLOAT ? readDouble(p) : type === FIELD_STRING ? readString(p)
        : type === FIELD_BLOB ? createByteArray(p) ?? new Int8Array(0) : null);
    }
    return w;
  }
}

const window = (h: bigint) => deref<NativeWindow>(h);

/** printf's %g, which nativeGetString formats a FLOAT field with */
function formatG(d: number): string {
  if (!Number.isFinite(d)) return Number.isNaN(d) ? "nan" : d > 0 ? "inf" : "-inf";
  if (d === 0) return Object.is(d, -0) ? "-0" : "0";
  const [mantissa, exp] = d.toExponential(5).split("e"), x = Number(exp);
  const trim = (s: string) => s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  if (x < -4 || x >= 6) return `${trim(mantissa)}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`;
  return trim(d.toFixed(5 - x));
}
const LLONG = 2n ** 63n;
/** strtoll(s, NULL, 0): the leading integer in base 10, 16 (0x) or 8 (0), saturating */
function strtoll(s: string): bigint {
  const m = /^[\t\n\v\f\r ]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(s);
  if (!m) return 0n;
  const digits = m[2], v = BigInt(digits.length > 1 && digits[0] === "0" && !/[xX]/.test(digits) ? "0o" + digits.slice(1) : digits);
  return m[1] === "-" ? (v > LLONG ? -LLONG : -v) : v >= LLONG ? LLONG - 1n : v;
}
/** strtod(s, NULL): the leading decimal number, infinity or nan */
function strtod(s: string): number {
  const m = /^[\t\n\v\f\r ]*([+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan))/i.exec(s);
  if (!m) return 0;
  const t = m[1].toLowerCase().replace("infinity", "inf");
  return t.endsWith("inf") ? (t[0] === "-" ? -Infinity : Infinity) : t.endsWith("nan") ? NaN : Number(t);
}
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** an INTEGER field's value as the window holds it */
const integer = (v: bigint): number | bigint => v >= -SAFE && v <= SAFE ? Number(v) : v;
/** nativeGetString's conversions, which nativeCopyStringToBuffer shares */
function fieldText(w: NativeWindow, row: number, col: number): string | null {
  const i = w.slot(row, col), v = w.values[i];
  switch (w.types[i]) {
    case FIELD_STRING: case FIELD_INTEGER: return String(v);
    case FIELD_FLOAT: return formatG(v as number);
    case FIELD_BLOB: throw noHandle("Unable to convert BLOB to string");
    default: return null;
  }
}
const putter = (type: number, size: (v: never) => number) => (h: bigint, value: never, row: number, col: number) =>
  +window(h).put(row, col, type, value, size(value));

rt.registerJnis("android/database/CursorWindow", {
  "nativeCreate(Ljava/lang/String;I)J": (name: string, size: number) => size < 0 ? 0n : ownedHandle(new NativeWindow(name, size)),
  "nativeDispose(J)V": (h: bigint) => release(h),
  "nativeGetName(J)Ljava/lang/String;": (h: bigint) => window(h).name,
  "nativeClear(J)V": (h: bigint) => { const w = window(h); if (!w.readOnly) w.clear(); },
  "nativeGetNumRows(J)I": (h: bigint) => window(h).rows,
  "nativeSetNumColumns(JI)Z": (h: bigint, n: number) => {
    const w = window(h);
    if (w.readOnly || ((w.cols > 0 || w.rows > 0) && w.cols !== n)) return 0;
    w.cols = n;
    return 1;
  },
  "nativeAllocRow(J)Z": (h: bigint) => +window(h).allocRow(),
  "nativeFreeLastRow(J)V": (h: bigint) => window(h).freeLastRow(),
  "nativeGetType(JII)I": (h: bigint, row: number, col: number) => { const w = window(h); return w.types[w.slot(row, col)]; },
  "nativeGetBlob(JII)[B": (h: bigint, row: number, col: number) => {
    const w = window(h), i = w.slot(row, col), v = w.values[i];
    switch (w.types[i]) {
      case FIELD_BLOB: return (v as Int8Array).slice();
      // a STRING field's bytes are its UTF-8 and the terminating NUL
      case FIELD_STRING: { const b = utf8.enc.encode(v as string), out = new Int8Array(b.length + 1); out.set(b); return out; }
      case FIELD_INTEGER: throw noHandle("INTEGER data in nativeGetBlob ");
      case FIELD_FLOAT: throw noHandle("FLOAT data in nativeGetBlob ");
      default: return null;
    }
  },
  "nativeGetString(JII)Ljava/lang/String;": (h: bigint, row: number, col: number) => fieldText(window(h), row, col),
  "nativeCopyStringToBuffer(JIILandroid/database/CharArrayBuffer;)V": (h: bigint, row: number, col: number, buffer: Record<string, unknown>) => {
    const text = fieldText(window(h), row, col) ?? "", field = declaredField("android/database/CharArrayBuffer", "data");
    let data = buffer[field] as Uint16Array | null;
    if (!data || data.length < text.length) buffer[field] = data = new Uint16Array(text.length);
    for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i);
    buffer[declaredField("android/database/CharArrayBuffer", "sizeCopied")] = text.length;
  },
  "nativeGetLong(JII)J": (h: bigint, row: number, col: number) => {
    const w = window(h), i = w.slot(row, col), v = w.values[i];
    switch (w.types[i]) {
      case FIELD_INTEGER: return typeof v === "bigint" ? v : BigInt(v as number);
      case FIELD_FLOAT: return BigInt.asIntN(64, BigInt(Math.trunc(v as number)));
      case FIELD_STRING: return strtoll(v as string);
      case FIELD_BLOB: throw noHandle("Unable to convert BLOB to long");
      default: return 0n;
    }
  },
  "nativeGetDouble(JII)D": (h: bigint, row: number, col: number) => {
    const w = window(h), i = w.slot(row, col), v = w.values[i];
    switch (w.types[i]) {
      case FIELD_FLOAT: case FIELD_INTEGER: return Number(v);
      case FIELD_STRING: return strtod(v as string);
      case FIELD_BLOB: throw noHandle("Unable to convert BLOB to double");
      default: return 0;
    }
  },
  "nativePutBlob(J[BII)Z": putter(FIELD_BLOB, (v: Int8Array) => v.length),
  "nativePutString(JLjava/lang/String;II)Z": putter(FIELD_STRING, (v: string) => utf8Length(v) + 1),
  "nativePutLong(JJII)Z": (h: bigint, v: bigint, row: number, col: number) =>
    +window(h).put(row, col, FIELD_INTEGER, integer(v)),
  "nativePutDouble(JDII)Z": putter(FIELD_FLOAT, () => 0),
  "nativePutNull(JII)Z": (h: bigint, row: number, col: number) => +window(h).put(row, col, FIELD_NULL, null),
  "nativeWriteToParcel(JLandroid/os/Parcel;)V": (h: bigint, parcel: JObj) => window(h).writeTo(nativeParcel(parcel)),
  "nativeCreateFromParcel(Landroid/os/Parcel;)J": (parcel: JObj) => ownedHandle(NativeWindow.fromParcel(nativeParcel(parcel))),
});
