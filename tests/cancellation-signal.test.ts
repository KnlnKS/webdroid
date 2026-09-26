import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";

class CancelListener extends JObj { calls = 0; }
rt.register({
  name: "test/CancelListener", ctor: CancelListener, ifaces: ["android/os/CancellationSignal$OnCancelListener"],
  methods: { "onCancel()V": function (this: CancelListener) { this.calls++; } },
});
rt.linkNatives();

test("CancellationSignal dispatches exactly once and immediately for late listeners", async () => {
  const signal = await newObj("android/os/CancellationSignal");
  const first = new CancelListener();
  await vcall(signal, "setOnCancelListener", "(Landroid/os/CancellationSignal$OnCancelListener;)V", first);
  await vcall(signal, "cancel", "()V");
  await vcall(signal, "cancel", "()V");
  expect(first.calls).toBe(1);
  expect(await vcall(signal, "isCanceled", "()Z")).toBe(1);
  const late = new CancelListener();
  await vcall(signal, "setOnCancelListener", "(Landroid/os/CancellationSignal$OnCancelListener;)V", late);
  expect(late.calls).toBe(1);
  await expect(vcallAsync(signal, "throwIfCanceled", "()V")).rejects.toMatchObject({
    constructor: { $i: { name: "android/os/OperationCanceledException" } },
  });
});

test("SQLite cancellation overloads reject canceled work before touching the database", async () => {
  const signal = await newObj("android/os/CancellationSignal");
  await vcall(signal, "cancel", "()V");
  const db = rt.make("android/database/sqlite/SQLiteDatabase");
  await expect(vcallAsync(db, "rawQuery", "(Ljava/lang/String;[Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;", "select 1", null, signal))
    .rejects.toMatchObject({ constructor: { $i: { name: "android/os/OperationCanceledException" } } });
  await expect(vcallAsync(db, "rawQueryWithFactory", "(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;", null, "select 1", null, null, signal))
    .rejects.toMatchObject({ constructor: { $i: { name: "android/os/OperationCanceledException" } } });
});
