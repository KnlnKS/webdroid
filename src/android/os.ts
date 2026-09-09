// android.os.* + android.util.* natives: Looper/Handler on the JS event loop.

import { rt, JObj, type NativeSpec, maySuspend } from "../jvm/runtime";
import { jarray, mangleMethod } from "../jvm/abi";
import { markProcessExited } from "../native/cpu";
import { device } from "../shell/config";
import { vcall, curThread, mainThread, JThread, setCurThread, reportUncaught, mkEnumSet, newObj, defineException } from "../jvm/natives/jlang";
export { reportUncaught };
import { onMain, inMainJob } from "./mainloop";
import { uiState } from "./view";
import { mkExecutor } from "../jvm/natives/jconc";
import { yieldToLoop } from "../native/cpu";
import { mkFile, JInputStream, JOutputStream, vfs, type JFileDescriptor } from "../jvm/natives/jio";
import { javaOpenFd, javaCloseFd, javaSeekFd, javaDupFd } from "../native/stdio";
import { newArrayList, newStringSet } from "../jvm/natives/jutil";

rt.register({
  name: "android/os/SystemProperties", ctor: class extends JObj {},
  methods: {
    // No property service is installed; use the caller's default, as the framework delegates do.
    "static get(Ljava/lang/String;)Ljava/lang/String;": () => "",
    "static get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (_key: string, fallback: string | null) => fallback ?? "",
  },
});

class JLooper extends JObj {
  thread: JThread;
  q: Promise<unknown> = Promise.resolve();
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
      try { return await job(); } finally { setCurThread(prev); }
    });
    this.q = p.catch(() => { /* a failed message must not poison the queue */ });
    return p;
  }
}
export const mainLooper = new JLooper(mainThread);
mainThread.looper = mainLooper;
rt.register({
  name: "android/os/Looper", ctor: JLooper,
  methods: {
    "static getMainLooper()Landroid/os/Looper;": () => mainLooper,
    "static myLooper()Landroid/os/Looper;": () => (curThread.looper as JLooper) ?? null,
    "static prepare()V": () => { if (!curThread.looper) curThread.looper = new JLooper(); },
    "static prepareMainLooper()V": () => {},
    "loop()V": () => new Promise(() => {}), // parks the java thread; JS loop drives everything
    "static loop()V": () => new Promise(() => {}),
    "getThread()Ljava/lang/Thread;": function (this: JLooper) { return this.thread; },
    "isCurrentThread()Z": function (this: JLooper) { return curThread === this.thread ? 1 : 0; },
    "quit()V": () => {},
    "quitSafely()V": () => {},
    "getQueue()Landroid/os/MessageQueue;": () => mainQueue,
  },
});
class JMessageQueue extends JObj {}
const mainQueue = new JMessageQueue();
rt.register({
  name: "android/os/MessageQueue", ctor: JMessageQueue,
  methods: {
    "addIdleHandler(Landroid/os/MessageQueue$IdleHandler;)V": (h: unknown) => {
      setTimeout(() => void onMain(async () => {
        try { await vcall(h, "queueIdle", "()Z"); } catch (e) { console.error("[idle]", e); }
      }), 50);
    },
    "removeIdleHandler(Landroid/os/MessageQueue$IdleHandler;)V": () => {},
  },
});
// A callback interface an app implements has to be registered or its class cannot link, and
// Runtime.link auto-stubs it and poisons everything downstream. Nothing calls it through this
// name -- addIdleHandler dispatches dynamically -- which is exactly why it was missed.
rt.register({ name: "android/os/MessageQueue$IdleHandler", ctor: class extends JObj {} });

class JMessage extends JObj {
  what = 0; arg1 = 0; arg2 = 0; obj: unknown = null;
  callback: unknown = null; target: JHandler | null = null;
  whenMs = 0;
  timer: ReturnType<typeof setTimeout> | undefined;
}
function obtain(h: JHandler | null, what = 0, obj: unknown = null, arg1 = 0, arg2 = 0, callback: unknown = null): JMessage {
  const m = new JMessage(); m.target = h; m.what = what; m.obj = obj; m.arg1 = arg1; m.arg2 = arg2; m.callback = callback; return m;
}
rt.register({
  name: "android/os/Message", ctor: JMessage,
  fields: { what: "what", arg1: "arg1", arg2: "arg2", obj: "obj" },
  methods: {
    "<init>()V": function () {},
    "static obtain()Landroid/os/Message;": () => new JMessage(),
    "static obtain(Landroid/os/Handler;)Landroid/os/Message;": (h: JHandler) => obtain(h),
    "static obtain(Landroid/os/Handler;I)Landroid/os/Message;": (h: JHandler, w: number) => obtain(h, w),
    "static obtain(Landroid/os/Handler;ILjava/lang/Object;)Landroid/os/Message;": (h: JHandler, w: number, o: unknown) => obtain(h, w, o),
    "static obtain(Landroid/os/Handler;III)Landroid/os/Message;": (h: JHandler, w: number, a1: number, a2: number) => obtain(h, w, null, a1, a2),
    "static obtain(Landroid/os/Handler;IIILjava/lang/Object;)Landroid/os/Message;": (h: JHandler, w: number, a1: number, a2: number, o: unknown) => obtain(h, w, o, a1, a2),
    "static obtain(Landroid/os/Handler;Ljava/lang/Runnable;)Landroid/os/Message;": (h: JHandler, r: unknown) => obtain(h, 0, null, 0, 0, r),
    "static obtain(Landroid/os/Message;)Landroid/os/Message;": (m: JMessage) => obtain(m.target, m.what, m.obj, m.arg1, m.arg2, m.callback),
    "setTarget(Landroid/os/Handler;)V": function (this: JMessage, h: JHandler) { this.target = h; },
    "sendToTarget()V": function (this: JMessage) { this.target?.send(this, 0); },
    "recycle()V": () => {},
    "getCallback()Ljava/lang/Runnable;": function (this: JMessage) { return this.callback; },
  },
});

rt.register({ name: "android/os/Handler$Callback", ctor: class extends JObj {} });

defineException("android/os/RemoteException", "java/lang/Exception");
defineException("android/os/DeadObjectException", "android/os/RemoteException");
// a Messenger over a Handler delivers in-process; one over a foreign binder has no process behind it
class JMessenger extends JObj { handler: JHandler | null = null; }
rt.register({
  name: "android/os/Messenger", ctor: JMessenger, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(Landroid/os/Handler;)V": function (this: JMessenger, h: JHandler) { this.handler = h; },
    "<init>(Landroid/os/IBinder;)V": function () {},
    "send(Landroid/os/Message;)V": function (this: JMessenger, m: JMessage) {
      if (!this.handler) throw rt.mkThrowable("android/os/DeadObjectException", null);
      this.handler.send(m, 0);
    },
    "getBinder()Landroid/os/IBinder;": () => newObj("android/os/Binder"),
    "describeContents()I": () => 0,
  },
});

let handlerSeq = 0;
class JHandler extends JObj {
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
    // still pending until it runs, so a removeMessages/hasMessages in between sees it
    const go = () => this.looper.run(() => { if (set.delete(msg)) return this.dispatch(msg); });
    if (delay > 0) msg.timer = setTimeout(() => void go(), delay); else void go();
    return 1;
  }
  post(r: unknown, delay: number): number { return this.send(obtain(this, 0, null, 0, 0, r), delay); }
  cancel(key: unknown): void {
    for (const m of this.pending.get(key) ?? []) clearTimeout(m.timer);
    this.pending.delete(key);
  }
  private async dispatch(msg: JMessage): Promise<void> {
    try {
      if (msg.callback) await vcall(msg.callback, "run", "()V");
      else if (this.cb && (await vcall(this.cb, "handleMessage", "(Landroid/os/Message;)Z", msg))) { /* handled */ }
      else await vcall(this, "handleMessage", "(Landroid/os/Message;)V", msg);
    } catch (e) { reportUncaught(e); }
  }
}
/** The window's handler, which View.post/postDelayed/scheduleDrawable enqueue on. Lazy so it
 *  is built after boot has linked the native classes. */
let _mainHandler: JHandler | null = null;
export function mainHandler(): JHandler {
  return _mainHandler ?? (_mainHandler = new JHandler());
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
    "post(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.post(r, 0); },
    "postDelayed(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, d: bigint) { return this.post(r, Number(d)); },
    "postAtTime(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, at: bigint) {
      return this.post(r, Math.max(0, Number(at) - performance.now()));
    },
    "postAtFrontOfQueue(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.post(r, 0); },
    "removeCallbacks(Ljava/lang/Runnable;)V": function (this: JHandler, r: unknown) { this.cancel(r); },
    "sendMessage(Landroid/os/Message;)Z": function (this: JHandler, m: JMessage) { return this.send(m, 0); },
    "sendMessageAtFrontOfQueue(Landroid/os/Message;)Z": function (this: JHandler, m: JMessage) { return this.send(m, 0); },
    "sendMessageDelayed(Landroid/os/Message;J)Z": function (this: JHandler, m: JMessage, d: bigint) { return this.send(m, Number(d)); },
    "sendEmptyMessage(I)Z": function (this: JHandler, w: number) { const m = new JMessage(); m.what = w; return this.send(m, 0); },
    "sendEmptyMessageDelayed(IJ)Z": function (this: JHandler, w: number, d: bigint) {
      const m = new JMessage(); m.what = w; return this.send(m, Number(d));
    },
    "removeCallbacks(Ljava/lang/Runnable;Ljava/lang/Object;)V": function (this: JHandler, r: unknown) { this.cancel(r); },
    "removeMessages(I)V": function (this: JHandler, w: number) { this.cancel(w); },
    "removeMessages(ILjava/lang/Object;)V": function (this: JHandler, w: number) { this.cancel(w); },
    "removeCallbacksAndMessages(Ljava/lang/Object;)V": function (this: JHandler) { for (const k of [...this.pending.keys()]) this.cancel(k); },
    "hasMessages(I)Z": function (this: JHandler, w: number) { return this.pending.get(w)?.size ? 1 : 0; },
    // the object variant asks about messages carrying that obj; posts here are keyed by `what`
    "hasMessages(ILjava/lang/Object;)Z": function (this: JHandler, w: number) { return this.pending.get(w)?.size ? 1 : 0; },
    "getLooper()Landroid/os/Looper;": function (this: JHandler) { return this.looper; },
    "obtainMessage()Landroid/os/Message;": function (this: JHandler) { const m = new JMessage(); m.target = this; return m; },
    "obtainMessage(I)Landroid/os/Message;": function (this: JHandler, w: number) {
      const m = new JMessage(); m.target = this; m.what = w; return m;
    },
    "obtainMessage(ILjava/lang/Object;)Landroid/os/Message;": function (this: JHandler, w: number, o: unknown) {
      const m = new JMessage(); m.target = this; m.what = w; m.obj = o; return m;
    },
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
    "quit()Z": () => 1, "quitSafely()Z": () => 1,
    "run()V": function () {},
  },
});

// ── SystemClock / Build / Process / Trace / Debug / StrictMode
class JSystemClock extends JObj {}
rt.register({
  name: "android/os/SystemClock", ctor: JSystemClock,
  methods: {
    "static uptimeMillis()J": () => BigInt(Math.floor(performance.now())),
    "static elapsedRealtime()J": () => BigInt(Math.floor(performance.now())),
    "static elapsedRealtimeNanos()J": () => BigInt(Math.floor(performance.now() * 1e6)),
    "static currentThreadTimeMillis()J": () => BigInt(Math.floor(performance.now())),
    "static sleep(J)V": (ms: bigint) => new Promise((r) => setTimeout(r, Number(ms))),
  },
});
class JConditionVariable extends JObj {
  opened = false;
  waiters = new Set<() => void>();
  block(ms = 0): number | Promise<number> {
    if (this.opened) return 1;
    if (ms < 0) return 0;
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(this.opened ? 1 : 0); };
      const timer = ms === 0 ? undefined : setTimeout(done, ms);
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
    "block()V": maySuspend(function (this: JConditionVariable) { return this.block(); }),
    "block(J)Z": maySuspend(function (this: JConditionVariable, ms: bigint) { return this.block(Number(ms)); }),
  },
});
class JBuild extends JObj {}
rt.register({
  name: "android/os/Build", ctor: JBuild,
  statics: {
    MODEL: "webdroid", MANUFACTURER: "webdroid", BRAND: "google", DEVICE: "webdroid",
    PRODUCT: "webdroid", HARDWARE: "browser", FINGERPRINT: "google/webdroid/1.0", SOC_MANUFACTURER: "unknown", SOC_MODEL: "unknown", SKU: "unknown", ODM_SKU: "unknown",
    SERIAL: "unknown", ID: "WD1A", DISPLAY: "webdroid 1.0", TAGS: "release-keys", TYPE: "user",
    BOARD: "web", BOOTLOADER: "unknown", HOST: "localhost", USER: "web", TIME: 0n,
    SUPPORTED_ABIS: jarray(["arm64-v8a", "armeabi-v7a"], "Ljava/lang/String;"),
    SUPPORTED_32_BIT_ABIS: jarray(["armeabi-v7a"], "Ljava/lang/String;"),
    SUPPORTED_64_BIT_ABIS: jarray(["arm64-v8a"], "Ljava/lang/String;"),
  },
});
class JBuildVersion extends JObj {}
rt.register({
  name: "android/os/Build$VERSION", ctor: JBuildVersion,
  statics: { SDK_INT: device.sdk, RELEASE: device.release, CODENAME: "REL", INCREMENTAL: "1", SECURITY_PATCH: "2023-01-01", SDK: String(device.sdk), BASE_OS: "", PREVIEW_SDK_INT: 0 },
});
rt.register({ name: "android/os/Build$VERSION_CODES", ctor: class extends JObj {},
  statics: Object.fromEntries([
    ["BASE", 1], ["JELLY_BEAN", 16], ["KITKAT", 19], ["LOLLIPOP", 21], ["LOLLIPOP_MR1", 22], ["M", 23],
    ["N", 24], ["N_MR1", 25], ["O", 26], ["O_MR1", 27], ["P", 28], ["Q", 29], ["R", 30],
    ["S", 31], ["S_V2", 32], ["TIRAMISU", 33], ["UPSIDE_DOWN_CAKE", 34], ["VANILLA_ICE_CREAM", 35],
  ]),
});
export const PROCESS_PID = 1000, PROCESS_UID = 10001;
rt.register({
  name: "android/os/Process", ctor: class extends JObj {},
  statics: { THREAD_PRIORITY_BACKGROUND: 10, THREAD_PRIORITY_DEFAULT: 0, THREAD_PRIORITY_URGENT_DISPLAY: -8 },
  methods: {
    "static myPid()I": () => PROCESS_PID,
    "static killProcess(I)V": (pid: number) => { console.warn("Process.killProcess", pid); markProcessExited(); },
    // androidx's startup tracing asks how long ago this process began; there is no earlier
    // moment here than the page's own timeOrigin
    "static getStartUptimeMillis()J": () => 0n,
    "static getStartElapsedRealtime()J": () => 0n,
    "static getElapsedCpuTime()J": () => BigInt(Math.round(performance.now())),
    "static isIsolated()Z": () => 0,
    "static isSdkSandbox()Z": () => 0,
    "static myTid()I": () => 1000,
    "static myUid()I": () => PROCESS_UID,
    "static getThreadPriority(I)I": () => 0,
    "static setThreadPriority(I)V": () => {},
    "static setThreadPriority(II)V": () => {},
  },
});
rt.register({
  name: "android/os/Trace", ctor: class extends JObj {},
  methods: {
    "static setCounter(Ljava/lang/String;J)V": () => {},
    "static isTagEnabled(J)Z": () => 0,
    "static beginSection(Ljava/lang/String;)V": () => {},
    "static endSection()V": () => {},
    "static beginAsyncSection(Ljava/lang/String;I)V": () => {},
    "static endAsyncSection(Ljava/lang/String;I)V": () => {},
    "static isEnabled()Z": () => 0,
  },
});
// the process's memory as the one heap the page has: no separate native, dalvik or graphics accounting
rt.register({
  name: "android/os/Debug$MemoryInfo", ctor: class extends JObj { dalvikPss = 0; nativePss = 0; otherPss = 0; },
  fields: { dalvikPss: "dalvikPss", nativePss: "nativePss", otherPss: "otherPss" },
  methods: {
    "<init>()V": function () {},
    "getTotalPss()I": () => ((performance as any).memory?.usedJSHeapSize ?? 0) / 1024 | 0,
    "getTotalPrivateDirty()I": () => 0,
    "getTotalSharedDirty()I": () => 0,
    "getMemoryStat(Ljava/lang/String;)Ljava/lang/String;": () => "0",
  },
});
rt.register({
  name: "android/os/Debug", ctor: class extends JObj {},
  methods: {
    "static isDebuggerConnected()Z": () => 0,
    "static getNativeHeapAllocatedSize()J": () => BigInt(((performance as any).memory?.usedJSHeapSize ?? 0) | 0),
    "static getNativeHeapSize()J": () => BigInt(((performance as any).memory?.totalJSHeapSize ?? 0) | 0),
    "static getNativeHeapFreeSize()J": () => 0n,
    "static waitingForDebugger()Z": () => 0,
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
  const threadPolicy = () => new (rt.link("android/os/StrictMode$ThreadPolicy").ctor)();
  rt.register({
    name: "android/os/StrictMode", ctor: class extends JObj {},
    methods: {
      "static setThreadPolicy(Landroid/os/StrictMode$ThreadPolicy;)V": () => {},
      "static noteSlowCall(Ljava/lang/String;)V": () => {},
      "static setVmPolicy(Landroid/os/StrictMode$VmPolicy;)V": () => {},
      "static getVmPolicy()Landroid/os/StrictMode$VmPolicy;": () => new (rt.link("android/os/StrictMode$VmPolicy").ctor)(),
      "static getThreadPolicy()Landroid/os/StrictMode$ThreadPolicy;": threadPolicy,
      "static allowThreadDiskReads()Landroid/os/StrictMode$ThreadPolicy;": threadPolicy,
      "static allowThreadDiskWrites()Landroid/os/StrictMode$ThreadPolicy;": threadPolicy,
    },
  });
}

class JBaseBundle extends JObj {
  map = new Map<string, unknown>();
  loader: unknown = null;
}
export class JBundle extends JBaseBundle {
  constructor() { super(); rt.link("android/os/Bundle"); }
}
const bundleMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(I)V": function () {},
  "<init>(Landroid/os/Bundle;)V": function (this: JBundle, b: JBundle) { if (b) { this.map = new Map(b.map); this.loader = b.loader; } },
  "<init>(Ljava/lang/ClassLoader;)V": function (this: JBundle, cl: unknown) { this.loader = cl; },
  "clone()Ljava/lang/Object;": function (this: JBundle) {
    const copy = new (this.constructor as typeof JBundle)();
    copy.map = new Map(this.map); copy.loader = this.loader;
    return copy;
  },
  "size()I": function (this: JBundle) { return this.map.size; },
  "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
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
  "getSerializable(Ljava/lang/String;)Ljava/io/Serializable;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putSerializable(Ljava/lang/String;Ljava/io/Serializable;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
  "getStringArrayList(Ljava/lang/String;)Ljava/util/ArrayList;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putStringArrayList(Ljava/lang/String;Ljava/util/ArrayList;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
  "getParcelableArrayList(Ljava/lang/String;)Ljava/util/ArrayList;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putParcelableArrayList(Ljava/lang/String;Ljava/util/ArrayList;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
  "getBundle(Ljava/lang/String;)Landroid/os/Bundle;": function (this: JBundle, k: string) { return this.map.get(k) ?? null; },
  "putBundle(Ljava/lang/String;Landroid/os/Bundle;)V": function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); },
};
for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Boolean", "Z"],
  ["Float", "F"], ["Double", "D"], ["CharSequence", "Ljava/lang/CharSequence;"], ["ByteArray", "[B"],
  ["IntArray", "[I"], ["LongArray", "[J"], ["StringArray", "[Ljava/lang/String;"],
  ["IntegerArrayList", "Ljava/util/ArrayList;"], ["ParcelableArray", "[Landroid/os/Parcelable;"],
  ["SparseParcelableArray", "Landroid/util/SparseArray;"], ["Binder", "Landroid/os/IBinder;"]] as const) {
  bundleMethods[`put${t}(Ljava/lang/String;${d})V`] = function (this: JBundle, k: string, v: unknown) { this.map.set(k, v); };
  bundleMethods[`get${t}(Ljava/lang/String;)${d}`] = function (this: JBundle, k: string) {
    const v = this.map.get(k);
    if (v !== undefined) return v;
    return d === "I" || d === "Z" ? 0 : d === "J" ? 0n : d === "F" || d === "D" ? 0 : null;
  };
  if (d === "I" || d === "J" || d === "Z" || d === "F" || d === "D" || d === "Ljava/lang/String;") {
    bundleMethods[`get${t}(Ljava/lang/String;${d})${d}`] = function (this: JBundle, k: string, dflt: unknown) {
      const v = this.map.get(k);
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
    return this.map.get(k) ?? null;
  };
}
rt.register({ name: "android/os/BaseBundle", ctor: JBaseBundle, methods: bundleMethods });
rt.register({ name: "android/os/Bundle", ctor: JBundle, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], statics: { get EMPTY() { return new JBundle(); } }, methods: bundleMethods });
rt.register({ name: "android/os/PersistableBundle", ctor: class extends JBaseBundle {}, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], methods: bundleMethods });

export const PARCELABLE = {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": () => {},
} as const;
rt.register({ name: "android/os/Parcelable", ctor: class extends JObj {} });
rt.register({ name: "android/os/Parcelable$Creator", ctor: class extends JObj {} });
rt.register({
  name: "android/os/CancellationSignal", ctor: class extends JObj { cancelled = 0; },
  methods: {
    "<init>()V": function () {},
    "isCanceled()Z": function (this: any) { return this.cancelled; },
    "cancel()V": function (this: any) { this.cancelled = 1; },
    "throwIfCanceled()V": function (this: any) {
      if (this.cancelled) throw rt.mkThrowable("android/os/OperationCanceledException", null);
    },
    "setOnCancelListener(Landroid/os/CancellationSignal$OnCancelListener;)V": () => {},
  },
});

/**
 * A file descriptor an app can pass around and read or write through. There are no real fds
 * here, so one carries the bytes it was opened over plus where they go on close — which is all
 * AutoClose{In,Out}putStream, the only way a Java caller can touch it, ever needs.
 */
class JParcelFileDescriptor extends JObj {
  bytes: Uint8Array = new Uint8Array(0);
  sink: ((b: Uint8Array) => unknown) | null = null;
  path = "";
  flags = 0;
  fd = -1;
}
/** the native descriptor, opened on first request: only a fd that crosses JNI needs one */
function pfdFd(p: JParcelFileDescriptor): number {
  if (p.fd < 0 && p.path) p.fd = javaOpenFd(p.path, p.flags);
  return p.fd;
}
export function mkPfd(bytes: Uint8Array, sink: ((b: Uint8Array) => unknown) | null): JParcelFileDescriptor {
  const p = new JParcelFileDescriptor();
  p.bytes = bytes;
  p.sink = sink;
  return p;
}
rt.register({
  name: "android/os/ParcelFileDescriptor", ctor: JParcelFileDescriptor,
  ifaces: ["android/os/Parcelable", "java/io/Closeable"],
  statics: {
    MODE_READ_ONLY: 0x10000000, MODE_WRITE_ONLY: 0x20000000, MODE_READ_WRITE: 0x30000000,
    MODE_CREATE: 0x08000000, MODE_TRUNCATE: 0x04000000, MODE_APPEND: 0x02000000,
  },
  methods: {
    "static open(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;": (f: { path: string }, mode: number) => {
      const path = f?.path ?? "";
      if (!vfs.exists(path) && !(mode & 0x08000000)) throw rt.mkThrowable("java/io/FileNotFoundException", path);
      if (mode & 0x04000000) vfs.write(path, new Uint8Array(0));
      const p = mkPfd(vfs.read(path) ?? new Uint8Array(0), (b) => vfs.write(path, b));
      p.path = path;
      // MODE_* bits → O_* flags: the access mode, then create/truncate/append
      p.flags = ((mode >>> 28) & 3) - 1 + (mode & 0x08000000 ? 0x40 : 0) + (mode & 0x04000000 ? 0x200 : 0) + (mode & 0x02000000 ? 0x400 : 0);
      return p;
    },
    "static parseMode(Ljava/lang/String;)I": (m: string) =>
      (m?.includes("w") ? 0x28000000 : 0x10000000) | (m?.includes("t") || m === "w" ? 0x04000000 : 0)
      | (m?.includes("a") ? 0x02000000 : 0),
    "getFileDescriptor()Ljava/io/FileDescriptor;": function (this: JParcelFileDescriptor) {
      const d = new (rt.link("java/io/FileDescriptor").ctor)() as JFileDescriptor;
      d.fd = pfdFd(this);
      return d;
    },
    "getFd()I": function (this: JParcelFileDescriptor) { return pfdFd(this); },
    "static adoptFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd }),
    "static fromFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd }),
    "detachFd()I": function (this: JParcelFileDescriptor) { const fd = pfdFd(this); this.fd = -1; return fd; },
    "dup()Landroid/os/ParcelFileDescriptor;": function (this: JParcelFileDescriptor) { return Object.assign(mkPfd(this.bytes, this.sink), { path: this.path, flags: this.flags }); },
    "getStatSize()J": function (this: JParcelFileDescriptor) { return BigInt(this.bytes.length); },
    "close()V": function (this: JParcelFileDescriptor) { if (this.fd >= 0) javaCloseFd(this.fd); this.fd = -1; },
    "checkError()V": () => {},
  },
});
class JPfdIn extends JInputStream {}
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseInputStream", ctor: JPfdIn, sup: "java/io/InputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdIn, p: JParcelFileDescriptor) { this.buf = p?.bytes ?? new Uint8Array(0); },
  },
});
class JPfdOut extends JOutputStream { pfd: JParcelFileDescriptor | null = null; }
const pfdFlush = async function (this: JPfdOut) { await this.pfd?.sink?.(Uint8Array.from(this.chunks)); };
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseOutputStream", ctor: JPfdOut, sup: "java/io/OutputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdOut, p: JParcelFileDescriptor) { this.pfd = p; },
    "flush()V": pfdFlush,
    "close()V": pfdFlush,
  },
});

for (const n of ["android/util/CloseGuard", "dalvik/system/CloseGuard"]) {
  rt.register({
    name: n, ctor: class extends JObj {},
    methods: {
      [`static get()L${n};`]: () => new (rt.link(n).ctor)(),
      "open(Ljava/lang/String;)V": () => {},
      "close()V": () => {},
      "warnIfOpen()V": () => {},
    },
  });
}

// ── android.os.StatFs: the browser's storage estimate for whichever path is asked about (one
// filesystem backs everything here), in 4K blocks.
class JStatFs extends JObj { path = ""; total = 0; free = 0; }
async function statFs(this: JStatFs, p: string) {
  this.path = p;
  try {
    const e = await navigator.storage?.estimate?.();
    this.total = e?.quota ?? 0; this.free = Math.max(0, (e?.quota ?? 0) - (e?.usage ?? 0));
  } catch { /* no estimate available: report an empty filesystem */ }
}
const BLK = 4096n;
rt.register({
  name: "android/os/StatFs", ctor: JStatFs,
  methods: {
    "<init>(Ljava/lang/String;)V": statFs,
    "restat(Ljava/lang/String;)V": statFs,
    "getBlockSizeLong()J": () => BLK,
    "getBlockSize()I": () => Number(BLK),
    "getBlockCountLong()J": function (this: JStatFs) { return BigInt(Math.floor(this.total / 4096)); },
    "getBlockCount()I": function (this: JStatFs) { return Math.floor(this.total / 4096) | 0; },
    "getAvailableBlocksLong()J": function (this: JStatFs) { return BigInt(Math.floor(this.free / 4096)); },
    "getAvailableBlocks()I": function (this: JStatFs) { return Math.floor(this.free / 4096) | 0; },
    "getFreeBlocksLong()J": function (this: JStatFs) { return BigInt(Math.floor(this.free / 4096)); },
    "getFreeBlocks()I": function (this: JStatFs) { return Math.floor(this.free / 4096) | 0; },
    "getAvailableBytes()J": function (this: JStatFs) { return BigInt(Math.floor(this.free)); },
    "getFreeBytes()J": function (this: JStatFs) { return BigInt(Math.floor(this.free)); },
    "getTotalBytes()J": function (this: JStatFs) { return BigInt(Math.floor(this.total)); },
  },
});

// ── Choreographer (frame callbacks; shell drains queue each rAF)
class JChoreographer extends JObj {
  // AOSP's own field, read reflectively by anything measuring frame pacing (Sentry, Matrix,
  // Flutter's FPS probe). It is the same nanos getFrameTimeNanos() answers.
  get mLastFrameTimeNanos(): bigint { return uiState.frameTimeNanos; }
}
const theChoreographer = new JChoreographer();
rt.register({
  name: "android/view/Choreographer", ctor: JChoreographer,
  fields: { mLastFrameTimeNanos: "mLastFrameTimeNanos" },
  methods: {
    "static getInstance()Landroid/view/Choreographer;": () => theChoreographer,
    "postFrameCallback(Landroid/view/Choreographer$FrameCallback;)V": (cb: unknown) => {
      uiState.frameCallbacks.push({ frame: cb });
    },
    "postFrameCallbackDelayed(Landroid/view/Choreographer$FrameCallback;J)V": (cb: unknown, d: bigint) => {
      setTimeout(() => uiState.frameCallbacks.push({ frame: cb }), Number(d));
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
rt.register({ name: "android/view/Choreographer$FrameCallback", ctor: class extends JObj {} });

class JKeyEvent extends JObj { action = 0; keyCode = 0; }
rt.register({
  name: "android/view/KeyEvent", ctor: JKeyEvent, ifaces: ["android/os/Parcelable"],
  statics: {
    ACTION_DOWN: 0, ACTION_UP: 1, KEYCODE_BACK: 4, KEYCODE_ENTER: 66, KEYCODE_DEL: 67, MAX_KEYCODE: 84,
    KEYCODE_DPAD_UP: 19, KEYCODE_DPAD_DOWN: 20, KEYCODE_MENU: 82, KEYCODE_VOLUME_UP: 24, KEYCODE_VOLUME_DOWN: 25,
  },
  methods: {
    "<init>(II)V": function (this: JKeyEvent, a: number, k: number) { this.action = a; this.keyCode = k; },
    "static getMaxKeyCode()I": () => 316,
    "static getModifierMetaStateMask()I": () => 0x770ff,
    "getAction()I": function (this: JKeyEvent) { return this.action; },
    "getKeyCode()I": function (this: JKeyEvent) { return this.keyCode; },
    "getRepeatCount()I": () => 0,
    "getUnicodeChar()I": () => 0,
    "hasModifiers(I)Z": () => 0,
    "hasNoModifiers()Z": () => 1,
    "startTracking()V": () => {},
    "isTracking()Z": () => 0,
    "isCanceled()Z": () => 0,
  },
});
rt.register({ name: "android/view/KeyEvent$Callback", ctor: class extends JObj {} });

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
    "notifyChanged()V": async function (this: JObservable) {
      for (const o of [...this.observers]) {
        try { await vcall(o, "onChanged", "()V"); } catch (e) { console.warn("[dataset]", e); }
      }
    },
    "notifyInvalidated()V": async function (this: JObservable) {
      for (const o of [...this.observers]) {
        try { await vcall(o, "onInvalidated", "()V"); } catch (e) { console.warn("[dataset]", e); }
      }
    },
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
    "static isExternalStorageLegacy()Z": () => 0,
  },
});

// android.system.Os: the libcore syscall surface over the same descriptor table native code uses
defineException("android/system/ErrnoException", "java/lang/Exception");
const errno = (fn: string, e: number) => { const x = rt.mkThrowable("android/system/ErrnoException", fn) as JObj & { errno: number }; x.errno = e; return x; };
class JStructStat extends JObj { st_dev = 0n; st_ino = 0n; st_mode = 0; st_nlink = 1n; st_uid = 0; st_gid = 0; st_size = 0n; st_atime = 0n; st_mtime = 0n; st_ctime = 0n; st_blksize = 4096n; st_blocks = 0n; }
rt.register({
  name: "android/system/StructStat", ctor: JStructStat,
  fields: { st_dev: "st_dev", st_ino: "st_ino", st_mode: "st_mode", st_nlink: "st_nlink", st_uid: "st_uid", st_gid: "st_gid", st_size: "st_size", st_atime: "st_atime", st_mtime: "st_mtime", st_ctime: "st_ctime", st_blksize: "st_blksize", st_blocks: "st_blocks" },
});
const FD = "Ljava/io/FileDescriptor;";
rt.register({
  name: "android/system/Os", ctor: class extends JObj {},
  methods: {
    [`static lseek(${FD}JI)J`]: (d: JFileDescriptor, off: bigint, whence: number) => {
      const r = javaSeekFd(d.fd, Number(off), whence);
      if (r < 0) throw errno("lseek", 9);
      return BigInt(r);
    },
    [`static close(${FD})V`]: (d: JFileDescriptor) => { javaCloseFd(d.fd); d.fd = -1; },
    [`static dup(${FD})${FD}`]: (d: JFileDescriptor) => {
      const n = new (rt.link("java/io/FileDescriptor").ctor)() as JFileDescriptor;
      n.fd = javaDupFd(d.fd);
      if (n.fd < 0) throw errno("dup", 9);
      return n;
    },
    "static gettid()I": () => PROCESS_PID,
    "static getpid()I": () => PROCESS_PID,
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
    "static readlink(Ljava/lang/String;)Ljava/lang/String;": () => { throw errno("readlink", 22); },
  },
});
// android.system.OsConstants: static int fields naming POSIX/bionic constants.
// Only the fields real APKs have actually asked for are implemented (checked via
// scripts/audit.ts-style field scan of the dex) — not the full table AOSP ships.
rt.register({
  name: "android/system/OsConstants", ctor: class extends JObj {},
  statics: {
    PROT_READ: 0x1,
    MAP_PRIVATE: 0x02,
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
    "<init>()V": function () {},
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
    "doInBackground([Ljava/lang/Object;)Ljava/lang/Object;": () => null,
    "onPreExecute()V": () => {},
    "onPostExecute(Ljava/lang/Object;)V": () => {},
    "onProgressUpdate([Ljava/lang/Object;)V": () => {},
    "onCancelled()V": () => {},
    "onCancelled(Ljava/lang/Object;)V": function (this: JAsyncTask) { return vcall(this, "onCancelled", "()V"); },
    "publishProgress([Ljava/lang/Object;)V": function (this: JAsyncTask, values: unknown[]) {
      if (!this.cancelled) void onMain(() => this.cancelled ? undefined : vcall(this, "onProgressUpdate", "([Ljava/lang/Object;)V", values)).catch(reportUncaught);
    },
    "get()Ljava/lang/Object;": async function (this: JAsyncTask) {
      if (!this.cancelled && this.done) await this.done;
      if (this.cancelled) throw rt.mkThrowable("java/util/concurrent/CancellationException", null);
      if (this.error) throw await newObj("java/util/concurrent/ExecutionException", "(Ljava/lang/Throwable;)V", this.error);
      return this.result;
    },
    "static execute(Ljava/lang/Runnable;)V": (r: unknown) => vcall(serialTaskExecutor(), "execute", "(Ljava/lang/Runnable;)V", r),
  },
});
async function runAsyncTask(this: JAsyncTask, executor: unknown, params: unknown[]): Promise<JAsyncTask> {
  if (this.status !== 0) throw rt.mkThrowable("java/lang/IllegalStateException", "Task has already been executed");
  this.status = 1;
  let finish!: () => void;
  this.done = new Promise(resolve => { finish = resolve; });
  const pre = () => vcall(this, "onPreExecute", "()V");
  if (curThread === mainThread && inMainJob()) await pre(); else await onMain(pre);
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
  await vcall(executor, "execute", "(Ljava/lang/Runnable;)V", runnable);
  return this;
}

class JCountDownTimer extends JObj {
  totalMs = 0n;
  intervalMs = 1000n;
  timer: ReturnType<typeof setInterval> | null = null;
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
      this.endAt = performance.now() + Number(this.totalMs);
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => {
        const left = this.endAt - performance.now();
        if (left <= 0) {
          clearInterval(this.timer!);
          this.timer = null;
          void vcall(this, "onFinish", "()V").catch(reportUncaught);
        } else {
          void vcall(this, "onTick", "(J)V", BigInt(Math.round(left))).catch(reportUncaught);
        }
      }, Math.max(50, Number(this.intervalMs)));
      return this;
    },
    "cancel()V": function (this: JCountDownTimer) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    },
    "onTick(J)V": function () {},
    "onFinish()V": function () {},
  },
});

/** a Runnable over a JS closure, for framework code that must go through a Handler queue */
class JFnRunnable extends JObj { fn: () => unknown = () => {}; }
rt.register({ name: "webdroid/FnRunnable", ctor: JFnRunnable, ifaces: ["java/lang/Runnable"], methods: { "run()V": maySuspend(function (this: JFnRunnable) { return this.fn(); }) } });

// ── ResultReceiver: a callback that crosses processes on Android; here the send() lands on the
// creating Handler's looper (or inline when made without one), exactly as the in-process path does.
class JResultReceiver extends JObj { handler: JHandler | null = null; }
rt.register({
  name: "android/os/ResultReceiver", ctor: JResultReceiver, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(Landroid/os/Handler;)V": function (this: JResultReceiver, h: JHandler | null) { this.handler = h; },
    "send(ILandroid/os/Bundle;)V": function (this: JResultReceiver, code: number, data: unknown) {
      const deliver = () => vcall(this, "onReceiveResult", "(ILandroid/os/Bundle;)V", code, data);
      if (!this.handler) return deliver();
      const r = new JFnRunnable(); r.fn = deliver;
      this.handler.post(r, 0);
    },
    "onReceiveResult(ILandroid/os/Bundle;)V": () => {},
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": () => {},
  },
});
