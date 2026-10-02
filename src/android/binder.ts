import { JObj, rt, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { callOn, curThread, JThread, construct, scall, vcall, vcallUncaught } from "../jvm/natives/jlang";
import { PROCESS_PID, PROCESS_UID, reportUncaught, mkPfd, parcelFileDescriptorData, writeParcelFileDescriptor } from "./os";
import { JParcel } from "./parcel";
import { jarray, mangleMethod, i8, u8 } from "../jvm/abi";

/** IBinder.INTERFACE_TRANSACTION: a binder answers it with its interface descriptor */
export const INTERFACE_TRANSACTION = 0x5f4e5446;
const emptyParcel = (): ParcelData => ({ bytes: new Uint8Array(), objects: [] });
export type BinderHandle = { pid: number; id: number };
/** a ParcelFileDescriptor crossing processes, since binder IPC here moves no descriptors: its
 *  bytes and, for a writable one, the binder that writes them back to the descriptor it came from */
export type FileHandle = { bytes: Uint8Array; writer: BinderHandle | null };
export type ParcelData = { bytes: Uint8Array; objects: [number, BinderHandle | FileHandle | null][] };
/** `system`: sent by a service hosted here on system_server's behalf, so it carries the system's identity */
export type Transaction = { handle: BinderHandle; code: number; flags: number; data: ParcelData; system?: boolean };
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
/** a binder system_server owns, as a client process holds it: a proxy, which AOSP tells apart
 *  from a local Binder (ActivityThread relaunches only activities whose token is not local) */
export function systemToken(): JObj {
  rt.link("android/os/BinderProxy");
  const proxy = new JBinderProxy(), id = nextId++;
  proxy.handle = { pid: PROCESS_PID, id };
  // a parcel written and read back here (an Intent's extras) imports the same token
  local.set(id, proxy);
  return proxy;
}
class JFileWriter extends JBinder { pfd: JObj | null = null; }
function exportObject(o: unknown): BinderHandle | FileHandle | null {
  const file = parcelFileDescriptorData(o);
  if (!file) return exportBinder(o);
  if (!file.writable) return { bytes: file.bytes, writer: null };
  rt.link("webdroid/FileWriter");
  const writer = new JFileWriter(); writer.pfd = o as JObj;
  return { bytes: file.bytes, writer: exportBinder(writer) };
}
function importObject(o: BinderHandle | FileHandle | null): unknown {
  if (!o || !("bytes" in o)) return importBinder(o);
  const writer = o.writer && importBinder(o.writer);
  return mkPfd(new Uint8Array(o.bytes), writer && (async (bytes: Uint8Array, closed?: boolean) => {
    const data = new JParcel();
    await vcall(data, "writeByteArray", "([B)V", i8(bytes));
    await vcall(data, "writeInt", "(I)V", +!!closed);
    await vcall(writer, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", 1, data, null, 0);
  }), writer ? `binder:${o.writer!.pid}:${o.writer!.id}` : undefined);
}
export function exportParcel(parcel: JParcel): ParcelData {
  return { bytes: parcel.buf.slice(0, parcel.size), objects: [...parcel.objects].map(([at, o]) => [at, exportObject(o)]) };
}
export function importParcel(data: ParcelData, parcel = new JParcel()): JParcel {
  parcel.buf = new Uint8Array(data.bytes); parcel.view = new DataView(parcel.buf.buffer);
  parcel.pos = 0; parcel.size = parcel.buf.length;
  parcel.objects = new Map(data.objects.map(([at, handle]) => [at, importObject(handle)]));
  return parcel;
}

const callers = new WeakMap<JThread, Caller>();
const SELF_TOKEN = -1n;
const strictModePolicies = new WeakMap<JThread, number>();
export const transactionCaller = (): Caller | undefined => callers.get(curThread);
export const callingIdentity = (): Caller => transactionCaller() ?? { pid: PROCESS_PID, uid: PROCESS_UID };
/** a cross-process transport's call before the broker connects it */
export const notConnected = async (): Promise<never> => { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); };
/** the context a hosted service checks its callers with, as a system service's mContext: the process's application */
export const serviceContext = (): Promise<JObj> => scall("android/app/ActivityThread", "currentApplication", "()Landroid/app/Application;");
export const enforceCallingOrSelfPermission = async (permission: string, message: string | null): Promise<void> =>
  vcall(await serviceContext(), "enforceCallingOrSelfPermission", "(Ljava/lang/String;Ljava/lang/String;)V", permission, message);
const oneWay = new Map<number, Promise<unknown>>();
/** Java frames entered by `call` keep the binder thread across suspensions; the thread is
 *  released as soon as `call` returns, so no other job resumes on it */
export async function withCallingIdentity<T>(caller: Caller, call: () => Promise<T>, system = false): Promise<T> {
  const thread = new JThread();
  thread.jname = "Binder:" + PROCESS_PID; callers.set(thread, caller);
  if (system) systemThreads.add(thread);
  try { return await callOn(thread, call); }
  finally { callers.delete(thread); }
}
/** system_server's identity: what a hosted service's binder calls carry, local or remote */
export const SYSTEM_CALLER: Caller = { pid: 0, uid: 1000 };
const systemThreads = new WeakSet<JThread>();
/** run a hosted service's calls into other binders as system_server makes them */
export function asSystem<T>(call: () => Promise<T>): Promise<T> {
  return withCallingIdentity(SYSTEM_CALLER, call, true);
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
  return { handled: 1, data: emptyParcel() };
}

rt.register({ name: "android/os/IBinder", ctor: class extends JObj {}, statics: { FIRST_CALL_TRANSACTION: 1, FLAG_ONEWAY: 1, INTERFACE_TRANSACTION } });
rt.markers("android/os/IBinder$DeathRecipient");
rt.register({ name: "android/os/Binder", ctor: JBinder, ifaces: ["android/os/IBinder"], methods: {
  // blocking-call warnings are StrictMode reporting, which is not modelled
  "static allowBlocking(Landroid/os/IBinder;)Landroid/os/IBinder;": (binder: unknown) => binder,
  "static defaultBlocking(Landroid/os/IBinder;)Landroid/os/IBinder;": (binder: unknown) => binder,
  "static copyAllowBlocking(Landroid/os/IBinder;Landroid/os/IBinder;)V": () => {},
  // a stability label for binders crossing partitions; every binder here shares one build
  "markVintfStability()V": () => {},
  "static getCallingUid()I": () => callingIdentity().uid,
  // IPCThreadState's per-thread StrictMode policy, which a call carries to its binder thread
  "static setThreadStrictModePolicy(I)V": (mask: number) => { strictModePolicies.set(curThread, mask); },
  "static getThreadStrictModePolicy()I": () => strictModePolicies.get(curThread) ?? 0,
  "static getCallingPid()I": () => callingIdentity().pid,
  // a binder thread is in onTransact for its caller (Parcel bounds what a transaction may allocate)
  "static isDirectlyHandlingTransaction()Z": () => +(transactionCaller() !== undefined),
  // IPCThreadState packs the caller into the token, so clearing twice gives the same one. This
  // process's own identity is one token whatever its uid: the page is the zygote that became the
  // app, so a Looper that started looping before then still finds its identity unchanged.
  "static clearCallingIdentity()J": () => {
    const caller = transactionCaller();
    callers.delete(curThread);
    return caller ? BigInt(caller.uid) << 32n | BigInt(caller.pid >>> 0) : SELF_TOKEN;
  },
  "static restoreCallingIdentity(J)V": (token: bigint) => {
    const caller = { pid: Number(BigInt.asIntN(32, token)), uid: Number(BigInt.asIntN(32, token >> 32n)) };
    if (token === SELF_TOKEN || caller.pid === PROCESS_PID && caller.uid === PROCESS_UID) callers.delete(curThread); else callers.set(curThread, caller);
  },
  "attachInterface(Landroid/os/IInterface;Ljava/lang/String;)V": function (this: JBinder, owner: unknown, descriptor: string) { this.owner = owner; this.descriptor = descriptor; },
  "queryLocalInterface(Ljava/lang/String;)Landroid/os/IInterface;": function (this: JBinder, descriptor: string) { return this.descriptor === descriptor ? this.owner : null; },
  "getInterfaceDescriptor()Ljava/lang/String;": function (this: JBinder) { return this.descriptor; },
  "<init>(Ljava/lang/String;)V": function (this: JBinder, descriptor: string | null) { this.descriptor = descriptor; },
  // the transaction callback reports binder calls' timing to tracing, which is off
  "static setTransactionCallback(Landroid/os/IBinderCallback;)V": () => {},
  ...noops("<init>()V", "static flushPendingCommands()V", "linkToDeath(Landroid/os/IBinder$DeathRecipient;I)V"),
  ...stubs(1, "pingBinder()Z", "isBinderAlive()Z", "unlinkToDeath(Landroid/os/IBinder$DeathRecipient;I)Z"),
  "transact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JBinder, code: number, data: JParcel, reply: JParcel | null, flags: number): Gen {
    const pos = data.pos; data.pos = 0;
    try { return yield vcall(this, "onTransact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", code, data, reply, flags); }
    finally { data.pos = pos; if (reply) reply.pos = 0; }
  }),
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JBinder, code: number, _data: JParcel, reply: JParcel | null): Gen {
    if (code !== INTERFACE_TRANSACTION || !reply) return 0;
    yield vcall(reply, "writeString", "(Ljava/lang/String;)V", this.descriptor); return 1;
  }),
} });
rt.register({ name: "webdroid/FileWriter", ctor: JFileWriter, sup: "android/os/Binder", methods: {
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JFileWriter, code: number, data: JParcel): Gen {
    if (code !== 1) return 0;
    const bytes: Int8Array = yield vcall(data, "createByteArray", "()[B"), closed: number = yield vcall(data, "readInt", "()I");
    yield writeParcelFileDescriptor(this.pfd, u8(bytes), !!closed);
    if (closed) yield vcall(this.pfd, "close", "()V");
    return 1;
  }),
} });
function proxyAlive(this: JBinderProxy) { return binderTransport.alive(this.handle.pid) ? 1 : 0; }
rt.register({ name: "android/os/BinderProxy", ctor: JBinderProxy, ifaces: ["android/os/IBinder"], methods: {
  "queryLocalInterface(Ljava/lang/String;)Landroid/os/IInterface;": () => null,
  "pingBinder()Z": proxyAlive,
  "isBinderAlive()Z": proxyAlive,
  "transact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JBinderProxy, code: number, data: JParcel, reply: JParcel | null, flags: number): Gen {
    const result = yield binderTransport.transact({ handle: this.handle, code, data: exportParcel(data), flags, system: systemThreads.has(curThread) });
    if (reply) importParcel(result.data, reply);
    return result.handled;
  }),
  "getInterfaceDescriptor()Ljava/lang/String;": driven(function* (this: JBinderProxy): Gen {
    const result = yield binderTransport.transact({ handle: this.handle, code: INTERFACE_TRANSACTION, flags: 0, data: emptyParcel() });
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

// ── servicemanager: the context object BinderInternal hands AOSP's ServiceManager. It answers
// from the services hosted behind binder; a name nobody hosts gets the null servicemanager
// returns for an absent service, and is reported as a boundary gap.
const binderServices = new Map<string, JObj | Promise<JObj> | (() => JObj | Promise<JObj>)>();
const M_ENFORCED = mangleMethod("<init>", "(Landroid/os/PermissionEnforcer;)V");
/** Host a system service, a subclass of its AIDL Stub, made when first asked for. A Stub whose
 *  methods declare @EnforcePermission takes its enforcer at construction (its no-argument
 *  constructor asks the system context for one); none of the hosted methods calls it. */
export function hostStub(name: string, cls: string): void {
  binderServices.set(name, () => newStub(cls));
}
/** a Stub subclass's instance, as hostStub makes one (also for binders a service hands out), on
 *  the asking thread: a class it initializes may be one that thread is already initializing */
export const newStub = driven(function* newStub$(cls: string): Gen<JObj> {
  return M_ENFORCED in rt.link(cls).ctor.prototype
    ? yield construct(cls, "(Landroid/os/PermissionEnforcer;)V", yield construct("android/os/PermissionEnforcer", "()V")) : yield construct(cls, "()V");
});
/** services the platform registers only on hardware this device does not have */
const absentServices = new Set<string>();
export const absentService = (...names: string[]): void => names.forEach((name) => absentServices.add(name));
class JServiceManager extends JObj { binder: JBinder | null = null; }
/** a hosted service's binder, made when first asked for */
export function hostedService(name: string): JObj | Promise<JObj> | null {
  const service = binderServices.get(name);
  if (!service) { if (!absentServices.has(name)) rt.noteMissing(`service ${name} [binder]`); return null; }
  if (typeof service !== "function") return service;
  const made = service();
  binderServices.set(name, made);
  if (made instanceof Promise) void made.then((binder: JObj) => binderServices.set(name, binder), () => binderServices.set(name, service));
  return made;
}
rt.register({ name: "webdroid/ServiceManager", ctor: JServiceManager, ifaces: ["android/os/IServiceManager"], methods: {
  "asBinder()Landroid/os/IBinder;": function (this: JServiceManager) { return this.binder; },
  "getService(Ljava/lang/String;)Landroid/os/IBinder;": hostedService,
  "checkService(Ljava/lang/String;)Landroid/os/IBinder;": hostedService,
  "isDeclared(Ljava/lang/String;)Z": (name: string) => binderServices.has(name) ? 1 : 0,
  "listServices(I)[Ljava/lang/String;": () => jarray([...binderServices.keys()], "Ljava/lang/String;"),
  "addService(Ljava/lang/String;Landroid/os/IBinder;ZI)V": () => {
    throw rt.mkThrowable("java/lang/SecurityException", "an app may not register a system service");
  },
} });
let contextObject: JBinder | null = null;
rt.registerJni("com/android/internal/os/BinderInternal", "getContextObject()Landroid/os/IBinder;", () => {
  if (contextObject) return contextObject;
  const manager = rt.make("webdroid/ServiceManager") as JServiceManager;
  contextObject = manager.binder = rt.make("android/os/Binder") as JBinder;
  contextObject.owner = manager;
  contextObject.descriptor = "android.os.IServiceManager";
  return contextObject;
});
