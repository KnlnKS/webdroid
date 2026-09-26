import { JObj, rt, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { curThread, JThread, setCurThread, vcall, vcallUncaught } from "../jvm/natives/jlang";
import { PROCESS_PID, PROCESS_UID, reportUncaught } from "./os";
import { JParcel } from "./parcel";

export type BinderHandle = { pid: number; id: number };
export type ParcelData = { bytes: Uint8Array; objects: [number, BinderHandle | null][] };
export type Transaction = { handle: BinderHandle; code: number; flags: number; data: ParcelData };
export type TransactionReply = { handled: number; data: ParcelData };
export type Caller = { pid: number; uid: number };
export const binderTransport: {
  transact: (request: Transaction) => Promise<TransactionReply>;
  alive: (pid: number) => boolean;
  watch: (pid: number, died: () => void) => () => void;
} = {
  transact: async () => { throw rt.mkThrowable("android/os/DeadObjectException", "Process unavailable"); },
  alive: () => false,
  watch: () => () => {},
};

export class JBinder extends JObj { owner: unknown = null; descriptor: string | null = null; }
class JBinderProxy extends JObj {
  handle: BinderHandle = { pid: 0, id: 0 };
  deaths = new Map<unknown, () => void>();
}
const local = new Map<number, JObj>();
const localIds = new WeakMap<JObj, number>();
const proxies = new Map<string, JBinderProxy>();
let nextId = 1;

export function exportBinder(binder: unknown): BinderHandle | null {
  if (binder == null || binder === 0) return null;
  if (binder instanceof JBinderProxy) return binder.handle;
  if (!(binder instanceof JObj) || !rt.iof(binder, "android/os/IBinder")) throw rt.mkThrowable("android/os/BadParcelableException", "Non-Binder object in IPC parcel: " + (binder instanceof JObj ? (binder.constructor as { $i?: { name: string } }).$i?.name : typeof binder));
  let id = localIds.get(binder);
  if (!id) { id = nextId++; localIds.set(binder, id); local.set(id, binder); }
  return { pid: PROCESS_PID, id };
}
export function importBinder(handle: BinderHandle | null): JObj | null {
  if (!handle) return null;
  if (handle.pid === PROCESS_PID) return local.get(handle.id) ?? null;
  const key = handle.pid + ":" + handle.id;
  let proxy = proxies.get(key);
  if (!proxy) {
    rt.link("android/os/BinderProxy");
    proxy = new JBinderProxy(); proxy.handle = handle; proxies.set(key, proxy);
  }
  return proxy;
}
export function exportParcel(parcel: JParcel): ParcelData {
  return { bytes: parcel.buf.slice(0, parcel.size), objects: [...parcel.objects].map(([at, o]) => [at, exportBinder(o)]) };
}
export function importParcel(data: ParcelData, parcel = new JParcel()): JParcel {
  parcel.buf = new Uint8Array(data.bytes); parcel.view = new DataView(parcel.buf.buffer);
  parcel.pos = 0; parcel.size = parcel.buf.length;
  parcel.objects = new Map(data.objects.map(([at, handle]) => [at, importBinder(handle)]));
  return parcel;
}

const callers = new WeakMap<JThread, Caller>();
const savedIdentities = new WeakMap<JThread, Map<bigint, Caller>>();
let nextIdentity = 1n;
export const transactionCaller = (): Caller | undefined => callers.get(curThread);
export const callingIdentity = (): Caller => transactionCaller() ?? { pid: PROCESS_PID, uid: PROCESS_UID };
const oneWay = new Map<number, Promise<unknown>>();
export async function withCallingIdentity<T>(caller: Caller, call: () => Promise<T>): Promise<T> {
  const thread = new JThread(), previous = curThread;
  thread.jname = "Binder:" + PROCESS_PID; callers.set(thread, caller); setCurThread(thread);
  try { return await call(); }
  finally { callers.delete(thread); if (curThread === thread) setCurThread(previous); }
}
export async function receiveTransaction(request: Transaction, caller: Caller): Promise<TransactionReply> {
  const binder = local.get(request.handle.id);
  if (!binder || request.handle.pid !== PROCESS_PID) throw rt.mkThrowable("android/os/DeadObjectException", "Binder is dead");
  const run = async (): Promise<TransactionReply> => {
    const data = importParcel(request.data), reply = new JParcel();
    return withCallingIdentity(caller, async () => {
      try {
        const handled = await vcall(binder, "onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", request.code, data, reply, request.flags);
        return { handled, data: exportParcel(reply) };
      } catch (error) {
        if (request.flags & 1) throw error;
        reply.pos = reply.size = 0; reply.objects.clear();
        await vcall(reply, "writeException", "(Ljava/lang/Exception;)V", error);
        return { handled: 1, data: exportParcel(reply) };
      }
    });
  };
  if (!(request.flags & 1)) return run();
  const pending = (oneWay.get(request.handle.id) ?? Promise.resolve()).then(run).catch(reportUncaught);
  oneWay.set(request.handle.id, pending);
  void pending.finally(() => { if (oneWay.get(request.handle.id) === pending) oneWay.delete(request.handle.id); });
  return { handled: 1, data: { bytes: new Uint8Array(), objects: [] } };
}

rt.register({ name: "android/os/IBinder", ctor: class extends JObj {}, statics: { FIRST_CALL_TRANSACTION: 1, FLAG_ONEWAY: 1, INTERFACE_TRANSACTION: 0x5f4e5446 } });
rt.markers("android/os/IBinder$DeathRecipient");
rt.register({ name: "android/os/Binder", ctor: JBinder, ifaces: ["android/os/IBinder"], methods: {
  "static getCallingUid()I": () => callingIdentity().uid,
  "static getCallingPid()I": () => callingIdentity().pid,
  "static clearCallingIdentity()J": () => {
    let saved = savedIdentities.get(curThread);
    if (!saved) savedIdentities.set(curThread, saved = new Map());
    const token = nextIdentity++; saved.set(token, callingIdentity()); callers.delete(curThread); return token;
  },
  "static restoreCallingIdentity(J)V": (token: bigint) => {
    const saved = savedIdentities.get(curThread), caller = saved?.get(token);
    if (!caller) throw rt.mkThrowable("java/lang/IllegalStateException", "Invalid calling identity");
    callers.set(curThread, caller); saved!.delete(token);
  },
  "attachInterface(Landroid/os/IInterface;Ljava/lang/String;)V": function (this: JBinder, owner: unknown, descriptor: string) { this.owner = owner; this.descriptor = descriptor; },
  "queryLocalInterface(Ljava/lang/String;)Landroid/os/IInterface;": function (this: JBinder, descriptor: string) { return this.descriptor === descriptor ? this.owner : null; },
  "getInterfaceDescriptor()Ljava/lang/String;": function (this: JBinder) { return this.descriptor; },
  ...noops("<init>()V", "static flushPendingCommands()V", "linkToDeath(Landroid/os/IBinder$DeathRecipient;I)V"),
  ...stubs(1, "pingBinder()Z", "isBinderAlive()Z", "unlinkToDeath(Landroid/os/IBinder$DeathRecipient;I)Z"),
  "transact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JBinder, code: number, data: JParcel, reply: JParcel | null, flags: number): Gen {
    const pos = data.pos; data.pos = 0;
    try { return yield vcall(this, "onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", code, data, reply, flags); }
    finally { data.pos = pos; if (reply) reply.pos = 0; }
  }),
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JBinder, code: number, _data: JParcel, reply: JParcel | null): Gen {
    if (code !== 0x5f4e5446 || !reply) return 0;
    yield vcall(reply, "writeString", "(Ljava/lang/String;)V", this.descriptor); return 1;
  }),
} });
rt.register({ name: "android/os/BinderProxy", ctor: JBinderProxy, ifaces: ["android/os/IBinder"], methods: {
  "queryLocalInterface(Ljava/lang/String;)Landroid/os/IInterface;": () => null,
  "pingBinder()Z": function (this: JBinderProxy) { return binderTransport.alive(this.handle.pid) ? 1 : 0; },
  "isBinderAlive()Z": function (this: JBinderProxy) { return binderTransport.alive(this.handle.pid) ? 1 : 0; },
  "transact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JBinderProxy, code: number, data: JParcel, reply: JParcel | null, flags: number): Gen {
    const result = yield binderTransport.transact({ handle: this.handle, code, data: exportParcel(data), flags });
    if (reply) importParcel(result.data, reply);
    return result.handled;
  }),
  "getInterfaceDescriptor()Ljava/lang/String;": driven(function* (this: JBinderProxy): Gen {
    const result = yield binderTransport.transact({ handle: this.handle, code: 0x5f4e5446, flags: 0, data: { bytes: new Uint8Array(), objects: [] } });
    return vcall(importParcel(result.data), "readString", "()Ljava/lang/String;");
  }),
  "linkToDeath(Landroid/os/IBinder$DeathRecipient;I)V": function (this: JBinderProxy, recipient: unknown) {
    if (!binderTransport.alive(this.handle.pid)) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead");
    if (!this.deaths.has(recipient)) this.deaths.set(recipient, binderTransport.watch(this.handle.pid, () => {
      this.deaths.delete(recipient); void vcallUncaught(recipient, "binderDied", "()V");
    }));
  },
  "unlinkToDeath(Landroid/os/IBinder$DeathRecipient;I)Z": function (this: JBinderProxy, recipient: unknown) {
    const cancel = this.deaths.get(recipient);
    if (!cancel) return 0;
    cancel(); this.deaths.delete(recipient); return 1;
  },
} });
