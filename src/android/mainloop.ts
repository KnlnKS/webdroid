// libutils' Looper under android.os.MessageQueue. AOSP's Looper, MessageQueue, Handler and Message
// run from bytecode; a thread's Looper.loop parks in nativePollOnce until nativeWake, its timeout or
// a native callback posted to its looper, which runs there as a device Looper runs its fd callbacks.
//
// The main thread loops from boot. Host work (frames, input, broker requests) reaches it with
// onMain, as an asynchronous message on the main looper: it keeps its order with the app's own
// posts, and a sync barrier (an app may post one) holds it no more than it holds the input and
// vsync a device delivers as native callbacks.
import { rt, JObj, declaredField, type Gen } from "../jvm/runtime";
import { curThread, mainThread, scall, newObj, vcall, callOn, classNameOf, initClass, linkClass, type JThread } from "../jvm/natives/jentry";
import { dispatchUncaught, toThread, type Escape } from "../jvm/natives/jthrowable";
import { processExited } from "../process-exit";
import { handle, deref, release } from "./handles";
import { clearGuestTimeout, setGuestTimeout, uptimeMillis } from "../guest-clock";
import { perf } from "../perf";
import { turnElapsed, wakeSoon, yieldToLoop } from "../jvm/yield";
import { compileAhead } from "../jvm/tier";
import { note, Ev } from "../timeline";

/** depth: the main thread is outside nativePollOnce (dispatching), so a job it awaits must run
 *  inline */
export const mainDbg = { trace: false, running: "", started: 0, depth: 0, queued: 0 };

/** A thread may hold the JS thread this long between macrotask turns before its looper yields, so
 *  a message that keeps reposting itself cannot starve input or rendering. */
const SLICE_MS = 16;
/** how long the main thread waits before its idle time goes to compiling ahead */
const AHEAD_QUIET_MS = 100;

export class NativeLooper {
  private callbacks: (() => unknown)[] = [];
  private woken = false;
  private waiter: (() => void) | null = null;
  polling = false;
  /** the time of the vsync whose frame this looper is running, until it next waits for work: what
   *  the frame posts runs within it */
  frameAt = -Infinity;
  constructor(readonly thread: JThread) {}
  wake(): void { this.woken = true; this.signal(); }
  /** run `fn` on this looper's thread at its next poll, between messages */
  post(fn: () => unknown): void { this.callbacks.push(fn); this.signal(); }
  private signal(): void { const w = this.waiter; this.waiter = null; w?.(); }
  /** MessageQueue.nativePollOnce: synchronous on the main looper when nothing is due to wait for.
   *  Another looper yields between messages, so a busy background thread does not hold off the
   *  main thread (a device runs them on other cores); the main looper's own yield goes ahead of
   *  theirs, as its core would keep it going. */
  pollOnce(timeout: number): void | Promise<void> {
    if (!this.callbacks.length) {
      if (this.woken) { this.woken = false; return; }
      if (timeout === 0 && this === mainLooper && turnElapsed() <= SLICE_MS) return;
    }
    return this.poll(timeout);
  }
  private async poll(timeout: number): Promise<void> {
    const main = this === mainLooper;
    if (!this.callbacks.length && !this.woken) {
      this.polling = true;
      if (timeout !== 0) this.frameAt = -Infinity;
      if (main) { mainDbg.depth--; note(Ev.LoopIdle, timeout); }
      try { await (timeout === 0 ? main ? wakeSoon() : yieldToLoop() : this.idle(timeout)); }
      finally { this.polling = false; if (main) { mainDbg.depth++; note(Ev.LoopWake); } }
    }
    this.woken = false;
    for (const fn of this.callbacks.splice(0)) {
      try { await callOn(this.thread, fn); } catch (error) { await dispatchUncaught(this.thread, error); }
    }
  }
  private idle(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = timeout > 0 ? setGuestTimeout(() => this.signal(), timeout) : undefined;
      // a main thread that stays waiting has time for code its next messages will want
      const ahead = this === mainLooper && (timeout < 0 || timeout > 2 * AHEAD_QUIET_MS)
        ? setTimeout(() => compileAhead(() => this.waiter === waiter), AHEAD_QUIET_MS) : undefined;
      const waiter = this.waiter = () => { clearGuestTimeout(timer); clearTimeout(ahead); resolve(); };
    });
  }
}

rt.registerJnis("android/os/MessageQueue", {
  "nativeInit()J": () => handle(curThread.looper = new NativeLooper(curThread)),
  "nativeDestroy(J)V": (ptr: bigint) => {
    const looper = deref<NativeLooper>(ptr);
    if (looper.thread.looper === looper) looper.thread.looper = null;
    release(ptr);
  },
  "nativePollOnce(JI)V": function (this: JObj, ptr: bigint, timeout: number) { return deref<NativeLooper>(ptr).pollOnce(timeout); },
  "nativeWake(J)V": (ptr: bigint) => deref<NativeLooper>(ptr).wake(),
  "nativeIsPolling(J)Z": (ptr: bigint) => +deref<NativeLooper>(ptr).polling,
});

export let mainLooper: NativeLooper | undefined;
let mainHandlerObj: JObj | null = null, hostHandler: JObj | null = null, starting: Promise<void> | null = null;
const ready = Promise.withResolvers<void>();

/** ActivityThread.main's first and last steps: prepare the main looper, then loop on it for good.
 *  An exception escaping a message goes to the main thread's uncaught handler, whose default
 *  (KillApplicationHandler) ends the process; past an app's handler that returns, the loop goes
 *  on where a device's main thread would end. */
export function startMainLooper(): Promise<void> {
  return starting ??= (async () => callOn(mainThread, () => rt.drive(function* (): Gen<void> {
    // as after the zygote: System is initialized before the loop's first SystemClock read
    // initializes it, which would otherwise suspend inside the loop sharing this thread
    yield initClass("java/lang/System");
    yield scall("android/os/Looper", "prepareMainLooper", "()V");
    mainLooper = mainThread.looper as NativeLooper;
    const looper = yield scall("android/os/Looper", "getMainLooper", "()Landroid/os/Looper;");
    mainHandlerObj = yield newObj("android/os/Handler", "(Landroid/os/Looper;)V", looper);
    hostHandler = yield scall("android/os/Handler", "createAsync", "(Landroid/os/Looper;)Landroid/os/Handler;", looper);
    mainDbg.depth++;
    loop();
    ready.resolve();
  }())))();
}
function loop(): void {
  let looping: unknown;
  try { looping = callOn(mainThread, () => scall("android/os/Looper", "loop", "()V")); } catch (error) { looping = Promise.reject(error); }
  void Promise.resolve(looping).catch(async (error) => {
    await dispatchUncaught(mainThread, error);
    loop();
  });
}

/** the main thread's Handler, which View.post and the framework's managers post on */
function mainHandler(): JObj {
  if (!mainHandlerObj) throw new Error("the main looper has not started");
  return mainHandlerObj;
}

/** a Runnable over a JS closure, for host work that must go through a Handler queue */
class JFnRunnable extends JObj { fn: () => unknown = () => {}; }
rt.register({ name: "webdroid/FnRunnable", ctor: JFnRunnable, ifaces: ["java/lang/Runnable"], methods: { "run()V": function (this: JFnRunnable) { return this.fn(); } } });
export function fnRunnable(fn: () => unknown): JFnRunnable {
  linkClass("webdroid/FnRunnable");
  const r = new JFnRunnable(); r.fn = fn; return r;
}

/** Run `job` on the main thread after what is already queued there, once the zygote has started
 *  the main looper. A failed job rejects its own promise and leaves the looper running. */
export function onMain<T>(job: () => Promise<T> | T): Promise<T> {
  const site = mainDbg.trace ? new Error().stack ?? "" : "";
  mainDbg.queued++; perf.mainJobs++;
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      mainDbg.queued--;
      if (mainDbg.trace) { mainDbg.running = site; mainDbg.started = Date.now(); }
      try { resolve(await job()); } catch (error) { reject(error); }
    };
    // posting is itself a call into Java, as the main thread
    const post = () => { try { void Promise.resolve(callOn(mainThread, () => postRunnable(fnRunnable(run), 0, hostHandler!))).catch(reject); } catch (error) { reject(error); } };
    if (hostHandler) post(); else void ready.promise.then(post);
  });
}

/** onMain for a job no caller waits on: its exception escapes the main thread, where it ran */
export function postMain(job: () => unknown, escape: Escape = toThread(mainThread)): void {
  if (!processExited()) onMain(job).catch(escape);
}

/** Handler.postDelayed(r, delay ms) on the main handler unless another is named */
export const postRunnable = (r: unknown, delay = 0, handler = mainHandler()): unknown =>
  vcall(handler, "postDelayed", "(Ljava/lang/Runnable;J)Z", r, BigInt(Math.max(0, Math.ceil(delay))));

/** debug: the main queue's pending messages and the looper's wait state (wd.looperDump) */
export const looperDump = (): unknown => callOn(mainThread, () => rt.drive(function* (): Gen<unknown> {
  const queue = yield vcall(yield scall("android/os/Looper", "getMainLooper", "()Landroid/os/Looper;"), "getQueue", "()Landroid/os/MessageQueue;");
  const f = (cls: string, o: unknown, name: string) => (o as Record<string, unknown>)[declaredField(cls, name)];
  const M = "android/os/Message", messages: string[] = [];
  for (let m = f("android/os/MessageQueue", queue, "mMessages"); m && messages.length < 50; m = f(M, m, "next")) {
    const target = f(M, m, "target") as JObj | null, callback = f(M, m, "callback") as JObj | null;
    const cls = (o: JObj | null) => o ? classNameOf(o) ?? "?" : "null";
    messages.push(`when=${f(M, m, "when")} what=${f(M, m, "what")} flags=${f(M, m, "flags")} target=${cls(target)} callback=${cls(callback)}`);
  }
  const native = mainLooper as unknown as Record<string, unknown>;
  return { now: uptimeMillis(), blocked: f("android/os/MessageQueue", queue, "mBlocked"), barrierToken: f("android/os/MessageQueue", queue, "mNextBarrierToken"),
    polling: native.polling, woken: native.woken, waiting: native.waiter !== null, callbacks: (native.callbacks as unknown[]).length, depth: mainDbg.depth, messages };
}()));
