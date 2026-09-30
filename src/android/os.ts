// android.os.* + android.util.* natives: Looper/Handler on the JS event loop.
import { readFully } from "../shell/lazyfile";
import { processEnv } from "../shell/environment";
import type { JMessenger } from "./messenger";
import { appUserName, procIdentity, processTid, sysconf } from "../shell/procfs";
import { parcelCreator, readObject, writeObject, type JParcel } from "./parcel";
import { guestAt, mem } from "../native/mem";
import { syncShared, trackSharedMap } from "../native/mappings";
import { rt, JObj, type NativeSpec, stubs, noops, driven, without, declaredField, type Gen } from "../jvm/runtime";
import { i8, jarray, jmethod, mangleMethod, utf8 } from "../jvm/abi";
import { markProcessExited, yieldToLoop } from "../native/cpu";
import { device } from "../shell/config";
import { androidGroupId } from "./identity";
import { uuidFromString } from "../jvm/natives/jvalues";
import { vcall, vcallOn, curThread, mainThread, JThread, JThrowable, setCurThread, reportUncaught, mkEnumSet, newObj, defineException, boxObject, box, JInt, JLong, JFloat, JDouble, JBool, JChar, JByte, JShort, vcallUncaught, after, checkFromIndexSize, scall } from "../jvm/natives/jlang";
import { E, ERRSTR } from "../native/abi";
import { OS_CONSTANTS } from "./os-constants";
export { reportUncaught };
import { onMain, inMainJob } from "./mainloop";
import { uiState } from "./view";
import { newFile, pathOf, fdInt, setFdInt, mkFd, heldByteReads, heldByteWrites } from "../jvm/natives/jio";
import { vfs } from "../shell/vfs";
import { frameworkString } from "./res";
import { javaOpenFd, javaCloseFd, javaSeekFd, javaDupFd, javaBytesFd, javaFdSource, javaFdStat, javaPipeFds, javaReadFd, javaPreadFd, javaWriteFd, javaPwriteFd, javaTruncateFd, javaSyncFd, javaFcntlFd, javaIoctlIntFd, fdFile, inoOf, accessPath, createPath, mkdirPath, removePath, renamePath } from "../native/stdio";
import { fdsanClose, fdsanExchangeOwnerTag, fdsanOwnerTag, fdsanTagType, fdsanTagValue } from "../native/fd";
import { newArrayList, newStringSet } from "../jvm/natives/jcoll";
import { type JBuffer, bufferBytes, directView, isBuffer, nonMovableBytes, resident } from "../jvm/natives/jnio";
import { clearGuestTimeout, guestNow, guestSleep, setGuestTimeout, type GuestTimer } from "../guest-clock";

rt.register({ name: "android/os/PerformanceHintManager", ctor: class extends JObj {} });

class JMessageQueue extends JObj {
  owner: JLooper | null = null;
  messages = new Set<JMessage>();
  handlers = new Set<unknown>();
  scheduled = false;
  isIdle(): boolean {
    const now = uptimeMillis();
    for (const m of this.messages) if (m.whenMs <= now) return false;
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
const dispatchLogged = driven(function* dispatchLogged(handler: JHandler, msg: JMessage, printer: unknown): Gen<void> {
  const thread = curThread;
  const str = async (o: unknown) => o === null ? "null" : String(await vcallOn(thread, o, "toString", "()Ljava/lang/String;"));
  try {
    yield vcallOn(thread, printer, "println", "(Ljava/lang/String;)V", `>>>>> Dispatching to ${yield str(handler)} ${yield str(msg.callback)}: ${msg.what}`);
    yield vcallOn(thread, handler, "dispatchMessage", "(Landroid/os/Message;)V", msg);
    yield vcallOn(thread, printer, "println", "(Ljava/lang/String;)V", `<<<<< Finished to ${yield str(handler)} ${yield str(msg.callback)}`);
  } catch (e) { reportUncaught(e); }
});
rt.markers("android/util/Printer");
export const mainLooper = new JLooper(mainThread);
mainThread.looper = mainLooper;
rt.register({
  name: "android/os/Looper", ctor: JLooper,
  methods: {
    "static getMainLooper()Landroid/os/Looper;": () => mainLooper,
    "static myLooper()Landroid/os/Looper;": () => (curThread.looper as JLooper) ?? null,
    "static prepare()V": () => { if (!curThread.looper) curThread.looper = new JLooper(); },
    "static loop()V": () => new Promise(() => {}), // parks the java thread; JS loop drives everything
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
export class JMessage extends JObj {
  asynchronous = false;
  what = 0; arg1 = 0; arg2 = 0; obj: unknown = null;
  callback: unknown = null; target: JHandler | null = null;
  whenMs = 0; sendingUid = -1; workSourceUid = -1;
  data: JBundle | null = null; replyTo: JMessenger | null = null;
  timer: GuestTimer | undefined;
}
export function obtain(h: JHandler | null, what = 0, obj: unknown = null, arg1 = 0, arg2 = 0, callback: unknown = null): JMessage {
  const m = new JMessage(); m.target = h; m.what = what; m.obj = obj; m.arg1 = arg1; m.arg2 = arg2; m.callback = callback; return m;
}
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
    msg.whenMs = uptimeMillis() + Math.max(0, delay);
    queue.messages.add(msg);
    // still pending until it runs, so a removeMessages/hasMessages in between sees it
    const go = () => this.looper.run(async () => {
      queue.messages.delete(msg);
      if (!set.delete(msg)) return;
      if (!set.size) this.pending.delete(key);
      const printer = this.looper.printer;
      try {
        if (printer) await dispatchLogged(this, msg, printer);
        else await vcallUncaught(this, "dispatchMessage", "(Landroid/os/Message;)V", msg);
      } finally { queue.checkIdle(); }
    });
    if (delay > 0) msg.timer = setGuestTimeout(() => void go(), delay); else void go();
    return 1;
  }
  // a Promise when an app's sendMessageAtTime suspends; natives hand it back to Java as the result
  post(r: unknown, delay: number): number { return sendDelayed(this, obtain(this, 0, null, 0, 0, r), delay) as number; }
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
/** AOSP's final post and send methods all enqueue through sendMessageAtTime, which a Handler
 *  subclass may override; one that does not is sent directly. */
function sendMessageAtTime(this: JHandler, msg: JMessage, at: bigint): number { return this.send(msg, Number(at) - uptimeMillis()); }
const M_sendMessageAtTime = mangleMethod("sendMessageAtTime", "(Landroid/os/Message;J)Z");
function sendAt(h: JHandler, msg: JMessage, at: bigint): unknown {
  const f = jmethod(h, M_sendMessageAtTime);
  return f && f !== sendMessageAtTime ? f.call(h, msg, at) : sendMessageAtTime.call(h, msg, at);
}
function sendDelayed(h: JHandler, msg: JMessage, delay: number): unknown {
  const f = jmethod(h, M_sendMessageAtTime);
  if (!f || f === sendMessageAtTime) return h.send(msg, delay);
  return f.call(h, msg, BigInt(Math.floor(uptimeMillis())) + BigInt(Math.max(0, Math.ceil(delay))));
}
/** The window's handler, which View.post/postDelayed/scheduleDrawable enqueue on. Lazy so it
 *  is built after boot has linked the native classes. */
let _mainHandler: JHandler | null = null;
export function mainHandler(): JHandler {
  if (!_mainHandler) { rt.link("android/os/Handler"); _mainHandler = new JHandler(); }
  return _mainHandler;
}

/** Context.getMainExecutor: AOSP's HandlerExecutor over the main handler */
let _mainExecutor: Promise<unknown> | null = null;
export function mainExecutor(): Promise<unknown> {
  return _mainExecutor ??= newObj("android/os/HandlerExecutor", "(Landroid/os/Handler;)V", mainHandler());
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
    "dispatchMessage(Landroid/os/Message;)V": driven(function* (this: JHandler, msg: JMessage): Gen {
      const thread = curThread;
      if (msg.callback) yield vcall(msg.callback, "run", "()V");
      else if (!this.cb || !(yield vcallOn(thread, this.cb, "handleMessage", "(Landroid/os/Message;)Z", msg)))
        yield vcallOn(thread, this, "handleMessage", "(Landroid/os/Message;)V", msg);
    }),
    "post(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.post(r, 0); },
    "postDelayed(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, d: bigint) { return this.post(r, Number(d)); },
    "postDelayed(Ljava/lang/Runnable;Ljava/lang/Object;J)Z": function (this: JHandler, r: unknown, token: unknown, d: bigint) {
      return sendDelayed(this, obtain(this, 0, token, 0, 0, r), Number(d));
    },
    "postAtTime(Ljava/lang/Runnable;J)Z": function (this: JHandler, r: unknown, at: bigint) {
      return sendAt(this, obtain(this, 0, null, 0, 0, r), at);
    },
    "postAtFrontOfQueue(Ljava/lang/Runnable;)Z": function (this: JHandler, r: unknown) { return this.post(r, 0); },
    "removeCallbacks(Ljava/lang/Runnable;)V": function (this: JHandler, r: unknown) { this.cancel(r); },
    "sendMessage(Landroid/os/Message;)Z": function (this: JHandler, m: JMessage) { return sendDelayed(this, m, 0); },
    "sendMessageAtFrontOfQueue(Landroid/os/Message;)Z": function (this: JHandler, m: JMessage) { return this.send(m, 0); },
    "sendMessageDelayed(Landroid/os/Message;J)Z": function (this: JHandler, m: JMessage, d: bigint) { return sendDelayed(this, m, Number(d)); },
    "sendMessageAtTime(Landroid/os/Message;J)Z": sendMessageAtTime,
    "sendEmptyMessage(I)Z": function (this: JHandler, w: number) { return sendDelayed(this, obtain(null, w), 0); },
    "sendEmptyMessageAtTime(IJ)Z": function (this: JHandler, w: number, at: bigint) { return sendAt(this, obtain(null, w), at); },
    "sendEmptyMessageDelayed(IJ)Z": function (this: JHandler, w: number, d: bigint) { return sendDelayed(this, obtain(null, w), Number(d)); },
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
    "obtainMessage()Landroid/os/Message;": function (this: JHandler) { return obtain(this); },
    "obtainMessage(I)Landroid/os/Message;": function (this: JHandler, w: number) { return obtain(this, w); },
    "obtainMessage(ILjava/lang/Object;)Landroid/os/Message;": function (this: JHandler, w: number, o: unknown) { return obtain(this, w, o); },
    "obtainMessage(III)Landroid/os/Message;": function (this: JHandler, w: number, a1: number, a2: number) { return obtain(this, w, null, a1, a2); },
    "obtainMessage(IIILjava/lang/Object;)Landroid/os/Message;": function (this: JHandler, w: number, a1: number, a2: number, obj: unknown) { return obtain(this, w, obj, a1, a2); },
    "static createAsync(Landroid/os/Looper;)Landroid/os/Handler;": (l: JLooper) => {
      const h = new JHandler(); h.looper = l ?? mainLooper; return h;
    },
  },
});
const handlerThreadQuit = (name: string) => function (this: JThread) {
  return after(vcall(this, "getLooper", "()Landroid/os/Looper;"), (looper: JLooper | null) => looper ? after(vcall(looper, name, "()V"), () => 1) : 0);
};
const initHandlerThread = function (this: any, n: string) { this.jname = n; this.jlooper.thread = this; this.looper = this.jlooper; };
rt.register({ name: "android/os/HandlerThread", ctor: class extends JThread { jlooper = new JLooper(); },
  sup: "java/lang/Thread",
  methods: {
    "<init>(Ljava/lang/String;)V": initHandlerThread,
    "<init>(Ljava/lang/String;I)V": initHandlerThread,
    // its looper's first job is onLooperPrepared, as HandlerThread.run calls it before Looper.loop
    "start()V": function (this: any) { this.alive = 1; void this.jlooper.run(() => vcallUncaught(this, "onLooperPrepared", "()V")); },
    "getLooper()Landroid/os/Looper;": function (this: any) { return this.jlooper; },
    "getThreadId()I": function (this: JThread) { return this.alive ? threadTid(this) : -1; },
    "quit()Z": handlerThreadQuit("quit"), "quitSafely()Z": handlerThreadQuit("quitSafely"),
    ...noops("run()V"),
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
    "static uptimeNanos()J": () => BigInt(Math.floor(uptimeMillis() * 1e6)),
    "static currentThreadTimeMillis()J": () => BigInt(Math.floor(performance.now())),
    // the host's wall clock is network-synchronized
    "static currentNetworkTimeClock()Ljava/time/Clock;": () => {
      const clock = rt.link("java/time/Clock");
      return after(rt.initClass(clock), () => vcall(clock.ctor, "systemUTC", "()Ljava/time/Clock;"));
    },
    "static sleep(J)V": (ms: bigint) => guestSleep(Number(ms)),
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
    BOARD: "web", BOOTLOADER: "unknown", HOST: "localhost", USER: "web", TIME: 0n, UNKNOWN: "unknown",
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
  // a release build: the codename is REL, so every RELEASE_OR_* name reads the release
  statics: { SDK_INT: device.sdk, RELEASE: device.release, RELEASE_OR_CODENAME: device.release, RELEASE_OR_PREVIEW_DISPLAY: device.release,
    CODENAME: "REL", INCREMENTAL: "1", SECURITY_PATCH: "2023-01-01", SDK: String(device.sdk), BASE_OS: "", PREVIEW_SDK_INT: 0,
    PREVIEW_SDK_FINGERPRINT: "REL", DEVICE_INITIAL_SDK_INT: device.sdk, MEDIA_PERFORMANCE_CLASS: 0,
    // SDK_INT, plus one for a pre-release codename, which a release build has none of
    RESOURCES_SDK_INT: device.sdk },
});
// API 33's codes, in the name order ART's getFields() reports for a dex class; apps index
// the array by SDK_INT to read the release codename
rt.register({ name: "android/os/Build$VERSION_CODES", ctor: class extends JObj {},
  statics: Object.fromEntries([
    ["BASE", 1], ["BASE_1_1", 2], ["CUPCAKE", 3], ["CUR_DEVELOPMENT", 10000], ["DONUT", 4], ["ECLAIR", 5],
    ["ECLAIR_0_1", 6], ["ECLAIR_MR1", 7], ["FROYO", 8], ["GINGERBREAD", 9], ["GINGERBREAD_MR1", 10],
    ["HONEYCOMB", 11], ["HONEYCOMB_MR1", 12], ["HONEYCOMB_MR2", 13], ["ICE_CREAM_SANDWICH", 14],
    ["ICE_CREAM_SANDWICH_MR1", 15], ["JELLY_BEAN", 16], ["JELLY_BEAN_MR1", 17], ["JELLY_BEAN_MR2", 18],
    ["KITKAT", 19], ["KITKAT_WATCH", 20], ["LOLLIPOP", 21], ["LOLLIPOP_MR1", 22], ["M", 23], ["N", 24],
    ["N_MR1", 25], ["O", 26], ["O_MR1", 27], ["P", 28], ["Q", 29], ["R", 30], ["S", 31], ["S_V2", 32],
    ["TIRAMISU", 33],
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
function threadTid(t: JThread): number {
  return processTid(t, t === mainThread);
}
export function setProcessName(name: string): void { PROCESS_NAME = name; procIdentity.name = name; }
rt.register({
  name: "android/os/Process", ctor: class extends JObj {},
  statics: { THREAD_PRIORITY_BACKGROUND: 10, THREAD_PRIORITY_DEFAULT: 0, THREAD_PRIORITY_URGENT_DISPLAY: -8 },
  methods: {
    "static myPid()I": () => PROCESS_PID,
    "static myProcessName()Ljava/lang/String;": () => PROCESS_NAME,
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
      const map = yield newObj("java/util/HashMap");
      for (const [key, value] of Object.entries(this.stats())) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, String(value));
      return map;
    }),
  },
});
/** the JS heap in KiB, the nearest thing to this process's dalvik footprint */
const jsHeapKb = () => (((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1024) | 0;
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
    "static getPss()J": () => BigInt(jsHeapKb()),
    // ART's runtime counters: nothing here collects, blocks or compacts, so every stat is zero
    "static getRuntimeStat(Ljava/lang/String;)Ljava/lang/String;": (name: string) => RUNTIME_STATS.includes(name) ? "0" : null,
    "static getRuntimeStats()Ljava/util/Map;": driven(function* (): Gen {
      const m = yield newObj("java/util/HashMap");
      for (const k of RUNTIME_STATS) yield vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", k, "0");
      return m;
    }),
    // nothing here is shared
    "static getMemoryInfo(Landroid/os/Debug$MemoryInfo;)V": (info: { dalvikPss: number; dalvikPrivateDirty: number; nativePss: number; nativePrivateDirty: number } | null) => {
      if (!info) throw rt.mkThrowable("java/lang/NullPointerException", "memoryInfo");
      const kb = jsHeapKb();
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
  // Nothing is enforced, so a policy is only what was last set, and LAX until then.
  const THREAD = "android/os/StrictMode$ThreadPolicy", VM = "android/os/StrictMode$VmPolicy";
  const lax: Record<string, JObj> = {}, current: Record<string, unknown> = {};
  const laxPolicy = (cls: string) => lax[cls] ??= rt.make(cls);
  const policy = (cls: string) => () => current[cls] ?? laxPolicy(cls);
  for (const cls of [THREAD, VM]) rt.register({ name: cls, ctor: class extends JObj {}, statics: { get LAX() { return laxPolicy(cls); } } });
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
  rt.register({
    name: "android/os/StrictMode", ctor: class extends JObj {},
    methods: {
      ...noops("static noteSlowCall(Ljava/lang/String;)V"),
      "static setThreadPolicy(Landroid/os/StrictMode$ThreadPolicy;)V": (p: unknown) => { current[THREAD] = p; },
      "static setVmPolicy(Landroid/os/StrictMode$VmPolicy;)V": (p: unknown) => { current[VM] = p; },
      "static getVmPolicy()Landroid/os/StrictMode$VmPolicy;": policy(VM),
      // the allow* calls hand back the policy to restore, which nothing here changed
      ...Object.fromEntries(["getThreadPolicy", "allowThreadDiskReads", "allowThreadDiskWrites"].map((m) => [`static ${m}()L${THREAD};`, policy(THREAD)])),
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
const bundleBoxes: Record<string, new () => { v: unknown }> = { I: JInt, J: JLong, F: JFloat, D: JDouble, Z: JBool, C: JChar, B: JByte, S: JShort };
export function bundlePrimitive(value: unknown, descriptor: string, fallback: unknown): unknown {
  if (typeof value === (descriptor === "J" ? "bigint" : "number")) return value;
  return value instanceof bundleBoxes[descriptor] ? value.v : fallback;
}
/** What put<Type> stores: I and J stay bare (their JS type names them); the other primitives
 *  keep their declared width in a box, as a Parcel round trip will too. */
export function bundleBox(value: unknown, descriptor: string): unknown {
  return typeof value === "number" && descriptor !== "I" && descriptor.length === 1 ? box(bundleBoxes[descriptor], value) : value;
}
export function bundleGet(b: JBaseBundle, k: string, descriptor: string, fallback: unknown): unknown {
  const v = b.map.get(k);
  return descriptor.length === 1 ? bundlePrimitive(v, descriptor, fallback) : v ?? fallback;
}
/** The typed values an Intent's extras carry, by accessor stem: Bundle get/put<stem>, and Intent's
 *  get<stem>Extra with putExtra (put<stem>Extra for the ArrayLists). */
export const INTENT_TYPES: readonly (readonly [string, string])[] = [
  ...["Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double"].flatMap((t, i) => [[t, "ZBCSIJFD"[i]], [t + "Array", "[" + "ZBCSIJFD"[i]]] as const),
  ["String", "Ljava/lang/String;"], ["CharSequence", "Ljava/lang/CharSequence;"], ["Parcelable", "Landroid/os/Parcelable;"],
  ["Serializable", "Ljava/io/Serializable;"], ["Bundle", "Landroid/os/Bundle;"], ["IBinder", "Landroid/os/IBinder;"],
  ["StringArray", "[Ljava/lang/String;"], ["CharSequenceArray", "[Ljava/lang/CharSequence;"], ["ParcelableArray", "[Landroid/os/Parcelable;"],
  ...["Integer", "String", "CharSequence", "Parcelable"].map((t) => [t + "ArrayList", "Ljava/util/ArrayList;"] as const),
];
const BUNDLE_TYPES = [...INTENT_TYPES, ["Binder", "Landroid/os/IBinder;"], ["PersistableBundle", "Landroid/os/PersistableBundle;"],
  ["Size", "Landroid/util/Size;"], ["SizeF", "Landroid/util/SizeF;"], ["SparseParcelableArray", "Landroid/util/SparseArray;"]] as const;
/** API 33's class-checked getters, [stem, return]: Intent's get<stem>Extra, and Bundle's get<stem>. */
export const INTENT_TYPED = [["Parcelable", "Ljava/lang/Object;"], ["Serializable", "Ljava/io/Serializable;"],
  ["ParcelableArray", "[Ljava/lang/Object;"], ["ParcelableArrayList", "Ljava/util/ArrayList;"]] as const;
const BUNDLE_TYPED = [...INTENT_TYPED, ["SparseParcelableArray", "Landroid/util/SparseArray;"]] as const;
/** A class-checked getter's value. The class narrows a single value, which a mismatch reads as
 *  null; arrays and lists hold what was put. */
export function bundleTyped(b: JBaseBundle, k: string, cls: unknown, ret: string): unknown {
  const v = boxObject(b.map.get(k) ?? null), single = ret === "Ljava/lang/Object;" || ret === "Ljava/io/Serializable;";
  return single && v !== null && !vcall(cls, "isInstance", "(Ljava/lang/Object;)Z", v) ? null : v;
}
function copyBundle(this: JBaseBundle, b: JBaseBundle | null) { if (b) { this.map = new Map(b.map); this.loader = b.loader; } }
function putAll(this: JBaseBundle, b: JBaseBundle) { for (const [k, v] of b.map) this.map.set(k, v); }
/** BaseBundle's deep copy: nested bundles and arrays are copied too, other values are shared */
function deepCopy(this: JBaseBundle): JBaseBundle {
  const copy = new (this.constructor as new () => JBaseBundle)();
  copy.loader = this.loader;
  for (const [k, v] of this.map) copy.map.set(k, v instanceof JBaseBundle ? deepCopy.call(v)
    : Array.isArray(v) ? Object.assign(v.slice(), { $t: (v as { $t?: string }).$t }) : ArrayBuffer.isView(v) ? (v as Uint8Array).slice() : v);
  return copy;
}
const bundleMethods: NativeSpec["methods"] = {
  "<init>(Landroid/os/Bundle;)V": copyBundle,
  "<init>(Landroid/os/PersistableBundle;)V": copyBundle,
  "<init>(Ljava/lang/ClassLoader;)V": function (this: JBundle, cl: unknown) { this.loader = cl; },
  "clone()Ljava/lang/Object;": function (this: JBundle) {
    const copy = new (this.constructor as typeof JBundle)();
    copy.map = new Map(this.map); copy.loader = this.loader;
    return copy;
  },
  ...noops("<init>()V", "<init>(I)V"),
  ...stubs(0, "describeContents()I"),
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JBundle, parcel: JParcel): Gen { yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", this); }),
  "readFromParcel(Landroid/os/Parcel;)V": driven(function* (this: JBundle, parcel: JParcel): Gen {
    this.map = (yield vcall(parcel, "readBundle", "(Ljava/lang/ClassLoader;)Landroid/os/Bundle;", this.loader))?.map ?? new Map();
  }),
  "size()I": function (this: JBundle) { return this.map.size; },
  // A Bundle holds boxed values: `get` is the only reader that lost the declared width, and a
  // caller that reaches for Object then calls toString()/instanceof Number needs the box.
  "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JBundle, k: string) { return boxObject(this.map.get(k) ?? null); },
  "isEmpty()Z": function (this: JBundle) { return this.map.size ? 0 : 1; },
  "containsKey(Ljava/lang/String;)Z": function (this: JBundle, k: string) { return this.map.has(k) ? 1 : 0; },
  "remove(Ljava/lang/String;)V": function (this: JBundle, k: string) { this.map.delete(k); },
  "clear()V": function (this: JBundle) { this.map.clear(); },
  "keySet()Ljava/util/Set;": function (this: JBundle) { return newStringSet(this.map.keys()); },
  "putAll(Landroid/os/Bundle;)V": putAll,
  "putAll(Landroid/os/PersistableBundle;)V": putAll,
  "setClassLoader(Ljava/lang/ClassLoader;)V": function (this: JBundle, cl: unknown) { this.loader = cl; },
  "getClassLoader()Ljava/lang/ClassLoader;": function (this: JBundle) { return this.loader; },
  "getSerializable(Ljava/lang/String;)Ljava/io/Serializable;": function (this: JBundle, k: string) { return boxObject(this.map.get(k) ?? null); },
};
for (const [t, d] of BUNDLE_TYPES) {
  const zero = d.length > 1 ? null : d === "J" ? 0n : 0;
  bundleMethods[`put${t}(Ljava/lang/String;${d})V`] = function (this: JBundle, k: string, v: unknown) { this.map.set(k, bundleBox(v, d)); };
  bundleMethods[`get${t}(Ljava/lang/String;)${d}`] ??= function (this: JBundle, k: string) { return bundleGet(this, k, d, zero); };
  // AOSP boxes getByte's default; the reference types with a default overload are the two strings
  if (d === "B") bundleMethods["getByte(Ljava/lang/String;B)Ljava/lang/Byte;"] = function (this: JBundle, k: string, dv: number) { return box(JByte, bundleGet(this, k, d, dv) as number); };
  else if (zero !== null || t === "String" || t === "CharSequence") {
    bundleMethods[`get${t}(Ljava/lang/String;${d})${d}`] = function (this: JBundle, k: string, dv: unknown) { return bundleGet(this, k, d, dv); };
  }
}
for (const [t, d] of BUNDLE_TYPED) {
  bundleMethods[`get${t}(Ljava/lang/String;Ljava/lang/Class;)${d}`] = function (this: JBundle, k: string, cls: unknown) { return bundleTyped(this, k, cls, d); };
}
/** what only Bundle holds (PersistableBundle keeps to strings, numbers and nested PersistableBundles) */
const PARCEL_STEMS = new Set(["Binder", "Bundle", "IBinder", "Parcelable", "ParcelableArray", "ParcelableArrayList", "Size", "SizeF", "SparseParcelableArray"]);
const bundleOnly = [
  ...BUNDLE_TYPES.filter(([t]) => PARCEL_STEMS.has(t)).flatMap(([t, d]) => [`put${t}(Ljava/lang/String;${d})V`, `get${t}(Ljava/lang/String;)${d}`]),
  ...BUNDLE_TYPED.filter(([t]) => PARCEL_STEMS.has(t)).map(([t, d]) => `get${t}(Ljava/lang/String;Ljava/lang/Class;)${d}`),
  "putAll(Landroid/os/Bundle;)V", "readFromParcel(Landroid/os/Parcel;)V",
];
const persistableOnly = ["putPersistableBundle(Ljava/lang/String;Landroid/os/PersistableBundle;)V", "getPersistableBundle(Ljava/lang/String;)Landroid/os/PersistableBundle;"];
rt.register({ name: "android/os/BaseBundle", ctor: JBaseBundle, methods: without(bundleMethods, bundleOnly, persistableOnly,
  ["<init>(Landroid/os/Bundle;)V", "<init>(Landroid/os/PersistableBundle;)V", "describeContents()I", "writeToParcel(Landroid/os/Parcel;I)V"]) });
rt.register({ name: "android/os/Bundle", ctor: JBundle, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], statics: { get EMPTY() { return new JBundle(); }, get CREATOR() { return parcelCreator("android/os/Bundle", (p) => vcall(p, "readBundle", "()Landroid/os/Bundle;")); } },
  methods: { ...without(bundleMethods, persistableOnly), "deepCopy()Landroid/os/Bundle;": deepCopy } });
rt.register({ name: "android/os/PersistableBundle", ctor: JPersistableBundle, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], statics: { get EMPTY() { return new JPersistableBundle(); } },
  methods: { ...without(bundleMethods, bundleOnly, ["<init>(Ljava/lang/ClassLoader;)V"]), "deepCopy()Landroid/os/PersistableBundle;": deepCopy } });

export const PARCELABLE = {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": () => {},
} as const;
rt.markers("android/os/Parcelable");
rt.markers("android/os/OutcomeReceiver");
const sharedMappings = new WeakSet<JBuffer>();
/** the ashmem region: guest memory, which each mapping's direct buffer addresses */
class JSharedMemory extends JObj {
  bytes: Int8Array = new Int8Array(0);
  protection = 7;
  closed = false;
  map(prot: number, offset: number, length: number): JBuffer | Promise<JBuffer> {
    if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
    if (offset < 0 || length <= 0 || offset > this.bytes.length - length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid shared memory range");
    if (prot < 0 || prot & ~7 || (prot & this.protection) !== prot) throw errno("mmap", E.ACCES);
    return after(directView(this.bytes, offset, length, !(prot & 2)), (buffer) => { sharedMappings.add(buffer); return buffer; });
  }
}
rt.register({
  name: "android/os/SharedMemory", ctor: JSharedMemory, ifaces: ["android/os/Parcelable", "java/io/Closeable"],
  statics: { get CREATOR() { return parcelCreator("android/os/SharedMemory", async (p) => {
    const protection = await vcall(p, "readInt", "()I") as number;
    const bytes = await vcall(p, "createByteArray", "()[B") as Int8Array;
    const shared = new JSharedMemory(); shared.protection = protection; shared.bytes = nonMovableBytes(bytes.length); shared.bytes.set(bytes);
    return shared;
  }); } },
  methods: {
    "static create(Ljava/lang/String;I)Landroid/os/SharedMemory;": (_name: string | null, size: number) => {
      if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Size must be positive");
      const shared = new JSharedMemory(); shared.bytes = nonMovableBytes(size); return shared;
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
      if (!sharedMappings.delete(buffer)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer is not mapped shared memory");
      return scall("java/nio/NioUtils", "freeDirectBuffer", "(Ljava/nio/ByteBuffer;)V", buffer);
    },
    "close()V": function (this: JSharedMemory) { this.closed = true; },
    "describeContents()I": () => 1,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JSharedMemory, parcel: JParcel): Gen {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      yield vcall(parcel, "writeInt", "(I)V", this.protection);
      yield vcall(parcel, "writeByteArray", "([B)V", this.bytes.slice());
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
      if (this.listener) yield vcall(this.listener, "onCancel", "()V");
    }),
    "throwIfCanceled()V": function (this: JCancellationSignal) {
      if (this.cancelled) throw rt.mkThrowable("android/os/OperationCanceledException", null);
    },
    "setOnCancelListener(Landroid/os/CancellationSignal$OnCancelListener;)V": driven(function* (this: JCancellationSignal, listener: unknown): Gen {
      if (this.listener === listener) return;
      this.listener = listener;
      if (this.cancelled && listener) yield vcall(listener, "onCancel", "()V");
    }),
  },
});

class JParcelFileDescriptor extends JObj {
  bytes: Uint8Array = new Uint8Array(0);
  sink: ((b: Uint8Array, closed?: boolean) => unknown) | null = null;
  path = "";
  flags = 0;
  fd = -1;
  closed = false;
  backing: PfdBacking | null = null;
  descriptor: JObj | null = null;
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
let pfdBackingSeq = 0;
const pfdBackings = new Map<string, PfdBacking>();
export const pfdBackingBytes = driven(function* pfdBackingBytes(key: string): Gen<Uint8Array | null> {
  const backing = pfdBackings.get(key);
  if (backing?.closing) { yield backing.closing; return null; }
  return backing ? vfs.read(backing.path) : null;
});
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
export const writeParcelFileDescriptor = driven(function* writeParcelFileDescriptor(value: unknown, bytes: Uint8Array, closed: boolean = false): Gen<void> {
  if (!(value instanceof JParcelFileDescriptor)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a ParcelFileDescriptor");
  value.bytes = bytes.slice();
  if (value.backing) vfs.write(value.backing.path, value.bytes, false);
  yield value.sink?.(value.bytes, closed);
});
rt.register({
  name: "android/os/ParcelFileDescriptor", ctor: JParcelFileDescriptor,
  ifaces: ["android/os/Parcelable", "java/io/Closeable"],
  statics: {
    MODE_READ_ONLY: 0x10000000, MODE_WRITE_ONLY: 0x20000000, MODE_READ_WRITE: 0x30000000,
    MODE_CREATE: 0x08000000, MODE_TRUNCATE: 0x04000000, MODE_APPEND: 0x02000000,
    get CREATOR() { return parcelCreator("android/os/ParcelFileDescriptor", async (parcel) => readObject(parcel)); },
  },
  methods: {
    "static open(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;": driven(function* (f: JObj | null, mode: number): Gen {
      if (!f) rt.npe();
      const path = pathOf(f!);
      if (!vfs.exists(path) && !(mode & 0x08000000)) throw rt.mkThrowable("java/io/FileNotFoundException", path);
      if (mode & 0x04000000) vfs.write(path, new Uint8Array(0));
      const source = vfs.source(path);
      const p = mkPfd(source ? yield readFully(source) : new Uint8Array(0), mode & 0x20000000 ? (b) => vfs.write(path, b) : null);
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
    // AOSP keeps one FileDescriptor per ParcelFileDescriptor, invalidated when it closes
    "getFileDescriptor()Ljava/io/FileDescriptor;": function (this: JParcelFileDescriptor) {
      if (this.descriptor) return this.descriptor;
      return after(mkFd(pfdFd(this)), (d) => this.descriptor ??= d);
    },
    "getFd()I": function (this: JParcelFileDescriptor) { return pfdFd(this); },
    "static adoptFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd }),
    "static fromFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd: javaDupFd(fd) }),
    // AOSP dup(FileDescriptor): a new descriptor on the same open file description
    "static dup(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;": (d: JObj | null) => {
      if (fdInt(d) < 0) throw rt.mkThrowable("java/io/IOException", "Invalid file descriptor");
      const fd = javaDupFd(fdInt(d));
      if (fd < 0) throw rt.mkThrowable("java/io/IOException", "dup failed: EBADF (Bad file descriptor)");
      return Object.assign(new JParcelFileDescriptor(), { fd });
    },
    "detachFd()I": function (this: JParcelFileDescriptor) {
      const fd = pfdFd(this);
      this.fd = -1; this.closed = true;
      if (this.descriptor) setFdInt(this.descriptor, -1);
      return fd;
    },
    "dup()Landroid/os/ParcelFileDescriptor;": function (this: JParcelFileDescriptor) {
      const p = Object.assign(mkPfd(this.bytes, this.sink), { path: this.path, flags: this.flags, fd: javaDupFd(pfdFd(this)), backing: this.backing });
      if (p.backing) p.backing.refs++;
      return p;
    },
    "getStatSize()J": function (this: JParcelFileDescriptor) { return BigInt(this.backing ? vfs.stat(this.backing.path)?.size ?? 0 : this.bytes.length); },
    // A parcel carries a duplicate of the descriptor, as the kernel does; it stays within this
    // process, since binder IPC here moves no descriptors (provider files travel as bytes).
    "describeContents()I": () => 1, // CONTENTS_FILE_DESCRIPTOR
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JParcelFileDescriptor, parcel: JParcel, flags: number): Gen {
      writeObject(parcel, yield vcall(this, "dup", "()Landroid/os/ParcelFileDescriptor;"));
      if (flags & 1) yield vcall(this, "close", "()V"); // PARCELABLE_WRITE_RETURN_VALUE
    }),
    "close()V": driven(function* (this: JParcelFileDescriptor): Gen {
      if (this.closed) return;
      if (this.fd >= 0) javaCloseFd(this.fd);
      this.fd = -1; this.closed = true;
      if (this.descriptor) setFdInt(this.descriptor, -1);
      if (this.backing && --this.backing.refs === 0) {
        const backing = this.backing, bytes = vfs.read(backing.path) ?? new Uint8Array(0);
        backing.closing = (async () => {
          try { await backing.sink?.(bytes, true); }
          finally {
            pfdBackings.delete(backing.key);
            vfs.delete(backing.path, false);
          }
        })();
        yield backing.closing;
      }
    }),
    "checkError()V": () => {},
  },
});
class JPfdIn extends JObj { buf: Uint8Array = new Uint8Array(0); pos = 0; pfd: JParcelFileDescriptor | null = null; channel: JObj | null = null; }
const pfdDescriptor = (s: JPfdIn) => {
  if (!s.pfd) throw rt.mkThrowable("java/io/IOException", "Stream Closed");
  return vcall(s.pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
};
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseInputStream", ctor: JPfdIn, sup: "java/io/InputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdIn, p: JParcelFileDescriptor) { this.buf = p.bytes; this.pfd = p; },
    ...heldByteReads,
    // FileInputStream's, which AOSP's subclasses (AssetFileDescriptor's streams) reach
    "getFD()Ljava/io/FileDescriptor;": function (this: JPfdIn) { return pfdDescriptor(this); },
    "getChannel()Ljava/nio/channels/FileChannel;": driven(function* (this: JPfdIn): Gen {
      return this.channel ??= yield scall("sun/nio/ch/FileChannelImpl", "open", "(Ljava/io/FileDescriptor;Ljava/lang/String;ZZLjava/lang/Object;)Ljava/nio/channels/FileChannel;",
        yield pfdDescriptor(this), null, 1, 0, this);
    }),
    "close()V": function (this: JPfdIn) { const pfd = this.pfd; this.pfd = null; if (pfd) return vcall(pfd, "close", "()V"); },
  },
});
class JPfdOut extends JObj { chunks: number[] = []; pfd: JParcelFileDescriptor | null = null; }
const pfdFlush = async function (this: JPfdOut, closed = false) {
  const pfd = this.pfd, bytes = Uint8Array.from(this.chunks);
  // a backed descriptor's sink takes its file when the last holder closes
  if (pfd?.backing) vfs.write(pfd.backing.path, bytes, false);
  else await pfd?.sink?.(bytes, closed);
};
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseOutputStream", ctor: JPfdOut, sup: "java/io/OutputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdOut, p: JParcelFileDescriptor) { this.pfd = p; },
    ...heldByteWrites,
    "flush()V": pfdFlush,
    "close()V": driven(function* (this: JPfdOut): Gen { yield pfdFlush.call(this, true); const pfd = this.pfd; this.pfd = null; if (pfd) yield vcall(pfd, "close", "()V"); }),
  },
});

// statvfs answers the browser's storage estimate for whichever path is asked about (one
// filesystem backs everything here), in 4K blocks.
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
export const storageEstimate = driven(function* storageEstimate(): Gen<{ total: number; free: number }> {
  try {
    const e = yield navigator.storage?.estimate?.();
    return { total: e?.quota ?? 0, free: Math.max(0, (e?.quota ?? 0) - (e?.usage ?? 0)) };
  } catch { return { total: 0, free: 0 }; /* no estimate available: report an empty filesystem */ }
});
// the emulated primary volume that is shared storage: it has no UUID of its own, and its
// storage UUID is the internal one it lives on
const SHARED = "/sdcard";
let primary: JObj | null = null;
const primaryVolume = () => primary ??= rt.make("android/os/storage/StorageVolume");
rt.register({
  name: "android/os/storage/StorageManager", ctor: class extends JObj {},
  statics: { get UUID_DEFAULT() { return uuidDefault(); } },
  methods: {
    "getUuidForPath(Ljava/io/File;)Ljava/util/UUID;": () => uuidDefault(),
    "getAllocatableBytes(Ljava/util/UUID;)J": driven(function* (): Gen { return BigInt(Math.floor((yield storageEstimate()).free)); }),
    "getCacheQuotaBytes(Ljava/util/UUID;)J": driven(function* (): Gen { return BigInt(Math.floor((yield storageEstimate()).total / 20)); }),
    "getCacheSizeBytes(Ljava/util/UUID;)J": () => 0n,
    "isAllocationSupported(Ljava/io/FileDescriptor;)Z": () => 0,
    "isEncrypted(Ljava/io/File;)Z": () => 0,
    "getStorageVolumes()Ljava/util/List;": () => newArrayList([primaryVolume()]),
    "getVolumeList()[Landroid/os/storage/StorageVolume;": () => jarray([primaryVolume()], "Landroid/os/storage/StorageVolume;"),
    "getPrimaryStorageVolume()Landroid/os/storage/StorageVolume;": primaryVolume,
    "getStorageVolume(Ljava/io/File;)Landroid/os/storage/StorageVolume;": (file: JObj | null) => {
      if (!file) rt.npe();
      const path = pathOf(file!);
      return path === SHARED || path.startsWith(SHARED + "/") ? primaryVolume() : null;
    },
  },
});
rt.register({
  name: "android/os/storage/StorageVolume", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable"],
  methods: {
    "getDirectory()Ljava/io/File;": () => newFile(SHARED),
    "getPath()Ljava/lang/String;": () => SHARED,
    "getDescription(Landroid/content/Context;)Ljava/lang/String;": () => frameworkString("storage_internal") ?? "",
    "getState()Ljava/lang/String;": () => "mounted",
    "getMediaStoreVolumeName()Ljava/lang/String;": () => "external_primary",
    "getStorageUuid()Ljava/util/UUID;": () => uuidDefault(),
    "getUuid()Ljava/lang/String;": () => null,
    ...stubs(1, "isPrimary()Z", "isEmulated()Z"),
    ...stubs(0, "isRemovable()Z", "describeContents()I"),
    "createOpenDocumentTreeIntent()Landroid/content/Intent;": () => newObj("android/content/Intent", "(Ljava/lang/String;)V", "android.intent.action.OPEN_DOCUMENT_TREE"),
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
let nextVsync = 0, vsyncWaiters: (() => void)[] = [], vsyncWatchdog: ReturnType<typeof setTimeout> | undefined;
const vsyncIntervalMs = (): number => 1000 / device.refreshRate;
function flushVsyncWaiters(): void {
  clearTimeout(vsyncWatchdog); vsyncWatchdog = undefined;
  const waiters = vsyncWaiters;
  vsyncWaiters = [];
  for (const resolve of waiters) resolve();
}
/** The next virtual vsync: what a blocking eglSwapBuffers waits for. A realm whose frame loop is
 *  not running (hidden page, background process) still advances, at the display's rate. */
export function vsync(): Promise<void> {
  return new Promise((resolve) => {
    vsyncWaiters.push(resolve);
    vsyncWatchdog ??= setTimeout(flushVsyncWaiters, 2 * vsyncIntervalMs());
  });
}
/** a display frame: true when it is a virtual vsync, whose choreographers off the main looper run now; the caller ticks the main one */
export function recordVsync(time: number): boolean {
  // Allow sub-millisecond rAF jitter without skipping a virtual display frame.
  if (nextVsync && time + 0.75 < nextVsync) return false;
  const interval = vsyncIntervalMs();
  nextVsync = !nextVsync || time > nextVsync + interval ? time + interval : nextVsync + interval;
  dispatchLooperFrames();
  flushVsyncWaiters();
  return true;
}
const dispatchVsync = driven(function* dispatchVsync(callback: JObj, time: bigint, presentation: bigint): Gen {
  rt.link("android/view/Choreographer$FrameData");
  rt.link("android/view/Choreographer$FrameTimeline");
  const data = new JFrameData(), timeline = data.timelines[0];
  data.time = timeline.id = time;
  // The browser exposes one predicted presentation, not Android's alternate timelines.
  timeline.presentation = presentation;
  data.active = timeline.active = true;
  try { yield vcall(callback, "onVsync", "(Landroid/view/Choreographer$FrameData;)V", data); }
  finally { data.active = timeline.active = false; }
});
export type FrameCallback = { frame?: unknown; run?: unknown; vsync?: JObj };
/** A Choreographer belongs to one looper, as getInstance() is per thread in AOSP. The main one's
 *  queue is the shell frame's (uiState.frameCallbacks); another's runs on its own thread at each
 *  vsync, so a render thread keeps its cadence while the main thread is busy or blocked. */
class JChoreographer extends JObj {
  readonly queue: FrameCallback[];
  frameTimeNanos = 0n;
  constructor(readonly looper: JLooper) { super(); this.queue = looper === mainLooper ? uiState.frameCallbacks : []; }
  // AOSP's own field, read reflectively by anything measuring frame pacing (Sentry, Matrix,
  // Flutter's FPS probe). It is the same nanos getFrameTimeNanos() answers.
  get mLastFrameTimeNanos(): bigint { return this.looper === mainLooper ? uiState.frameTimeNanos : this.frameTimeNanos; }
  post(cb: FrameCallback): void {
    this.queue.push(cb);
    if (this.looper !== mainLooper) pendingChoreographers.add(this);
  }
  remove(match: (cb: FrameCallback) => boolean): void {
    for (let i = this.queue.length; i-- > 0;) if (match(this.queue[i])) this.queue.splice(i, 1);
  }
}
const choreographers = new WeakMap<JLooper, JChoreographer>();
const pendingChoreographers = new Set<JChoreographer>();
/** the vsync of every choreographer off the main looper: its callbacks run as one message on its thread */
function dispatchLooperFrames(): void {
  if (!pendingChoreographers.size) return;
  const time = BigInt(Math.floor(guestNow() * 1e6)), presentation = time + device.frameIntervalNanos;
  for (const choreographer of pendingChoreographers) {
    const cbs = choreographer.queue.splice(0);
    choreographer.frameTimeNanos = time;
    void choreographer.looper.run(() => runFrameCallbacks(cbs, time, presentation));
  }
  pendingChoreographers.clear();
}
export const runFrameCallbacks = driven(function* runFrameCallbacks(cbs: FrameCallback[], time: bigint, presentation: bigint): Gen {
  for (const cb of cbs) {
    try {
      if (cb.frame) yield vcall(cb.frame, "doFrame", "(J)V", time);
      else if (cb.vsync) yield dispatchVsync(cb.vsync, time, presentation);
      else if (cb.run) yield vcall(cb.run, "run", "()V");
    } catch (e) { reportUncaught(e); }
  }
});
const nonNull = (cb: unknown): void => { if (cb == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "callback must not be null"); };
/** AOSP's marker for a record whose action is a FrameCallback rather than a Runnable */
let frameCallbackToken: JObj | null = null;
const FRAME_CALLBACK_TOKEN = () => frameCallbackToken ??= rt.make("java/lang/Object");
rt.register({
  name: "android/view/Choreographer", ctor: JChoreographer,
  fields: ["mLastFrameTimeNanos"],
  statics: { get FRAME_CALLBACK_TOKEN() { return FRAME_CALLBACK_TOKEN(); } },
  methods: {
    "postCallbackDelayedInternal(ILjava/lang/Object;Ljava/lang/Object;J)V": function (this: JChoreographer, _type: number, action: unknown, token: unknown, d: bigint) {
      const cb = token === FRAME_CALLBACK_TOKEN() ? { frame: action } : { run: action };
      if (d > 0n) setGuestTimeout(() => this.post(cb), Number(d)); else this.post(cb);
    },
    "static getInstance()Landroid/view/Choreographer;": () => {
      const looper = curThread.looper as JLooper | undefined;
      if (!looper) throw rt.mkThrowable("java/lang/IllegalStateException", "The current thread must have a looper!");
      let choreographer = choreographers.get(looper);
      if (!choreographer) choreographers.set(looper, choreographer = new JChoreographer(looper));
      return choreographer;
    },
    "postVsyncCallback(Landroid/view/Choreographer$VsyncCallback;)V": function (this: JChoreographer, cb: JObj) { nonNull(cb); this.post({ vsync: cb }); },
    "removeVsyncCallback(Landroid/view/Choreographer$VsyncCallback;)V": function (this: JChoreographer, cb: JObj) { nonNull(cb); this.remove((c) => c.vsync === cb); },
    "postFrameCallback(Landroid/view/Choreographer$FrameCallback;)V": function (this: JChoreographer, cb: unknown) { this.post({ frame: cb }); },
    "postFrameCallbackDelayed(Landroid/view/Choreographer$FrameCallback;J)V": function (this: JChoreographer, cb: unknown, d: bigint) {
      setGuestTimeout(() => this.post({ frame: cb }), Number(d));
    },
    "removeFrameCallback(Landroid/view/Choreographer$FrameCallback;)V": function (this: JChoreographer, cb: unknown) { this.remove((c) => c.frame === cb); },
    "postCallback(ILjava/lang/Runnable;Ljava/lang/Object;)V": function (this: JChoreographer, _type: number, r: unknown) { this.post({ run: r }); },
    "removeCallbacks(ILjava/lang/Runnable;Ljava/lang/Object;)V": function (this: JChoreographer, _type: number, r: unknown) { this.remove((c) => c.run === r); },
    "getFrameTimeNanos()J": function (this: JChoreographer) { return this.mLastFrameTimeNanos; },
  },
});
rt.register({ name: "android/view/Choreographer$FrameCallback", ctor: class extends JObj {}, methods: {
  "doFrame(J)V": () => { throw rt.mkThrowable("java/lang/AbstractMethodError", "android.view.Choreographer.FrameCallback.doFrame"); },
} });

// android.os.Environment: virtual storage paths (backed by our in-memory FS)
rt.register({
  name: "android/os/Environment", ctor: class extends JObj {},
  statics: { MEDIA_MOUNTED: "mounted", MEDIA_MOUNTED_READ_ONLY: "mounted_ro", MEDIA_UNMOUNTED: "unmounted", MEDIA_REMOVED: "removed", MEDIA_UNKNOWN: "unknown",
    DIRECTORY_DOWNLOADS: "Download", DIRECTORY_PICTURES: "Pictures", DIRECTORY_DCIM: "DCIM", DIRECTORY_MUSIC: "Music", DIRECTORY_MOVIES: "Movies", DIRECTORY_DOCUMENTS: "Documents" },
  methods: {
    "static getExternalStorageDirectory()Ljava/io/File;": () => newFile("/sdcard"),
    "static getExternalStoragePublicDirectory(Ljava/lang/String;)Ljava/io/File;": (t: string) => newFile("/sdcard/" + (t ?? "")),
    "static getDataDirectory()Ljava/io/File;": () => newFile("/data"),
    "static getRootDirectory()Ljava/io/File;": () => newFile("/system"),
    // the device's partitions, which AOSP's statics read from the environment its init sets
    "static getVendorDirectory()Ljava/io/File;": () => newFile("/vendor"),
    "static getOdmDirectory()Ljava/io/File;": () => newFile("/odm"),
    "static getOemDirectory()Ljava/io/File;": () => newFile("/oem"),
    "static getProductDirectory()Ljava/io/File;": () => newFile("/product"),
    "static getSystemExtDirectory()Ljava/io/File;": () => newFile("/system_ext"),
    "static getDownloadCacheDirectory()Ljava/io/File;": () => newFile("/cache"),
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
const rethrowAs = (cls: string) => function (this: JErrnoException) {
  const error = rt.mkThrowable(cls, errnoMessage.call(this)); error.cause = this; throw error;
};
rt.register({
  name: "android/system/ErrnoException", ctor: JErrnoException, sup: "java/lang/Exception",
  fields: ["errno", "functionName"],
  methods: {
    "<init>(Ljava/lang/String;I)V": initErrno,
    "<init>(Ljava/lang/String;ILjava/lang/Throwable;)V": initErrno,
    "getMessage()Ljava/lang/String;": errnoMessage,
    "rethrowAsIOException()Ljava/io/IOException;": rethrowAs("java/io/IOException"),
    "rethrowAsSocketException()Ljava/net/SocketException;": rethrowAs("java/net/SocketException"),
  },
});
export const errno = (fn: string, e: number) => { const x = rt.mkThrowable("android/system/ErrnoException", fn) as JErrnoException; initErrno.call(x, fn, e); return x; };
/** a path's file stat, null for a directory; ENOENT for neither */
const existing = (fn: string, path: string) => { const st = vfs.stat(path); if (!st && !vfs.isDir(path)) throw errno(fn, 2); return st; };
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
export const FD = "Ljava/io/FileDescriptor;";
function statOf(size: number, mode: number, mtimeMs: number): JStructStat {
  const s = new JStructStat();
  s.st_mode = mode;
  s.st_size = BigInt(size);
  s.st_mtime = s.st_atime = s.st_ctime = BigInt(Math.floor(mtimeMs / 1000));
  s.st_blocks = (s.st_size + 511n) / 512n;
  return s;
}
const storageStatVfs = driven(function* storageStatVfs(): Gen<JStructStatVfs> {
  const { total, free } = yield storageEstimate();
  const s = new JStructStatVfs();
  s.f_bsize = s.f_frsize = BLK;
  s.f_blocks = BigInt(Math.floor(total / Number(BLK)));
  s.f_bfree = s.f_bavail = BigInt(Math.floor(free / Number(BLK)));
  s.f_namemax = 255n;
  return s;
});
// libcore.io.Linux: the syscalls behind android.system.Os and Libcore.os, over the descriptor
// table native code shares
const linux: Record<string, (...args: never[]) => unknown> = {
    "open(Ljava/lang/String;II)Ljava/io/FileDescriptor;": (path: string, flags: number) => {
      if (path === null) rt.npe();
      const fd = javaOpenFd(path, flags);
      if (fd < 0) throw errno("open", -fd);
      return mkFd(fd);
    },
    [`fstat(${FD})Landroid/system/StructStat;`]: (d: JObj | null) => {
      const st = javaFdStat(fdInt(d));
      if (!st) throw errno("fstat", E.BADF);
      return statOf(st.size, st.mode, st.path ? vfs.mtime(st.path) : 0);
    },
    [`readBytes(${FD}Ljava/lang/Object;II)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      readBytes("read", buffer, offset, count, (target) => javaReadFd(fdInt(d), target)),
    [`preadBytes(${FD}Ljava/lang/Object;IIJ)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      readBytes("pread", buffer, offset, count, (target) => javaPreadFd(fdInt(d), target, Number(position))),
    [`writeBytes(${FD}Ljava/lang/Object;II)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      writeBytes(buffer, offset, count, (bytes) => ioResult("write", javaWriteFd(fdInt(d), bytes))),
    [`pwriteBytes(${FD}Ljava/lang/Object;IIJ)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      writeBytes(buffer, offset, count, (bytes) => ioResult("pwrite", javaPwriteFd(fdInt(d), bytes, Number(position)))),
    [`ftruncate(${FD}J)V`]: (d: JObj | null, length: bigint) => sys("ftruncate", javaTruncateFd(fdInt(d), Number(length))),
    [`fsync(${FD})V`]: (d: JObj | null) => sys("fsync", javaSyncFd(fdInt(d))),
    [`fdatasync(${FD})V`]: (d: JObj | null) => sys("fdatasync", javaSyncFd(fdInt(d))),
    [`ioctlInt(${FD}I)I`]: (d: JObj | null, request: number) => ioResult("ioctl", javaIoctlIntFd(fdInt(d), request)),
    [`fcntlInt(${FD}II)I`]: (d: JObj | null, cmd: number, arg: number) => ioResult("fcntl", javaFcntlFd(fdInt(d), cmd, arg)),
    [`fcntlVoid(${FD}I)I`]: (d: JObj | null, cmd: number) => ioResult("fcntl", javaFcntlFd(fdInt(d), cmd, 0)),
    [`android_fdsan_exchange_owner_tag(${FD}JJ)V`]: (d: JObj | null, expected: bigint, tag: bigint) =>
      fdsanExchangeOwnerTag(fdInt(d), expected, tag),
    [`android_fdsan_get_owner_tag(${FD})J`]: (d: JObj | null) => fdsanOwnerTag(fdInt(d)),
    "android_fdsan_get_tag_type(J)Ljava/lang/String;": (tag: bigint) => fdsanTagType(tag),
    "android_fdsan_get_tag_value(J)J": (tag: bigint) => fdsanTagValue(tag),
    // no descriptor here is a terminal
    [`isatty(${FD})Z`]: () => 0,
    "pipe2(I)[Ljava/io/FileDescriptor;": (flags: number) => {
      const [read, write] = javaPipeFds(flags);
      return after(mkFd(read), (r) => after(mkFd(write), (w) => jarray([r, w], FD)));
    },
    [`sendfile(${FD}${FD}Landroid/system/Int64Ref;J)J`]: (out: JObj | null, input: JObj | null, offset: JObj | null, count: bigint) => {
      const value = offset && declaredField("android/system/Int64Ref", "value");
      const start = value ? Number((offset as unknown as Record<string, bigint>)[value]) : 0;
      const n = count < 0n ? -1 : Math.min(Number(count), SENDFILE_CHUNK);
      if (n < 0 || start < 0) throw errno("sendfile", E.INVAL);
      if (!javaFdStat(fdInt(out))) throw errno("sendfile", E.BADF);
      const scratch = new Uint8Array(n), from = fdInt(input);
      return after(value ? javaPreadFd(from, scratch, start) : javaReadFd(from, scratch), (read) => {
        sys("sendfile", read);
        const written = read ? javaWriteFd(fdInt(out), scratch.subarray(0, read)) : 0;
        sys("sendfile", written);
        if (value) (offset as unknown as Record<string, bigint>)[value] = BigInt(start + written);
        return BigInt(written);
      });
    },
    [`lseek(${FD}JI)J`]: (d: JObj | null, off: bigint, whence: number) => {
      const r = javaSeekFd(fdInt(d), Number(off), whence);
      if (r < 0) throw errno("lseek", -r);
      return BigInt(r);
    },
    [`close(${FD})V`]: (d: JObj | null) => {
      if (d === null) return rt.npe();
      const fd = fdInt(d), owner = (d as unknown as Record<string, bigint | undefined>)[declaredField("java/io/FileDescriptor", "ownerId")];
      setFdInt(d, -1);
      sys("close", fdsanClose(fd, owner ?? 0n, javaCloseFd));
    },
    [`dup(${FD})${FD}`]: (d: JObj | null) => {
      const fd = javaDupFd(fdInt(d));
      if (fd < 0) throw errno("dup", -fd);
      return mkFd(fd);
    },
    [`mmap(JJII${FD}J)J`]: driven(function* (hint: bigint, count: bigint, prot: number, flags: number, d: JObj | null, offset: bigint): Gen {
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size <= 0 || offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER) || (offset & 4095n) !== 0n ||
          (prot & ~7) !== 0 || ((flags & 3) !== 1 && (flags & 3) !== 2) || (flags & 0x10) !== 0 && (hint & 4095n) !== 0n)
        throw errno("mmap", E.INVAL);
      if (flags & 0x10) throw errno("mmap", E.NOTSUP);
      const anonymous = !!(flags & 0x20), fd = anonymous ? -1 : fdInt(d);
      const source = anonymous ? null : javaFdSource(fd);
      if (!anonymous && !source) throw errno("mmap", E.BADF);
      if (source && prot === 0) throw errno("mmap", E.NOTSUP);
      const file = flags & 1 ? fdFile(fd) : null;
      if (flags & 1 && prot & 2 && !file) throw errno("mmap", E.NOTSUP);
      const address = mem.mapVa(size, prot === 0);
      if (!address) throw errno("mmap", E.NOMEM);
      try {
        if (source && prot) mem.write(guestAt(address), yield readFully(source, Number(offset), size));
      } catch {
        mem.unmapVa(BigInt(address), size);
        throw errno("mmap", E.IO);
      }
      if (file) trackSharedMap(BigInt(address), size, Number(offset), file, (prot & 2) !== 0);
      return BigInt(address);
    }),
    "munmap(JJ)V": (address: bigint, count: bigint) => {
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size <= 0 || address & 4095n) throw errno("munmap", E.INVAL);
      syncShared(address, size, true);
      if (!mem.unmapVa(address, size)) throw errno("munmap", E.INVAL);
    },
    "gettid()I": () => threadTid(curThread),
    "getenv(Ljava/lang/String;)Ljava/lang/String;": (key: string) => {
      if (key === null) rt.npe();
      return processEnv[key] ?? null;
    },
    "getpid()I": () => PROCESS_PID,
    "uname()Landroid/system/StructUtsname;": () => {
      const info = new JStructUtsname();
      info.machine = is64BitProcess() ? "aarch64" : "armv7l";
      return info;
    },
    "sysconf(I)J": (name: number) => BigInt(sysconf(name)),
    "stat(Ljava/lang/String;)Landroid/system/StructStat;": (path: string) => {
      const st = existing("stat", path);
      return statOf(st?.size ?? 0, st ? 0o100644 : 0o40755, vfs.mtime(path));
    },
    // the VFS keeps no permission bits: an existing file takes any mode
    "chmod(Ljava/lang/String;I)V": (path: string) => {
      if (path === null) rt.npe();
      existing("chmod", path);
    },
    "statvfs(Ljava/lang/String;)Landroid/system/StructStatVfs;": (path: string) => {
      existing("statvfs", path);
      return storageStatVfs();
    },
    [`fstatvfs(${FD})Landroid/system/StructStatVfs;`]: (d: JObj | null) => {
      if (fdInt(d) < 0) throw errno("fstatvfs", E.BADF);
      return storageStatVfs();
    },
    "readlink(Ljava/lang/String;)Ljava/lang/String;": () => { throw errno("readlink", 22); },
    "access(Ljava/lang/String;I)Z": (path: string, mode: number) => { if (path === null) rt.npe(); sys("access", accessPath(null, path, mode)); return 1; },
    "remove(Ljava/lang/String;)V": (path: string) => { if (path === null) rt.npe(); sys("remove", removePath(null, path)); },
    "rename(Ljava/lang/String;Ljava/lang/String;)V": (from: string, to: string) => {
      if (from === null || to === null) rt.npe();
      sys("rename", renamePath(null, from, to));
    },
};
/** a -errno result as the ErrnoException libcore's Os methods throw */
export function sys(fn: string, result: number): void { if (result < 0) throw errno(fn, -result); }
export const ioResult = (fn: string, result: number): number => { sys(fn, result); return result; };
/** sendfile moves at most this much a call, which its callers loop over as Linux allows */
const SENDFILE_CHUNK = 1 << 20;
/** the Object readBytes and its kin take: a byte[], or a direct ByteBuffer addressed from its start */
export type IoBuffer = Int8Array | JBuffer | null;
export function ioRegion(buffer: IoBuffer, offset: number, count: number): Uint8Array {
  if (buffer === null) return rt.npe();
  const view = isBuffer(buffer) ? bufferBytes(buffer) : buffer;
  checkFromIndexSize(offset, count, view.byteLength, "java/lang/ArrayIndexOutOfBoundsException");
  return new Uint8Array(view.buffer, view.byteOffset + offset, count);
}
/** the bytes to write, once a mapped direct buffer's pages are in */
export function writeBytes<T>(buffer: IoBuffer, offset: number, count: number, write: (bytes: Uint8Array) => T): T | Promise<T> {
  return after(isBuffer(buffer) ? resident(buffer) : null, () => write(ioRegion(buffer, offset, count)));
}
/** A direct buffer may live in guest memory, which can move while a read waits: it takes the
 *  bytes once they have arrived. */
export function readBytes(fn: string, buffer: IoBuffer, offset: number, count: number, read: (target: Uint8Array) => number | Promise<number>) {
  const target = ioRegion(buffer, offset, count);
  if (!isBuffer(buffer)) return after(read(target), (n) => ioResult(fn, n));
  const scratch = new Uint8Array(count);
  return after(read(scratch), (n) => {
    if (n > 0) ioRegion(buffer, offset, n).set(scratch.subarray(0, n));
    return ioResult(fn, n);
  });
}
rt.registerJnis("libcore/io/Linux", linux);
// Android interrupts threads blocked on the descriptor; a reader parked on a pipe here stays parked
rt.registerJni("libcore/io/AsynchronousCloseMonitor", `signalBlockedThreads(${FD})V`, () => {});

// java.io.UnixFileSystem: java.io.File's natives over the VFS. It keeps no permission bits and
// no hard links, so a mode change on an existing path succeeds, as chmod does above.
const BA_EXISTS = 1, BA_REGULAR = 2, BA_DIRECTORY = 4;
const unixFileSystem: Record<string, (...args: never[]) => unknown> = {
  "initIDs()V": () => {},
  "canonicalize0(Ljava/lang/String;Z)Ljava/lang/String;": (path: string) => vfs.norm(path),
  "getBooleanAttributes0(Ljava/lang/String;)I": (path: string) => {
    const p = vfs.norm(path);
    return vfs.isDir(p) ? BA_EXISTS | BA_DIRECTORY : vfs.exists(p) ? BA_EXISTS | BA_REGULAR : 0;
  },
  "list0(Ljava/io/File;)[Ljava/lang/String;": (file: JObj) => {
    const p = pathOf(file);
    return vfs.isDir(p) ? jarray(vfs.list(p), "Ljava/lang/String;") : null;
  },
  "createFileExclusively0(Ljava/lang/String;)Z": (path: string) => {
    const r = createPath(null, path);
    if (r === -E.EXIST) return 0;
    // JNU_ThrowIOExceptionWithLastError: an IOException carrying strerror
    if (r < 0) throw rt.mkThrowable("java/io/IOException", ERRSTR[-r] ?? path);
    return 1;
  },
  "createDirectory0(Ljava/io/File;)Z": (file: JObj) => +(mkdirPath(null, pathOf(file)) === 0),
  "getLastModifiedTime0(Ljava/io/File;)J": (file: JObj) => BigInt(vfs.mtime(pathOf(file))),
  "setLastModifiedTime0(Ljava/io/File;J)Z": (file: JObj, ms: bigint) => {
    const p = pathOf(file);
    if (!vfs.exists(p)) return 0;
    vfs.mtimes.set(p, Number(ms)); return 1;
  },
  "setPermission0(Ljava/io/File;IZZ)Z": (file: JObj) => +vfs.exists(pathOf(file)),
  "setReadOnly0(Ljava/io/File;)Z": (file: JObj) => +vfs.exists(pathOf(file)),
  // FileSystem.SPACE_TOTAL, SPACE_FREE, SPACE_USABLE
  "getSpace0(Ljava/io/File;I)J": driven(function* (_file: JObj, kind: number): Gen {
    const s: JStructStatVfs = yield storageStatVfs();
    return kind === 0 ? s.f_blocks * s.f_frsize : kind === 1 ? s.f_bfree * s.f_frsize : s.f_bavail * s.f_bsize;
  }),
  "getNameMax0(Ljava/lang/String;)J": () => 255n,
};
rt.registerJnis("java/io/UnixFileSystem", unixFileSystem);

// sun.nio.fs.UnixNativeDispatcher (UnixNativeDispatcher.c): java.nio.file's syscalls over the VFS.
// Paths arrive as NUL-terminated strings in native memory; failures throw UnixException(errno).
// The VFS has no symbolic or hard links and keeps no permission bits, as the libc above.
// UnixException's fillInStackTrace records nothing, so none is captured
const unixError = (e: number) => {
  const x = rt.make("sun/nio/fs/UnixException");
  x[declaredField("sun/nio/fs/UnixException", "errno")] = e;
  return x;
};
const unixSys = (result: number): number => { if (result < 0) throw unixError(-result); return result; };
const cpath = (address: bigint) => mem.cstr(mem.txVa(BigInt.asUintN(64, address)));
const bytesOf = (s: string) => i8(utf8.enc.encode(s));
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, AT_FDCWD = -100, AT_REMOVEDIR = 0x200;
/** a name relative to directory descriptor `dfd`, as the *at calls resolve it */
function atPath(dfd: number, address: bigint): string {
  const name = cpath(address);
  if (name.startsWith("/") || dfd === AT_FDCWD) return name;
  const st = javaFdStat(dfd);
  if (!st) throw unixError(E.BADF);
  if ((st.mode & S_IFMT) !== S_IFDIR || st.path === null) throw unixError(E.NOTDIR);
  return st.path + "/" + name;
}
const ATTR_FIELDS = ["st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size",
  "st_atime_sec", "st_atime_nsec", "st_mtime_sec", "st_mtime_nsec", "st_ctime_sec", "st_ctime_nsec"] as const;
let attrProps: string[] | undefined;
function fillAttrs(attrs: JObj, path: string, mode: number, size: number): void {
  const a = attrs as unknown as Record<string, number | bigint>;
  const p = attrProps ??= ATTR_FIELDS.map((name) => declaredField("sun/nio/fs/UnixFileAttributes", name));
  const ms = vfs.mtime(path), sec = BigInt(Math.floor(ms / 1000)), nsec = BigInt((ms % 1000) * 1e6);
  a[p[0]] = mode; a[p[1]] = BigInt(inoOf(path)); a[p[2]] = 1n; a[p[3]] = 1; a[p[4]] = a[p[5]] = procIdentity.uid; a[p[6]] = BigInt(size);
  for (let i = 7; i < 13; i += 2) { a[p[i]] = sec; a[p[i + 1]] = nsec; }
}
/** stat(2) of a path: a directory, or a file (procfs included) */
function statPath(path: string, attrs: JObj | null): number {
  const p = vfs.norm(path), dir = vfs.isDir(p), st = dir ? null : vfs.stat(p);
  if (!dir && !st) throw unixError(E.NOENT);
  const mode = dir ? S_IFDIR | 0o755 : S_IFREG | 0o644;
  if (attrs) fillAttrs(attrs, p, mode, dir ? 4096 : st!.size);
  return mode;
}
function unlinkPath(path: string): void {
  const p = vfs.norm(path);
  if (vfs.isDir(p)) throw unixError(E.ISDIR);
  if (!vfs.delete(p)) throw unixError(E.NOENT);
}
function rmdirPath(path: string): void {
  const p = vfs.norm(path);
  if (!vfs.isDir(p)) throw unixError(vfs.exists(p) ? E.NOTDIR : E.NOENT);
  if (vfs.list(p).length) throw unixError(E.NOTEMPTY);
  vfs.rmdir(p);
}
/** utimes(2): times in microseconds; the VFS keeps modification times only */
function setTimes(path: string, modified: bigint): void {
  const p = vfs.norm(path);
  if (!vfs.exists(p)) throw unixError(E.NOENT);
  vfs.mtimes.set(p, Number(modified / 1000n));
}
/** chown(2) as an app's uid may: to its own ids, or -1 to keep one */
function chownPath(path: string, uid: number, gid: number): void {
  statPath(path, null);
  if (![-1, procIdentity.uid].includes(uid) || ![-1, procIdentity.uid].includes(gid)) throw unixError(E.PERM);
}
const fdPath = (fd: number): string => { const st = javaFdStat(fd); if (!st) throw unixError(E.BADF); return st.path ?? ""; };
/** open DIR streams: the entries as readdir(3) returns them, and the descriptor closedir closes */
const dirStreams = new Map<bigint, { names: string[]; i: number; fd: number }>();
let nextDir = 0n;
function openDirStream(path: string, fd: number): bigint {
  const p = vfs.norm(path);
  if (!vfs.isDir(p)) throw unixError(vfs.exists(p) ? E.NOTDIR : E.NOENT);
  dirStreams.set(++nextDir, { names: [".", "..", ...vfs.list(p)], i: 0, fd });
  return nextDir;
}
const passwdName = (id: number) => bytesOf(appUserName(id));
const unixNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  // SUPPORTS_OPENAT | SUPPORTS_FUTIMES: bionic has openat64, fstatat64, unlinkat, renameat, futimesat
  // and fdopendir. UnixException is initialized first, since the natives throw it synchronously.
  "init()I": () => after(rt.initClass(rt.link("sun/nio/fs/UnixException")), () => 6),
  "getcwd()[B": () => bytesOf("/"),
  "strerror(I)[B": (e: number) => bytesOf(ERRSTR[e] ?? `Unknown error ${e}`),
  "dup(I)I": (fd: number) => unixSys(javaDupFd(fd)),
  "open0(JII)I": (path: bigint, flags: number) => unixSys(javaOpenFd(cpath(path), flags)),
  "openat0(IJII)I": (dfd: number, path: bigint, flags: number) => unixSys(javaOpenFd(atPath(dfd, path), flags)),
  "close(I)V": (fd: number) => { unixSys(javaCloseFd(fd)); },
  "link0(JJ)V": () => { throw unixError(E.PERM); },
  "symlink0(JJ)V": () => { throw unixError(E.PERM); },
  "unlink0(J)V": (path: bigint) => unlinkPath(cpath(path)),
  "unlinkat0(IJI)V": (dfd: number, path: bigint, flags: number) => (flags & AT_REMOVEDIR ? rmdirPath : unlinkPath)(atPath(dfd, path)),
  "rename0(JJ)V": (from: bigint, to: bigint) => { unixSys(renamePath(null, cpath(from), cpath(to))); },
  "renameat0(IJIJ)V": (fromDir: number, from: bigint, toDir: number, to: bigint) => { unixSys(renamePath(null, atPath(fromDir, from), atPath(toDir, to))); },
  "mkdir0(JI)V": (path: bigint) => { unixSys(mkdirPath(null, cpath(path))); },
  "rmdir0(J)V": (path: bigint) => rmdirPath(cpath(path)),
  // an existing path is never a link
  "readlink0(J)[B": (path: bigint) => { statPath(cpath(path), null); throw unixError(E.INVAL); },
  "realpath0(J)[B": (path: bigint) => { const p = vfs.norm(cpath(path)); statPath(p, null); return bytesOf(p); },
  "stat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => { statPath(cpath(path), attrs); },
  "lstat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => { statPath(cpath(path), attrs); },
  "stat1(J)I": (path: bigint) => { try { return statPath(cpath(path), null); } catch { return 0; } },
  "fstatat0(IJILsun/nio/fs/UnixFileAttributes;)V": (dfd: number, path: bigint, _flag: number, attrs: JObj) => { statPath(atPath(dfd, path), attrs); },
  "fstat(ILsun/nio/fs/UnixFileAttributes;)V": (fd: number, attrs: JObj) => {
    const st = javaFdStat(fd);
    if (!st) throw unixError(E.BADF);
    fillAttrs(attrs, st.path ?? "", st.mode, (st.mode & S_IFMT) === S_IFDIR ? 4096 : st.size);
  },
  "chmod0(JI)V": (path: bigint) => { statPath(cpath(path), null); },
  "fchmod(II)V": (fd: number) => { fdPath(fd); },
  "chown0(JII)V": (path: bigint, uid: number, gid: number) => chownPath(cpath(path), uid, gid),
  "lchown0(JII)V": (path: bigint, uid: number, gid: number) => chownPath(cpath(path), uid, gid),
  "fchown(III)V": (fd: number, uid: number, gid: number) => chownPath(fdPath(fd), uid, gid),
  "utimes0(JJJ)V": (path: bigint, _accessed: bigint, modified: bigint) => setTimes(cpath(path), modified),
  "futimes(IJJ)V": (fd: number, _accessed: bigint, modified: bigint) => setTimes(fdPath(fd), modified),
  "opendir0(J)J": (path: bigint) => openDirStream(cpath(path), -1),
  "fdopendir(I)J": (fd: number) => openDirStream(fdPath(fd), fd),
  "closedir(J)V": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    dirStreams.delete(dir);
    if (stream.fd >= 0) unixSys(javaCloseFd(stream.fd));
  },
  "readdir(J)[B": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    return stream.i < stream.names.length ? bytesOf(stream.names[stream.i++]) : null;
  },
  "access0(JI)V": (path: bigint, mode: number) => { unixSys(accessPath(null, cpath(path), mode)); },
  "exists0(J)Z": (path: bigint) => +(accessPath(null, cpath(path), 0) === 0),
  "getpwuid(I)[B": passwdName,
  "getgrgid(I)[B": passwdName,
  "statvfs0(JLsun/nio/fs/UnixFileStoreAttributes;)V": driven(function* (path: bigint, attrs: JObj): Gen {
    statPath(cpath(path), null);
    const s: JStructStatVfs = yield storageStatVfs(), a = attrs as unknown as Record<string, bigint>;
    const f = (name: string) => declaredField("sun/nio/fs/UnixFileStoreAttributes", name);
    a[f("f_frsize")] = s.f_frsize; a[f("f_blocks")] = s.f_blocks; a[f("f_bfree")] = s.f_bfree; a[f("f_bavail")] = s.f_bavail;
  }),
};
rt.registerJnis("sun/nio/fs/UnixNativeDispatcher", unixNativeDispatcher);
// LinuxNativeDispatcher.c: the VFS stores no extended attributes, and its only mount table would be
// a file some app wrote (there is no /proc/mounts)
const mountTables = new Map<bigint, string[][]>();
let nextMountTable = 0n;
const linuxNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  "init()V": () => {},
  "flistxattr(IJI)I": (fd: number) => { fdPath(fd); return 0; },
  "fgetxattr0(IJJI)I": (fd: number) => { fdPath(fd); throw unixError(OS_CONSTANTS.ENODATA); },
  "fremovexattr0(IJ)V": (fd: number) => { fdPath(fd); throw unixError(OS_CONSTANTS.ENODATA); },
  "fsetxattr0(IJJI)V": (fd: number) => { fdPath(fd); throw unixError(OS_CONSTANTS.EOPNOTSUPP); },
  "setmntent0(JJ)J": (path: bigint) => {
    const text = vfs.read(cpath(path));
    if (!text) throw unixError(E.NOENT);
    mountTables.set(++nextMountTable, utf8.dec.decode(text).split("\n").map((line) => line.trim().split(/\s+/)).filter((f) => f.length >= 4 && !f[0].startsWith("#")));
    return nextMountTable;
  },
  "getmntent(JLsun/nio/fs/UnixMountEntry;)I": (table: bigint, entry: JObj) => {
    const fields = mountTables.get(table)?.shift();
    if (!fields) return -1;
    const e = entry as unknown as Record<string, Int8Array>;
    ["name", "dir", "fstype", "opts"].forEach((name, i) => { e[declaredField("sun/nio/fs/UnixMountEntry", name)] = bytesOf(fields[i]); });
    return 0;
  },
  "endmntent(J)V": (table: bigint) => { mountTables.delete(table); },
};
rt.registerJnis("sun/nio/fs/LinuxNativeDispatcher", linuxNativeDispatcher);
// UnixCopyFile.c: read(2) and write(2) until the source's end, checking the cancel flag between reads
rt.registerJni("sun/nio/fs/UnixCopyFile", "transfer(IIJ)V", driven(function* (dst: number, src: number, cancel: bigint): Gen {
  const buffer = new Uint8Array(1 << 16);
  for (;;) {
    const n = unixSys(yield javaReadFd(src, buffer));
    if (!n) return;
    if (cancel && mem.ld32(mem.txVa(cancel))) throw unixError(OS_CONSTANTS.ECANCELED);
    for (let at = 0; at < n;) at += unixSys(javaWriteFd(dst, buffer.subarray(at, n)));
  }
}));
// libcore's OsConstants fills its fields from native initConstants(); these are the reference
// device's values (bun run gen-framework)
rt.registerJni("android/system/OsConstants", "initConstants()V", () => {
  const info = rt.link("android/system/OsConstants");
  for (const [name, value] of Object.entries(OS_CONSTANTS)) {
    const prop = info.staticFieldTable.get(name + ":I");
    if (prop) info.ctor[prop] = value;
  }
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
const runAsyncTask = driven(function* runAsyncTask(this: JAsyncTask, executor: unknown, params: unknown[]): Gen<JAsyncTask> {
  if (this.status !== 0) throw rt.mkThrowable("java/lang/IllegalStateException", "Task has already been executed");
  this.status = 1;
  let finish!: () => void;
  this.done = new Promise(resolve => { finish = resolve; });
  const pre = () => vcall(this, "onPreExecute", "()V");
  if (curThread === mainThread && inMainJob()) yield pre(); else yield onMain(pre);
  // a real Runnable: an executor's worker casts what it takes from its queue
  rt.link("webdroid/FnRunnable");
  const runnable = new JFnRunnable();
  runnable.fn = async () => {
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
  };
  yield vcall(executor, "execute", "(Ljava/lang/Runnable;)V", runnable);
  return this;
});
rt.register({
  name: "android/os/AsyncTask", ctor: JAsyncTask,
  statics: { THREAD_POOL_EXECUTOR: null, SERIAL_EXECUTOR: null },
  clinit: async () => {
    rt.link("android/os/AsyncTask$Status");
    const c = rt.link("android/os/AsyncTask").ctor as Record<string, unknown>, service = "Ljava/util/concurrent/ExecutorService;";
    c.s$THREAD_POOL_EXECUTOR = await scall("java/util/concurrent/Executors", "newFixedThreadPool", `(I)${service}`,
      Math.max(2, Math.min(globalThis.navigator?.hardwareConcurrency ?? 2, 4)));
    c.s$SERIAL_EXECUTOR = await scall("java/util/concurrent/Executors", "newSingleThreadExecutor", `()${service}`);
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
    ...noops("<init>()V"),
    ...stubs(null, "doInBackground([Ljava/lang/Object;)Ljava/lang/Object;"),
    "onCancelled(Ljava/lang/Object;)V": function (this: JAsyncTask) { return vcall(this, "onCancelled", "()V"); },
    "publishProgress([Ljava/lang/Object;)V": function (this: JAsyncTask, values: unknown[]) {
      if (!this.cancelled) void onMain(() => this.cancelled ? undefined : vcall(this, "onProgressUpdate", "([Ljava/lang/Object;)V", values)).catch(reportUncaught);
    },
    "get()Ljava/lang/Object;": driven(function* (this: JAsyncTask): Gen {
      if (!this.cancelled && this.done) yield this.done;
      if (this.cancelled) throw rt.mkThrowable("java/util/concurrent/CancellationException", null);
      if (this.error) throw yield newObj("java/util/concurrent/ExecutionException", "(Ljava/lang/Throwable;)V", this.error);
      return this.result;
    }),
    "static execute(Ljava/lang/Runnable;)V": (r: unknown) => vcall(serialTaskExecutor(), "execute", "(Ljava/lang/Runnable;)V", r),
  },
});

/** a Runnable over a JS closure, for framework code that must go through a Handler queue */
export class JFnRunnable extends JObj { fn: () => unknown = () => {}; }
rt.register({ name: "webdroid/FnRunnable", ctor: JFnRunnable, ifaces: ["java/lang/Runnable"], methods: { "run()V": function (this: JFnRunnable) { return this.fn(); } } });
