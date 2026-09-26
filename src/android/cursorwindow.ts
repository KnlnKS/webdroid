import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { i8 } from "../jvm/abi";
import { parcelCreator, readInt, readString, writeInt, writeString, type JParcel } from "./parcel";
import { vcall } from "../jvm/natives/jlang";

class JSQLiteClosable extends JObj {
  references = 1;
  onReleased() {}
  release() { if (this.references > 0 && --this.references === 0) this.onReleased(); }
}
rt.register({
  name: "android/database/sqlite/SQLiteClosable", ctor: JSQLiteClosable, ifaces: ["java/io/Closeable"],
  methods: {
    "acquireReference()V": function (this: JSQLiteClosable) {
      if (this.references <= 0) throw rt.mkThrowable("java/lang/IllegalStateException", "attempt to re-open an already-closed object");
      this.references++;
    },
    "releaseReference()V": function (this: JSQLiteClosable) { this.release(); },
    "releaseReferenceFromContainer()V": function (this: JSQLiteClosable) { this.release(); },
    "close()V": function (this: JSQLiteClosable) { this.release(); },
  },
});

type Cell = null | string | number | bigint | Int8Array;
class JCursorWindow extends JSQLiteClosable {
  name: string | null = null;
  start = 0;
  columns = 0;
  rows: Cell[][] = [];
  readOnly = false;
  onReleased() { this.rows = []; }
  cell(row: number, column: number): Cell {
    if (this.references <= 0) throw rt.mkThrowable("java/lang/IllegalStateException", "CursorWindow is closed");
    const value = this.rows[row - this.start]?.[column];
    if (value === undefined) throw rt.mkThrowable("java/lang/IllegalStateException", `Couldn't read row ${row}, column ${column} from CursorWindow`);
    return value;
  }
  put(value: Cell, row: number, column: number): number {
    if (this.references <= 0) throw rt.mkThrowable("java/lang/IllegalStateException", "CursorWindow is closed");
    if (this.readOnly || row < this.start || row >= this.start + this.rows.length || column < 0 || column >= this.columns) return 0;
    this.rows[row - this.start][column] = value;
    return 1;
  }
}
const numeric = (value: Cell): number => {
  if (value instanceof Int8Array) throw rt.mkThrowable("android/database/sqlite/SQLiteException", "Cannot convert blob to number");
  return value === null ? 0 : typeof value === "string" ? Number.parseFloat(value) || 0 : Number(value);
};
const text = (value: Cell): string | null => {
  if (value === null) return null;
  if (value instanceof Int8Array) throw rt.mkThrowable("android/database/sqlite/SQLiteException", "Cannot convert blob to string");
  return String(value);
};
const cellType = (value: Cell): number => value === null ? 0
  : typeof value === "bigint" || typeof value === "number" && Number.isInteger(value) ? 1
    : typeof value === "number" ? 2 : typeof value === "string" ? 3 : 4;
async function fromParcel(parcel: JParcel): Promise<JCursorWindow> {
  rt.link("android/database/CursorWindow");
  const window = new JCursorWindow();
  window.start = readInt(parcel);
  window.columns = readInt(parcel);
  const count = readInt(parcel);
  if (window.columns < 0 || count < 0) throw rt.mkThrowable("android/os/BadParcelableException", "Invalid CursorWindow dimensions");
  window.readOnly = true;
  for (let row = 0; row < count; row++) {
    const values: Cell[] = [];
    for (let col = 0; col < window.columns; col++) {
      switch (readInt(parcel)) {
        case 0: values.push(null); break;
        case 1: values.push(await vcall(parcel, "readLong", "()J") as bigint); break;
        case 2: values.push(await vcall(parcel, "readDouble", "()D") as number); break;
        case 3: values.push(readString(parcel)); break;
        case 4: values.push(await vcall(parcel, "createByteArray", "()[B") as Int8Array); break;
        default: throw rt.mkThrowable("android/os/BadParcelableException", "Invalid CursorWindow cell type");
      }
    }
    window.rows.push(values);
  }
  return window;
}
rt.register({
  name: "android/database/CursorWindow", ctor: JCursorWindow, sup: "android/database/sqlite/SQLiteClosable",
  ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/database/CursorWindow", fromParcel); } },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JCursorWindow, name: string | null) { this.name = name; },
    "<init>(Ljava/lang/String;Z)V": function (this: JCursorWindow, name: string | null) { this.name = name; },
    "<init>(Ljava/lang/String;J)V": function (this: JCursorWindow, name: string | null) { this.name = name; },
    "<init>(Z)V": function () {},
    "getName()Ljava/lang/String;": function (this: JCursorWindow) { return this.name; },
    "getStartPosition()I": function (this: JCursorWindow) { return this.start; },
    "setStartPosition(I)V": function (this: JCursorWindow, pos: number) { this.start = pos; },
    "getNumRows()I": function (this: JCursorWindow) { return this.rows.length; },
    "getNumColumns()I": function (this: JCursorWindow) { return this.columns; },
    "setNumColumns(I)Z": function (this: JCursorWindow, count: number) {
      if (this.readOnly || count < 0 || (this.rows.length > 0 && this.columns !== count)) return 0;
      this.columns = count;
      return 1;
    },
    "allocRow()Z": function (this: JCursorWindow) {
      if (this.readOnly) return 0;
      this.rows.push(Array(this.columns).fill(null));
      return 1;
    },
    "freeLastRow()V": function (this: JCursorWindow) { if (!this.readOnly) this.rows.pop(); },
    "clear()V": function (this: JCursorWindow) { if (!this.readOnly) { this.rows = []; this.columns = 0; this.start = 0; } },
    "getType(II)I": function (this: JCursorWindow, row: number, col: number) {
      return cellType(this.cell(row, col));
    },
    "isNull(II)Z": function (this: JCursorWindow, row: number, col: number) { return +(this.cell(row, col) === null); },
    "getString(II)Ljava/lang/String;": function (this: JCursorWindow, row: number, col: number) { return text(this.cell(row, col)); },
    "getBlob(II)[B": function (this: JCursorWindow, row: number, col: number) {
      const value = this.cell(row, col);
      if (value === null) return null;
      return value instanceof Int8Array ? value.slice() : i8(new TextEncoder().encode(text(value)!));
    },
    "getLong(II)J": function (this: JCursorWindow, row: number, col: number) {
      const value = this.cell(row, col);
      return typeof value === "bigint" ? value : BigInt(Math.trunc(numeric(value)));
    },
    "getInt(II)I": function (this: JCursorWindow, row: number, col: number) { return numeric(this.cell(row, col)) | 0; },
    "getShort(II)S": function (this: JCursorWindow, row: number, col: number) { return numeric(this.cell(row, col)) << 16 >> 16; },
    "getDouble(II)D": function (this: JCursorWindow, row: number, col: number) { return numeric(this.cell(row, col)); },
    "getFloat(II)F": function (this: JCursorWindow, row: number, col: number) { return Math.fround(numeric(this.cell(row, col))); },
    "putNull(II)Z": function (this: JCursorWindow, row: number, col: number) { return this.put(null, row, col); },
    "putString(Ljava/lang/String;II)Z": function (this: JCursorWindow, value: string, row: number, col: number) { return this.put(value, row, col); },
    "putLong(JII)Z": function (this: JCursorWindow, value: bigint, row: number, col: number) { return this.put(value, row, col); },
    "putDouble(DII)Z": function (this: JCursorWindow, value: number, row: number, col: number) { return this.put(value, row, col); },
    "putBlob([BII)Z": function (this: JCursorWindow, value: Int8Array, row: number, col: number) { return this.put(value.slice(), row, col); },
    "describeContents()I": () => 0,
    "static newFromParcel(Landroid/os/Parcel;)Landroid/database/CursorWindow;": fromParcel,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JCursorWindow, parcel: JParcel, flags: number): Gen {
      writeInt(parcel, this.start);
      writeInt(parcel, this.columns);
      writeInt(parcel, this.rows.length);
      for (const row of this.rows) for (const value of row) {
        const tag = cellType(value);
        writeInt(parcel, tag);
        if (tag === 1) yield vcall(parcel, "writeLong", "(J)V", typeof value === "bigint" ? value : BigInt(value as number));
        else if (tag === 2) yield vcall(parcel, "writeDouble", "(D)V", value);
        else if (tag === 3) writeString(parcel, value as string);
        else if (tag === 4) yield vcall(parcel, "writeByteArray", "([B)V", value);
      }
      if (flags & 1) yield vcall(this, "releaseReference", "()V");
    }),
  },
});
