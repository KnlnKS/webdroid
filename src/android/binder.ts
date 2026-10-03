// Binder and BinderProxy run from AOSP bytecode; this is libbinder under them: IPCThreadState's
// calling identity, local binders exported to the broker and proxies to other processes' binders.
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime";
import { callOn, curThread, JThread, scall, vcall, after, linkInit, logUncaught, newObj } from "../jvm/natives/jlang";
import { inStrand, newStrand } from "../jvm/suspend";
import { exitProcess, processExited } from "../process-exit";
import { newArrayList } from "../jvm/natives/jcoll";
import { PROCESS_PID, PROCESS_UID, ashmemFd, ashmemProt, fdOverBytes, fdContents } from "./os";
import { O_ACCMODE, javaCloseFd, javaDupFd, javaFcntlFd, javaPwriteFd, javaTruncateFd } from "../native/fs";
import { NativeParcel, OwnedFd, freeData, nativeParcel, parcelAt, newParcel, setParcelBytes, readInt, readString, writeInt, writeString, createByteArray } from "./parcel";
import { jarray, mangleMethod, mangleStaticField, i8, u8 } from "../jvm/abi";
import { handle, release, FINALIZER } from "./handles";

const F_GETFL = 3, O_RDONLY = 0;
/** IBinder.INTERFACE_TRANSACTION: a binder answers it with its interface descriptor */
export const INTERFACE_TRANSACTION = 0x5f4e5446;
export type BinderHandle = { pid: number; id: number };
/** a descriptor crossing processes, since binder IPC here moves no descriptors: its file's bytes,
 *  for a writable one the binder that writes them back to the descriptor it came from, and for an
 *  ashmem region its protection */
type FileHandle = { bytes: Uint8Array; writer: BinderHandle | null; prot?: number };
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

/** BinderProxyNativeData: the remote binder a proxy stands for and the deaths it reports */
type ProxyData = { handle: BinderHandle; deaths: Map<unknown, () => void> };
const proxyData = new WeakMap<JObj, ProxyData>();
const local = new Map<number, JObj>();
const localIds = new WeakMap<JObj, number>();
const proxies = new Map<string, JObj | Promise<JObj>>();
let nextId = 1;

export function exportBinder(binder: unknown): BinderHandle | null {
  if (binder == null) return null;
  const proxy = proxyData.get(binder as JObj);
  if (proxy) return proxy.handle;
  if (!rt.iof(binder, "android/os/Binder")) throw rt.mkThrowable("android/os/BadParcelableException", "Non-Binder object in IPC parcel: " + ((binder as JObj).constructor as { $i?: { name: string } }).$i?.name);
  let id = localIds.get(binder as JObj);
  if (!id) { id = nextId++; localIds.set(binder as JObj, id); local.set(id, binder as JObj); }
  return { pid: PROCESS_PID, id };
}
/** javaObjectForIBinder's one proxy per remote binder */
function proxyFor(key: string, h: BinderHandle): JObj | Promise<JObj> {
  let proxy = proxies.get(key);
  if (proxy) return proxy;
  const data: ProxyData = { handle: h, deaths: new Map() };
  proxy = after<JObj, JObj>(newObj("android/os/BinderProxy", "(J)V", handle(data)), (made) => { proxyData.set(made, data); proxies.set(key, made); return made; });
  proxies.set(key, proxy);
  return proxy;
}
export function importBinder(h: BinderHandle | null): JObj | null | Promise<JObj> {
  if (!h) return null;
  if (h.pid === PROCESS_PID) return local.get(h.id) ?? null;
  return proxyFor(h.pid + ":" + h.id, h);
}
/** a binder system_server owns, as a client process holds it: a proxy, which AOSP tells apart
 *  from a local Binder (ActivityThread relaunches only activities whose token is not local) */
export function systemToken(): JObj | Promise<JObj> {
  const id = nextId++;
  // a parcel written and read back here (an Intent's extras) imports the same token
  return after(proxyFor("token:" + id, { pid: PROCESS_PID, id }), (proxy) => { local.set(id, proxy); return proxy; });
}
/** the binder a writable descriptor's importer sends its final bytes back through */
class JFileWriter extends JObj { fd = -1; }
function* exportObject(o: unknown): Gen<BinderHandle | FileHandle | null> {
  if (!(o instanceof OwnedFd)) return exportBinder(o);
  const bytes = yield* awaited(fdContents(o.fd));
  if (!bytes) throw rt.mkThrowable("java/lang/RuntimeException", "Not allowed to write file descriptors here");
  const prot = ashmemProt(o.fd), region = prot === undefined ? {} : { prot };
  if ((javaFcntlFd(o.fd, F_GETFL, 0) & O_ACCMODE) === O_RDONLY) return { bytes, writer: null, ...region };
  rt.link("webdroid/FileWriter");
  const writer = new JFileWriter(); writer.fd = javaDupFd(o.fd);
  return { bytes, writer: exportBinder(writer), ...region };
}
function importObject(o: BinderHandle | FileHandle | null): unknown {
  if (!o || !("bytes" in o)) return importBinder(o);
  return after(o.writer && importBinder(o.writer), (writer) => {
    const sink = writer && driven(function* (bytes: Uint8Array): Gen<void> {
      const data = yield* awaited(newParcel());
      yield vcall(data, "writeByteArray", "([B)V", i8(bytes));
      yield vcall(writer, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", 1, data, null, 0);
    });
    const bytes = new Uint8Array(o.bytes);
    return new OwnedFd(o.prot === undefined ? fdOverBytes(bytes, sink) : ashmemFd(bytes, o.prot, sink));
  });
}
/** what a parcel carries across processes: its bytes and its side table */
export const exportParcel = driven(function* exportParcel(p: NativeParcel): Gen<ParcelData> {
  const objects: ParcelData["objects"] = [];
  for (const [at, o] of p.objects) objects.push([at, yield* exportObject(o)]);
  return { bytes: p.buf.slice(0, p.size), objects };
});
const fillParcel = driven(function* fillParcel(p: NativeParcel, data: ParcelData): Gen<void> {
  const objects: [number, unknown][] = [];
  for (const [at, o] of data.objects) objects.push([at, yield importObject(o)]);
  setParcelBytes(p, data.bytes, objects);
});
/** a Parcel holding what another process sent, read from its start */
export const importParcel = driven(function* importParcel(data: ParcelData): Gen<JObj> {
  const parcel = yield* awaited(newParcel());
  yield fillParcel(nativeParcel(parcel), data);
  return parcel;
});
/** a Parcelable as it crosses processes: what its writeToParcel writes */
export const parcelled = driven(function* parcelled(o: JObj): Gen<ParcelData> {
  const parcel = yield* awaited(newParcel());
  try {
    yield vcall(o, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    return yield* awaited(exportParcel(nativeParcel(parcel)));
  } finally { yield vcall(parcel, "recycle", "()V"); }
});
/** a Parcelable of class `cls` read back by its CREATOR; the parcel, and the descriptors it
 *  imported, are released once read */
export const unparcelled = driven(function* unparcelled(cls: string, data: ParcelData): Gen<JObj> {
  const creator = (yield* awaited(linkInit(cls))).ctor[mangleStaticField("CREATOR")], parcel = yield* awaited(importParcel(data));
  try { return yield vcall(creator, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel); }
  finally { yield vcall(parcel, "recycle", "()V"); }
});

// ── IPCThreadState
const callers = new WeakMap<JThread, Caller>();
const SELF_TOKEN = -1n;
const strictModePolicies = new WeakMap<JThread, number>();
const UNSET_WORK_SOURCE = -1;
const workSources = new WeakMap<JThread, { uid: number; propagate: boolean }>();
const workSource = () => workSources.get(curThread) ?? { uid: UNSET_WORK_SOURCE, propagate: false };
function setWorkSource(uid: number, propagate: boolean): bigint {
  const was = workSource();
  workSources.set(curThread, { uid, propagate });
  return BigInt(+was.propagate) << 32n | BigInt(was.uid >>> 0);
}
const transactionCaller = (): Caller | undefined => callers.get(curThread);
export const callingIdentity = (): Caller => transactionCaller() ?? { pid: PROCESS_PID, uid: PROCESS_UID };
const SIGABRT = 6;
/** an exception escaping a stub's method, as JavaBBinder's report_exception takes it: logged,
 *  except that an Error is fatal (LOG_ALWAYS_FATAL aborts the process) */
function reportException(e: unknown, message: string): void {
  const je = rt.jx(e);
  console.error(`[Binder] ${message}`);
  logUncaught(je);
  if (!rt.iof(je, "java/lang/Error") || processExited()) return;
  console.error(`Fatal signal ${SIGABRT} (SIGABRT), pid ${PROCESS_PID}\nAbort message: '${message}'`);
  exitProcess({ signal: SIGABRT });
}
/** a call into a local stub that no caller waits on (a oneway transaction, a death notice), as
 *  Binder.execTransact makes it: a RuntimeException is logged, and anything else is reported */
export function binderUncaught(call: () => unknown, message = "*** Uncaught remote exception!  (Exceptions are not yet supported across processes.)"): void {
  if (processExited()) return;
  const escaped = (e: unknown) => {
    if (rt.iof(rt.jx(e), "java/lang/RuntimeException")) console.warn("[Binder] Caught a RuntimeException from the binder stub implementation.", rt.jx(e));
    else reportException(e, message);
  };
  try { const r = inStrand(newStrand(), call); if (r instanceof Promise) r.catch(escaped); } catch (e) { escaped(e); }
}
/** a oneway call to a local binder: made on a fresh turn of the caller's thread, which neither
 *  waits for the callee nor hears of its failure */
export function oneway(target: JObj, name: string, desc: string, ...args: unknown[]): void {
  const thread = curThread;
  queueMicrotask(() => binderUncaught(() => callOn(thread, () => vcall(target, name, desc, ...args))));
}
/** a cross-process transport's call before the broker connects it */
export const notConnected = async (): Promise<never> => { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); };
/** the context a hosted service checks its callers with, as a system service's mContext: the process's application */
export const serviceContext = (): Promise<JObj> => scall("android/app/ActivityThread", "currentApplication", "()Landroid/app/Application;");
export const enforceCallingOrSelfPermission = driven(function* (permission: string, message: string | null): Gen<void> {
  yield vcall(yield* awaited(serviceContext()), "enforceCallingOrSelfPermission", "(Ljava/lang/String;Ljava/lang/String;)V", permission, message);
});
const oneWay = new Map<number, Promise<unknown>>();
/** a thread of this process's binder pool, which another process's calls into it run on */
export const binderThread = (): JThread => Object.assign(new JThread(), { jname: "Binder:" + PROCESS_PID });
/** Java frames entered by `call` keep the binder thread across suspensions; the thread is
 *  released as soon as `call` returns, so no other job resumes on it */
async function withCallingIdentity<T>(caller: Caller, call: () => T | Promise<T>, system = false): Promise<T> {
  const thread = binderThread();
  callers.set(thread, caller);
  if (system) systemThreads.add(thread);
  try { return await callOn(thread, call); }
  finally { callers.delete(thread); }
}
/** system_server's identity: what a hosted service's binder calls carry, local or remote */
export const SYSTEM_CALLER: Caller = { pid: 0, uid: 1000 };
const systemThreads = new WeakSet<JThread>();
/** run a hosted service's calls into other binders as system_server makes them */
export function asSystem<T>(call: () => T | Promise<T>): Promise<T> {
  return withCallingIdentity(SYSTEM_CALLER, call, true);
}
/** JavaBBinder::onTransact: Binder.execTransact over the transaction's parcels */
export async function receiveTransaction(request: Transaction, caller: Caller): Promise<TransactionReply> {
  const binder = local.get(request.handle.id);
  if (!binder || request.handle.pid !== PROCESS_PID) throw rt.mkThrowable("android/os/DeadObjectException", "Binder is dead");
  const run = () => withCallingIdentity(caller, () => rt.drive(function* (): Gen<TransactionReply> {
    const data = new NativeParcel(), reply = new NativeParcel(), dataPtr = handle(data), replyPtr = handle(reply);
    try {
      yield fillParcel(data, request.data);
      let handled = 0;
      try { handled = yield vcall(binder, "execTransact", "(IJJI)Z", request.code, dataPtr, replyPtr, request.flags); }
      catch (error) { reportException(error, "*** Uncaught remote exception!  (Exceptions are not yet supported across processes.)"); } // the caller sees UNKNOWN_TRANSACTION
      return { handled, data: yield* awaited(exportParcel(reply)) };
    } finally { freeData(data); freeData(reply); release(dataPtr); release(replyPtr); }
  }()));
  if (!(request.flags & 1)) return run();
  const pending = (oneWay.get(request.handle.id) ?? Promise.resolve()).then(run).catch(logUncaught);
  oneWay.set(request.handle.id, pending);
  void pending.finally(() => { if (oneWay.get(request.handle.id) === pending) oneWay.delete(request.handle.id); });
  return { handled: 1, data: await exportParcel(new NativeParcel()) };
}

const extensions = new WeakMap<JObj, unknown>();
const explicitIdentity = new WeakSet<JThread>();
const EXPLICIT = 1n << 31n;
rt.registerJnis("android/os/Binder", {
  "getNativeBBinderHolder()J": () => handle({}),
  "getNativeFinalizer()J": () => FINALIZER,
  "getCallingPid()I": () => callingIdentity().pid,
  "getCallingUid()I": () => callingIdentity().uid,
  "isDirectlyHandlingTransactionNative()Z": () => +(transactionCaller() !== undefined),
  "hasExplicitIdentity()Z": () => +explicitIdentity.has(curThread),
  // IPCThreadState packs the caller into the token, so clearing twice gives the same one. This
  // process's own identity is one token whatever its uid: the page is the zygote that became the
  // app, so a Looper that started looping before then still finds its identity unchanged.
  "clearCallingIdentity()J": () => {
    const caller = transactionCaller(), explicit = explicitIdentity.has(curThread) ? EXPLICIT : 0n;
    callers.delete(curThread); explicitIdentity.add(curThread);
    return caller ? BigInt(caller.uid) << 32n | explicit | BigInt(caller.pid & 0x7fffffff) : SELF_TOKEN;
  },
  "restoreCallingIdentity(J)V": (token: bigint) => {
    const caller = { pid: Number(token & 0x7fffffffn), uid: Number(BigInt.asIntN(32, token >> 32n)) };
    if (token === SELF_TOKEN || caller.pid === PROCESS_PID && caller.uid === PROCESS_UID) callers.delete(curThread); else callers.set(curThread, caller);
    if (token !== SELF_TOKEN && token & EXPLICIT) explicitIdentity.add(curThread); else explicitIdentity.delete(curThread);
  },
  // IPCThreadState's per-thread StrictMode policy, which a call carries to its binder thread
  "setThreadStrictModePolicy(I)V": (mask: number) => { strictModePolicies.set(curThread, mask); },
  "getThreadStrictModePolicy()I": () => strictModePolicies.get(curThread) ?? 0,
  "getCallingWorkSourceUid()I": () => workSource().uid,
  "setCallingWorkSourceUid(I)J": (uid: number) => setWorkSource(uid, true),
  "clearCallingWorkSource()J": () => setWorkSource(UNSET_WORK_SOURCE, true),
  "restoreCallingWorkSource(J)V": (token: bigint) => { setWorkSource(Number(BigInt.asIntN(32, token)), !!(token >> 32n)); },
  "flushPendingCommands()V": () => {},
  "blockUntilThreadAvailable()V": () => {},
  // stability labels for binders crossing partitions; every binder here shares one build
  "markVintfStability()V": () => {},
  "forceDowngradeToSystemStability()V": () => {},
  "getExtension()Landroid/os/IBinder;": function (this: JObj) { return extensions.get(this) ?? null; },
  "setExtension(Landroid/os/IBinder;)V": function (this: JObj, ext: unknown) { extensions.set(this, ext); },
});

// Parcel's interface token: the caller's StrictMode policy and work source ahead of the descriptor
const STRICT_MODE_PENALTY_GATHER = 1 << 31, SYST = 0x53595354;
rt.registerJnis("android/os/Parcel", {
  "nativeWriteInterfaceToken(JLjava/lang/String;)V": (ptr: bigint, name: string) => {
    const p = parcelAt(ptr), source = workSource();
    writeInt(p, (strictModePolicies.get(curThread) ?? 0) | STRICT_MODE_PENALTY_GATHER);
    p.workSourceAt = p.pos;
    writeInt(p, source.propagate ? source.uid : UNSET_WORK_SOURCE);
    writeInt(p, SYST);
    writeString(p, name);
  },
  "nativeEnforceInterface(JLjava/lang/String;)V": (ptr: bigint, name: string) => {
    const p = parcelAt(ptr);
    strictModePolicies.set(curThread, readInt(p) & ~STRICT_MODE_PENALTY_GATHER);
    p.workSourceAt = p.pos;
    workSources.set(curThread, { uid: readInt(p), propagate: false });
    if (readInt(p) !== SYST || readString(p) !== name) throw rt.mkThrowable("java/lang/SecurityException", "Binder invocation to an incorrect interface");
  },
  "nativeReadCallingWorkSourceUid(J)I": (ptr: bigint) => {
    const p = parcelAt(ptr);
    return p.workSourceAt < 0 ? UNSET_WORK_SOURCE : p.view.getInt32(p.workSourceAt, true);
  },
  "nativeReplaceCallingWorkSourceUid(JI)Z": (ptr: bigint, uid: number) => {
    const p = parcelAt(ptr);
    if (p.workSourceAt < 0) return 0;
    p.view.setInt32(p.workSourceAt, uid, true);
    return 1;
  },
});

// a writable descriptor's final bytes, which replace its file's
rt.register({ name: "webdroid/FileWriter", ctor: JFileWriter, sup: "android/os/Binder", methods: {
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": function (this: JFileWriter, code: number, data: JObj) {
    if (code !== 1 || this.fd < 0) return 0;
    const bytes = u8(createByteArray(nativeParcel(data))!);
    javaTruncateFd(this.fd, 0); javaPwriteFd(this.fd, bytes, 0); javaCloseFd(this.fd);
    this.fd = -1;
    return 1;
  },
} });

const proxyOf = (proxy: JObj) => proxyData.get(proxy)!;
const proxyAlive = function (this: JObj) { return +binderTransport.alive(proxyOf(this).handle.pid); };
/** BpBinder::transact: the data parcel's bytes go whole; the reply is read from its start */
const transact = driven(function* transact(target: BinderHandle, code: number, data: ParcelData, reply: NativeParcel | null, flags: number): Gen<number> {
  const result = yield* awaited(binderTransport.transact({ handle: target, code, data, flags, system: systemThreads.has(curThread) }));
  if (reply) yield fillParcel(reply, result.data);
  return result.handled;
});
rt.registerJnis("android/os/BinderProxy", {
  "getNativeFinalizer()J": () => FINALIZER,
  "pingBinder()Z": proxyAlive,
  "isBinderAlive()Z": proxyAlive,
  "getExtension()Landroid/os/IBinder;": () => null,
  "transactNative(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": function (this: JObj, code: number, data: JObj | null, reply: JObj | null, flags: number) {
    return after(exportParcel(nativeParcel(data ?? rt.npe())), (exported) => transact(proxyOf(this).handle, code, exported, reply && nativeParcel(reply), flags));
  },
  "getInterfaceDescriptor()Ljava/lang/String;": driven(function* (this: JObj): Gen<string | null> {
    const reply = new NativeParcel();
    yield transact(proxyOf(this).handle, INTERFACE_TRANSACTION, yield* awaited(exportParcel(new NativeParcel())), reply, 0);
    return readString(reply);
  }),
  "linkToDeathNative(Landroid/os/IBinder$DeathRecipient;I)V": function (this: JObj, recipient: unknown) {
    const { handle: target, deaths } = proxyOf(this);
    if (!binderTransport.alive(target.pid)) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead");
    if (!deaths.has(recipient)) deaths.set(recipient, binderTransport.watch(target.pid, () => {
      deaths.delete(recipient);
      // binderDied arrives on a binder thread
      binderUncaught(() => withCallingIdentity(SYSTEM_CALLER, () => scall("android/os/BinderProxy", "sendDeathNotice", "(Landroid/os/IBinder$DeathRecipient;Landroid/os/IBinder;)V", recipient, this)),
        "*** Uncaught exception returned from death notification!");
    }));
  },
  "unlinkToDeathNative(Landroid/os/IBinder$DeathRecipient;I)Z": function (this: JObj, recipient: unknown) {
    const { deaths } = proxyOf(this), cancel = deaths.get(recipient);
    if (!cancel) return 0;
    cancel(); deaths.delete(recipient); return 1;
  },
});

// ── servicemanager: the context object BinderInternal hands AOSP's ServiceManager. It answers
// from the services hosted behind binder; a name nobody hosts gets the null servicemanager
// returns for an absent service, and is reported as a boundary gap.
const binderServices = new Map<string, JObj | Promise<JObj> | (() => JObj | Promise<JObj>)>();
const M_ENFORCED = mangleMethod("<init>", "(Landroid/os/PermissionEnforcer;)V");
/** a ParceledListSlice over `items`, as a service returns a list too long for one transaction */
export const parceledList = (items: unknown[] = []): JObj | Promise<JObj> => newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList(items));
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
    ? yield newObj(cls, "(Landroid/os/PermissionEnforcer;)V", yield newObj("android/os/PermissionEnforcer", "()V")) : yield newObj(cls, "()V");
});
/** services the platform registers only on hardware this device does not have */
const absentServices = new Set<string>();
export const absentService = (...names: string[]): void => names.forEach((name) => absentServices.add(name));
class JServiceManager extends JObj { binder: JObj | null = null; }
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
let contextObject: JObj | Promise<JObj> | null = null;
rt.registerJni("com/android/internal/os/BinderInternal", "getContextObject()Landroid/os/IBinder;", () => contextObject ??= after(newObj("android/os/Binder", "()V"), (binder) => {
  const manager = rt.make("webdroid/ServiceManager") as JServiceManager;
  manager.binder = binder;
  return after(vcall(binder, "attachInterface", "(Landroid/os/IInterface;Ljava/lang/String;)V", manager, "android.os.IServiceManager"), () => contextObject = binder);
}));
