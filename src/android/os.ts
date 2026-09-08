import { newStringSet } from "../jvm/natives/jutil";
// android.os.* + android.util.* natives: Looper/Handler on the JS event loop.

import { rt, JObj, type NativeSpec, maySuspend } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { markProcessExited } from "../native/cpu";
import { device } from "../shell/config";
import { vcall, curThread, mainThread, JThread, setCurThread, reportUncaught, JEnum } from "../jvm/natives/jlang";
export { reportUncaught };
import { onMain } from "./mainloop";
import { yieldToLoop } from "../native/cpu";
import { mkFile, JInputStream, JOutputStream, vfs } from "../jvm/natives/jio";
import { newArrayList } from "../jvm/natives/jutil";

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
    "sendMessageDelayed(Landroid/os/Message;J)Z": function (this: JHandler, m: JMessage, d: bigint) { return this.send(m, Number(d)); },
    "sendEmptyMessage(I)Z": function (this: JHandler, w: number) { const m = new JMessage(); m.what = w; return this.send(m, 0); },
    "sendEmptyMessageDelayed(IJ)Z": function (this: JHandler, w: number, d: bigint) {
      const m = new JMessage(); m.what = w; return this.send(m, Number(d));
    },
    "removeCallbacks(Ljava/lang/Runnable;Ljava/lang/Object;)V": function (this: JHandler, r: unknown) { this.cancel(r); },
    "removeMessages(I)V": function (this: JHandler, w: number) { this.cancel(w); },
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
    PRODUCT: "webdroid", HARDWARE: "browser", FINGERPRINT: "google/webdroid/1.0",
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
rt.register({
  name: "android/os/Process", ctor: class extends JObj {},
  statics: { THREAD_PRIORITY_BACKGROUND: 10, THREAD_PRIORITY_DEFAULT: 0, THREAD_PRIORITY_URGENT_DISPLAY: -8 },
  methods: {
    "static myPid()I": () => 1000,
    "static killProcess(I)V": (pid: number) => { console.warn("Process.killProcess", pid); markProcessExited(); },
    // androidx's startup tracing asks how long ago this process began; there is no earlier
    // moment here than the page's own timeOrigin
    "static getStartUptimeMillis()J": () => 0n,
    "static getStartElapsedRealtime()J": () => 0n,
    "static getElapsedCpuTime()J": () => BigInt(Math.round(performance.now())),
    "static isIsolated()Z": () => 0,
    "static isSdkSandbox()Z": () => 0,
    "static myTid()I": () => 1000,
    "static myUid()I": () => 10001,
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
rt.register({
  name: "android/os/Debug", ctor: class extends JObj {},
  methods: {
    "static isDebuggerConnected()Z": () => 0,
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
  chain("android/os/StrictMode$ThreadPolicy$Builder",
    ["detectAll()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "detectDiskReads()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "detectDiskWrites()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "detectNetwork()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "detectResourceMismatches()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "detectUnbufferedIo()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "penaltyLog()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "penaltyDeath()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "permitAll()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "permitDiskReads()Landroid/os/StrictMode$ThreadPolicy$Builder;",
      "permitDiskWrites()Landroid/os/StrictMode$ThreadPolicy$Builder;"],
    "android/os/StrictMode$ThreadPolicy");
  chain("android/os/StrictMode$VmPolicy$Builder",
    ["detectAll()Landroid/os/StrictMode$VmPolicy$Builder;",
      "detectLeakedClosableObjects()Landroid/os/StrictMode$VmPolicy$Builder;",
      "penaltyLog()Landroid/os/StrictMode$VmPolicy$Builder;",
      "permitUnsafeIntentLaunch()Landroid/os/StrictMode$VmPolicy$Builder;"],
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

export class JBundle extends JObj {
  map = new Map<string, unknown>();
  loader: unknown = null;
}
const bundleMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(I)V": function () {},
  "<init>(Landroid/os/Bundle;)V": function (this: JBundle, b: JBundle) { if (b) this.map = new Map(b.map); },
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
rt.register({ name: "android/os/BaseBundle", ctor: JBundle, methods: bundleMethods });
rt.register({ name: "android/os/Bundle", ctor: class extends JBundle {}, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], methods: bundleMethods });
rt.register({ name: "android/os/PersistableBundle", ctor: class extends JBundle {}, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], methods: bundleMethods });

export const PARCELABLE = {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": () => {},
} as const;
rt.register({ name: "android/os/Parcelable", ctor: class extends JObj {} });
rt.register({ name: "android/os/Parcelable$Creator", ctor: class extends JObj {} });
rt.register({ name: "android/os/Parcel", ctor: class extends JObj {} });
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
      return mkPfd(vfs.read(path) ?? new Uint8Array(0), (b) => vfs.write(path, b));
    },
    "static parseMode(Ljava/lang/String;)I": (m: string) =>
      (m?.includes("w") ? 0x28000000 : 0x10000000) | (m?.includes("t") || m === "w" ? 0x04000000 : 0)
      | (m?.includes("a") ? 0x02000000 : 0),
    "getFileDescriptor()Ljava/io/FileDescriptor;": () => new (rt.link("java/io/FileDescriptor").ctor)(),
    "getFd()I": () => -1,
    "detachFd()I": () => -1,
    "dup()Landroid/os/ParcelFileDescriptor;": function (this: JParcelFileDescriptor) { return mkPfd(this.bytes, this.sink); },
    "getStatSize()J": function (this: JParcelFileDescriptor) { return BigInt(this.bytes.length); },
    "close()V": () => {},
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

class JLog extends JObj {}
const logFn = (lvl: string) => (tag: string, msg: string, tr?: unknown) => {
  const t = tr as { msg?: string; jsStack?: string; stack?: string } | undefined;
  console.log(`[${lvl}/${tag}]`, msg, tr ? `(${t?.msg ?? tr})` : "", t?.jsStack ?? t?.stack ?? "");
  return 0;
};
rt.register({
  name: "android/util/Log", ctor: JLog,
  statics: { VERBOSE: 2, DEBUG: 3, INFO: 4, WARN: 5, ERROR: 6, ASSERT: 7 },
  methods: {
    ...Object.fromEntries(["v", "d", "i", "w", "e"].flatMap((l) => [
      [`static ${l}(Ljava/lang/String;Ljava/lang/String;)I`, logFn(l.toUpperCase())],
      [`static ${l}(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I`, logFn(l.toUpperCase())],
    ])),
    "static w(Ljava/lang/String;Ljava/lang/Throwable;)I": (tag: string, tr: unknown) => logFn("W")(tag, String((tr as any)?.msg ?? tr)),
    "static wtf(Ljava/lang/String;Ljava/lang/String;)I": logFn("WTF"),
    "static isLoggable(Ljava/lang/String;I)Z": () => 0,
    "static getStackTraceString(Ljava/lang/Throwable;)Ljava/lang/String;": (t: unknown) => String((t as any)?.msg ?? t ?? ""),
    "static println(ILjava/lang/String;Ljava/lang/String;)I": (p: number, tag: string, msg: string) => logFn("P")(tag, msg),
  },
});

class JSparseArray extends JObj {
  m = new Map<number, unknown>();
  /** keys in index order (Android keeps them sorted ascending) */
  keys(): number[] { return [...this.m.keys()].sort((a, b) => a - b); }
}
const sparseMethods = (valDesc: string, dflt: unknown): NativeSpec["methods"] => ({
  "<init>()V": function () {},
  "<init>(I)V": function () {},
  [`get(I)${valDesc}`]: function (this: JSparseArray, k: number) { return this.m.get(k) ?? dflt; },
  [`get(I${valDesc})${valDesc}`]: function (this: JSparseArray, k: number, d: unknown) { return this.m.has(k) ? this.m.get(k) : d; },
  [`put(I${valDesc})V`]: function (this: JSparseArray, k: number, v: unknown) { this.m.set(k, v); },
  [`append(I${valDesc})V`]: function (this: JSparseArray, k: number, v: unknown) { this.m.set(k, v); },
  "size()I": function (this: JSparseArray) { return this.m.size; },
  "keyAt(I)I": function (this: JSparseArray, i: number) { return this.keys()[i]; },
  [`valueAt(I)${valDesc}`]: function (this: JSparseArray, i: number) { return this.m.get(this.keys()[i]) ?? dflt; },
  "delete(I)V": function (this: JSparseArray, k: number) { this.m.delete(k); },
  "remove(I)V": function (this: JSparseArray, k: number) { this.m.delete(k); },
  "removeAt(I)V": function (this: JSparseArray, i: number) { this.m.delete(this.keys()[i]); },
  "clear()V": function (this: JSparseArray) { this.m.clear(); },
  "indexOfKey(I)I": function (this: JSparseArray, k: number) { return this.keys().indexOf(k); },
  [`indexOfValue(${valDesc})I`]: function (this: JSparseArray, v: unknown) { return [...this.m.values()].indexOf(v); },
});
rt.register({ name: "android/util/SparseArray", ctor: JSparseArray, methods: sparseMethods("Ljava/lang/Object;", null) });
rt.register({ name: "android/util/SparseIntArray", ctor: class extends JSparseArray {}, methods: sparseMethods("I", 0) });
rt.register({ name: "android/util/SparseBooleanArray", ctor: class extends JSparseArray {}, methods: sparseMethods("Z", 0) });
rt.register({ name: "android/util/SparseLongArray", ctor: class extends JSparseArray {}, methods: sparseMethods("J", 0n) });
rt.register({ name: "android/util/LongSparseArray", ctor: class extends JSparseArray {},
  methods: {
    "<init>()V": function () {},
    "get(J)Ljava/lang/Object;": function (this: JSparseArray, k: bigint) { return this.m.get(k as any) ?? null; },
    "put(JLjava/lang/Object;)V": function (this: JSparseArray, k: bigint, v: unknown) { this.m.set(k as any, v); },
    "size()I": function (this: JSparseArray) { return this.m.size; },
    "delete(J)V": function (this: JSparseArray, k: bigint) { this.m.delete(k as any); },
  } });

// android.util.StateSet: a spec lists the state ids a drawable/color entry needs (negative =
// must be absent), 0 terminates either array; both wildcards are answered by the constants.
const isWild = (s: Int32Array) => s.length === 0 || s[0] === 0;
export function stateSetMatches(spec: Int32Array | null, set: ArrayLike<number> | null): boolean {
  if (set === null) return spec === null || isWild(spec);
  for (let i = 0; i < spec!.length; i++) {
    let want = spec![i];
    if (want === 0) return true;
    const must = want > 0;
    if (!must) want = -want;
    let found = false;
    for (let j = 0; j < set.length; j++) {
      const st = set[j];
      if (st === 0) { if (must) return false; break; }
      if (st === want) { if (!must) return false; found = true; break; }
    }
    if (must && !found) return false;
  }
  return true;
}
rt.register({
  name: "android/util/StateSet", ctor: class extends JObj {},
  statics: { WILD_CARD: new Int32Array(0), NOTHING: Int32Array.of(0) },
  methods: {
    "static isWildCard([I)Z": (s: Int32Array) => isWild(s) ? 1 : 0,
    "static stateSetMatches([I[I)Z": (spec: Int32Array, set: Int32Array | null) => stateSetMatches(spec, set) ? 1 : 0,
    "static stateSetMatches([II)Z": (spec: Int32Array, state: number) => {
      for (let i = 0; i < spec.length; i++) {
        const want = spec[i];
        if (want === 0) return 1;
        if (want > 0 ? state !== want : state === -want) return 0;
      }
      return 1;
    },
    "static trimStateSet([II)[I": (s: Int32Array, n: number) => s.length === n ? s : s.slice(0, n),
    "static dump([I)Ljava/lang/String;": (s: Int32Array) => Array.from(s, (v) => v.toString(16)).join(" "),
  },
});

class JPair extends JObj { first: unknown = null; second: unknown = null; }
rt.register({
  name: "android/util/Pair", ctor: JPair,
  fields: { first: "first", second: "second" },
  methods: {
    "<init>(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JPair, a: unknown, b: unknown) { this.first = a; this.second = b; },
    "static create(Ljava/lang/Object;Ljava/lang/Object;)Landroid/util/Pair;": (a: unknown, b: unknown) => {
      const p = new JPair(); p.first = a; p.second = b; return p;
    },
  },
});

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

// ── android.util.Property / IntProperty / FloatProperty: abstract get/set handles that
// ObjectAnimator drives. The primitive subclasses unbox into the app's setValue override.
class JProperty extends JObj { type: unknown = null; name = ""; }
rt.register({
  name: "android/util/Property", ctor: JProperty,
  methods: {
    "<init>(Ljava/lang/Class;Ljava/lang/String;)V": function (this: JProperty, t: unknown, n: string) { this.type = t; this.name = n; },
    "getName()Ljava/lang/String;": function (this: JProperty) { return this.name; },
    "getType()Ljava/lang/Class;": function (this: JProperty) { return this.type; },
    "isReadOnly()Z": () => 0,
    "set(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JProperty) {
      throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Property " + this.name + " is read-only");
    },
  },
});
for (const [name, desc, cls, unbox] of [
  ["android/util/IntProperty", "(Ljava/lang/Object;I)V", "java/lang/Integer", (v: any) => v?.v | 0],
  ["android/util/FloatProperty", "(Ljava/lang/Object;F)V", "java/lang/Float", (v: any) => Math.fround(v?.v ?? 0)],
] as const) {
  rt.register({
    name, ctor: class extends JProperty {}, sup: "android/util/Property",
    methods: {
      "<init>(Ljava/lang/String;)V": function (this: JProperty, n: string) { this.type = rt.classFor(cls); this.name = n; },
      "set(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JProperty, o: unknown, v: unknown) { return vcall(this, "setValue", desc, o, unbox(v)); },
    },
  });
}

export class JDisplayMetrics extends JObj {
  density = device.density; densityDpi = device.densityDpi; scaledDensity = device.density;
  widthPixels = device.width; heightPixels = device.height;
  xdpi = device.densityDpi; ydpi = device.densityDpi;
}
rt.register({
  name: "android/util/DisplayMetrics", ctor: JDisplayMetrics,
  statics: { DENSITY_DEFAULT: 160 },
  fields: {
    density: "density", densityDpi: "densityDpi", scaledDensity: "scaledDensity",
    widthPixels: "widthPixels", heightPixels: "heightPixels", xdpi: "xdpi", ydpi: "ydpi",
  },
  methods: { "<init>()V": function () {}, "setTo(Landroid/util/DisplayMetrics;)V": function (this: JDisplayMetrics, o: JDisplayMetrics) { Object.assign(this, o); } },
});

class JLruCache extends JObj {
  max = 16; m = new Map<unknown, unknown>();
}
rt.register({
  name: "android/util/LruCache", ctor: JLruCache,
  methods: {
    "<init>(I)V": function (this: JLruCache, n: number) { this.max = Math.max(1, n); },
    "get(Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JLruCache, k: unknown) {
      if (this.m.has(k)) {
        const v = this.m.get(k);
        this.m.delete(k); this.m.set(k, v);   // re-insert: Map order is the recency order
        return v;
      }
      const created = await vcall(this, "create", "(Ljava/lang/Object;)Ljava/lang/Object;", k);
      if (created !== null) this.m.set(k, created);
      return created;
    },
    "create(Ljava/lang/Object;)Ljava/lang/Object;": () => null,
    "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function (this: JLruCache, k: unknown, v: unknown) {
      const old = this.m.get(k) ?? null;
      this.m.set(k, v);
      if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
      return old;
    },
    "remove(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JLruCache, k: unknown) {
      const old = this.m.get(k) ?? null;
      this.m.delete(k);
      return old;
    },
    "evictAll()V": function (this: JLruCache) { this.m.clear(); },
    "size()I": function (this: JLruCache) { return this.m.size; },
    "maxSize()I": function (this: JLruCache) { return this.max; },
  },
});

// android.util.TypedValue — real impl lives with res.ts; register constants here
export class JTypedValue extends JObj {
  type = 0; data = 0; resourceId = 0; string: string | null = null; density = 0;
  assetCookie = 0;            // set to 1 by fillTypedValue: the app apk is our only asset path
  changingConfigurations = 0; // resources resolve against one fixed config, so nothing varies
}
rt.register({
  name: "android/util/TypedValue", ctor: JTypedValue,
  statics: {
    TYPE_NULL: 0, TYPE_REFERENCE: 1, TYPE_ATTRIBUTE: 2, TYPE_STRING: 3, TYPE_FLOAT: 4,
    TYPE_DIMENSION: 5, TYPE_FRACTION: 6, TYPE_FIRST_INT: 16, TYPE_INT_DEC: 16, TYPE_INT_HEX: 17,
    TYPE_INT_BOOLEAN: 18, TYPE_FIRST_COLOR_INT: 28, TYPE_INT_COLOR_ARGB8: 28, TYPE_INT_COLOR_RGB8: 29,
    TYPE_INT_COLOR_ARGB4: 30, TYPE_INT_COLOR_RGB4: 31, TYPE_LAST_COLOR_INT: 31, TYPE_LAST_INT: 31,
    COMPLEX_UNIT_PX: 0, COMPLEX_UNIT_DIP: 1, COMPLEX_UNIT_SP: 2, COMPLEX_UNIT_PT: 3,
    COMPLEX_UNIT_IN: 4, COMPLEX_UNIT_MM: 5,
  },
  fields: { type: "type", data: "data", resourceId: "resourceId", string: "string", density: "density",
            assetCookie: "assetCookie", changingConfigurations: "changingConfigurations" },
  methods: {
    "<init>()V": function () {},
    "static complexToDimensionPixelSize(ILandroid/util/DisplayMetrics;)I": (data: number, dm: JDisplayMetrics) => {
      return Math.round(complexToPx(data, dm));
    },
    "static complexToDimension(ILandroid/util/DisplayMetrics;)F": (data: number, dm: JDisplayMetrics) => complexToPx(data, dm),
    "static applyDimension(IFLandroid/util/DisplayMetrics;)F": (unit: number, v: number, dm: JDisplayMetrics) => {
      switch (unit) {
        case 1: return v * dm.density;
        case 2: return v * dm.scaledDensity;
        default: return v;
      }
    },
    "getDimension(Landroid/util/DisplayMetrics;)F": function (this: JTypedValue, dm: JDisplayMetrics) {
      return complexToPx(this.data, dm);
    },
    "getFloat()F": function (this: JTypedValue) { return intBitsToFloat(this.data); },
    // COMPLEX_UNIT_FRACTION scales the base, FRACTION_PARENT the parent's base
    "getFraction(FF)F": function (this: JTypedValue, base: number, pbase: number) {
      return ((this.data & 0xf) === 0 ? base : pbase) * complexToPx(this.data & ~0xf, NO_DM);
    },
    "static complexToFraction(IFF)F": (data: number, base: number, pbase: number) =>
      ((data & 0xf) === 0 ? base : pbase) * complexToPx(data & ~0xf, NO_DM),
    "static complexToFloat(I)F": (data: number) => complexToPx(data & ~0xf, NO_DM),
  },
});
const NO_DM = { density: 1, scaledDensity: 1 };
export function complexToPx(data: number, dm: { density: number; scaledDensity: number }): number {
  const unit = data & 0xf;
  const mantissa = (data & 0xffffff00) | 0; // signed
  const mult = [2 ** -8, 2 ** -15, 2 ** -23, 2 ** -31][(data >> 4) & 3];
  const v = mantissa * mult;
  switch (unit) {
    case 0: return v;                      // px
    case 1: return v * dm.density;         // dip
    case 2: return v * dm.scaledDensity;   // sp
    case 3: return v * dm.density * 160 / 72; // pt
    case 4: return v * dm.density * 160;   // in
    case 5: return v * dm.density * 160 / 25.4; // mm
    default: return v;
  }
}

// ── Choreographer (frame callbacks; shell drains queue each rAF)
import { uiState } from "./view";
import { intBitsToFloat } from "../jvm/abi";
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
    ACTION_DOWN: 0, ACTION_UP: 1, KEYCODE_BACK: 4, KEYCODE_ENTER: 66, KEYCODE_DEL: 67,
    KEYCODE_DPAD_UP: 19, KEYCODE_DPAD_DOWN: 20, KEYCODE_MENU: 82, KEYCODE_VOLUME_UP: 24, KEYCODE_VOLUME_DOWN: 25,
  },
  methods: {
    "<init>(II)V": function (this: JKeyEvent, a: number, k: number) { this.action = a; this.keyCode = k; },
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

// android.system.OsConstants: static int fields naming POSIX/bionic constants.
// Only the fields real APKs have actually asked for are implemented (checked via
// scripts/audit.ts-style field scan of the dex) — not the full table AOSP ships.
rt.register({
  name: "android/system/OsConstants", ctor: class extends JObj {},
  statics: {
    PROT_READ: 0x1,
    MAP_PRIVATE: 0x02,
    SEEK_SET: 0,
    SIGKILL: 9,
  },
});

class JAsyncTask extends JObj {
  status = 0; // PENDING/RUNNING/FINISHED
  cancelled = 0;
}
rt.register({
  name: "android/os/AsyncTask", ctor: JAsyncTask,
  // the two executors AOSP publishes; app code hands them to executeOnExecutor or uses them
  // directly as a background Executor
  statics: { THREAD_POOL_EXECUTOR: null, SERIAL_EXECUTOR: null },
  clinit: () => {
    const c = rt.link("android/os/AsyncTask").ctor as Record<string, unknown>;
    c.s$THREAD_POOL_EXECUTOR = new (rt.link("webdroid/Executor").ctor)();
    c.s$SERIAL_EXECUTOR = new (rt.link("webdroid/Executor").ctor)();
  },
  methods: {
    "<init>()V": function () {},
    "execute([Ljava/lang/Object;)Landroid/os/AsyncTask;": function (this: JAsyncTask, params: unknown[]) {
      return runAsyncTask(this, params);
    },
    "executeOnExecutor(Ljava/util/concurrent/Executor;[Ljava/lang/Object;)Landroid/os/AsyncTask;":
      function (this: JAsyncTask, ex: unknown, params: unknown[]) {
        return runAsyncTask(this, params);
      },
    "cancel(Z)Z": function (this: JAsyncTask) { this.cancelled = 1; return 1; },
    "isCancelled()Z": function (this: JAsyncTask) { return this.cancelled; },
    "getStatus()Landroid/os/AsyncTask$Status;": () => null,
    "doInBackground([Ljava/lang/Object;)Ljava/lang/Object;": () => null,
    "onPreExecute()V": function () {},
    "onPostExecute(Ljava/lang/Object;)V": function () {},
    "onProgressUpdate([Ljava/lang/Object;)V": function () {},
    "onCancelled()V": function () {},
    "onCancelled(Ljava/lang/Object;)V": function () {},
    "publishProgress([Ljava/lang/Object;)V": function (this: JAsyncTask, values: unknown[]) {
      setTimeout(() => {
        void vcall(this, "onProgressUpdate", "([Ljava/lang/Object;)V", values).catch(reportUncaught);
      }, 0);
    },
    "get()Ljava/lang/Object;": function () { return null; },
    "static execute(Ljava/lang/Runnable;)V": (r: unknown) => {
      setTimeout(() => void vcall(r, "run", "()V").catch(reportUncaught), 0);
    },
  },
});
function runAsyncTask(t: JAsyncTask, params: unknown[]): JAsyncTask {
  t.status = 1;
  void (async () => {
    try {
      await vcall(t, "onPreExecute", "()V");
      // cooperative model: keep main-thread identity so Looper-based asserts in app code pass
      const result: unknown = await vcall(t, "doInBackground", "([Ljava/lang/Object;)Ljava/lang/Object;", params ?? []);
      t.status = 2;
      if (t.cancelled) {
        await vcall(t, "onCancelled", "(Ljava/lang/Object;)V", result);
        await vcall(t, "onCancelled", "()V");
      } else {
        await vcall(t, "onPostExecute", "(Ljava/lang/Object;)V", result);
      }
    } catch (e) { reportUncaught(e); }
  })();
  return t;
}
rt.register({ name: "android/os/AsyncTask$Status", ctor: class extends JObj {}, sup: "java/lang/Enum" });

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

// ── android.util.Size / SizeF — immutable value types (Bundle.putSize/getSize reference them)
for (const [n, num] of [["Size", (v: number) => v | 0], ["SizeF", (v: number) => v]] as const) {
  class JSize extends JObj { w = 0; h = 0; }
  const desc = n === "Size" ? "II" : "FF";
  rt.register({
    name: "android/util/" + n, ctor: JSize, ifaces: ["java/io/Serializable"],
    methods: {
      [`<init>(${desc})V`]: function (this: JSize, w: number, h: number) { this.w = num(w); this.h = num(h); },
      [`getWidth()${desc[0]}`]: function (this: JSize) { return this.w; },
      [`getHeight()${desc[0]}`]: function (this: JSize) { return this.h; },
      "toString()Ljava/lang/String;": function (this: JSize) { return `${this.w}x${this.h}`; },
      "equals(Ljava/lang/Object;)Z": function (this: JSize, o: JSize) {
        return o instanceof JSize && o.w === this.w && o.h === this.h ? 1 : 0;
      },
      "hashCode()I": function (this: JSize) { return (this.w * 31 + this.h) | 0; },
      [`static parse${n}(Ljava/lang/String;)Landroid/util/${n};`]: (s: string) => {
        const m = /^(-?[\d.]+)\s*[*x]\s*(-?[\d.]+)$/.exec(s ?? "");
        if (!m) throw rt.mkThrowable("java/lang/NumberFormatException", "Invalid " + n + ": " + s);
        const o = new (rt.link("android/util/" + n).ctor)() as JSize;
        o.w = num(parseFloat(m[1])); o.h = num(parseFloat(m[2]));
        return o;
      },
    },
  });
}

// ── android.util.FloatMath — deprecated, but older game loops still link it
const fm1 = (fn: (x: number) => number) => (x: number) => Math.fround(fn(x));
const fm2 = (fn: (a: number, b: number) => number) => (a: number, b: number) => Math.fround(fn(a, b));
rt.register({
  name: "android/util/FloatMath", ctor: class extends JObj {},
  methods: {
    "static sin(F)F": fm1(Math.sin), "static cos(F)F": fm1(Math.cos), "static sqrt(F)F": fm1(Math.sqrt),
    "static floor(F)F": fm1(Math.floor), "static ceil(F)F": fm1(Math.ceil), "static exp(F)F": fm1(Math.exp),
    "static pow(FF)F": fm2(Math.pow), "static hypot(FF)F": fm2(Math.hypot),
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

// ── android.util.JsonReader: the streaming pull parser Android ships. Reading the document
// through and walking the parsed value as a token stream is the same contract a strict reader
// offers, without a second hand-written JSON scanner in the tree.
class JJsonToken extends JEnum {}
const JSON_TOKENS = ["BEGIN_ARRAY", "END_ARRAY", "BEGIN_OBJECT", "END_OBJECT", "NAME",
  "STRING", "NUMBER", "BOOLEAN", "NULL", "END_DOCUMENT"];
const jsonToken: Record<string, JJsonToken> = {};
JSON_TOKENS.forEach((n, i) => { const t = new JJsonToken(); t.ename = n; t.ord = i; jsonToken[n] = t; });
rt.register({
  name: "android/util/JsonToken", ctor: JJsonToken, sup: "java/lang/Enum",
  statics: jsonToken,
  methods: {
    "static values()[Landroid/util/JsonToken;": () => JSON_TOKENS.map((n) => jsonToken[n]),
    "static valueOf(Ljava/lang/String;)Landroid/util/JsonToken;": (n: string) => jsonToken[n],
  },
});
type JsonEv = { t: string; v?: unknown };
function flattenJson(v: unknown, out: JsonEv[]) {
  if (v === null) out.push({ t: "NULL" });
  else if (Array.isArray(v)) {
    out.push({ t: "BEGIN_ARRAY" });
    for (const x of v) flattenJson(x, out);
    out.push({ t: "END_ARRAY" });
  } else if (typeof v === "object") {
    out.push({ t: "BEGIN_OBJECT" });
    for (const k of Object.keys(v as object)) { out.push({ t: "NAME", v: k }); flattenJson((v as Record<string, unknown>)[k], out); }
    out.push({ t: "END_OBJECT" });
  } else out.push({ t: typeof v === "string" ? "STRING" : typeof v === "number" ? "NUMBER" : "BOOLEAN", v });
}
class JJsonReader extends JObj {
  src: unknown = null;
  ev: JsonEv[] | null = null;
  i = 0;
}
/** the document is drained through the VIRTUAL read, so an app's own Reader subclass works */
async function jsonEvents(r: JJsonReader): Promise<JsonEv[]> {
  if (r.ev) return r.ev;
  const buf = new Uint16Array(8192);
  let s = "";
  for (;;) {
    const n = (await vcall(r.src, "read", "([CII)I", buf, 0, buf.length)) as number;
    if (n <= 0) break;
    s += String.fromCharCode(...buf.subarray(0, n));
  }
  const out: JsonEv[] = [];
  if (s.trim()) flattenJson(JSON.parse(s), out);
  out.push({ t: "END_DOCUMENT" });
  return (r.ev = out);
}
const jsonNext = async (r: JJsonReader, want?: string) => {
  const ev = await jsonEvents(r);
  const e = ev[r.i] ?? { t: "END_DOCUMENT" };
  if (want && e.t !== want) throw rt.mkThrowable("java/lang/IllegalStateException", `Expected ${want} but was ${e.t}`);
  r.i++;
  return e;
};
const jsonNum = async (r: JJsonReader) => Number((await jsonNext(r)).v);
rt.register({
  name: "android/util/JsonReader", ctor: JJsonReader, ifaces: ["java/io/Closeable"],
  methods: {
    "<init>(Ljava/io/Reader;)V": function (this: JJsonReader, r: unknown) { this.src = r; },
    "setLenient(Z)V": () => {},
    "close()V": function (this: JJsonReader) { this.ev = null; },
    "beginArray()V": function (this: JJsonReader) { return jsonNext(this, "BEGIN_ARRAY").then(() => {}); },
    "endArray()V": function (this: JJsonReader) { return jsonNext(this, "END_ARRAY").then(() => {}); },
    "beginObject()V": function (this: JJsonReader) { return jsonNext(this, "BEGIN_OBJECT").then(() => {}); },
    "endObject()V": function (this: JJsonReader) { return jsonNext(this, "END_OBJECT").then(() => {}); },
    "nextName()Ljava/lang/String;": async function (this: JJsonReader) { return (await jsonNext(this, "NAME")).v as string; },
    // AOSP coerces between the scalar types, so a number read as a string is legal and common
    "nextString()Ljava/lang/String;": async function (this: JJsonReader) { return String((await jsonNext(this)).v); },
    "nextInt()I": async function (this: JJsonReader) { return await jsonNum(this) | 0; },
    "nextLong()J": async function (this: JJsonReader) { return BigInt(Math.trunc(await jsonNum(this))); },
    "nextDouble()D": function (this: JJsonReader) { return jsonNum(this); },
    "nextBoolean()Z": async function (this: JJsonReader) { return (await jsonNext(this)).v ? 1 : 0; },
    "nextNull()V": function (this: JJsonReader) { return jsonNext(this, "NULL").then(() => {}); },
    "peek()Landroid/util/JsonToken;": async function (this: JJsonReader) {
      const ev = await jsonEvents(this);
      return jsonToken[(ev[this.i] ?? { t: "END_DOCUMENT" }).t];
    },
    "hasNext()Z": async function (this: JJsonReader) {
      const t = (await jsonEvents(this))[this.i]?.t;
      return t && t !== "END_OBJECT" && t !== "END_ARRAY" && t !== "END_DOCUMENT" ? 1 : 0;
    },
    "skipValue()V": async function (this: JJsonReader) {
      const ev = await jsonEvents(this);
      if (ev[this.i]?.t === "NAME") this.i++;
      let depth = 0;
      do {
        const t = ev[this.i++]?.t;
        if (t === "BEGIN_ARRAY" || t === "BEGIN_OBJECT") depth++;
        else if (t === "END_ARRAY" || t === "END_OBJECT") depth--;
        else if (t === undefined) break;
      } while (depth > 0);
    },
  },
});
