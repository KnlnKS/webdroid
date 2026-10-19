// Binder and BinderProxy run from AOSP bytecode; this is libbinder under them: IPCThreadState's
// calling identity, local binders exported to the broker and proxies to other processes' binders.
import { shareable } from "../jvm/suspend.ts";
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { callOn, curThread, JThread, scall, vcall, after, linkInit, linkClass, newObj, iof, classNameOf } from "../jvm/natives/jentry.ts";
import { logUncaught, detached, type Escape } from "../jvm/natives/jthrowable.ts";
import { exitProcess, processExited } from "../process-exit.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { PROCESS_PID, PROCESS_UID, ashmemFd, ashmemProt, fdOverBytes, fdContents } from "./os.ts";
import { O_ACCMODE, javaCloseFd, javaDupFd, javaFcntlFd, javaPwriteFd, javaTruncateFd, FdScope, detachFdScope } from "../native/fs.ts";
import { stageBinderFd, takeBinderFd, unstageBinderFd, discardBinderFd } from "../native/process-fd.ts";
import { NativeParcel, OwnedFd, freeData, nativeParcel, parcelAt, newParcel, setParcelBytes, transactionSize, readInt, readString, writeInt, writeString, createByteArray } from "./parcel.ts";
import { jarray, i8, u8 } from "../jvm/abi.ts";
import { handle, release, FINALIZER } from "./handles.ts";

const F_GETFL = 3, O_RDONLY = 0;
/** the binder driver's buffer for a process (BINDER_VM_SIZE), half of it for oneway calls */
const BINDER_VM_SIZE = (1 << 20) - 2 * 4096, FLAG_ONEWAY = 1;
/** IBinder.INTERFACE_TRANSACTION: a binder answers it with its interface descriptor */
export const INTERFACE_TRANSACTION = 0x5f4e5446;
export type BinderHandle = { pid: number; id: number };
/** a descriptor crossing processes, since binder IPC here moves no descriptors: its file's bytes,
 *  for a writable one the binder that writes them back to the descriptor it came from, and for an
 *  ashmem region its protection */
type FileHandle = { bytes: Uint8Array; writer: BinderHandle | null; prot?: number };
export type DescriptorHandle = { descriptor: number };
export type ParcelData = { bytes: Uint8Array; objects: [number, BinderHandle | FileHandle | DescriptorHandle | null][] };
/** `system`: sent by a service hosted here on system_server's behalf, so it carries the system's identity */
export type Transaction = { handle: BinderHandle; code: number; flags: number; data: ParcelData; system?: boolean };
export type TransactionReply = { handled: number; data: ParcelData };
export type Caller = { pid: number; uid: number };
export const binderTransport: {
  transact: (request: Transaction) => Promise<TransactionReply>;
  alive: (pid: number) => boolean | Promise<boolean>;
  watch: (pid: number, died: () => void) => (() => void) | Promise<() => void>;
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
  if (!iof(binder, "android/os/Binder")) throw rt.mkThrowable("android/os/BadParcelableException", "Non-Binder object in IPC parcel: " + classNameOf(binder));
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
  if (h.pid === PROCESS_PID) return appView(local.get(h.id) ?? null) as JObj | null | Promise<JObj>;
  return proxyFor(h.pid + ":" + h.id, h);
}
/** binders hosted here on system_server's behalf, the webdroid/ classes: its services and the binders they hand out */
const systemClasses = new WeakMap<object, boolean>();
function isSystemBinder(o: unknown): o is JObj {
  if (!(o instanceof JObj)) return false;
  let system = systemClasses.get(o.constructor);
  if (system === undefined) {
    system = !!classNameOf(o)?.startsWith("webdroid/") && !!iof(o, "android/os/Binder");
    systemClasses.set(o.constructor, system);
  }
  return system;
}
/** a system binder as an app holds it: a proxy, whose calls cross a parcel as they do into system_server */
function appView(o: unknown): unknown {
  if (!isSystemBinder(o)) return o;
  const h = exportBinder(o)!;
  return proxyFor(h.pid + ":" + h.id, h);
}
/** a binder as system_server reads it from an app's parcel: its own binder for a proxy to one */
function systemView(o: unknown): unknown {
  const h = o instanceof JObj ? proxyData.get(o)?.handle : undefined, binder = h?.pid === PROCESS_PID ? local.get(h.id) : undefined;
  return binder && isSystemBinder(binder) ? binder : o;
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
function* exportObject(o: unknown, descriptors = false): Gen<BinderHandle | FileHandle | DescriptorHandle | null> {
  if (!(o instanceof OwnedFd)) return exportBinder(o);
  if (descriptors) {
    const token = yield* awaited(stageBinderFd(o.fd));
    if (token !== null) {
      if (token < 0) throw rt.mkThrowable("android/os/BadParcelableException", "Cannot stage Binder descriptor: " + token);
      return {descriptor:token};
    }
  }
  const contents = yield* awaited(fdContents(o.fd));
  if (!contents) throw rt.mkThrowable("java/lang/RuntimeException", "Not allowed to write file descriptors here");
  // Own the wire buffer: FileSource views may alias guest memory. This copy does not
  // implement shared FD backing; the current importer only writes back on last close.
  const bytes = new Uint8Array(contents);
  const prot = ashmemProt(o.fd), region = prot === undefined ? {} : { prot };
  if (((yield* awaited(javaFcntlFd(o.fd, F_GETFL, 0))) & O_ACCMODE) === O_RDONLY) return { bytes, writer: null, ...region };
  linkClass("webdroid/FileWriter");
  const writer = new JFileWriter(); writer.fd = javaDupFd(o.fd);
  return { bytes, writer: exportBinder(writer), ...region };
}
type TakeDescriptor = (token: number) => number | Promise<number>;
function importObject(o: BinderHandle | FileHandle | DescriptorHandle | null, scope?: FdScope, take: TakeDescriptor = takeBinderFd): unknown {
  if (o && "descriptor" in o) return after(take(o.descriptor),fd => {
    if (fd < 0) throw rt.mkThrowable("android/os/BadParcelableException", "Cannot import Binder descriptor: " + fd);
    return new OwnedFd(fd, scope);
  });
  if (!o || !("bytes" in o)) return importBinder(o);
  return after(o.writer && importBinder(o.writer), (writer) => {
    const sink = writer && driven(function* (bytes: Uint8Array): Gen<void> {
      const data = yield* awaited(newParcel());
      yield vcall(data, "writeByteArray", "([B)V", i8(bytes));
      yield vcall(writer, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", 1, data, null, 0);
    });
    const bytes = new Uint8Array(o.bytes);
    return new OwnedFd(o.prot === undefined ? fdOverBytes(bytes, sink) : ashmemFd(bytes, o.prot, sink), scope);
  });
}
/** what a parcel carries across processes: its bytes and its side table */
export const exportParcel = driven(function* exportParcel(p: NativeParcel): Gen<ParcelData> {
  const objects: ParcelData["objects"] = [];
  for (const [at, o] of p.objects) objects.push([at, yield* exportObject(o)]);
  return { bytes: p.buf.slice(0, p.size), objects };
});
/** Staged rights are consumed by the broker before Binder delivery. Other serialized
 * stores require their own retained-Parcel lifecycle and cannot use these one-shot rights. */
export const exportBinderParcel = driven(function* exportBinderParcel(p: NativeParcel): Gen<ParcelData> {
  const data: ParcelData = {bytes:p.buf.slice(0,p.size),objects:[]};
  try {
    for (const [at,o] of p.objects) data.objects.push([at,yield* exportObject(o,true)]);
    return data;
  } catch (error) {
    try { yield* awaited(releaseBinderParcel(data)); } catch (cleanup) { logUncaught(cleanup); }
    throw error;
  }
});
export async function releaseBinderParcel(data: ParcelData): Promise<void> {
  await Promise.all(data.objects.map(async ([,object]) => {
    if (object && "descriptor" in object) await unstageBinderFd(object.descriptor);
  }));
}
const fillParcel = driven(function* fillParcel(p: NativeParcel, data: ParcelData, take: TakeDescriptor = takeBinderFd, scope: FdScope | undefined = p.fdScope,
  discard: typeof discardReceivedDescriptors = discardReceivedDescriptors): Gen<void> {
  const objects: [number, unknown][] = [];
  try {
    for (const [at, o] of data.objects) objects.push([at, yield importObject(o, scope, take)]);
    setParcelBytes(p, data.bytes, objects);
  } catch (error) {
    for (const [,o] of objects) if (o instanceof OwnedFd) javaCloseFd(o.fd);
    try { yield* awaited(discard(data)); } catch (cleanup) { logUncaught(cleanup); }
    throw error;
  }
});
async function discardReceivedDescriptors(data: ParcelData): Promise<void> {
  await Promise.all(data.objects.map(([,object]) => object && "descriptor" in object ? discardBinderFd(object.descriptor) : undefined));
}
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
/** A retaining broker consumes staged regular-FD rights; it must release them on failure. */
export type ParcelRights = { stage(fd: number): number | Promise<number> | null; discard(token: number): Promise<number> };
export const parcelledWithRights = driven(function* parcelledWithRights(o:JObj, rights: ParcelRights = { stage: stageBinderFd, discard: unstageBinderFd }): Gen<ParcelData> {
  const parcel=yield* awaited(newParcel()),data:ParcelData={bytes:new Uint8Array(),objects:[]};
  try {
    yield vcall(o,"writeToParcel","(Landroid/os/Parcel;I)V",parcel,0);
    const native=nativeParcel(parcel);data.bytes=native.buf.slice(0,native.size);
    for (const [at,object] of native.objects) {
      if (!(object instanceof OwnedFd)) {data.objects.push([at,exportBinder(object)]);continue;}
      const token=yield* awaited(rights.stage(object.fd));
      if (token === null || token < 0) throw rt.mkThrowable("android/os/BadParcelableException","Cannot retain descriptor right");
      data.objects.push([at,{descriptor:token}]);
    }
    return data;
  } catch (error) {yield* awaited(Promise.all(data.objects.map(([,o]) => o && "descriptor" in o ? rights.discard(o.descriptor) : undefined)));throw error;}
  finally {yield vcall(parcel,"recycle","()V");}
});
/** a Parcelable of class `cls` read back by its CREATOR; the parcel, and the descriptors it
 *  imported, are released once read */
const created = (cls: string, parcel: JObj) => after(linkInit(cls), (c) => vcall(c.static("CREATOR"), "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel));
export const unparcelled = driven(function* unparcelled(cls: string, data: ParcelData): Gen<JObj> {
  const parcel = yield* awaited(importParcel(data));
  try { return yield* awaited(created(cls, parcel)); }
  finally { yield vcall(parcel, "recycle", "()V"); }
});
/** Explicit broker borrowing; ordinary unparcelled callers retain their Java ownership. */
export const unparcelledScoped = driven(function* (cls: string, data: ParcelData, scope: FdScope, take: TakeDescriptor = takeBinderFd,
  discard: typeof discardReceivedDescriptors = discardReceivedDescriptors): Gen<JObj> {
  const parcel = yield* awaited(newParcel());
  try {
    yield* awaited(fillParcel(nativeParcel(parcel), data, take, scope, discard));
    return yield* awaited(created(cls, parcel));
  } finally { yield vcall(parcel, "recycle", "()V"); }
});
/** A local Parcelable copy keeps descriptor identity without a wire snapshot. */
export const copyParcelable = driven(function* (cls: string, object: JObj, scope: FdScope | undefined = parcelScope()): Gen<JObj> {
  const parcel = yield* awaited(newParcel()), native = nativeParcel(parcel);
  try {
    yield vcall(object, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    if (scope) for (const [at, o] of native.objects) if (o instanceof OwnedFd) native.objects.set(at, new OwnedFd(o.fd, scope));
    native.pos = 0;
    return yield* awaited(created(cls, parcel));
  } finally { yield vcall(parcel, "recycle", "()V"); }
});

// ── IPCThreadState: a thread's calling identity (`explicit` once cleared), StrictMode policy and
// work source, and whether it transacts as system_server
type IpcState = { caller: Caller | undefined; explicit: boolean; policy: number; workSource: { uid: number; propagate: boolean }; system: boolean; parcelScope?: FdScope };
const UNSET_WORK_SOURCE = -1;
const ipcStates = new WeakMap<JThread, IpcState>();
function ipc(thread = curThread): IpcState {
  let state = ipcStates.get(thread);
  if (!state) ipcStates.set(thread, state = { caller: undefined, explicit: false, policy: 0, workSource: { uid: UNSET_WORK_SOURCE, propagate: false }, system: false });
  return state;
}
const SELF_TOKEN = -1n;
function setWorkSource(uid: number, propagate: boolean): bigint {
  const state = ipc(), was = state.workSource;
  state.workSource = { uid, propagate };
  return BigInt(+was.propagate) << 32n | BigInt(was.uid >>> 0);
}
const transactionCaller = (): Caller | undefined => ipc().caller;
export const parcelScope = (): FdScope | undefined => ipc().parcelScope;
export async function withParcelScope<T>(work: () => T | Promise<T>): Promise<T> {
  const state = ipc();
  if (state.parcelScope) return work();
  const scope = new FdScope(); state.parcelScope = scope;
  try { return await work(); }
  finally { state.parcelScope = undefined; scope.close(); }
}
export const callingIdentity = (): Caller => transactionCaller() ?? { pid: PROCESS_PID, uid: PROCESS_UID };
const SIGABRT = 6;
/** an exception escaping a stub's method, as JavaBBinder's report_exception takes it: logged,
 *  except that an Error is fatal (LOG_ALWAYS_FATAL aborts the process) */
function reportException(e: unknown, message: string): void {
  const je = rt.jx(e);
  console.error(`[Binder] ${message}`);
  logUncaught(je);
  if (!iof(je, "java/lang/Error") || processExited()) return;
  console.error(`Fatal signal ${SIGABRT} (SIGABRT), pid ${PROCESS_PID}\nAbort message: '${message}'`);
  exitProcess({ signal: SIGABRT });
}
const UNCAUGHT_REMOTE = "*** Uncaught remote exception!  (Exceptions are not yet supported across processes.)";
/** the escape of a call into a local stub that no caller waits on (a oneway transaction, a death
 *  notice), as Binder.execTransact takes it: a RuntimeException is logged, and anything else is reported */
export const binderEscape = (message = UNCAUGHT_REMOTE): Escape => (e) => {
  if (iof(rt.jx(e), "java/lang/RuntimeException")) console.warn("[Binder] Caught a RuntimeException from the binder stub implementation.", rt.jx(e));
  else reportException(e, message);
};
/** a oneway call to a local binder: made on a fresh turn of the caller's thread, which neither
 *  waits for the callee nor hears of its failure */
export function oneway(target: JObj, name: string, desc: string, ...args: unknown[]): void {
  const thread = curThread;
  queueMicrotask(() => detached(() => callOn(thread, () => vcall(target, name, desc, ...args)), binderEscape()));
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
export async function withCallingIdentity<T>(caller: Caller, call: () => T | Promise<T>, system = false): Promise<T> {
  const thread = binderThread(), state = ipc(thread);
  state.caller = caller;
  if (system) state.system = true;
  try { return await callOn(thread, call); }
  finally { state.caller = undefined; }
}
/** system_server's identity: what a hosted service's binder calls carry, local or remote */
export const SYSTEM_CALLER: Caller = { pid: 0, uid: 1000 };
/** run a hosted service's calls into other binders as system_server makes them */
export function asSystem<T>(call: () => T | Promise<T>): Promise<T> {
  return withCallingIdentity(SYSTEM_CALLER, call, true);
}
/** Binder.execTransact over parcels of its own: `fill` writes the request (`size` bytes as sent),
 *  and a caller that waits for the reply has `read` take it once it fits its buffer. `escaped`
 *  hears an exception that escapes execTransact, as JavaBBinder reports it; without it the caller does. */
function* execTransact<T>(binder: JObj, code: number, flags: number, size: number, fill: (data: NativeParcel) => unknown,
  read: ((reply: NativeParcel) => T | Promise<T>) | null, escaped?: (error: unknown) => void): Gen<{ handled: number; reply: T | null }> {
  const scope = scopedServices.has(binder) ? new FdScope() : undefined, state = ipc(), previous = state.parcelScope;
  if (scope) state.parcelScope = scope;
  const data = new NativeParcel(scope), reply = new NativeParcel(), dataPtr = handle(data), replyPtr = handle(reply);
  try {
    yield fill(data);
    let handled = 0;
    try { handled = yield vcall(binder, "execTransact", "(IJJI)Z", code, dataPtr, replyPtr, flags); }
    catch (error) { if (!escaped) throw error; escaped(error); }
    if (read) checkBuffer(reply, false, size);
    return { handled, reply: read && (yield read(reply)) as T };
  } finally {
    try { freeData(data); freeData(reply); release(dataPtr); release(replyPtr); }
    finally { if (scope) { state.parcelScope = previous; scope.close(); } }
  }
}
/** JavaBBinder::onTransact: Binder.execTransact over the transaction's parcels, on a binder thread */
export async function receiveTransaction(request: Transaction, caller: Caller): Promise<TransactionReply> {
  const binder = local.get(request.handle.id);
  if (!binder || request.handle.pid !== PROCESS_PID) throw rt.mkThrowable("android/os/DeadObjectException", "Binder is dead");
  const oneway = (request.flags & FLAG_ONEWAY) !== 0;
  const run = () => withCallingIdentity(caller, () => rt.drive(function* (): Gen<TransactionReply> {
    // an escaped exception leaves the caller UNKNOWN_TRANSACTION
    const { handled, reply } = yield* execTransact(binder, request.code, request.flags, request.data.bytes.length, (data) => fillParcel(data, request.data),
      oneway ? null : exportBinderParcel, (error) => reportException(error, UNCAUGHT_REMOTE));
    return { handled, data: reply! };
  }()));
  if (!oneway) return run();
  const pending = (oneWay.get(request.handle.id) ?? Promise.resolve()).then(run).catch(logUncaught);
  oneWay.set(request.handle.id, pending);
  void pending.finally(() => { if (oneWay.get(request.handle.id) === pending) oneWay.delete(request.handle.id); });
  return { handled: 1, data: await exportParcel(new NativeParcel()) };
}

const extensions = new WeakMap<JObj, unknown>();
const EXPLICIT = 1n << 31n;
rt.registerJnis("android/os/Binder", {
  "getNativeBBinderHolder()J": () => handle({}),
  "getNativeFinalizer()J": () => FINALIZER,
  "getCallingPid()I": () => callingIdentity().pid,
  "getCallingUid()I": () => callingIdentity().uid,
  "isDirectlyHandlingTransactionNative()Z": () => +(transactionCaller() !== undefined),
  "hasExplicitIdentity()Z": () => +ipc().explicit,
  // IPCThreadState packs the caller into the token, so clearing twice gives the same one. This
  // process's own identity is one token whatever its uid: the page is the zygote that became the
  // app, so a Looper that started looping before then still finds its identity unchanged.
  "clearCallingIdentity()J": () => {
    const state = ipc(), caller = state.caller, explicit = state.explicit ? EXPLICIT : 0n;
    state.caller = undefined; state.explicit = true;
    return caller ? BigInt(caller.uid) << 32n | explicit | BigInt(caller.pid & 0x7fffffff) : SELF_TOKEN;
  },
  "restoreCallingIdentity(J)V": (token: bigint) => {
    const state = ipc(), caller = { pid: Number(token & 0x7fffffffn), uid: Number(BigInt.asIntN(32, token >> 32n)) };
    state.caller = token === SELF_TOKEN || caller.pid === PROCESS_PID && caller.uid === PROCESS_UID ? undefined : caller;
    state.explicit = token !== SELF_TOKEN && !!(token & EXPLICIT);
  },
  // IPCThreadState's per-thread StrictMode policy, which a call carries to its binder thread
  "setThreadStrictModePolicy(I)V": (mask: number) => { ipc().policy = mask; },
  "getThreadStrictModePolicy()I": () => ipc().policy,
  "getCallingWorkSourceUid()I": () => ipc().workSource.uid,
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
    const p = parcelAt(ptr), { policy, workSource: source } = ipc();
    writeInt(p, policy | STRICT_MODE_PENALTY_GATHER);
    p.workSourceAt = p.pos;
    writeInt(p, source.propagate ? source.uid : UNSET_WORK_SOURCE);
    writeInt(p, SYST);
    writeString(p, name);
  },
  "nativeEnforceInterface(JLjava/lang/String;)V": (ptr: bigint, name: string) => {
    const p = parcelAt(ptr), state = ipc();
    state.policy = readInt(p) & ~STRICT_MODE_PENALTY_GATHER;
    p.workSourceAt = p.pos;
    state.workSource = { uid: readInt(p), propagate: false };
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
    const bytes = u8(createByteArray(nativeParcel(data))!), fd = this.fd;
    this.fd = -1;
    return after(javaTruncateFd(fd, 0), () => after(javaPwriteFd(fd, bytes, 0), () => after(javaCloseFd(fd), () => 1)));
  },
} });

const proxyOf = (proxy: JObj) => proxyData.get(proxy)!;
const pidAlive = (pid: number) => pid === PROCESS_PID || binderTransport.alive(pid);
const proxyAlive = function (this: JObj) { return after(pidAlive(proxyOf(this).handle.pid), alive => +alive); };
/** a transaction or reply the target's buffer cannot take fails, as signalExceptionForError reports
 *  FAILED_TRANSACTION for the data parcel's size */
function checkBuffer(p: NativeParcel, oneway: boolean, dataSize: number): void {
  if (transactionSize(p) <= (oneway ? BINDER_VM_SIZE / 2 : BINDER_VM_SIZE)) return;
  console.error(`!!! FAILED BINDER TRANSACTION !!!  (parcel size = ${dataSize})`);
  throw dataSize > 200 * 1024 ? rt.mkThrowable("android/os/TransactionTooLargeException", `data parcel size ${dataSize} bytes`)
    : rt.mkThrowable("android/os/DeadObjectException", "Transaction failed on small parcel; remote process probably died, but this could also be caused by running out of binder buffer space");
}
/** a parcel's copy, its binders as `view` makes them and its descriptors duplicated, as the driver delivers one */
const copyParcel = driven(function* copyParcel(from: NativeParcel, to: NativeParcel, view: (o: unknown) => unknown): Gen<void> {
  const objects: [number, unknown][] = [];
  try {
    for (const [at, o] of from.objects) {
      if (!(o instanceof OwnedFd)) { objects.push([at, yield view(o)]); continue; }
      const fd = javaDupFd(o.fd); detachFdScope(fd);
      objects.push([at, new OwnedFd(fd, to.fdScope)]);
    }
    setParcelBytes(to, from.buf.subarray(0, from.size), objects);
  } catch (error) { for (const [,o] of objects) if (o instanceof OwnedFd) javaCloseFd(o.fd); throw error; }
  for (const [at, len] of from.ashmem) to.ashmem.set(at, len);
});
/** a call from this process into a service it hosts for system_server: the stub reads a copy of
 *  the caller's parcel and the caller a copy of the reply, as across processes. It runs on the
 *  calling thread as a transaction from this process, and the thread's IPCThreadState comes back
 *  after it. A oneway call too runs to its end before the caller goes on, so oneway calls to a
 *  binder are delivered in order as the driver's per-binder queue keeps them; only the caller
 *  waits where a device's would not. */
const localTransact = driven(function* localTransact(binder: JObj, code: number, data: NativeParcel, reply: NativeParcel | null, flags: number): Gen<number> {
  const state = ipc(), { caller, explicit, policy, workSource } = state;
  state.caller = state.system ? SYSTEM_CALLER : { pid: PROCESS_PID, uid: PROCESS_UID };
  try {
    return (yield* execTransact(binder, code, flags, data.size, (request) => copyParcel(data, request, systemView),
      reply && ((answer) => copyParcel(answer, reply, appView)))).handled;
  } finally { state.caller = caller; state.explicit = explicit; state.policy = policy; state.workSource = workSource; }
});
/** BpBinder::transact: the data parcel's bytes go whole; the reply is read from its start */
const transact = driven(function* transact(target: BinderHandle, code: number, data: NativeParcel, reply: NativeParcel | null, flags: number): Gen<number> {
  checkBuffer(data, (flags & FLAG_ONEWAY) !== 0, data.size);
  const binder = target.pid === PROCESS_PID ? local.get(target.id) : undefined;
  if (binder && isSystemBinder(binder)) return yield localTransact(binder, code, data, reply, flags);
  const sent = yield* awaited(exportBinderParcel(data));
  try {
    const result = yield* awaited(binderTransport.transact({ handle: target, code, data:sent, flags, system: ipc().system }));
    if (reply) yield fillParcel(reply, result.data);
    else yield* awaited(discardReceivedDescriptors(result.data));
    return result.handled;
  } finally {
    try { yield* awaited(releaseBinderParcel(sent)); } catch (error) { logUncaught(error); }
  }
});
rt.registerJnis("android/os/BinderProxy", {
  "getNativeFinalizer()J": () => FINALIZER,
  "pingBinder()Z": proxyAlive,
  "isBinderAlive()Z": proxyAlive,
  "getExtension()Landroid/os/IBinder;": () => null,
  "transactNative(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": function (this: JObj, code: number, data: JObj | null, reply: JObj | null, flags: number) {
    return transact(proxyOf(this).handle, code, nativeParcel(data ?? rt.npe()), reply && nativeParcel(reply), flags);
  },
  "getInterfaceDescriptor()Ljava/lang/String;": driven(function* (this: JObj): Gen<string | null> {
    const reply = new NativeParcel();
    yield transact(proxyOf(this).handle, INTERFACE_TRANSACTION, new NativeParcel(), reply, 0);
    return readString(reply);
  }),
  "linkToDeathNative(Landroid/os/IBinder$DeathRecipient;I)V": driven(function* (this: JObj, recipient: unknown): Gen<void> {
    const { handle: target, deaths } = proxyOf(this);
    if (!(yield pidAlive(target.pid))) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead");
    if (deaths.has(recipient)) return;
    let cancel = () => {}, received = false;
    const unlink = () => { received = true; cancel(); };
    deaths.set(recipient, unlink);
    try {
      cancel = yield binderTransport.watch(target.pid, () => {
        if (received || deaths.get(recipient) !== unlink) return;
        received = true;
        deaths.delete(recipient);
        // binderDied arrives on a binder thread
        detached(() => withCallingIdentity(SYSTEM_CALLER, () => scall("android/os/BinderProxy", "sendDeathNotice", "(Landroid/os/IBinder$DeathRecipient;Landroid/os/IBinder;)V", recipient, this)),
          binderEscape("*** Uncaught exception returned from death notification!"));
      });
    }
    catch (error) { if (deaths.get(recipient) === unlink) deaths.delete(recipient); throw error; }
    if (received) cancel();
  }),
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
/** a ParceledListSlice over `items`, as a service returns a list too long for one transaction */
export const parceledList = (items: unknown[] = []): JObj | Promise<JObj> => after(newArrayList(items), list => newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", list));
/** Host a system service, a subclass of its AIDL Stub, made when first asked for. A Stub whose
 *  methods declare @EnforcePermission takes its enforcer at construction (its no-argument
 *  constructor asks the system context for one); none of the hosted methods calls it. */
const scopedServices = new WeakSet<object>();
export function hostStub(name: string, cls: string, scopedDescriptors = false): void {
  binderServices.set(name, () => after(newStub(cls), binder => { if (scopedDescriptors) scopedServices.add(binder); return binder; }));
}
/** a Stub subclass's instance, as hostStub makes one (also for binders a service hands out), on
 *  the asking thread: a class it initializes may be one that thread is already initializing */
export const newStub = driven(function* newStub$(cls: string): Gen<JObj> {
  return linkClass(cls).has("<init>", "(Landroid/os/PermissionEnforcer;)V")
    ? yield newObj(cls, "(Landroid/os/PermissionEnforcer;)V", yield newObj("android/os/PermissionEnforcer", "()V")) : yield newObj(cls, "()V");
});
/** services the platform registers only on hardware this device does not have */
const absentServices = new Set<string>();
export const absentService = (...names: string[]): void => names.forEach((name) => absentServices.add(name));
class JServiceManager extends JObj { binder: JObj | null = null; }
/** a hosted service's binder, made when first asked for */
let remoteServices = new Set<string>();
let serviceLookup: ((name: string) => Promise<BinderHandle | null>) | undefined;
export function useSystemServiceAccess(names: readonly string[], lookup?: (name: string) => Promise<BinderHandle | null>): void {
  if (names.length && !lookup) throw new Error("System service lookup is required");
  remoteServices = new Set(names);
  serviceLookup = lookup;
}
export function ownedSystemService(name: string): BinderHandle | null | Promise<BinderHandle | null> {
  return after(localHostedService(name), exportBinder);
}
export function hostedService(name: string): JObj | Promise<JObj> | null {
  if (remoteServices.has(name) && serviceLookup) return after(serviceLookup(name), importBinder);
  return localHostedService(name);
}
function localHostedService(name: string): JObj | Promise<JObj> | null {
  const service = binderServices.get(name);
  if (!service) { if (!absentServices.has(name)) rt.noteMissing(`service ${name} [binder]`); return null; }
  if (typeof service !== "function") return service;
  const result = service();
  // A cached service is shared across asks. Its constructor suspension belongs
  // to the constructor: joining a caller to it would keep the cache pending
  // until that caller returns, and a later ask in that caller waits on itself.
  const made = result instanceof Promise ? shareable(result) : result;
  binderServices.set(name, made);
  if (made instanceof Promise) void made.then((binder: JObj) => binderServices.set(name, binder), () => binderServices.set(name, service));
  return made;
}
rt.register({ name: "webdroid/ServiceManager", ctor: JServiceManager, ifaces: ["android/os/IServiceManager"], methods: {
  "asBinder()Landroid/os/IBinder;": function (this: JServiceManager) { return this.binder; },
  "getService(Ljava/lang/String;)Landroid/os/IBinder;": (name: string) => after(hostedService(name), appView),
  "checkService(Ljava/lang/String;)Landroid/os/IBinder;": (name: string) => after(hostedService(name), appView),
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
