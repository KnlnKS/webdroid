import { JObj, rt, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { callOn, curThread, JThread, newObj, vcall, vcallUncaught } from "../jvm/natives/jlang";
import { PROCESS_PID, PROCESS_UID, reportUncaught } from "./os";
import { JParcel } from "./parcel";
import { jarray, mangleMethod } from "../jvm/abi";

/** IBinder.INTERFACE_TRANSACTION: a binder answers it with its interface descriptor */
export const INTERFACE_TRANSACTION = 0x5f4e5446;
const emptyParcel = (): ParcelData => ({ bytes: new Uint8Array(), objects: [] });
export type BinderHandle = { pid: number; id: number };
export type ParcelData = { bytes: Uint8Array; objects: [number, BinderHandle | null][] };
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
  // a stability label for binders crossing partitions; every binder here shares one build
  "markVintfStability()V": () => {},
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
  "<init>(Ljava/lang/String;)V": function (this: JBinder, descriptor: string | null) { this.descriptor = descriptor; },
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
const binderServices = new Map<string, JObj | Promise<JObj> | (() => Promise<JObj>)>();
const M_ENFORCED = mangleMethod("<init>", "(Landroid/os/PermissionEnforcer;)V");
/** Host a system service, a subclass of its AIDL Stub, made when first asked for. A Stub whose
 *  methods declare @EnforcePermission takes its enforcer at construction (its no-argument
 *  constructor asks the system context for one); none of the hosted methods calls it. */
export function hostStub(name: string, cls: string): void {
  binderServices.set(name, async () => M_ENFORCED in rt.link(cls).ctor.prototype
    ? newObj(cls, "(Landroid/os/PermissionEnforcer;)V", await newObj("android/os/PermissionEnforcer")) : newObj(cls));
}
class JServiceManager extends JObj { binder: JBinder | null = null; }
/** a hosted service's binder, made when first asked for */
export function hostedService(name: string): JObj | Promise<JObj> | null {
  const service = binderServices.get(name);
  if (!service) { rt.noteMissing(`service ${name} [binder]`); return null; }
  if (typeof service !== "function") return service;
  const made = service();
  binderServices.set(name, made);
  void made.then((binder: JObj) => binderServices.set(name, binder));
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
