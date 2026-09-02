// android.os.* + android.util.* natives: Looper/Handler on the JS event loop.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { device } from "../shell/config";
import { vcall, curThread, mainThread, JThread, setCurThread, reportUncaught } from "../jvm/natives/jlang";
export { reportUncaught };
import { onMain } from "./mainloop";
import { mkFile } from "../jvm/natives/jio";
import { newArrayList } from "../jvm/natives/jutil";

// ── Looper
class JLooper extends JObj {
  thread: JThread;
  constructor(thread?: JThread) { super(); this.thread = thread ?? curThread; }
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

// ── Message / Handler
class JMessage extends JObj {
  what = 0; arg1 = 0; arg2 = 0; obj: unknown = null;
  callback: unknown = null; target: JHandler | null = null;
  whenMs = 0;
}
rt.register({
  name: "android/os/Message", ctor: JMessage,
  fields: { what: "what", arg1: "arg1", arg2: "arg2", obj: "obj" },
  methods: {
    "<init>()V": function () {},
    "static obtain()Landroid/os/Message;": () => new JMessage(),
    "static obtain(Landroid/os/Handler;)Landroid/os/Message;": (h: JHandler) => { const m = new JMessage(); m.target = h; return m; },
    "static obtain(Landroid/os/Handler;I)Landroid/os/Message;": (h: JHandler, w: number) => {
      const m = new JMessage(); m.target = h; m.what = w; return m;
    },
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
  pending = new Map<number, Set<ReturnType<typeof setTimeout>>>(); // what → timers
  byRunnable = new Map<unknown, Set<ReturnType<typeof setTimeout>>>();
  id = handlerSeq++;

  send(msg: JMessage, delay: number): number {
    msg.target = this;
    const t = setTimeout(() => this.dispatch(msg), delay);
    let set = this.pending.get(msg.what);
    if (!set) this.pending.set(msg.what, (set = new Set()));
    set.add(t);
    return 1;
  }
  postRun(r: unknown, delay: number): number {
    const t = setTimeout(() => void onMain(async () => {
      this.byRunnable.get(r)?.delete(t);
      const prev = curThread;
      setCurThread(this.looper.thread);
      try { await vcall(r, "run", "()V"); }
      catch (e) { reportUncaught(e); }
      finally { setCurThread(prev); }
    }), delay);
    let set = this.byRunnable.get(r);
    if (!set) this.byRunnable.set(r, (set = new Set()));
    set.add(t);
    return 1;
  }
  cancelRun(r: unknown): void {
    for (const t of this.byRunnable.get(r) ?? []) clearTimeout(t);
    this.byRunnable.delete(r);
  }
  private dispatch(msg: JMessage) {
    return onMain(async () => {
      this.pending.get(msg.what)?.clear();
      const prev = curThread;
      setCurThread(this.looper.thread);
      try {
        if (msg.callback) await vcall(msg.callback, "run", "()V");
        else if (this.cb && (await vcall(this.cb, "handleMessage", "(Landroid/os/Message;)Z", msg))) { /* handled */ }
        else await vcall(this, "handleMessage", "(Landroid/os/Message;)V", msg);
      } catch (e) { reportUncaught(e); }
      finally { setCurThread(prev); }
    });
  }
}
/** The window's handler, which View.post/postDelayed/scheduleDrawable enqueue on. Lazy so it
 *  is built after boot has linked the native classes. */
let _mainHandler: JHandler | null = null;
export function mainHandler(): JHandler {
  return _mainHandler ?? (_mainHandler = new JHandler());
}

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
    "post(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.postRun(r, 0); },
    "postDelayed(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, d: bigint) { return this.postRun(r, Number(d)); },
    "postAtTime(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, at: bigint) {
      return this.postRun(r, Math.max(0, Number(at) - performance.now()));
    },
    "postAtFrontOfQueue(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.postRun(r, 0); },
    "removeCallbacks(Ljava/lang/Runnable;)V": function (this: JHandler, r: unknown) { this.cancelRun(r); },
    "sendMessage(Landroid/os/Message;)Z": function (this: JHandler, m: JMessage) { return this.send(m, 0); },
    "sendMessageDelayed(Landroid/os/Message;J)Z": function (this: JHandler, m: JMessage, d: bigint) { return this.send(m, Number(d)); },
    "sendEmptyMessage(I)Z": function (this: JHandler, w: number) { const m = new JMessage(); m.what = w; return this.send(m, 0); },
    "sendEmptyMessageDelayed(IJ)Z": function (this: JHandler, w: number, d: bigint) {
      const m = new JMessage(); m.what = w; return this.send(m, Number(d));
    },
    "removeCallbacks(Ljava/lang/Runnable;Ljava/lang/Object;)V": function (this: JHandler, r: unknown) { this.cancelRun(r); },
    "removeMessages(I)V": function (this: JHandler, w: number) {
      for (const t of this.pending.get(w) ?? []) clearTimeout(t);
      this.pending.delete(w);
    },
    "removeCallbacksAndMessages(Ljava/lang/Object;)V": function (this: JHandler) {
      for (const s of this.pending.values()) for (const t of s) clearTimeout(t);
      for (const s of this.byRunnable.values()) for (const t of s) clearTimeout(t);
      this.pending.clear(); this.byRunnable.clear();
    },
    "hasMessages(I)Z": function (this: JHandler, w: number) { return this.pending.get(w)?.size ? 1 : 0; },
    "getLooper()Landroid/os/Looper;": function (this: JHandler) { return this.looper; },
    "obtainMessage()Landroid/os/Message;": function (this: JHandler) { const m = new JMessage(); m.target = this; return m; },
    "obtainMessage(I)Landroid/os/Message;": function (this: JHandler, w: number) {
      const m = new JMessage(); m.target = this; m.what = w; return m;
    },
    "obtainMessage(ILjava/lang/Object;)Landroid/os/Message;": function (this: JHandler, w: number, o: unknown) {
      const m = new JMessage(); m.target = this; m.what = w; m.obj = o; return m;
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
class JBuild extends JObj {}
rt.register({
  name: "android/os/Build", ctor: JBuild,
  statics: {
    MODEL: "webdroid", MANUFACTURER: "webdroid", BRAND: "google", DEVICE: "webdroid",
    PRODUCT: "webdroid", HARDWARE: "browser", FINGERPRINT: "google/webdroid/1.0",
    SERIAL: "unknown", ID: "WD1A", DISPLAY: "webdroid 1.0", TAGS: "release-keys", TYPE: "user",
    BOARD: "web", BOOTLOADER: "unknown", HOST: "localhost", USER: "web", TIME: 0n,
    SUPPORTED_ABIS: (() => { const a = ["arm64-v8a", "armeabi-v7a"]; (a as any).$t = "Ljava/lang/String;"; return a; })(),
  },
});
class JBuildVersion extends JObj {}
rt.register({
  name: "android/os/Build$VERSION", ctor: JBuildVersion,
  statics: { SDK_INT: device.sdk, RELEASE: device.release, CODENAME: "REL", INCREMENTAL: "1", SECURITY_PATCH: "2023-01-01", SDK: String(device.sdk) },
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
    "static myTid()I": () => 1000,
    "static myUid()I": () => 10001,
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

// ── Bundle
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
    const info = rt.link("java/util/HashSet");
    const s = new info.ctor();
    for (const k of this.map.keys()) s.m.set(k, { k, v: k });
    return s;
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
rt.register({ name: "android/os/BaseBundle", ctor: JBundle, methods: bundleMethods });
rt.register({ name: "android/os/Bundle", ctor: class extends JBundle {}, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], methods: bundleMethods });
rt.register({ name: "android/os/PersistableBundle", ctor: class extends JBundle {}, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], methods: bundleMethods });

// Parcelable/Parcel markers
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

// ── android.util.Log & friends
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

// ── android.util.Property / IntProperty / FloatProperty: abstract get/set handles that
// ObjectAnimator drives. The primitive subclasses unbox into the app's setValue override.
export class JProperty extends JObj { type: unknown = null; name = ""; }
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
    "getFloat()F": function (this: JTypedValue) { const s = scratchF; s.setUint32(0, this.data); return s.getFloat32(0); },
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
const scratchF = new DataView(new ArrayBuffer(4));
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
class JChoreographer extends JObj {}
const theChoreographer = new JChoreographer();
rt.register({
  name: "android/view/Choreographer", ctor: JChoreographer,
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

// KeyEvent
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
  methods: {
    "static getExternalStorageDirectory()Ljava/io/File;": () => mkFile("/sdcard"),
    "static getExternalStoragePublicDirectory(Ljava/lang/String;)Ljava/io/File;": (t: string) => mkFile("/sdcard/" + (t ?? "")),
    "static getDataDirectory()Ljava/io/File;": () => mkFile("/data"),
    "static getDownloadCacheDirectory()Ljava/io/File;": () => mkFile("/cache"),
    "static getExternalStorageState()Ljava/lang/String;": () => "mounted",
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

// ── AsyncTask
class JAsyncTask extends JObj {
  status = 0; // PENDING/RUNNING/FINISHED
  cancelled = 0;
}
rt.register({
  name: "android/os/AsyncTask", ctor: JAsyncTask,
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

// ── CountDownTimer
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
rt.register({ name: "webdroid/FnRunnable", ctor: JFnRunnable, ifaces: ["java/lang/Runnable"], methods: { "run()V": function (this: JFnRunnable) { return this.fn(); } } });

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
      this.handler.postRun(r, 0);
    },
    "onReceiveResult(ILandroid/os/Bundle;)V": () => {},
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": () => {},
  },
});
