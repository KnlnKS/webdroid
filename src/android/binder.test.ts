import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall, curThread } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";
import { exportBinder, importBinder, exportParcel, importParcel, receiveTransaction, callingIdentity, binderTransport } from "./binder";
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

test("nested Binder callbacks retain their scoped callers and restore cleared identities", async () => {
  const outer = await newObj("android/os/Binder"), callback = await newObj("android/os/Binder");
  const data = exportParcel(new JParcel()), original = curThread, caller = { pid: 21, uid: 10021 };
  callback[mangleMethod("onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z")] = async () => {
    expect(callingIdentity()).toEqual({ pid: 22, uid: 10022 });
    const cls = rt.link("android/os/Binder").ctor;
    const token = await vcall(cls, "clearCallingIdentity", "()J");
    expect(callingIdentity()).toEqual({ pid: PROCESS_PID, uid: PROCESS_UID });
    await vcall(cls, "restoreCallingIdentity", "(J)V", token);
    expect(callingIdentity()).toEqual({ pid: 22, uid: 10022 });
    return 1;
  };
  outer[mangleMethod("onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z")] = async () => {
    expect(callingIdentity()).toEqual(caller);
    const reply = await receiveTransaction({ handle: exportBinder(callback)!, code: 1, flags: 0, data }, { pid: 22, uid: 10022 });
    expect(reply.handled).toBe(1); expect(callingIdentity()).toEqual(caller); return 1;
  };
  await receiveTransaction({ handle: exportBinder(outer)!, code: 1, flags: 0, data }, caller);
  expect(curThread).toBe(original);
});

test("remote Binder death recipients can be removed and are delivered once", async () => {
  const saved = { ...binderTransport }, watchers = new Set<() => void>();
  let alive = true, deaths = 0;
  binderTransport.alive = () => alive;
  binderTransport.watch = (_pid, died) => { watchers.add(died); return () => { watchers.delete(died); }; };
  try {
    const binder = importBinder({ pid: 98765, id: 1 }), recipient = await newObj("java/lang/Object");
    recipient[mangleMethod("binderDied", "()V")] = () => { deaths++; };
    await vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", recipient, 0);
    expect(await vcall(binder, "unlinkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)Z", recipient, 0)).toBe(1);
    expect(watchers.size).toBe(0);
    await vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", recipient, 0);
    await vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", recipient, 0);
    expect(watchers.size).toBe(1);
    alive = false; for (const died of watchers) died(); watchers.clear();
    await Promise.resolve(); expect(deaths).toBe(1);
    expect(await vcall(binder, "isBinderAlive", "()Z")).toBe(0);
    expect(await vcall(binder, "unlinkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)Z", recipient, 0)).toBe(0);
    await expect(vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", recipient, 0)).rejects.toBeTruthy();
  } finally { Object.assign(binderTransport, saved); }
});

test("unhandled Binder calls leave an empty reply with Android primitive read defaults", async () => {
  const binder = await newObj("android/os/Binder"), data = new JParcel(), reply = new JParcel();
  expect(await vcall(binder, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", 1234, data, reply, 0)).toBe(0);
  expect(reply.size).toBe(0);
  await vcall(reply, "readException", "()V");
  for (const [name, desc, value] of [["readInt", "()I", 0], ["readLong", "()J", 0n], ["readFloat", "()F", 0], ["readDouble", "()D", 0]] as const) {
    expect(await vcall(reply, name, desc)).toBe(value);
    expect(reply.pos).toBe(0); expect(reply.size).toBe(0);
  }
  await vcall(reply, "writeInt", "(I)V", 17); reply.pos = 0;
  expect(await vcall(reply, "readLong", "()J")).toBe(0n);
  expect(reply.pos).toBe(0);
  expect(await vcall(reply, "readInt", "()I")).toBe(17);
});
