// android.database.AbstractCursor and AbstractWindowedCursor, as AOSP writes them: the base
// that bytecode cursors extend. SQLCipher's SQLiteCursor is one — it reads mPos and mWindow and
// fills its CursorWindow from native code — so the fields are shared with subclass bytecode.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { vcall, newObj, defineException } from "../jvm/natives/jlang";
import { toJsArray, newArrayList } from "../jvm/natives/jutil";
import { JBundle } from "./os";

const S = "Ljava/lang/String;", URI = "Landroid/net/Uri;", CR = "Landroid/content/ContentResolver;";
const OBSERVER = "Landroid/database/ContentObserver;";
defineException("android/database/CursorIndexOutOfBoundsException", "java/lang/IndexOutOfBoundsException", [], {
  "<init>(II)V": function (this: JObj, index: number, size: number) {
    return vcall(this, "<init>", `(${S})V`, `Index ${index} requested, with a size of ${size}`);
  },
});
defineException("android/database/StaleDataException", "java/lang/RuntimeException");

rt.register({ name: "android/database/CrossProcessCursor", ctor: class extends JObj {}, ifaces: ["android/database/Cursor"] });
export class JAbstractCursor extends JObj {
  mPos = -1;
  mClosed = 0;
  mContentResolver: JObj | null = null;
  contentObservable: JObj | null = null;
  dataSetObservable: JObj | null = null;
  selfObserver: JObj | null = null;
  selfObserverRegistered = false;
  notifyUris: JObj | null = null;
  extras: JObj = new JBundle();
}
// CharArrayBuffer: the caller's reusable char[] a text column is copied into, grown when it is short
class JCharArrayBuffer extends JObj { data: Uint16Array | null = null; sizeCopied = 0; }
rt.register({
  name: "android/database/CharArrayBuffer", ctor: JCharArrayBuffer, fields: ["data", "sizeCopied"],
  methods: {
    "<init>(I)V": function (this: JCharArrayBuffer, n: number) { this.data = new Uint16Array(n); },
    "<init>([C)V": function (this: JCharArrayBuffer, chars: Uint16Array) { this.data = chars; },
  },
});
class JAbstractWindowedCursor extends JAbstractCursor { mWindow: JObj | null = null; }
class JSelfContentObserver extends JObj { cursor: JAbstractCursor | null = null; }

const count = (c: JObj): Promise<number> | number => vcall(c, "getCount", "()I");
const observables = driven(function* observables(c: JAbstractCursor): Gen<void> {
  c.contentObservable ??= yield newObj("android/database/ContentObservable");
  c.dataSetObservable ??= yield newObj("android/database/DataSetObservable");
});
const moveToPosition = driven(function* moveToPosition(c: JAbstractCursor, position: number): Gen<number> {
  const n: number = yield count(c);
  if (position >= n) { c.mPos = n; return 0; }
  if (position < 0) { c.mPos = -1; return 0; }
  if (position === c.mPos) return 1;
  const moved: number = yield vcall(c, "onMove", "(II)Z", c.mPos, position);
  c.mPos = moved ? position : -1;
  return moved;
});
const unregisterSelf = driven(function* unregisterSelf(c: JAbstractCursor): Gen<void> {
  if (c.selfObserver && c.selfObserverRegistered) {
    yield vcall(c.mContentResolver, "unregisterContentObserver", `(${OBSERVER})V`, c.selfObserver);
    c.selfObserverRegistered = false;
  }
});
const onDeactivateOrClose = driven(function* (this: JAbstractCursor): Gen<void> {
  yield unregisterSelf(this);
  yield observables(this);
  yield vcall(this.dataSetObservable, "notifyInvalidated", "()V");
});
const checkPosition = driven(function* (this: JAbstractCursor): Gen<void> {
  const n: number = yield count(this);
  if (this.mPos === -1 || this.mPos === n) throw yield newObj("android/database/CursorIndexOutOfBoundsException", "(II)V", this.mPos, n);
});
const columnIndex = driven(function* (this: JAbstractCursor, name: string): Gen<number> {
  const dot = name.lastIndexOf(".");
  if (dot !== -1) name = name.slice(dot + 1);
  const columns = (yield vcall(this, "getColumnNames", `()[${S}`)) as string[];
  const want = name.toLowerCase();
  return columns.findIndex((column) => column.toLowerCase() === want);
});

rt.register({
  name: "android/database/AbstractCursor", ctor: JAbstractCursor, ifaces: ["android/database/CrossProcessCursor", "android/database/Cursor"],
  fields: ["mPos", "mClosed", "mContentResolver"],
  methods: {
    "<init>()V": function () {},
    "getType(I)I": () => 3,
    "getBlob(I)[B": () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", "getBlob is not supported"); },
    "getWindow()Landroid/database/CursorWindow;": () => null,
    "getColumnCount()I": driven(function* (this: JAbstractCursor): Gen {
      return ((yield vcall(this, "getColumnNames", `()[${S}`)) as string[]).length;
    }),
    "deactivate()V": function (this: JAbstractCursor) { return vcall(this, "onDeactivateOrClose", "()V"); },
    "onDeactivateOrClose()V": onDeactivateOrClose,
    "requery()Z": driven(function* (this: JAbstractCursor): Gen {
      if (this.selfObserver && !this.selfObserverRegistered) yield registerSelf(this);
      yield observables(this);
      yield vcall(this.dataSetObservable, "notifyChanged", "()V");
      return 1;
    }),
    "isClosed()Z": function (this: JAbstractCursor) { return this.mClosed; },
    "close()V": driven(function* (this: JAbstractCursor): Gen {
      this.mClosed = 1;
      yield observables(this);
      yield vcall(this.contentObservable, "unregisterAll", "()V");
      yield vcall(this, "onDeactivateOrClose", "()V");
    }),
    "onMove(II)Z": () => 1,
    "copyStringToBuffer(ILandroid/database/CharArrayBuffer;)V": driven(function* (this: JAbstractCursor, column: number, buffer: JCharArrayBuffer): Gen {
      const text = (yield vcall(this, "getString", `(I)${S}`, column)) as string | null;
      if (text === null) { buffer.sizeCopied = 0; return; }
      if (!buffer.data || buffer.data.length < text.length) buffer.data = new Uint16Array(text.length);
      for (let i = 0; i < text.length; i++) buffer.data[i] = text.charCodeAt(i);
      buffer.sizeCopied = text.length;
    }),
    "getPosition()I": function (this: JAbstractCursor) { return this.mPos; },
    "moveToPosition(I)Z": function (this: JAbstractCursor, position: number) { return moveToPosition(this, position); },
    "fillWindow(ILandroid/database/CursorWindow;)V": function (this: JAbstractCursor, position: number, window: JObj) {
      return vcall(rt.link("android/database/DatabaseUtils").ctor, "cursorFillWindow", "(Landroid/database/Cursor;ILandroid/database/CursorWindow;)V", this, position, window);
    },
    "move(I)Z": function (this: JAbstractCursor, offset: number) { return moveToPosition(this, this.mPos + offset); },
    "moveToFirst()Z": function (this: JAbstractCursor) { return moveToPosition(this, 0); },
    "moveToLast()Z": driven(function* (this: JAbstractCursor): Gen { return yield moveToPosition(this, (yield count(this)) - 1); }),
    "moveToNext()Z": function (this: JAbstractCursor) { return moveToPosition(this, this.mPos + 1); },
    "moveToPrevious()Z": function (this: JAbstractCursor) { return moveToPosition(this, this.mPos - 1); },
    "isFirst()Z": driven(function* (this: JAbstractCursor): Gen { return +(this.mPos === 0 && (yield count(this)) !== 0); }),
    "isLast()Z": driven(function* (this: JAbstractCursor): Gen { const n = yield count(this); return +(this.mPos === n - 1 && n !== 0); }),
    "isBeforeFirst()Z": driven(function* (this: JAbstractCursor): Gen { return +((yield count(this)) === 0 || this.mPos === -1); }),
    "isAfterLast()Z": driven(function* (this: JAbstractCursor): Gen { const n = yield count(this); return +(n === 0 || this.mPos === n); }),
    "getColumnIndex(Ljava/lang/String;)I": columnIndex,
    "getColumnIndexOrThrow(Ljava/lang/String;)I": driven(function* (this: JAbstractCursor, name: string): Gen {
      const index: number = yield vcall(this, "getColumnIndex", `(${S})I`, name);
      if (index >= 0) return index;
      const columns = (yield vcall(this, "getColumnNames", `()[${S}`)) as string[];
      throw rt.mkThrowable("java/lang/IllegalArgumentException", `column '${name}' does not exist. Available columns: [${columns.join(", ")}]`);
    }),
    "getColumnName(I)Ljava/lang/String;": driven(function* (this: JAbstractCursor, i: number): Gen {
      const columns = (yield vcall(this, "getColumnNames", `()[${S}`)) as string[];
      if (i < 0 || i >= columns.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", `length=${columns.length}; index=${i}`);
      return columns[i];
    }),
    "registerContentObserver(Landroid/database/ContentObserver;)V": driven(function* (this: JAbstractCursor, o: JObj): Gen {
      yield observables(this);
      yield vcall(this.contentObservable, "registerObserver", "(Ljava/lang/Object;)V", o);
    }),
    "unregisterContentObserver(Landroid/database/ContentObserver;)V": driven(function* (this: JAbstractCursor, o: JObj): Gen {
      if (this.mClosed) return;
      yield observables(this);
      yield vcall(this.contentObservable, "unregisterObserver", "(Ljava/lang/Object;)V", o);
    }),
    "registerDataSetObserver(Landroid/database/DataSetObserver;)V": driven(function* (this: JAbstractCursor, o: JObj): Gen {
      yield observables(this);
      yield vcall(this.dataSetObservable, "registerObserver", "(Ljava/lang/Object;)V", o);
    }),
    "unregisterDataSetObserver(Landroid/database/DataSetObserver;)V": driven(function* (this: JAbstractCursor, o: JObj): Gen {
      yield observables(this);
      yield vcall(this.dataSetObservable, "unregisterObserver", "(Ljava/lang/Object;)V", o);
    }),
    "onChange(Z)V": driven(function* (this: JAbstractCursor, selfChange: number): Gen {
      yield observables(this);
      yield vcall(this.contentObservable, "dispatchChange", `(Z${URI})V`, selfChange, null);
      if (this.notifyUris && selfChange) for (const uri of (yield toJsArray(this.notifyUris)) as unknown[])
        yield vcall(this.mContentResolver, "notifyChange", `(${URI}${OBSERVER})V`, uri, this.selfObserver);
    }),
    "setNotificationUri(Landroid/content/ContentResolver;Landroid/net/Uri;)V": driven(function* (this: JAbstractCursor, cr: JObj, uri: JObj): Gen {
      yield vcall(this, "setNotificationUris", `(${CR}Ljava/util/List;)V`, cr, newArrayList([uri]));
    }),
    "setNotificationUris(Landroid/content/ContentResolver;Ljava/util/List;)V": driven(function* (this: JAbstractCursor, cr: JObj, uris: JObj): Gen {
      if (!uris) rt.npe();
      this.notifyUris = uris;
      this.mContentResolver = cr;
      yield unregisterSelf(this);
      if (!this.selfObserver) {
        const observer = (yield newObj("android/database/AbstractCursor$SelfContentObserver", "(Landroid/database/AbstractCursor;)V", this)) as JSelfContentObserver;
        this.selfObserver = observer;
      }
      yield registerSelf(this);
    }),
    "getNotificationUri()Landroid/net/Uri;": driven(function* (this: JAbstractCursor): Gen {
      return this.notifyUris ? ((yield toJsArray(this.notifyUris)) as unknown[])[0] ?? null : null;
    }),
    "getNotificationUris()Ljava/util/List;": function (this: JAbstractCursor) { return this.notifyUris; },
    "getWantsAllOnMoveCalls()Z": () => 0,
    "setExtras(Landroid/os/Bundle;)V": function (this: JAbstractCursor, extras: JObj | null) { this.extras = extras ?? new JBundle(); },
    "getExtras()Landroid/os/Bundle;": function (this: JAbstractCursor) { return this.extras; },
    "respond(Landroid/os/Bundle;)Landroid/os/Bundle;": () => new JBundle(),
    "checkPosition()V": checkPosition,
  },
});
const registerSelf = driven(function* registerSelf(c: JAbstractCursor): Gen<void> {
  for (const uri of (yield toJsArray(c.notifyUris)) as unknown[])
    yield vcall(c.mContentResolver, "registerContentObserver", `(${URI}Z${OBSERVER})V`, uri, 1, c.selfObserver);
  c.selfObserverRegistered = true;
});

rt.register({
  name: "android/database/AbstractCursor$SelfContentObserver", ctor: JSelfContentObserver, sup: "android/database/ContentObserver",
  methods: {
    "<init>(Landroid/database/AbstractCursor;)V": function (this: JSelfContentObserver, cursor: JAbstractCursor) { this.cursor = cursor; },
    "deliverSelfNotifications()Z": () => 0,
    "onChange(Z)V": function (this: JSelfContentObserver) { return this.cursor && vcall(this.cursor, "onChange", "(Z)V", 0); },
  },
});

/** the row-and-column read every getter makes, once checkPosition has passed */
const windowRead = (desc: string) => {
  const [name, ret] = [desc.slice(0, desc.indexOf("(")), desc.slice(desc.indexOf(")") + 1)];
  return driven(function* (this: JAbstractWindowedCursor, column: number): Gen {
    yield vcall(this, "checkPosition", "()V");
    return yield vcall(this.mWindow, name, `(II)${ret}`, this.mPos, column);
  });
};
const closeWindow = function (this: JAbstractWindowedCursor) {
  const window = this.mWindow;
  this.mWindow = null;
  return window && vcall(window, "close", "()V");
};
rt.register({
  name: "android/database/AbstractWindowedCursor", ctor: JAbstractWindowedCursor, sup: "android/database/AbstractCursor",
  fields: ["mWindow"],
  methods: {
    "<init>()V": function () {},
    ...Object.fromEntries(["getBlob(I)[B", `getString(I)${S}`, "getShort(I)S", "getInt(I)I", "getLong(I)J", "getFloat(I)F", "getDouble(I)D", "getType(I)I"]
      .map((desc) => [desc, windowRead(desc)])),
    "isNull(I)Z": driven(function* (this: JAbstractWindowedCursor, column: number): Gen {
      yield vcall(this, "checkPosition", "()V");
      return +((yield vcall(this.mWindow, "getType", "(II)I", this.mPos, column)) === 0);
    }),
    "checkPosition()V": driven(function* (this: JAbstractWindowedCursor): Gen {
      yield checkPosition.call(this);
      if (!this.mWindow) throw rt.mkThrowable("android/database/StaleDataException",
        "Attempting to access a closed CursorWindow.Most probable cause: cursor is deactivated prior to calling this method.");
    }),
    "getWindow()Landroid/database/CursorWindow;": function (this: JAbstractWindowedCursor) { return this.mWindow; },
    "setWindow(Landroid/database/CursorWindow;)V": function (this: JAbstractWindowedCursor, window: JObj | null) {
      if (window === this.mWindow) return;
      const closed = closeWindow.call(this);
      this.mWindow = window;
      return closed;
    },
    "hasWindow()Z": function (this: JAbstractWindowedCursor) { return +!!this.mWindow; },
    "closeWindow()V": closeWindow,
    "clearOrCreateWindow(Ljava/lang/String;)V": driven(function* (this: JAbstractWindowedCursor, name: string): Gen {
      if (this.mWindow) yield vcall(this.mWindow, "clear", "()V");
      else this.mWindow = yield newObj("android/database/CursorWindow", `(${S})V`, name);
    }),
    "onDeactivateOrClose()V": driven(function* (this: JAbstractWindowedCursor): Gen {
      yield onDeactivateOrClose.call(this);
      yield closeWindow.call(this);
    }),
  },
});
