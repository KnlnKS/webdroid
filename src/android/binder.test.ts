import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall, curThread } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";
import { exportBinder, importBinder, exportParcel, importParcel, receiveTransaction, callingIdentity } from "./binder";
import { PROCESS_PID, PROCESS_UID } from "./os";
import { JParcel } from "./parcel";
rt.link("android/os/Parcel");

test("Binder transactions preserve payloads, callback identity and local interfaces", async () => {
  const binder = await newObj("android/os/Binder"), callback = await newObj("android/os/Binder");
  await vcall(binder, "attachInterface", "(Landroid/os/IInterface;Ljava/lang/String;)V", callback, "test.IService");
  expect(await vcall(binder, "queryLocalInterface", "(Ljava/lang/String;)Landroid/os/IInterface;", "test.IService")).toBe(callback);
  const handle = exportBinder(binder)!;
  const data = new JParcel();
  await vcall(data, "writeInterfaceToken", "(Ljava/lang/String;)V", "test.IService");
  await vcall(data, "writeInt", "(I)V", 42);
  await vcall(data, "writeStrongBinder", "(Landroid/os/IBinder;)V", callback);
  binder[mangleMethod("onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z")] = async (code: number, request: JParcel, reply: JParcel) => {
    expect(callingIdentity()).toEqual({ pid: 2222, uid: 10009 });
    expect(code).toBe(7);
    await vcall(request, "enforceInterface", "(Ljava/lang/String;)V", "test.IService");
    const value = await vcall(request, "readInt", "()I");
    expect(await vcall(request, "readStrongBinder", "()Landroid/os/IBinder;")).toBe(callback);
    await vcall(reply, "writeNoException", "()V");
    await vcall(reply, "writeInt", "(I)V", value + 1);
    return 1;
  };
  const before = curThread;
  const reply = await receiveTransaction({ handle, code: 7, flags: 0, data: exportParcel(data) }, { pid: 2222, uid: 10009 });
  expect(curThread).toBe(before);
  const result = importParcel(reply.data);
  await vcall(result, "readException", "()V");
  expect(await vcall(result, "readInt", "()I")).toBe(43);
  expect(importBinder(handle)).toBe(binder);
  expect(callingIdentity()).toEqual({ pid: PROCESS_PID, uid: PROCESS_UID });
});

test("Binder rejects wrong interface tokens and transports Java exception types", async () => {
  const binder = await newObj("android/os/Binder");
  binder[mangleMethod("onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z")] = async (_code: number, request: JParcel) => {
    await vcall(request, "enforceInterface", "(Ljava/lang/String;)V", "test.EXPECTED"); return 1;
  };
  const data = new JParcel();
  await vcall(data, "writeInterfaceToken", "(Ljava/lang/String;)V", "test.WRONG");
  const reply = await receiveTransaction({ handle: exportBinder(binder)!, code: 1, flags: 0, data: exportParcel(data) }, { pid: 2, uid: 3 });
  try { await vcall(importParcel(reply.data), "readException", "()V"); throw new Error("exception missing"); }
  catch (error) { expect(rt.iof(error, "java/lang/SecurityException")).toBe(1); }
});

test("one-way Binder work is ordered without blocking the sender", async () => {
  const binder = await newObj("android/os/Binder"), events: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  binder[mangleMethod("onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z")] = async (code: number) => {
    if (code === 1) await blocked;
    events.push(code); return 1;
  };
  const handle = exportBinder(binder)!, data = exportParcel(new JParcel()), caller = { pid: 8, uid: 9 };
  await receiveTransaction({ handle, code: 1, flags: 1, data }, caller);
  await receiveTransaction({ handle, code: 2, flags: 1, data }, caller);
  expect(events).toEqual([]);
  release();
  for (let i = 0; i < 20 && events.length !== 2; i++) await Promise.resolve();
  expect(events).toEqual([1, 2]);
});
