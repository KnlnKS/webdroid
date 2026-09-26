import { readFully } from "../shell/lazyfile";
import { processEnv } from "../shell/environment";
// android.os.* + android.util.* natives: Looper/Handler on the JS event loop.

import { JMessage, obtain } from "./messenger";
import { procIdentity, processTid } from "../shell/procfs";
import { parcelCreator, type JParcel } from "./parcel";
import { keyCodes, deadChar } from "./keycodes";
import { guestAt, mem } from "../native/mem";
import { syncShared, trackSharedMap } from "../native/mappings";
import { rt, JObj, type NativeSpec, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { jarray, mangleMethod } from "../jvm/abi";
import { markProcessExited } from "../native/cpu";
import { device } from "../shell/config";
import { androidGroupId } from "./identity";
import { uuidFromString } from "../jvm/natives/jvalues";
import { vcall, vcallOn, curThread, mainThread, JThread, JThrowable, setCurThread, reportUncaught, mkEnumSet, newObj, defineException, boxObject, box, JInt, JLong, JFloat, JDouble, JBool, JChar, vcallAsync } from "../jvm/natives/jlang";
import { E, ERRSTR } from "../native/abi";
export { reportUncaught };
import { onMain, inMainJob } from "./mainloop";
import { uiState } from "./view";
import { mkExecutor } from "../jvm/natives/jconc";
import { yieldToLoop } from "../native/cpu";
import { mkFile, JInputStream, JOutputStream, vfs, type JFileDescriptor } from "../jvm/natives/jio";
import { javaOpenFd, javaCloseFd, javaSeekFd, javaDupFd, javaBytesFd, javaFdSource, fdWriteBack } from "../native/stdio";
import { newArrayList, newStringSet } from "../jvm/natives/jutil";
import { JBuffer, mkByteBuffer } from "../jvm/natives/jnio";
import { unavailableClock } from "../jvm/natives/jtime";
import { clearGuestInterval, clearGuestTimeout, guestNow, guestSleep, setGuestInterval, setGuestTimeout, type GuestTimer } from "../guest-clock";

rt.register({
  name: "android/os/SystemProperties", ctor: class extends JObj {},
  methods: {
    // No property service is installed; use the caller's default, as the framework delegates do.
    "static get(Ljava/lang/String;)Ljava/lang/String;": () => "",
    "static get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (_key: string, fallback: string | null) => fallback ?? "",
    "static getInt(Ljava/lang/String;I)I": (_key: string, fallback: number) => fallback,
    "static getLong(Ljava/lang/String;J)J": (_key: string, fallback: bigint) => fallback,
    "static getBoolean(Ljava/lang/String;Z)Z": (_key: string, fallback: number) => fallback,
  },
});
rt.register({ name: "android/os/PerformanceHintManager", ctor: class extends JObj {} });

class JMessageQueue extends JObj {
  owner: JLooper | null = null;
  messages = new Map<JMessage, number>();
  handlers = new Set<unknown>();
  scheduled = false;
  isIdle(): boolean {
    const now = uptimeMillis();
    for (const when of this.messages.values()) if (when <= now) return false;
    return true;
  }
  checkIdle() {
    if (!this.owner || this.scheduled || !this.handlers.size || !this.isIdle()) return;
    this.scheduled = true;
    setGuestTimeout(() => void this.owner!.run(async () => {
      this.scheduled = false;
      if (!this.isIdle()) return;
      for (const handler of [...this.handlers]) {
        if (!this.handlers.has(handler)) continue;
        try { if (!await vcall(handler, "queueIdle", "()Z")) this.handlers.delete(handler); }
        catch (error) { this.handlers.delete(handler); reportUncaught(error); }
      }
    }), 0);
  }
}
export class JLooper extends JObj {
  thread: JThread;
  q: Promise<unknown> = Promise.resolve();
  queue = Object.assign(new JMessageQueue(), { owner: this });
  printer: unknown = null;   // Looper.setMessageLogging
  constructor(thread?: JThread) { super(); this.thread = thread ?? curThread; }
  /** Messages run serialized on the looper's thread. The main looper is the shell's queue; any
   *  other is its own chain with a macrotask hop between messages, so the shell, rAF and the
   *  other loopers get the JS thread even under a self-reposting message (a game's frame loop). */
  run<T>(job: () => Promise<T> | T): Promise<T> {
    if (this === mainLooper) return onMain(job);
    const p = this.q.then(async () => {
      await yieldToLoop();
      await this.thread.untilIdle();                                             // a thread blocked in native code runs no message, as on a device
      const prev = curThread;
      setCurThread(this.thread);
      try { return job(); } finally { setCurThread(prev); }
    });
    this.q = p.catch(() => { /* a failed message must not poison the queue */ });
    return p;
  }
}
/** Looper.loop with a Printer installed: the two lines around each dispatch that block-detectors time */
function dispatchLogged(handler: JHandler, msg: JMessage, printer: unknown): void | Promise<void> { return rt.drive(dispatchLogged$(handler, msg, printer)); }
function* dispatchLogged$(handler: JHandler, msg: JMessage, printer: unknown): Gen<void> {
  const thread = curThread;
  const str = async (o: unknown) => o === null ? "null" : String(await vcallOn(thread, o, "toString", "()Ljava/lang/String;"));
  try {
    (yield vcallOn(thread, printer, "println", "(Ljava/lang/String;)V", `>>>>> Dispatching to ${(yield str(handler))} ${(yield str(msg.callback))}: ${msg.what}`));
    (yield vcallOn(thread, handler, "dispatchMessage", "(Landroid/os/Message;)V", msg));
    (yield vcallOn(thread, printer, "println", "(Ljava/lang/String;)V", `<<<<< Finished to ${(yield str(handler))} ${(yield str(msg.callback))}`));
  } catch (e) { reportUncaught(e); }
}
rt.markers("android/util/Printer");
export const mainLooper = new JLooper(mainThread);
mainThread.looper = mainLooper;
rt.register({
  name: "android/os/Looper", ctor: JLooper,
  methods: {
    "static getMainLooper()Landroid/os/Looper;": () => mainLooper,
    "static myLooper()Landroid/os/Looper;": () => (curThread.looper as JLooper) ?? null,
    "static prepare()V": () => { if (!curThread.looper) curThread.looper = new JLooper(); },
    "loop()V": () => new Promise(() => {}), // parks the java thread; JS loop drives everything
    "static loop()V": () => new Promise(() => {}),
    "getThread()Ljava/lang/Thread;": function (this: JLooper) { return this.thread; },
    "isCurrentThread()Z": function (this: JLooper) { return curThread === this.thread ? 1 : 0; },
    ...noops("static prepareMainLooper()V", "quit()V", "quitSafely()V"),
    "getQueue()Landroid/os/MessageQueue;": function (this: JLooper) { return this.queue; },
    "setMessageLogging(Landroid/util/Printer;)V": function (this: JLooper, printer: unknown) { this.printer = printer; },
    "static myQueue()Landroid/os/MessageQueue;": () => {
      if (!curThread.looper) throw rt.mkThrowable("java/lang/IllegalStateException", "No Looper; Looper.prepare() wasn't called on this thread.");
      return (curThread.looper as JLooper).queue;
    },
  },
});
rt.register({
  name: "android/os/MessageQueue", ctor: JMessageQueue,
  methods: {
    "isIdle()Z": function (this: JMessageQueue) { return +this.isIdle(); },
    "addIdleHandler(Landroid/os/MessageQueue$IdleHandler;)V": function (this: JMessageQueue, h: unknown) {
      if (!h) throw rt.mkThrowable("java/lang/NullPointerException", "handler");
      this.handlers.add(h); this.checkIdle();
    },
    "removeIdleHandler(Landroid/os/MessageQueue$IdleHandler;)V": function (this: JMessageQueue, h: unknown) { this.handlers.delete(h); },
  },
});
// A callback interface an app implements has to be registered or its class cannot link, and
// Runtime.link auto-stubs it and poisons everything downstream. Nothing calls it through this
// name -- addIdleHandler dispatches dynamically -- which is exactly why it was missed.
rt.markers("android/os/MessageQueue$IdleHandler");

rt.register({ name: "android/os/Handler$Callback", ctor: class extends JObj {}, methods: {
  "handleMessage(Landroid/os/Message;)Z": () => { throw rt.mkThrowable("java/lang/AbstractMethodError", "android.os.Handler.Callback.handleMessage"); },
} });
defineException("android/os/RemoteException", "java/lang/Exception");
defineException("android/os/DeadObjectException", "android/os/RemoteException");
defineException("android/os/OperationCanceledException", "java/lang/RuntimeException");

export const bootTime = typeof window === "undefined" ? performance.timeOrigin : window.parent.performance.timeOrigin;
export const uptimeMillis = () => performance.timeOrigin - bootTime + guestNow();
let handlerSeq = 0;
function emptyMessage(w: number): JMessage { const m = new JMessage(); m.what = w; return m; }
export class JHandler extends JObj {
  looper: JLooper = mainLooper;
  cb: unknown = null; // Handler.Callback
  pending = new Map<unknown, Set<JMessage>>(); // keyed by `what`, or by the Runnable of a post
  id = handlerSeq++;

  send(msg: JMessage, delay: number): number {
    msg.target = this;
    const key = msg.callback ?? msg.what;
    let set = this.pending.get(key);
    if (!set) this.pending.set(key, (set = new Set()));
    set.add(msg);
    const queue = this.looper.queue;
    queue.messages.set(msg, uptimeMillis() + Math.max(0, delay));
    // still pending until it runs, so a removeMessages/hasMessages in between sees it
    const go = () => this.looper.run(async () => {
      queue.messages.delete(msg);
      if (!set.delete(msg)) return;
      if (!set.size) this.pending.delete(key);
      const printer = this.looper.printer;
      try {
        if (printer) await dispatchLogged(this, msg, printer);
        else await vcallAsync(this, "dispatchMessage", "(Landroid/os/Message;)V", msg).catch(reportUncaught);
      } finally { queue.checkIdle(); }
    });
    if (delay > 0) msg.timer = setGuestTimeout(() => void go(), delay) as ReturnType<typeof setTimeout>; else void go();
    return 1;
  }
  post(r: unknown, delay: number): number { return this.send(obtain(this, 0, null, 0, 0, r), delay); }
  cancel(key: unknown): void {
    const messages = this.pending.get(key);
    if (messages) this.cancelMatching(() => true, [[key, messages]]);
  }
  cancelMatching(matches: (key: unknown, message: JMessage) => boolean, entries: Iterable<[unknown, Set<JMessage>]> = this.pending): void {
    for (const [key, messages] of entries) {
      for (const message of messages) {
        if (!matches(key, message)) continue;
        clearGuestTimeout(message.timer);
        this.looper.queue.messages.delete(message);
        messages.delete(message);
      }
      if (!messages.size) this.pending.delete(key);
    }
    this.looper.queue.checkIdle();
  }
}
/** The window's handler, which View.post/postDelayed/scheduleDrawable enqueue on. Lazy so it
 *  is built after boot has linked the native classes. */
let _mainHandler: JHandler | null = null;
export function mainHandler(): JHandler {
  if (!_mainHandler) { rt.link("android/os/Handler"); _mainHandler = new JHandler(); }
  return _mainHandler;
}

class JHandlerExecutor extends JObj { handler = mainHandler(); }
let _mainExecutor: JHandlerExecutor | null = null;
export function mainExecutor(): JHandlerExecutor { return _mainExecutor ??= new JHandlerExecutor(); }
rt.register({
  name: "android/os/HandlerExecutor", ctor: JHandlerExecutor, ifaces: ["java/util/concurrent/Executor"],
  methods: {
    "<init>(Landroid/os/Handler;)V": function (this: JHandlerExecutor, handler: JHandler) {
      if (!handler) throw rt.mkThrowable("java/lang/NullPointerException", "handler");
      this.handler = handler;
    },
    "execute(Ljava/lang/Runnable;)V": function (this: JHandlerExecutor, task: unknown) {
      if (!task) throw rt.mkThrowable("java/lang/NullPointerException", "task");
      if (!this.handler.post(task, 0)) throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "Handler is shutting down");
    },
  },
});

rt.register({
  name: "android/os/Handler", ctor: JHandler,
  methods: {
    "<init>()V": function (this: JHandler) { this.looper = (curThread.looper as JLooper) ?? mainLooper; },
    "<init>(Landroid/os/Looper;)V": function (this: JHandler, l: JLooper) { this.looper = l ?? mainLooper; },
    "<init>(Landroid/os/Looper;Landroid/os/Handler$Callback;)V": function (this: JHandler, l: JLooper, cb: unknown) {
      this.looper = l ?? mainLooper; this.cb = cb;
    },
    "<init>(Landroid/os/Handler$Callback;)V": function (this: JHandler, cb: unknown) {
      this.looper = (curThread.looper as JLooper) ?? mainLooper; this.cb = cb;
    },
    "handleMessage(Landroid/os/Message;)V": function () {},
    "dispatchMessage(Landroid/os/Message;)V": driven(function* (this: JHandler, msg: JMessage): Gen {
      const thread = curThread;
      if (msg.callback) (yield vcall(msg.callback, "run", "()V"));
      else if (!this.cb || !(yield vcallOn(thread, this.cb, "handleMessage", "(Landroid/os/Message;)Z", msg)))
        (yield vcallOn(thread, this, "handleMessage", "(Landroid/os/Message;)V", msg));
    }),
    "post(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.post(r, 0); },
    "postDelayed(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, d: bigint) { return this.post(r, Number(d)); },
    "postDelayed(Ljava/lang/Runnable;Ljava/lang/Object;J)Z": function (this: JHandler, r: unknown, token: unknown, d: bigint) {
      return this.send(obtain(this, 0, token, 0, 0, r), Number(d));
    },
    "postAtTime(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, at: bigint) {
      return this.post(r, Math.max(0, Number(at) - uptimeMillis()));
    },
    "postAtFrontOfQueue(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.post(r, 0); },
    "removeCallbacks(Ljava/lang/Runnable;)V": function (this: JHandler, r: unknown) { this.cancel(r); },
    "sendMessage(Landroid/os/Message;)Z": function (this: JHandler, m: JMessage) { return this.send(m, 0); },
    "sendMessageAtFrontOfQueue(Landroid/os/Message;)Z": function (this: JHandler, m: JMessage) { return this.send(m, 0); },
    "sendMessageDelayed(Landroid/os/Message;J)Z": function (this: JHandler, m: JMessage, d: bigint) { return this.send(m, Number(d)); },
    "sendEmptyMessage(I)Z": function (this: JHandler, w: number) { return this.send(emptyMessage(w), 0); },
    "sendEmptyMessageAtTime(IJ)Z": function (this: JHandler, w: number, at: bigint) { return this.send(emptyMessage(w), Math.max(0, Number(at) - uptimeMillis())); },
    "sendEmptyMessageDelayed(IJ)Z": function (this: JHandler, w: number, d: bigint) { return this.send(emptyMessage(w), Number(d)); },
    "removeCallbacks(Ljava/lang/Runnable;Ljava/lang/Object;)V": function (this: JHandler, r: unknown, token: unknown) {
      this.cancelMatching((key, message) => key === r && (token == null || message.obj === token));
    },
    "removeMessages(I)V": function (this: JHandler, w: number) { this.cancel(w); },
    "removeMessages(ILjava/lang/Object;)V": function (this: JHandler, w: number, obj: unknown) {
      const messages = this.pending.get(w);
      if (messages) this.cancelMatching((_key, message) => obj == null || message.obj === obj, [[w, messages]]);
    },
    "removeCallbacksAndMessages(Ljava/lang/Object;)V": function (this: JHandler, token: unknown) {
      this.cancelMatching((_key, message) => token == null || message.obj === token);
    },
    "hasMessages(I)Z": function (this: JHandler, w: number) { return this.pending.get(w)?.size ? 1 : 0; },
    "hasCallbacks(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.pending.get(r)?.size ? 1 : 0; },
    // the object variant asks about messages carrying that obj; posts here are keyed by `what`
    "hasMessages(ILjava/lang/Object;)Z": function (this: JHandler, w: number) { return this.pending.get(w)?.size ? 1 : 0; },
    "getLooper()Landroid/os/Looper;": function (this: JHandler) { return this.looper; },
    "obtainMessage()Landroid/os/Message;": function (this: JHandler) { const m = new JMessage(); m.target = this; return m; },
    "obtainMessage(I)Landroid/os/Message;": function (this: JHandler, w: number) { const m = emptyMessage(w); m.target = this; return m; },
    "obtainMessage(ILjava/lang/Object;)Landroid/os/Message;": function (this: JHandler, w: number, o: unknown) { const m = emptyMessage(w); m.target = this; m.obj = o; return m; },
    "obtainMessage(III)Landroid/os/Message;": function (this: JHandler, w: number, a1: number, a2: number) {
      return obtain(this, w, null, a1, a2);
    },
    "obtainMessage(IIILjava/lang/Object;)Landroid/os/Message;": function (this: JHandler, w: number, a1: number, a2: number, obj: unknown) {
      return obtain(this, w, obj, a1, a2);
    },
    "static createAsync(Landroid/os/Looper;)Landroid/os/Handler;": (l: JLooper) => {
      const h = new JHandler(); h.looper = l ?? mainLooper; return h;
    },
  },
});
rt.register({ name: "android/os/HandlerThread", ctor: class extends JThread { jlooper = new JLooper(); },
  sup: "java/lang/Thread",
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: any, n: string) { this.jname = n; this.jlooper.thread = this; this.looper = this.jlooper; },
    "<init>(Ljava/lang/String;I)V": function (this: any, n: string) { this.jname = n; this.jlooper.thread = this; this.looper = this.jlooper; },
    "start()V": function (this: any) { this.alive = 1; },
    "getLooper()Landroid/os/Looper;": function (this: any) { return this.jlooper; },
    "getThreadId()I": function (this: JThread) { return this.alive ? threadTid(this) : -1; },
    "quit()Z": () => 1, "quitSafely()Z": () => 1,
    "run()V": function () {},
  },
});

const RUNTIME_STATS = ["art.gc.gc-count", "art.gc.gc-time", "art.gc.bytes-allocated", "art.gc.bytes-freed", "art.gc.blocking-gc-count", "art.gc.blocking-gc-time", "art.gc.gc-count-rate-histogram", "art.gc.blocking-gc-count-rate-histogram"];
// ── SystemClock / Build / Process / Trace / Debug / StrictMode
class JSystemClock extends JObj {}
rt.register({
  name: "android/os/SystemClock", ctor: JSystemClock,
  methods: {
    "static uptimeMillis()J": () => BigInt(Math.floor(uptimeMillis())),
    "static elapsedRealtime()J": () => BigInt(Math.floor(uptimeMillis())),
    "static elapsedRealtimeNanos()J": () => BigInt(Math.floor(uptimeMillis() * 1e6)),
    "static currentThreadTimeMillis()J": () => BigInt(Math.floor(performance.now())),
    "static currentGnssTimeClock()Ljava/time/Clock;": () => unavailableClock("Gnss based time is not available."),
    "static sleep(J)V": (ms: bigint) => guestSleep(Number(ms)),
  },
});
class JConditionVariable extends JObj {
  opened = false;
  waiters = new Set<() => void>();
  block(ms = 0): number | Promise<number> {
    if (this.opened) return 1;
    if (ms < 0) return 0;
    return new Promise((resolve) => {
      const done = () => { clearGuestTimeout(timer); this.waiters.delete(done); resolve(this.opened ? 1 : 0); };
      const timer = ms === 0 ? undefined : setGuestTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}
rt.register({
  name: "android/os/ConditionVariable", ctor: JConditionVariable,
  methods: {
    "<init>()V": function (this: JConditionVariable) { this.opened = false; },
    "<init>(Z)V": function (this: JConditionVariable, state: number) { this.opened = !!state; },
    "open()V": function (this: JConditionVariable) { this.opened = true; for (const wake of this.waiters) wake(); },
    "close()V": function (this: JConditionVariable) { this.opened = false; },
    "block()V": function (this: JConditionVariable) { return this.block(); },
    "block(J)Z": function (this: JConditionVariable, ms: bigint) { return this.block(Number(ms)); },
  },
});
class JBuild extends JObj {}
const abi32 = jarray(["armeabi-v7a"], "Ljava/lang/String;"), abi64 = jarray(["arm64-v8a"], "Ljava/lang/String;");
const is64BitProcess = () => rt.nativeAbis.find(abi => Object.keys(rt.classpath).some(path => path.startsWith("lib/" + abi + "/"))) !== "armeabi-v7a";
rt.register({
  name: "android/os/Build", ctor: JBuild,
  statics: {
    MODEL: "webdroid", MANUFACTURER: "webdroid", BRAND: "google", DEVICE: "webdroid",
    PRODUCT: "webdroid", HARDWARE: "browser", FINGERPRINT: "google/webdroid/1.0", SOC_MANUFACTURER: "unknown", SOC_MODEL: "unknown", SKU: "unknown", ODM_SKU: "unknown",
    SERIAL: "unknown", RADIO: "unknown", ID: "WD1A", DISPLAY: "webdroid 1.0", TAGS: "release-keys", TYPE: "user",
    BOARD: "web", BOOTLOADER: "unknown", HOST: "localhost", USER: "web", TIME: 0n,
    SUPPORTED_ABIS: jarray([...abi64, ...abi32], "Ljava/lang/String;"),
    SUPPORTED_32_BIT_ABIS: abi32,
    SUPPORTED_64_BIT_ABIS: abi64,
    get CPU_ABI() { return (is64BitProcess() ? abi64 : abi32)[0]; },
    get CPU_ABI2() { return (is64BitProcess() ? abi64 : abi32)[1] ?? ""; },
  },
  methods: { "static getSerial()Ljava/lang/String;": () => "unknown", "static getRadioVersion()Ljava/lang/String;": () => null },
});
class JBuildVersion extends JObj {}
rt.register({
  name: "android/os/Build$VERSION", ctor: JBuildVersion,
  statics: { SDK_INT: device.sdk, RELEASE: device.release, CODENAME: "REL", INCREMENTAL: "1", SECURITY_PATCH: "2023-01-01", SDK: String(device.sdk), BASE_OS: "", PREVIEW_SDK_INT: 0, MEDIA_PERFORMANCE_CLASS: 0 },
});
rt.register({ name: "android/os/Build$VERSION_CODES", ctor: class extends JObj {},
  statics: Object.fromEntries([
    ["BASE", 1], ["JELLY_BEAN", 16], ["KITKAT", 19], ["LOLLIPOP", 21], ["LOLLIPOP_MR1", 22], ["M", 23],
    ["N", 24], ["N_MR1", 25], ["O", 26], ["O_MR1", 27], ["P", 28], ["Q", 29], ["R", 30],
    ["S", 31], ["S_V2", 32], ["TIRAMISU", 33], ["UPSIDE_DOWN_CAKE", 34], ["VANILLA_ICE_CREAM", 35],
  ]),
});
export let PROCESS_PID = 1000, PROCESS_UID = 10001;
export let PROCESS_NAME = "";
export function setProcessIdentity(pid: number, uid: number): void { PROCESS_PID = pid; PROCESS_UID = uid; procIdentity.pid = pid; procIdentity.uid = uid; }
export class JUserHandle extends JObj { constructor(readonly id = 0) { super(); } }
const userHandles = new Map<number, JUserHandle>();
export function userHandleForUid(uid: number): JUserHandle {
  const userId = Math.trunc(uid / 100000);
  let handle = userHandles.get(userId);
  if (!handle) { handle = new JUserHandle(userId); userHandles.set(userId, handle); }
  return handle;
}
/** the kernel thread id of a Java thread: the main thread's is the pid, as on a device */
export function threadTid(t: JThread): number {
  return processTid(t, t === mainThread);
}
export function setProcessName(name: string): void { PROCESS_NAME = name; procIdentity.name = name; }
rt.register({
  name: "android/os/Process", ctor: class extends JObj {},
  statics: { THREAD_PRIORITY_BACKGROUND: 10, THREAD_PRIORITY_DEFAULT: 0, THREAD_PRIORITY_URGENT_DISPLAY: -8 },
  methods: {
    "static myPid()I": () => PROCESS_PID,
    "static is64Bit()Z": () => is64BitProcess() ? 1 : 0,
    "static killProcess(I)V": (pid: number) => { console.warn("Process.killProcess", pid); markProcessExited(); },
    // androidx's startup tracing asks how long ago this process began; there is no earlier
    // moment here than the page's own timeOrigin
    "static getStartUptimeMillis()J": () => 0n,
    "static getStartRequestedUptimeMillis()J": () => 0n,
    "static getStartRequestedElapsedRealtime()J": () => 0n,
    "static getElapsedCpuTime()J": () => BigInt(Math.round(performance.now())),
    "static myTid()I": () => threadTid(curThread),
    "static myUid()I": () => PROCESS_UID,
    "static myUserHandle()Landroid/os/UserHandle;": () => userHandleForUid(PROCESS_UID),
    "static isApplicationUid(I)Z": (uid: number) => { const appId = uid % 100000; return appId >= 10000 && appId <= 19999 ? 1 : 0; },
    "static getGidForName(Ljava/lang/String;)I": (name: string | null) => {
      if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      return androidGroupId(name);
    },
    ...stubs(0n, "static getStartElapsedRealtime()J"),
    ...stubs(0, "static isIsolated()Z", "static isSdkSandbox()Z", "static getThreadPriority(I)I"),
    ...noops("static setThreadPriority(I)V", "static setThreadPriority(II)V"),
  },
});
rt.register({
  name: "android/os/Trace", ctor: class extends JObj {},
  methods: {
    ...noops("static setCounter(Ljava/lang/String;J)V", "static beginSection(Ljava/lang/String;)V",
      "static endSection()V", "static beginAsyncSection(Ljava/lang/String;I)V",
      "static endAsyncSection(Ljava/lang/String;I)V"),
    ...stubs(0, "static isTagEnabled(J)Z", "static isEnabled()Z"),
  },
});
class JMemoryInfo extends JObj {
  dalvikSharedClean = 0; nativeSharedClean = 0; otherSharedClean = 0;
  dalvikPrivateClean = 0; nativePrivateClean = 0; otherPrivateClean = 0;
  dalvikPss = 0; nativePss = 0; otherPss = 0;
  dalvikSwappablePss = 0; nativeSwappablePss = 0; otherSwappablePss = 0;
  dalvikSharedDirty = 0; dalvikPrivateDirty = 0; nativeSharedDirty = 0; nativePrivateDirty = 0; otherSharedDirty = 0; otherPrivateDirty = 0;
  get totalPss() { return this.dalvikPss + this.nativePss + this.otherPss; }
  get privateDirty() { return this.dalvikPrivateDirty + this.nativePrivateDirty + this.otherPrivateDirty; }
  stats(): Record<string, number> {
    return {
      "summary.java-heap": this.dalvikPrivateDirty, "summary.native-heap": this.nativePrivateDirty,
      "summary.code": 0, "summary.stack": 0, "summary.graphics": 0,
      "summary.private-other": this.otherPrivateDirty, "summary.system": this.totalPss - this.privateDirty,
      "summary.total-pss": this.totalPss, "summary.total-swap": 0,
    };
  }
}
rt.register({
  name: "android/os/Debug$MemoryInfo", ctor: JMemoryInfo,
  fields: ["dalvikPss", "nativePss", "otherPss", "dalvikSharedDirty", "dalvikPrivateDirty",
    "nativeSharedDirty", "nativePrivateDirty", "otherSharedDirty", "otherPrivateDirty",
    "dalvikSwappablePss", "nativeSwappablePss", "otherSwappablePss",
    "dalvikSharedClean", "nativeSharedClean", "otherSharedClean", "dalvikPrivateClean", "nativePrivateClean", "otherPrivateClean"],
  methods: {
    "getTotalPss()I": function (this: JMemoryInfo) { return this.totalPss; },
    "getTotalSwappablePss()I": function (this: JMemoryInfo) { return this.dalvikSwappablePss + this.nativeSwappablePss + this.otherSwappablePss; },
    ...noops("<init>()V"),
    "getTotalPrivateDirty()I": function (this: JMemoryInfo) { return this.privateDirty; },
    "getTotalSharedDirty()I": function (this: JMemoryInfo) { return this.dalvikSharedDirty + this.nativeSharedDirty + this.otherSharedDirty; },
    "getTotalSharedClean()I": function (this: JMemoryInfo) { return this.dalvikSharedClean + this.nativeSharedClean + this.otherSharedClean; },
    "getTotalPrivateClean()I": function (this: JMemoryInfo) { return this.dalvikPrivateClean + this.nativePrivateClean + this.otherPrivateClean; },
    "getMemoryStat(Ljava/lang/String;)Ljava/lang/String;": function (this: JMemoryInfo, key: string) {
      const stats = this.stats(); return Object.hasOwn(stats, key) ? String(stats[key]) : null;
    },
    "getMemoryStats()Ljava/util/Map;": driven(function* (this: JMemoryInfo): Gen {
      const map = (yield newObj("java/util/HashMap"));
      for (const [key, value] of Object.entries(this.stats())) (yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, String(value)));
      return map;
    }),
  },
});
rt.register({
  name: "android/os/Debug", ctor: class extends JObj {},
  methods: {
    // the native heap is the guest allocator's: bytes in use, the extent it has reached, and the gap
    "static getNativeHeapAllocatedSize()J": () => BigInt(Math.round(mem.stats().used)),
    "static getNativeHeapSize()J": () => BigInt(Math.round(mem.stats().peak)),
    "static getNativeHeapFreeSize()J": () => BigInt(Math.max(0, Math.round(mem.stats().peak - mem.stats().used))),
    ...stubs(0, "static isDebuggerConnected()Z", "static waitingForDebugger()Z"),
    "static threadCpuTimeNanos()J": () => BigInt(Math.round(performance.now() * 1e6)),
    "static getThreadAllocCount()I": () => 0,
    "static getThreadAllocSize()I": () => 0,
    "static getPss()J": () => BigInt((((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1024) | 0),
    // ART's runtime counters: nothing here collects, blocks or compacts, so every stat is zero
    "static getRuntimeStat(Ljava/lang/String;)Ljava/lang/String;": (name: string) => RUNTIME_STATS.includes(name) ? "0" : null,
    "static getRuntimeStats()Ljava/util/Map;": driven(function* (): Gen  {
      const m = (yield newObj("java/util/HashMap"));
      for (const k of RUNTIME_STATS) (yield vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", k, "0"));
      return m;
    }),
    // the JS heap is the nearest thing to this process's dalvik footprint; nothing here is shared
    "static getMemoryInfo(Landroid/os/Debug$MemoryInfo;)V": (info: { dalvikPss: number; dalvikPrivateDirty: number; nativePss: number; nativePrivateDirty: number } | null) => {
      if (!info) throw rt.mkThrowable("java/lang/NullPointerException", "memoryInfo");
      const kb = (((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1024) | 0;
      info.dalvikPss = kb; info.dalvikPrivateDirty = kb;
      const native = Math.round(mem.stats().used / 1024);
      info.nativePss = native; info.nativePrivateDirty = native;
    },
  },
});
{
  const chain = (name: string, methods: string[], buildRet?: string) => {
    class C extends JObj {}
    const m: NativeSpec["methods"] = { "<init>()V": function () {} };
    for (const mm of methods) m[mm] = function (this: C) { return this; };
    if (buildRet) {
      const info = () => rt.link(buildRet);
      m[`build()L${buildRet};`] = () => new (info().ctor)();
      m[`<init>(L${buildRet};)V`] = function () {}; // Builder(existing policy) — nothing is enforced, so nothing to copy
    }
    rt.register({ name, ctor: C, methods: m });
  };
  rt.register({ name: "android/os/StrictMode$ThreadPolicy", ctor: class extends JObj {} });
  rt.register({ name: "android/os/StrictMode$VmPolicy", ctor: class extends JObj {} });
  // every detect*/permit*/penalty* of the API-34 builders: nothing is enforced, so each returns the builder
  const TB = "Landroid/os/StrictMode$ThreadPolicy$Builder;", VB = "Landroid/os/StrictMode$VmPolicy$Builder;";
  const flags = (ret: string, kinds: string[], extra: string[]) => [...kinds.map((k) => `${k}()${ret}`), ...extra.map((e) => e + ret)];
  chain("android/os/StrictMode$ThreadPolicy$Builder",
    flags(TB, ["All", "CustomSlowCalls", "DiskReads", "DiskWrites", "ExplicitGc", "Network", "ResourceMismatches", "UnbufferedIo"].flatMap((k) => ["detect" + k, "permit" + k]),
      ["penaltyDeath()", "penaltyDeathOnNetwork()", "penaltyDialog()", "penaltyDropBox()", "penaltyFlashScreen()", "penaltyLog()",
        "penaltyListener(Ljava/util/concurrent/Executor;Landroid/os/StrictMode$OnThreadViolationListener;)"]),
    "android/os/StrictMode$ThreadPolicy");
  chain("android/os/StrictMode$VmPolicy$Builder",
    flags(VB, ["ActivityLeaks", "All", "CleartextNetwork", "ContentUriWithoutPermission", "CredentialProtectedWhileLocked", "FileUriExposure", "ImplicitDirectBoot",
      "IncorrectContextUse", "LeakedClosableObjects", "LeakedRegistrationObjects", "LeakedSqlLiteObjects", "NonSdkApiUsage", "UnsafeIntentLaunch", "UntaggedSockets"].map((k) => "detect" + k),
      ["permitNonSdkApiUsage()", "permitUnsafeIntentLaunch()", "penaltyDeath()", "penaltyDeathOnCleartextNetwork()", "penaltyDeathOnFileUriExposure()", "penaltyDropBox()", "penaltyLog()",
        "penaltyListener(Ljava/util/concurrent/Executor;Landroid/os/StrictMode$OnVmViolationListener;)", "setClassInstanceLimit(Ljava/lang/Class;I)"]),
    "android/os/StrictMode$VmPolicy");
  const threadPolicy = () => rt.make("android/os/StrictMode$ThreadPolicy");
  rt.register({
    name: "android/os/StrictMode", ctor: class extends JObj {},
    methods: {
      ...noops("static setThreadPolicy(Landroid/os/StrictMode$ThreadPolicy;)V",
        "static noteSlowCall(Ljava/lang/String;)V", "static setVmPolicy(Landroid/os/StrictMode$VmPolicy;)V"),
      "static getVmPolicy()Landroid/os/StrictMode$VmPolicy;": () => rt.make("android/os/StrictMode$VmPolicy"),
      "static getThreadPolicy()Landroid/os/StrictMode$ThreadPolicy;": threadPolicy,
      "static allowThreadDiskReads()Landroid/os/StrictMode$ThreadPolicy;": threadPolicy,
      "static allowThreadDiskWrites()Landroid/os/StrictMode$ThreadPolicy;": threadPolicy,
    },
  });
}

export class JBaseBundle extends JObj {
  map = new Map<string, unknown>();
  loader: unknown = null;
}
export class JPersistableBundle extends JBaseBundle {}
export class JBundle extends JBaseBundle {
  constructor() { super(); rt.link("android/os/Bundle"); }
}
const bundleBoxes: Record<string, typeof JInt | typeof JLong | typeof JFloat | typeof JDouble | typeof JBool | typeof JChar> = {
  I: JInt, J: JLong, F: JFloat, D: JDouble, Z: JBool, C: JChar,
};
export function bundlePrimitive(value: unknown, descriptor: string, fallback: unknown): unknown {
  if (typeof value === (descriptor === "J" ? "bigint" : "number")) return value;
  return value instanceof bundleBoxes[descriptor] ? value.v : fallback;
}
export function bundleBox(value: unknown, descriptor: string): unknown {
  if (typeof value !== "number") return value;
  if (descriptor === "C") return box(JChar, value);
  if (descriptor === "Z") return box(JBool, value);
  if (descriptor === "F") return box(JFloat, value);
  if (descriptor === "D") return box(JDouble, value);
  return value;
}
const bundleMethods: NativeSpec["methods"] = {
  "<init>(Landroid/os/Bundle;)V": function (this: JBundle, b: JBundle) { if (b) { this.map = new Map(b.map); this.loader = b.loader; } },
  "<init>(Ljava/lang/ClassLoader;)V": function (this: JBundle, cl: unknown) { this.loader = cl; },
  "clone()Ljava/lang/Object;": function (this: JBundle) {
    const copy = new (this.constructor as typeof JBundle)();
    copy.map = new Map(this.map); copy.loader = this.loader;
    return copy;
  },
  ...noops("<init>()V", "<init>(I)V"),
  ...stubs(0, "describeContents()I"),
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JBundle, parcel: JParcel): Gen { (yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", this)); }),
  "size()I": function (this: JBundle) { return this.map.size; },
  // A Bundle holds boxed values: `get` is the only reader that lost the declared width, and a
  // caller that reaches for Object then calls toString()/instanceof Number needs the box.
  "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JBundle, k: string) { return boxObject(this.map.get(k) ?? null); },
  "isEmpty()Z": function (this: JBundle) { return this.map.size ? 0 : 1; },
  "containsKey(Ljava/lang/String;)Z": function (this: JBundle, k: string) { return this.map.has(k) ? 1 : 0; },
  "remove(Ljava/lang/String;)V": function (this: JBundle, k: string) { this.map.delete(k); },
  "clear()V": function (this: JBundle) { this.map.clear(); },
  "keySet()Ljava/util/Set;": function (this: JBundle) {
    return newStringSet(this.map.keys());
  },
  "putAll(Landroid/os/Bundle;)V": function (this: JBundle, b: JBundle) { for (const [k, v] of b.map) this.map.set(k, v); },
  "setClassLoader(Ljava/lang/ClassLoader;)V": function (this: JBundle, cl: unknown) { this.loader = cl; },
  "getClassLoader()Ljava/lang/ClassLoader;": function (this: JBundle) { return this.loader; },
  "getParcelable(Ljava/lang/String;)Landroid/os/Parcelable;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putParcelable(Ljava/lang/String;Landroid/os/Parcelable;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
  "getSerializable(Ljava/lang/String;)Ljava/io/Serializable;": function (this: JBundle, k: string) { return boxObject(this.map.get(k) ?? null); },
  "putSerializable(Ljava/lang/String;Ljava/io/Serializable;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
  "getStringArrayList(Ljava/lang/String;)Ljava/util/ArrayList;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putStringArrayList(Ljava/lang/String;Ljava/util/ArrayList;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
  "getParcelableArrayList(Ljava/lang/String;)Ljava/util/ArrayList;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putParcelableArrayList(Ljava/lang/String;Ljava/util/ArrayList;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
  "getBundle(Ljava/lang/String;)Landroid/os/Bundle;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putBundle(Ljava/lang/String;Landroid/os/Bundle;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
};
for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Byte", "B"], ["Short", "S"], ["Boolean", "Z"], ["Char", "C"],
  ["Float", "F"], ["Double", "D"], ["CharSequence", "Ljava/lang/CharSequence;"], ["ByteArray", "[B"],
  ["IntArray", "[I"], ["LongArray", "[J"], ["StringArray", "[Ljava/lang/String;"],
  ["IntegerArrayList", "Ljava/util/ArrayList;"], ["ParcelableArray", "[Landroid/os/Parcelable;"],
  ["SparseParcelableArray", "Landroid/util/SparseArray;"], ["Binder", "Landroid/os/IBinder;"]] as const) {
  bundleMethods[`put${t}(Ljava/lang/String;${d})V`] = function (this: JBundle, k: string, v: unknown) { this.map.set(k, bundleBox(v, d)); };
  bundleMethods[`get${t}(Ljava/lang/String;)${d}`] = function (this: JBundle, k: string) {
    const v = this.map.get(k);
    if (d.length === 1) return bundlePrimitive(v, d, d === "J" ? 0n : 0);
    if (v !== undefined) return v;
    return d === "I" || d === "Z" ? 0 : d === "J" ? 0n : d === "F" || d === "D" ? 0 : null;
  };
  if (d === "I" || d === "J" || d === "Z" || d === "C" || d === "F" || d === "D" || d === "Ljava/lang/String;" || d === "Ljava/lang/CharSequence;") {
    bundleMethods[`get${t}(Ljava/lang/String;${d})${d}`] = function (this: JBundle, k: string, dflt: unknown) {
      const v = this.map.get(k);
      if (d.length === 1) return bundlePrimitive(v, d, dflt);
      return v !== undefined ? v : dflt;
    };
  }
}
// The API 33 type-checked getters. The class argument only narrows the return type, so they read
// the same slot; androidx reaches for them from SDK_INT 34 up.
for (const [t, d] of [["Parcelable", "Ljava/lang/Object;"], ["Serializable", "Ljava/lang/Object;"],
  ["ParcelableArrayList", "Ljava/util/ArrayList;"], ["ParcelableArray", "[Ljava/lang/Object;"],
  ["SparseParcelableArray", "Landroid/util/SparseArray;"]] as const) {
  bundleMethods[`get${t}(Ljava/lang/String;Ljava/lang/Class;)${d}`] = function (this: JBundle, k: string) {
    return boxObject(this.map.get(k) ?? null);
  };
}
rt.register({ name: "android/os/BaseBundle", ctor: JBaseBundle, methods: bundleMethods });
rt.register({ name: "android/os/Bundle", ctor: JBundle, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], statics: { get EMPTY() { return new JBundle(); }, get CREATOR() { return parcelCreator("android/os/Bundle", (p) => vcall(p, "readBundle", "()Landroid/os/Bundle;")); } }, methods: bundleMethods });
rt.register({ name: "android/os/PersistableBundle", ctor: JPersistableBundle, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], methods: bundleMethods });

export const PARCELABLE = {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": () => {},
} as const;
// ParcelUuid is a Parcelable box around java.util.UUID and nothing else; it carries device and
// session identifiers across intents, so a class that is merely absent poisons the caller.
class JParcelUuid extends JObj { uuid: unknown = null; }
rt.register({
  name: "android/os/ParcelUuid", ctor: JParcelUuid, ifaces: ["android/os/Parcelable"],
  methods: {
    ...PARCELABLE,
    "<init>(Ljava/util/UUID;)V": function (this: JParcelUuid, u: unknown) { this.uuid = u; },
    "static fromString(Ljava/lang/String;)Landroid/os/ParcelUuid;": (s: string) => {
      rt.link("java/util/UUID");
      return Object.assign(new JParcelUuid(), { uuid: uuidFromString(s) });
    },
    "getUuid()Ljava/util/UUID;": function (this: JParcelUuid) { return this.uuid; },
    "toString()Ljava/lang/String;": function (this: JParcelUuid) { return vcall(this.uuid, "toString", "()Ljava/lang/String;"); },
    "equals(Ljava/lang/Object;)Z": function (this: JParcelUuid, o: unknown) {
      return o instanceof JParcelUuid ? vcall(this.uuid, "equals", "(Ljava/lang/Object;)Z", o.uuid) : 0;
    },
    "hashCode()I": function (this: JParcelUuid) { return vcall(this.uuid, "hashCode", "()I"); },
  },
});
rt.markers("android/os/Parcelable", "android/os/Parcelable$Creator");
rt.markers("android/os/OutcomeReceiver");
const sharedMappings = new WeakSet<JBuffer["backing"]>();
class JSharedMemory extends JObj {
  bytes = new Uint8Array(0);
  protection = 7;
  closed = false;
  map(prot: number, offset: number, length: number): JBuffer {
    if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
    if (offset < 0 || length <= 0 || offset > this.bytes.length - length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid shared memory range");
    if (prot < 0 || prot & ~7 || (prot & this.protection) !== prot) throw errno("mmap", E.ACCES);
    rt.link("java/nio/ByteBuffer");
    const buffer = mkByteBuffer(0, true);
    buffer.backing = { storage: { kind: "direct", ab: this.bytes.buffer as ArrayBuffer } };
    buffer.byteOffset = offset;
    buffer.cap = buffer.lim = length;
    buffer.readOnly = !(prot & 2);
    sharedMappings.add(buffer.backing);
    return buffer;
  }
}
rt.register({
  name: "android/os/SharedMemory", ctor: JSharedMemory, ifaces: ["android/os/Parcelable", "java/io/Closeable"],
  statics: { get CREATOR() { return parcelCreator("android/os/SharedMemory", async (p) => {
    const protection = await vcall(p, "readInt", "()I") as number;
    const bytes = await vcall(p, "createByteArray", "()[B") as Int8Array;
    const shared = new JSharedMemory(); shared.protection = protection; shared.bytes = Uint8Array.from(bytes);
    return shared;
  }); } },
  methods: {
    "static create(Ljava/lang/String;I)Landroid/os/SharedMemory;": (_name: string | null, size: number) => {
      if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Size must be positive");
      const shared = new JSharedMemory(); shared.bytes = new Uint8Array(size); return shared;
    },
    "getSize()I": function (this: JSharedMemory) {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      return this.bytes.length;
    },
    "map(III)Ljava/nio/ByteBuffer;": function (this: JSharedMemory, prot: number, offset: number, length: number) { return this.map(prot, offset, length); },
    "mapReadOnly()Ljava/nio/ByteBuffer;": function (this: JSharedMemory) { return this.map(1, 0, this.bytes.length); },
    "mapReadWrite()Ljava/nio/ByteBuffer;": function (this: JSharedMemory) { return this.map(3, 0, this.bytes.length); },
    "setProtect(I)Z": function (this: JSharedMemory, prot: number) {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      if (prot < 0 || prot & ~7) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid protection");
      if ((prot & this.protection) !== prot) return 0;
      this.protection = prot; return 1;
    },
    "static unmap(Ljava/nio/ByteBuffer;)V": (buffer: JBuffer | null) => {
      if (!buffer) return rt.npe();
      if (!sharedMappings.delete(buffer.backing)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer is not mapped shared memory");
      buffer.backing.storage = { kind: "direct", ab: new ArrayBuffer(0) };
    },
    "close()V": function (this: JSharedMemory) { this.closed = true; },
    "describeContents()I": () => 1,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JSharedMemory, parcel: JParcel): Gen {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      (yield vcall(parcel, "writeInt", "(I)V", this.protection));
      (yield vcall(parcel, "writeByteArray", "([B)V", new Int8Array(this.bytes.buffer)));
    }),
  },
});
class JCancellationSignal extends JObj {
  cancelled = 0;
  listener: unknown = null;
}
rt.markers("android/os/CancellationSignal$OnCancelListener");
rt.register({
  name: "android/os/CancellationSignal", ctor: JCancellationSignal,
  methods: {
    "<init>()V": function () {},
    "isCanceled()Z": function (this: JCancellationSignal) { return this.cancelled; },
    "cancel()V": driven(function* (this: JCancellationSignal): Gen {
      if (this.cancelled) return;
      this.cancelled = 1;
      if (this.listener) (yield vcall(this.listener, "onCancel", "()V"));
    }),
    "throwIfCanceled()V": function (this: JCancellationSignal) {
      if (this.cancelled) throw rt.mkThrowable("android/os/OperationCanceledException", null);
    },
    "setOnCancelListener(Landroid/os/CancellationSignal$OnCancelListener;)V": driven(function* (this: JCancellationSignal, listener: unknown): Gen {
      if (this.listener === listener) return;
      this.listener = listener;
      if (this.cancelled && listener) (yield vcall(listener, "onCancel", "()V"));
    }),
  },
});

export class JParcelFileDescriptor extends JObj {
  bytes: Uint8Array = new Uint8Array(0);
  sink: ((b: Uint8Array, closed?: boolean) => unknown) | null = null;
  path = "";
  flags = 0;
  fd = -1;
  closed = false;
  backing: PfdBacking | null = null;
}
type PfdBacking = { path: string; refs: number; key: string; closing: Promise<void> | null; sink: ((b: Uint8Array, closed?: boolean) => unknown) | null };
/** the native descriptor, opened on first request: only a fd that crosses JNI needs one. A
 *  read-only descriptor over bytes with no file behind them reads those bytes. */
function pfdFd(p: JParcelFileDescriptor): number {
  if (p.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "Already closed");
  if (p.fd < 0 && p.path) p.fd = javaOpenFd(p.path, p.flags);
  else if (p.fd < 0 && !p.sink) p.fd = javaBytesFd(p.bytes);
  return p.fd;
}
/** a java.io stream's descriptor opens its file into the native table when first asked (O_TRUNC
 *  and O_EXCL already happened when the stream opened it) */
export function descriptorFd(d: JFileDescriptor): number {
  if (d.fd < 0 && d.path) d.fd = javaOpenFd(d.path, d.flags & ~0x280);
  return d.fd;
}
let pfdBackingSeq = 0;
const pfdBackings = new Map<string, PfdBacking>();
export function pfdBackingBytes(key: string): Uint8Array | null | Promise<Uint8Array | null> { return rt.drive(pfdBackingBytes$(key)); }
function* pfdBackingBytes$(key: string): Gen<Uint8Array | null> {
  const backing = pfdBackings.get(key);
  if (backing?.closing) { (yield backing.closing); return null; }
  return backing ? vfs.read(backing.path) : null;
}
export function mkPfd(bytes: Uint8Array, sink: ((b: Uint8Array, closed?: boolean) => unknown) | null, backingKey?: string): JParcelFileDescriptor {
  const p = new JParcelFileDescriptor();
  p.bytes = bytes;
  p.sink = sink;
  if (backingKey) {
    let backing = pfdBackings.get(backingKey);
    if (!backing) {
      backing = { path: `/data/webdroid-pfd-${++pfdBackingSeq}`, refs: 0, key: backingKey, closing: null, sink };
      pfdBackings.set(backingKey, backing);
      vfs.markVolatile(backing.path);
      vfs.write(backing.path, bytes, false);
    }
    if (sink) backing.sink = sink;
    backing.refs++;
    p.path = backing.path;
    p.flags = sink ? 2 : 0;
    p.backing = backing;
  }
  return p;
}
export function parcelFileDescriptorData(value: unknown): { bytes: Uint8Array; writable: boolean } | null {
  return value instanceof JParcelFileDescriptor
    ? { bytes: (value.backing ? vfs.read(value.backing.path) : value.bytes)?.slice() ?? new Uint8Array(0), writable: value.sink !== null }
    : null;
}
export function writeParcelFileDescriptor(value: unknown, bytes: Uint8Array, closed = false): void | Promise<void> { return rt.drive(writeParcelFileDescriptor$(value, bytes, closed)); }
function* writeParcelFileDescriptor$(value: unknown, bytes: Uint8Array, closed = false): Gen<void> {
  if (!(value instanceof JParcelFileDescriptor)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a ParcelFileDescriptor");
  value.bytes = bytes.slice();
  if (value.backing) vfs.write(value.backing.path, value.bytes, false);
  (yield value.sink?.(value.bytes, closed));
}
rt.register({
  name: "android/os/ParcelFileDescriptor", ctor: JParcelFileDescriptor,
  ifaces: ["android/os/Parcelable", "java/io/Closeable"],
  statics: {
    MODE_READ_ONLY: 0x10000000, MODE_WRITE_ONLY: 0x20000000, MODE_READ_WRITE: 0x30000000,
    MODE_CREATE: 0x08000000, MODE_TRUNCATE: 0x04000000, MODE_APPEND: 0x02000000,
  },
  methods: {
    "static open(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;": driven(function* (f: { path: string }, mode: number): Gen  {
      const path = f?.path ?? "";
      if (!vfs.exists(path) && !(mode & 0x08000000)) throw rt.mkThrowable("java/io/FileNotFoundException", path);
      if (mode & 0x04000000) vfs.write(path, new Uint8Array(0));
      const source = vfs.source(path);
      const p = mkPfd(source ? (yield readFully(source)) : new Uint8Array(0), mode & 0x20000000 ? (b) => vfs.write(path, b) : null);
      p.path = path;
      // MODE_* bits → O_* flags: the access mode, then create/truncate/append
      p.flags = ((mode >>> 28) & 3) - 1 + (mode & 0x08000000 ? 0x40 : 0) + (mode & 0x04000000 ? 0x200 : 0) + (mode & 0x02000000 ? 0x400 : 0);
      return p;
    }),
    "static parseMode(Ljava/lang/String;)I": (m: string) => {
      switch (m) {
        case "r": return 0x10000000;
        case "w": case "wt": return 0x2c000000;
        case "wa": return 0x2a000000;
        case "rw": return 0x38000000;
        case "rwt": return 0x3c000000;
        default: throw rt.mkThrowable("java/lang/IllegalArgumentException", "Bad mode: " + m);
      }
    },
    "getFileDescriptor()Ljava/io/FileDescriptor;": function (this: JParcelFileDescriptor) {
      const d = rt.make("java/io/FileDescriptor") as JFileDescriptor;
      d.fd = pfdFd(this);
      d.path = this.path;
      d.flags = this.flags;
      d.owner = this;
      return d;
    },
    "getFd()I": function (this: JParcelFileDescriptor) { return pfdFd(this); },
    "static adoptFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd }),
    "static fromFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd: javaDupFd(fd) }),
    // AOSP dup(FileDescriptor): a new descriptor on the same open file description
    "static dup(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;": (d: JFileDescriptor | null) => {
      if (!d || descriptorFd(d) < 0) throw rt.mkThrowable("java/io/IOException", "Invalid file descriptor");
      const fd = javaDupFd(d.fd);
      if (fd < 0) throw rt.mkThrowable("java/io/IOException", "dup failed: EBADF (Bad file descriptor)");
      return Object.assign(new JParcelFileDescriptor(), { fd });
    },
    "detachFd()I": function (this: JParcelFileDescriptor) { const fd = pfdFd(this); this.fd = -1; this.closed = true; return fd; },
    "dup()Landroid/os/ParcelFileDescriptor;": function (this: JParcelFileDescriptor) {
      const p = Object.assign(mkPfd(this.bytes, this.sink), { path: this.path, flags: this.flags, fd: javaDupFd(pfdFd(this)), backing: this.backing });
      if (p.backing) p.backing.refs++;
      return p;
    },
    "getStatSize()J": function (this: JParcelFileDescriptor) { return BigInt(this.backing ? vfs.stat(this.backing.path)?.size ?? 0 : this.bytes.length); },
    "close()V": driven(function* (this: JParcelFileDescriptor): Gen {
      if (this.closed) return;
      if (this.fd >= 0) javaCloseFd(this.fd);
      this.fd = -1; this.closed = true;
      if (this.backing && --this.backing.refs === 0) {
        const backing = this.backing, bytes = vfs.read(backing.path) ?? new Uint8Array(0);
        backing.closing = (async () => {
          try { await backing.sink?.(bytes, true); }
          finally {
            pfdBackings.delete(backing.key);
            vfs.delete(backing.path, false);
          }
        })();
        (yield backing.closing);
      }
    }),
    "checkError()V": () => {},
  },
});
class JPfdIn extends JInputStream { pfd: JParcelFileDescriptor | null = null; }
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseInputStream", ctor: JPfdIn, sup: "java/io/InputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdIn, p: JParcelFileDescriptor) { this.buf = p.bytes; this.pfd = p; },
    "close()V": function (this: JPfdIn) { const pfd = this.pfd; this.pfd = null; if (pfd) return vcall(pfd, "close", "()V"); },
  },
});
class JPfdOut extends JOutputStream { pfd: JParcelFileDescriptor | null = null; }
const pfdFlush = async function (this: JPfdOut, closed = false) { await this.pfd?.sink?.(Uint8Array.from(this.chunks), closed); };
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseOutputStream", ctor: JPfdOut, sup: "java/io/OutputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdOut, p: JParcelFileDescriptor) { this.pfd = p; },
    "flush()V": pfdFlush,
    "close()V": driven(function* (this: JPfdOut): Gen { (yield pfdFlush.call(this, true)); const pfd = this.pfd; this.pfd = null; if (pfd) (yield vcall(pfd, "close", "()V")); }),
  },
});

for (const n of ["android/util/CloseGuard", "dalvik/system/CloseGuard"]) {
  rt.register({
    name: n, ctor: class extends JObj {},
    methods: {
      [`static get()L${n};`]: () => rt.make(n),
      ...noops("open(Ljava/lang/String;)V", "close()V", "warnIfOpen()V"),
    },
  });
}

// ── android.os.StatFs: the browser's storage estimate for whichever path is asked about (one
// filesystem backs everything here), in 4K blocks.
class JStatFs extends JObj { path = ""; total = 0; free = 0; }
function statFs(this: JStatFs, p: string): unknown { return rt.drive(statFs$.call(this, p)); }
function* statFs$(this: JStatFs, p: string): Gen {
  this.path = p;
  try {
    const e = (yield navigator.storage?.estimate?.());
    this.total = e?.quota ?? 0; this.free = Math.max(0, (e?.quota ?? 0) - (e?.usage ?? 0));
  } catch { /* no estimate available: report an empty filesystem */ }
}
const BLK = 4096n;
const statVfsFields = ["f_bsize", "f_frsize", "f_blocks", "f_bfree", "f_bavail", "f_files", "f_ffree", "f_favail", "f_fsid", "f_flag", "f_namemax"] as const;
class JStructStatVfs extends JObj {
  f_bsize = 0n; f_frsize = 0n; f_blocks = 0n; f_bfree = 0n; f_bavail = 0n;
  f_files = 0n; f_ffree = 0n; f_favail = 0n; f_fsid = 0n; f_flag = 0n; f_namemax = 0n;
}
rt.register({ name: "android/system/StructStatVfs", ctor: JStructStatVfs, fields: [...statVfsFields], methods: {
  "<init>(JJJJJJJJJJJ)V": function (this: JStructStatVfs, ...values: bigint[]) {
    for (let i = 0; i < statVfsFields.length; i++) Reflect.set(this, statVfsFields[i], values[i]);
  },
} });
// ── android.os.storage.StorageManager: the one volume, identified by the platform's default UUID
let storageUuid: ReturnType<typeof uuidFromString> | null = null;
const uuidDefault = () => storageUuid ??= uuidFromString("41217664-9172-527a-b3d5-edabb50a7d69");
function storageEstimate(): { total: number; free: number } | Promise<{ total: number; free: number }> { return rt.drive(storageEstimate$()); }
function* storageEstimate$(): Gen<{ total: number; free: number }> {
  const s = new JStatFs();
  (yield statFs.call(s, "/data"));
  return s;
}
rt.register({
  name: "android/os/storage/StorageManager", ctor: class extends JObj {},
  statics: { get UUID_DEFAULT() { return uuidDefault(); } },
  methods: {
    "getUuidForPath(Ljava/io/File;)Ljava/util/UUID;": () => uuidDefault(),
    "getAllocatableBytes(Ljava/util/UUID;)J": driven(function* (): Gen  { return BigInt(Math.floor(((yield storageEstimate())).free)); }),
    "getCacheQuotaBytes(Ljava/util/UUID;)J": driven(function* (): Gen  { return BigInt(Math.floor(((yield storageEstimate())).total / 20)); }),
    "getCacheSizeBytes(Ljava/util/UUID;)J": () => 0n,
    "isAllocationSupported(Ljava/io/FileDescriptor;)Z": () => 0,
    "isEncrypted(Ljava/io/File;)Z": () => 0,
    "getStorageVolumes()Ljava/util/List;": () => newArrayList(),
    "getPrimaryStorageVolume()Landroid/os/storage/StorageVolume;": () => null,
    "getStorageVolume(Ljava/io/File;)Landroid/os/storage/StorageVolume;": () => null,
  },
});
rt.register({
  name: "android/os/StatFs", ctor: JStatFs,
  methods: {
    "<init>(Ljava/lang/String;)V": statFs,
    "restat(Ljava/lang/String;)V": statFs,
    "getBlockSizeLong()J": () => BLK,
    "getBlockSize()I": () => Number(BLK),
    ...Object.fromEntries(([["BlockCount", "total"], ["AvailableBlocks", "free"], ["FreeBlocks", "free"]] as const).flatMap(([n, f]) => [
      [`get${n}Long()J`, function (this: JStatFs) { return BigInt(Math.floor(this[f] / 4096)); }],
      [`get${n}()I`, function (this: JStatFs) { return Math.floor(this[f] / 4096) | 0; }]])),
    "getAvailableBytes()J": function (this: JStatFs) { return BigInt(Math.floor(this.free)); },
    "getFreeBytes()J": function (this: JStatFs) { return BigInt(Math.floor(this.free)); },
    "getTotalBytes()J": function (this: JStatFs) { return BigInt(Math.floor(this.total)); },
  },
});

// ── Choreographer (frame callbacks; shell drains queue each rAF)
class JFrameTimeline extends JObj {
  active = false;
  id = 0n;
  presentation = 0n;
  check() {
    if (!this.active) throw rt.mkThrowable("java/lang/IllegalStateException", "Frame data is only valid during its vsync callback");
  }
}
class JFrameData extends JFrameTimeline {
  time = 0n;
  timelines = jarray([new JFrameTimeline()], "Landroid/view/Choreographer$FrameTimeline;");
}
rt.register({
  name: "android/view/Choreographer$FrameTimeline", ctor: JFrameTimeline,
  methods: {
    "getVsyncId()J": function (this: JFrameTimeline) { this.check(); return this.id; },
    "getExpectedPresentationTimeNanos()J": function (this: JFrameTimeline) { this.check(); return this.presentation; },
    "getDeadlineNanos()J": function (this: JFrameTimeline) { this.check(); return this.presentation; },
  },
});
rt.register({
  name: "android/view/Choreographer$FrameData", ctor: JFrameData,
  methods: {
    "getFrameTimeNanos()J": function (this: JFrameData) { this.check(); return this.time; },
    "getFrameTimelines()[Landroid/view/Choreographer$FrameTimeline;": function (this: JFrameData) { this.check(); return this.timelines; },
    "getPreferredFrameTimeline()Landroid/view/Choreographer$FrameTimeline;": function (this: JFrameData) { this.check(); return this.timelines[0]; },
  },
});
rt.markers("android/view/Choreographer$VsyncCallback");
const VSYNC_INTERVAL_MS = 1000 / device.refreshRate;
let nextVsync = 0;
export function recordVsync(time: number): boolean {
  // Allow sub-millisecond rAF jitter without skipping a virtual display frame.
  if (nextVsync && time + 0.75 < nextVsync) return false;
  nextVsync = !nextVsync || time > nextVsync + VSYNC_INTERVAL_MS ? time + VSYNC_INTERVAL_MS : nextVsync + VSYNC_INTERVAL_MS;
  return true;
}
export function dispatchVsync(callback: JObj, presentation: bigint): unknown { return rt.drive(dispatchVsync$(callback, presentation)); }
function* dispatchVsync$(callback: JObj, presentation: bigint): Gen {
  rt.link("android/view/Choreographer$FrameData");
  rt.link("android/view/Choreographer$FrameTimeline");
  const data = new JFrameData(), timeline = data.timelines[0];
  data.time = timeline.id = uiState.frameTimeNanos;
  // The browser exposes one predicted presentation, not Android's alternate timelines.
  timeline.presentation = presentation;
  data.active = timeline.active = true;
  try { (yield vcall(callback, "onVsync", "(Landroid/view/Choreographer$FrameData;)V", data)); }
  finally { data.active = timeline.active = false; }
}
class JChoreographer extends JObj {
  // AOSP's own field, read reflectively by anything measuring frame pacing (Sentry, Matrix,
  // Flutter's FPS probe). It is the same nanos getFrameTimeNanos() answers.
  get mLastFrameTimeNanos(): bigint { return uiState.frameTimeNanos; }
}
const theChoreographer = new JChoreographer();
rt.register({
  name: "android/view/Choreographer", ctor: JChoreographer,
  fields: ["mLastFrameTimeNanos"],
  methods: {
    "static getInstance()Landroid/view/Choreographer;": () => theChoreographer,
    "postVsyncCallback(Landroid/view/Choreographer$VsyncCallback;)V": (cb: JObj) => {
      if (cb == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "callback must not be null");
      uiState.frameCallbacks.push({ vsync: cb });
    },
    "removeVsyncCallback(Landroid/view/Choreographer$VsyncCallback;)V": (cb: JObj) => {
      if (cb == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "callback must not be null");
      uiState.frameCallbacks = uiState.frameCallbacks.filter((c: any) => c.vsync !== cb);
    },
    "postFrameCallback(Landroid/view/Choreographer$FrameCallback;)V": (cb: unknown) => {
      uiState.frameCallbacks.push({ frame: cb });
    },
    "postFrameCallbackDelayed(Landroid/view/Choreographer$FrameCallback;J)V": (cb: unknown, d: bigint) => {
      setGuestTimeout(() => uiState.frameCallbacks.push({ frame: cb }), Number(d));
    },
    "removeFrameCallback(Landroid/view/Choreographer$FrameCallback;)V": (cb: unknown) => {
      uiState.frameCallbacks = uiState.frameCallbacks.filter((c: any) => c.frame !== cb);
    },
    "postCallback(ILjava/lang/Runnable;Ljava/lang/Object;)V": (type: number, r: unknown) => {
      uiState.frameCallbacks.push({ run: r });
    },
    "removeCallbacks(ILjava/lang/Runnable;Ljava/lang/Object;)V": (_t: number, r: unknown) => {
      uiState.frameCallbacks = uiState.frameCallbacks.filter((c: any) => c.run !== r);
    },
    "getFrameTimeNanos()J": () => uiState.frameTimeNanos,
  },
});
rt.register({ name: "android/view/Choreographer$FrameCallback", ctor: class extends JObj {}, methods: {
  "doFrame(J)V": () => { throw rt.mkThrowable("java/lang/AbstractMethodError", "android.view.Choreographer.FrameCallback.doFrame"); },
} });

class JKeyEvent extends JObj { action = 0; keyCode = 0; }
rt.register({
  name: "android/view/KeyEvent", ctor: JKeyEvent, ifaces: ["android/os/Parcelable"],
  statics: {
    get CREATOR() { return parcelCreator("android/view/KeyEvent", async p => {
      const action: number = await vcall(p, "readInt", "()I");
      const keyCode: number = await vcall(p, "readInt", "()I");
      return Object.assign(new JKeyEvent(), { action, keyCode });
    }); },
    ACTION_DOWN: 0, ACTION_UP: 1, MAX_KEYCODE: 84,
    ...Object.fromEntries([...keyCodes].map(([name, code]) => ["KEYCODE_" + name, code])),
  },
  methods: {
    "<init>(II)V": function (this: JKeyEvent, a: number, k: number) { this.action = a; this.keyCode = k; },
    "static getDeadChar(II)I": deadChar,
    "static getMaxKeyCode()I": () => keyCodes.size - 1,
    "static keyCodeFromString(Ljava/lang/String;)I": (name: string) => {
      if (name == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (/^[+-]?\d+$/.test(name)) {
        const code = Number(name);
        if (code >= 0 && code < keyCodes.size) return code | 0;
      }
      return keyCodes.get(name.startsWith("KEYCODE_") ? name.slice(8) : name) ?? 0;
    },
    "static getModifierMetaStateMask()I": () => 0x770ff,
    "static normalizeMetaState(I)I": (state: number) => {
      if (state & 0xc0) state |= 1;
      if (state & 0x30) state |= 2;
      if (state & 0x6000) state |= 0x1000;
      if (state & 0x60000) state |= 0x10000;
      if (state & 0x100) state |= 0x100000;
      if (state & 0x200) state |= 2;
      if (state & 0x400) state |= 4;
      return state & 0x7770ff;
    },
    "getAction()I": function (this: JKeyEvent) { return this.action; },
    "getKeyCode()I": function (this: JKeyEvent) { return this.keyCode; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JKeyEvent, p: JParcel): Gen {
      (yield vcall(p, "writeInt", "(I)V", this.action));
      (yield vcall(p, "writeInt", "(I)V", this.keyCode));
    }),
    ...stubs(0, "getRepeatCount()I", "getUnicodeChar()I", "hasModifiers(I)Z", "isTracking()Z", "isCanceled()Z"),
    ...stubs(1, "hasNoModifiers()Z"),
    ...noops("startTracking()V"),
  },
});
rt.markers("android/view/KeyEvent$Callback");

// Observable / DataSetObservable. `mObservers` is the protected ArrayList subclasses walk
// directly (RecyclerView's AdapterDataObservable does), so it is a real java.util.ArrayList.
class JObservable extends JObj {
  list = newArrayList();
  get observers(): unknown[] { return this.list.a; }
}
rt.register({
  name: "android/database/Observable", ctor: JObservable,
  fields: { mObservers: "list" },
  methods: {
    "<init>()V": function () {},
    "registerObserver(Ljava/lang/Object;)V": function (this: JObservable, o: unknown) {
      if (o == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "The observer is null.");
      if (this.observers.includes(o)) throw rt.mkThrowable("java/lang/IllegalStateException", "Observer " + o + " is already registered.");
      this.observers.push(o);
    },
    "unregisterObserver(Ljava/lang/Object;)V": function (this: JObservable, o: unknown) {
      if (o == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "The observer is null.");
      const i = this.observers.indexOf(o);
      if (i < 0) throw rt.mkThrowable("java/lang/IllegalStateException", "Observer " + o + " was not registered.");
      this.observers.splice(i, 1);
    },
    "unregisterAll()V": function (this: JObservable) { this.observers.length = 0; },
  },
});
rt.register({
  name: "android/database/DataSetObservable", ctor: class extends JObservable {}, sup: "android/database/Observable",
  methods: {
    "<init>()V": function () {},
    "notifyChanged()V": driven(function* (this: JObservable): Gen {
      for (const o of [...this.observers]) {
        try { (yield vcall(o, "onChanged", "()V")); } catch (e) { console.warn("[dataset]", e); }
      }
    }),
    "notifyInvalidated()V": driven(function* (this: JObservable): Gen {
      for (const o of [...this.observers]) {
        try { (yield vcall(o, "onInvalidated", "()V")); } catch (e) { console.warn("[dataset]", e); }
      }
    }),
  },
});

// android.os.Environment: virtual storage paths (backed by our in-memory FS)
rt.register({
  name: "android/os/Environment", ctor: class extends JObj {},
  statics: { MEDIA_MOUNTED: "mounted", MEDIA_MOUNTED_READ_ONLY: "mounted_ro", MEDIA_UNMOUNTED: "unmounted", MEDIA_REMOVED: "removed", MEDIA_UNKNOWN: "unknown",
    DIRECTORY_DOWNLOADS: "Download", DIRECTORY_PICTURES: "Pictures", DIRECTORY_DCIM: "DCIM", DIRECTORY_MUSIC: "Music", DIRECTORY_MOVIES: "Movies", DIRECTORY_DOCUMENTS: "Documents" },
  methods: {
    "static getExternalStorageDirectory()Ljava/io/File;": () => mkFile("/sdcard"),
    "static getExternalStoragePublicDirectory(Ljava/lang/String;)Ljava/io/File;": (t: string) => mkFile("/sdcard/" + (t ?? "")),
    "static getDataDirectory()Ljava/io/File;": () => mkFile("/data"),
    "static getDownloadCacheDirectory()Ljava/io/File;": () => mkFile("/cache"),
    "static getExternalStorageState()Ljava/lang/String;": () => "mounted",
    "static getExternalStorageState(Ljava/io/File;)Ljava/lang/String;": () => "mounted",
    "static getStorageState(Ljava/io/File;)Ljava/lang/String;": () => "mounted",
    "static isExternalStorageManager()Z": () => 1,
    "static isExternalStorageEmulated()Z": () => 1,
    "static isExternalStorageEmulated(Ljava/io/File;)Z": () => 1,
    "static isExternalStorageRemovable()Z": () => 0,
    "static isExternalStorageRemovable(Ljava/io/File;)Z": () => 0,
    "static isExternalStorageLegacy()Z": () => 0,
  },
});

// android.system.Os: the libcore syscall surface over the same descriptor table native code uses
class JErrnoException extends JThrowable { errno = 0; functionName = ""; }
function errnoMessage(this: JErrnoException): string {
  const name = Object.entries(E).find(([, value]) => value === this.errno)?.[0];
  return `${this.functionName} failed: ${name ? "E" + name : "errno " + this.errno} (${ERRSTR[this.errno] ?? "Unknown error " + this.errno})`;
}
function initErrno(this: JErrnoException, fn: string, value: number, cause: JThrowable | null = null) {
  this.functionName = fn; this.errno = value; this.cause = cause;
}
rt.register({
  name: "android/system/ErrnoException", ctor: JErrnoException, sup: "java/lang/Exception",
  fields: ["errno", "functionName"],
  methods: {
    "<init>(Ljava/lang/String;I)V": initErrno,
    "<init>(Ljava/lang/String;ILjava/lang/Throwable;)V": initErrno,
    "getMessage()Ljava/lang/String;": errnoMessage,
    "rethrowAsIOException()Ljava/io/IOException;": function (this: JErrnoException) {
      const error = rt.mkThrowable("java/io/IOException", errnoMessage.call(this)); error.cause = this; throw error;
    },
    "rethrowAsSocketException()Ljava/net/SocketException;": function (this: JErrnoException) {
      const error = rt.mkThrowable("java/net/SocketException", errnoMessage.call(this)); error.cause = this; throw error;
    },
  },
});
const errno = (fn: string, e: number) => { const x = rt.mkThrowable("android/system/ErrnoException", fn) as JErrnoException; initErrno.call(x, fn, e); return x; };
class JStructStat extends JObj { st_dev = 0n; st_ino = 0n; st_mode = 0; st_nlink = 1n; st_uid = 0; st_gid = 0; st_size = 0n; st_atime = 0n; st_mtime = 0n; st_ctime = 0n; st_blksize = 4096n; st_blocks = 0n; }
rt.register({
  name: "android/system/StructStat", ctor: JStructStat,
  fields: ["st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_atime", "st_mtime",
    "st_ctime", "st_blksize", "st_blocks"],
});
class JStructUtsname extends JObj {
  sysname = "Linux";
  nodename = "localhost";
  release = "5.10.0-webdroid";
  version = "#1 SMP PREEMPT";
  machine = "aarch64";
}
rt.register({
  name: "android/system/StructUtsname", ctor: JStructUtsname,
  fields: ["sysname", "nodename", "release", "version", "machine"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      function (this: JStructUtsname, sysname: string, nodename: string, release: string, version: string, machine: string) {
        this.sysname = sysname; this.nodename = nodename; this.release = release; this.version = version; this.machine = machine;
      },
  },
});
const FD = "Ljava/io/FileDescriptor;";
rt.register({
  name: "android/system/Os", ctor: class extends JObj {},
  methods: {
    [`static lseek(${FD}JI)J`]: (d: JFileDescriptor, off: bigint, whence: number) => {
      const r = javaSeekFd(descriptorFd(d), Number(off), whence);
      if (r < 0) throw errno("lseek", 9);
      return BigInt(r);
    },
    [`static close(${FD})V`]: (d: JFileDescriptor) => { javaCloseFd(d.fd); d.fd = -1; },
    [`static dup(${FD})${FD}`]: (d: JFileDescriptor) => {
      const n = rt.make("java/io/FileDescriptor") as JFileDescriptor;
      n.fd = javaDupFd(descriptorFd(d));
      if (n.fd < 0) throw errno("dup", 9);
      return n;
    },
    [`static mmap(JJII${FD}J)J`]: driven(function* (hint: bigint, count: bigint, prot: number, flags: number, d: JFileDescriptor | null, offset: bigint): Gen  {
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size <= 0 || offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER) || (offset & 4095n) !== 0n ||
          (prot & ~7) !== 0 || ((flags & 3) !== 1 && (flags & 3) !== 2) || (flags & 0x10) !== 0 && (hint & 4095n) !== 0n)
        throw errno("mmap", E.INVAL);
      if (flags & 0x10) throw errno("mmap", E.NOTSUP);
      const anonymous = !!(flags & 0x20), fd = anonymous ? -1 : d ? descriptorFd(d) : -1;
      const source = anonymous ? null : javaFdSource(fd);
      if (!anonymous && !source) throw errno("mmap", E.BADF);
      if (source && prot === 0) throw errno("mmap", E.NOTSUP);
      const writeBack = flags & 1 && prot & 2 ? fdWriteBack(fd) : null;
      if (flags & 1 && prot & 2 && !writeBack) throw errno("mmap", E.NOTSUP);
      const address = mem.mapVa(size, prot === 0);
      if (!address) throw errno("mmap", E.NOMEM);
      try {
        if (source && prot) mem.write(guestAt(address), (yield readFully(source, Number(offset), size)));
      } catch {
        mem.unmapVa(BigInt(address), size);
        throw errno("mmap", E.IO);
      }
      if (writeBack) trackSharedMap(BigInt(address), size, Number(offset), writeBack);
      return BigInt(address);
    }),
    "static munmap(JJ)V": (address: bigint, count: bigint) => {
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size <= 0 || address & 4095n) throw errno("munmap", E.INVAL);
      syncShared(address, size, true);
      if (!mem.unmapVa(address, size)) throw errno("munmap", E.INVAL);
    },
    "static gettid()I": () => threadTid(curThread),
    "static getenv(Ljava/lang/String;)Ljava/lang/String;": (key: string) => {
      if (key === null) rt.npe();
      return processEnv[key] ?? null;
    },
    "static getpid()I": () => PROCESS_PID,
    "static uname()Landroid/system/StructUtsname;": () => {
      const info = new JStructUtsname();
      info.machine = rt.nativeAbis.find((abi) => Object.keys(rt.classpath).some((path) => path.startsWith("lib/" + abi + "/"))) === "armeabi-v7a" ? "armv7l" : "aarch64";
      return info;
    },
    "static sysconf(I)J": (name: number) => BigInt(name === 0x27 || name === 0x28 ? 4096 : name === 0x60 || name === 0x61 ? device.cpu.cores : name === 0x62 ? device.cpu.memKb / 4 : -1),
    "static stat(Ljava/lang/String;)Landroid/system/StructStat;": (path: string) => {
      const st = vfs.stat(path);
      if (!st && !vfs.isDir(path)) throw errno("stat", 2);
      const s = new JStructStat();
      s.st_mode = st ? 0o100644 : 0o40755;
      s.st_size = BigInt(st?.size ?? 0);
      s.st_mtime = s.st_atime = s.st_ctime = BigInt(Math.floor(Date.now() / 1000));
      s.st_blocks = (s.st_size + 511n) / 512n;
      return s;
    },
    "static statvfs(Ljava/lang/String;)Landroid/system/StructStatVfs;": driven(function* (path: string): Gen  {
      if (!vfs.stat(path) && !vfs.isDir(path)) throw errno("statvfs", 2);
      const { total, free } = (yield storageEstimate());
      const s = new JStructStatVfs();
      s.f_bsize = s.f_frsize = BLK;
      s.f_blocks = BigInt(Math.floor(total / Number(BLK)));
      s.f_bfree = s.f_bavail = BigInt(Math.floor(free / Number(BLK)));
      s.f_namemax = 255n;
      return s;
    }),
    [`static fstatvfs(${FD})Landroid/system/StructStatVfs;`]: driven(function* (d: JFileDescriptor): Gen  {
      if (descriptorFd(d) < 0) throw errno("fstatvfs", E.BADF);
      const { total, free } = (yield storageEstimate());
      const s = new JStructStatVfs();
      s.f_bsize = s.f_frsize = BLK;
      s.f_blocks = BigInt(Math.floor(total / Number(BLK)));
      s.f_bfree = s.f_bavail = BigInt(Math.floor(free / Number(BLK)));
      s.f_namemax = 255n;
      return s;
    }),
    "static readlink(Ljava/lang/String;)Ljava/lang/String;": () => { throw errno("readlink", 22); },
  },
});
// android.system.OsConstants: static int fields naming POSIX/bionic constants.
// Only the fields real APKs have actually asked for are implemented (checked via
// scripts/audit.ts-style field scan of the dex) — not the full table AOSP ships.
rt.register({
  name: "android/system/OsConstants", ctor: class extends JObj {},
  statics: {
    ...Object.fromEntries(Object.entries(E).map(([name, value]) => ["E" + name, value])),
    PROT_READ: 0x1,
    PROT_WRITE: 0x2,
    PROT_EXEC: 0x4,
    PROT_NONE: 0,
    MAP_PRIVATE: 0x02, MAP_SHARED: 0x01, MAP_ANONYMOUS: 0x20,
    SEEK_SET: 0, SEEK_CUR: 1, SEEK_END: 2,
    SIGKILL: 9,
    S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o40000,
  },
});

class JAsyncTask extends JObj {
  status = 0;
  cancelled = 0;
  completed = false;
  worker: JThread | null = null;
  result: unknown = null;
  error: unknown = null;
  done: Promise<void> | null = null;
}
const taskStatuses = mkEnumSet("android/os/AsyncTask$Status", ["PENDING", "RUNNING", "FINISHED"]);
const serialTaskExecutor = () => (rt.link("android/os/AsyncTask").ctor as Record<string, unknown>).s$SERIAL_EXECUTOR;
rt.register({
  name: "android/os/AsyncTask", ctor: JAsyncTask,
  statics: { THREAD_POOL_EXECUTOR: null, SERIAL_EXECUTOR: null },
  clinit: () => {
    rt.link("android/os/AsyncTask$Status");
    const c = rt.link("android/os/AsyncTask").ctor as Record<string, unknown>;
    c.s$THREAD_POOL_EXECUTOR = mkExecutor(Math.max(2, Math.min(globalThis.navigator?.hardwareConcurrency ?? 2, 4)));
    c.s$SERIAL_EXECUTOR = mkExecutor(1);
  },
  methods: {
    "execute([Ljava/lang/Object;)Landroid/os/AsyncTask;": function (this: JAsyncTask, params: unknown[]) {
      return runAsyncTask.call(this, serialTaskExecutor(), params);
    },
    "executeOnExecutor(Ljava/util/concurrent/Executor;[Ljava/lang/Object;)Landroid/os/AsyncTask;": runAsyncTask,
    "cancel(Z)Z": function (this: JAsyncTask, interrupt: number) {
      if (this.cancelled || this.completed) return 0;
      this.cancelled = 1;
      if (interrupt && this.worker) { this.worker.interrupted = 1; this.worker.wake?.(); }
      return 1;
    },
    "isCancelled()Z": function (this: JAsyncTask) { return this.cancelled; },
    "getStatus()Landroid/os/AsyncTask$Status;": function (this: JAsyncTask) { return taskStatuses[this.status]; },
    ...noops("<init>()V", "onPreExecute()V", "onPostExecute(Ljava/lang/Object;)V",
      "onProgressUpdate([Ljava/lang/Object;)V", "onCancelled()V"),
    ...stubs(null, "doInBackground([Ljava/lang/Object;)Ljava/lang/Object;"),
    "onCancelled(Ljava/lang/Object;)V": function (this: JAsyncTask) { return vcall(this, "onCancelled", "()V"); },
    "publishProgress([Ljava/lang/Object;)V": function (this: JAsyncTask, values: unknown[]) {
      if (!this.cancelled) void onMain(() => this.cancelled ? undefined : vcall(this, "onProgressUpdate", "([Ljava/lang/Object;)V", values)).catch(reportUncaught);
    },
    "get()Ljava/lang/Object;": driven(function* (this: JAsyncTask): Gen {
      if (!this.cancelled && this.done) (yield this.done);
      if (this.cancelled) throw rt.mkThrowable("java/util/concurrent/CancellationException", null);
      if (this.error) throw (yield newObj("java/util/concurrent/ExecutionException", "(Ljava/lang/Throwable;)V", this.error));
      return this.result;
    }),
    "static execute(Ljava/lang/Runnable;)V": (r: unknown) => vcall(serialTaskExecutor(), "execute", "(Ljava/lang/Runnable;)V", r),
  },
});
function runAsyncTask(this: JAsyncTask, executor: unknown, params: unknown[]): JAsyncTask | Promise<JAsyncTask> { return rt.drive(runAsyncTask$.call(this, executor, params)); }
function* runAsyncTask$(this: JAsyncTask, executor: unknown, params: unknown[]): Gen<JAsyncTask> {
  if (this.status !== 0) throw rt.mkThrowable("java/lang/IllegalStateException", "Task has already been executed");
  this.status = 1;
  let finish!: () => void;
  this.done = new Promise(resolve => { finish = resolve; });
  const pre = () => vcall(this, "onPreExecute", "()V");
  if (curThread === mainThread && inMainJob()) (yield pre()); else (yield onMain(pre));
  const runnable = new JObj();
  Object.assign(runnable, { [mangleMethod("run", "()V")]: async () => {
    this.worker = curThread;
    try {
      if (!this.cancelled) this.result = await vcall(this, "doInBackground", "([Ljava/lang/Object;)Ljava/lang/Object;", params ?? []);
    } catch (error) { if (!this.cancelled) { this.error = rt.jx(error); reportUncaught(this.error); } }
    finally { this.worker = null; this.completed = true; finish(); }
    void onMain(async () => {
      try {
        if (!this.error) await vcall(this, this.cancelled ? "onCancelled" : "onPostExecute", "(Ljava/lang/Object;)V", this.result);
      } finally { this.status = 2; }
    }).catch(reportUncaught);
  } });
  (yield vcall(executor, "execute", "(Ljava/lang/Runnable;)V", runnable));
  return this;
}

class JCountDownTimer extends JObj {
  totalMs = 0n;
  intervalMs = 1000n;
  timer: GuestTimer | null = null;
  endAt = 0;
}
rt.register({
  name: "android/os/CountDownTimer", ctor: JCountDownTimer,
  methods: {
    "<init>(JJ)V": function (this: JCountDownTimer, total: bigint, interval: bigint) {
      this.totalMs = total;
      this.intervalMs = interval;
    },
    "start()Landroid/os/CountDownTimer;": function (this: JCountDownTimer) {
      this.endAt = guestNow() + Number(this.totalMs);
      if (this.timer) clearGuestInterval(this.timer);
      this.timer = setGuestInterval(() => {
        const left = this.endAt - guestNow();
        if (left <= 0) {
          clearGuestInterval(this.timer!);
          this.timer = null;
          void vcallAsync(this, "onFinish", "()V").catch(reportUncaught);
        } else {
          void vcallAsync(this, "onTick", "(J)V", BigInt(Math.round(left))).catch(reportUncaught);
        }
      }, Math.max(50, Number(this.intervalMs)));
      return this;
    },
    "cancel()V": function (this: JCountDownTimer) {
      if (this.timer) { clearGuestInterval(this.timer); this.timer = null; }
    },
    "onTick(J)V": function () {},
    "onFinish()V": function () {},
  },
});

/** a Runnable over a JS closure, for framework code that must go through a Handler queue */
export class JFnRunnable extends JObj { fn: () => unknown = () => {}; }
rt.register({ name: "webdroid/FnRunnable", ctor: JFnRunnable, ifaces: ["java/lang/Runnable"], methods: { "run()V": function (this: JFnRunnable) { return this.fn(); } } });
