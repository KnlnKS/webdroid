import { afterEach, expect, test } from "bun:test";
import { Monitors } from "./monitor";
import { rt } from "./runtime";
import { DexFile } from "./dex";
import { Program } from "./reach";
import { analyseSuspend } from "./suspend";
import { mangleMethod } from "./abi";
import { JThread, curThread, mainThread, setCurThread, newObj, vcall } from "./natives/jlang";

const dex = new DexFile(new Uint8Array(await Bun.file(new URL("./fixtures/monitor.dex", import.meta.url)).arrayBuffer()));
rt.loadDex(dex);
let pause = () => Promise.resolve();
rt.jni.set("webdroid/MonitorFixture|pause()V", () => pause());
afterEach(() => setCurThread(mainThread));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("monitors enter immediately, preserve recursion, and transfer ownership in order", async () => {
  const monitors = new Monitors((name) => new Error(name)), obj = {}, a = {}, b = {}, c = {};
  expect(monitors.enter(obj, a)).toBeUndefined();
  expect(monitors.enter(obj, a)).toBeUndefined();
  const next = monitors.enter(obj, b), last = monitors.enter(obj, c);
  expect(next).toBeInstanceOf(Promise);
  monitors.exit(obj, a);
  expect(monitors.holds(obj, a)).toBe(true);
  expect(() => monitors.exit(obj, b)).toThrow("IllegalMonitorStateException");
  monitors.exit(obj, a);
  await next;
  expect(monitors.holds(obj, b)).toBe(true);
  monitors.exit(obj, b);
  await last;
  expect(monitors.holds(obj, c)).toBe(true);
  monitors.exit(obj, c);
  expect(() => monitors.enter(null, a)).toThrow("NullPointerException");
  expect(() => monitors.enter(0, a)).toThrow("NullPointerException");
  expect(() => monitors.notify(obj, a, true)).toThrow("IllegalMonitorStateException");
});

test("compiled monitor bytecode serializes lazy initialization across Java threads", async () => {
  const obj = await newObj("webdroid/MonitorFixture"), first = {}, second = {}, worker = new JThread();
  let resume!: () => void, calls = 0;
  pause = () => { calls++; return new Promise<void>((r) => { resume = r; }); };
  const one = vcall(obj, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", first);
  await flush();
  setCurThread(worker);
  const two = vcall(obj, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", second);
  await flush();
  expect(calls).toBe(1);
  resume();
  expect(await one).toBe(first);
  expect(await two).toBe(first);
  expect(calls).toBe(1);
  expect(rt.monitors.holds(obj, worker)).toBe(false);
});

test("compiled catch-all releases its monitor after an awaited exception on a worker", async () => {
  const obj = await newObj("webdroid/MonitorFixture"), worker = new JThread(), failure = rt.mkThrowable("java/lang/RuntimeException", "pause failed");
  let reject!: (reason: unknown) => void;
  pause = () => new Promise<void>((_resolve, fail) => { reject = fail; });
  setCurThread(worker);
  const failed = vcall(obj, "failing", "()V");
  const rejected = failed.catch((e: unknown) => e);
  await flush();
  expect(curThread).toBe(mainThread);
  const entered = rt.me(obj);
  expect(entered).toBeInstanceOf(Promise);
  reject(failure);
  expect(await rejected).toBe(failure);
  await entered;
  setCurThread(mainThread);
  expect(rt.monitors.holds(obj, mainThread)).toBe(true);
  rt.mx(obj);
});

test("monitor-enter is a suspending leaf in both compiler and call graph", async () => {
  const program = new Program(); program.add(dex);
  const key = "webdroid/MonitorFixture.enter(Ljava/lang/Object;)V";
  expect(analyseSuspend(program, [key], new Map(), () => false).has(key)).toBe(true);
  const ctor = (await newObj("webdroid/MonitorFixture")).constructor;
  const obj = {}, worker = new JThread();
  rt.me(obj);
  setCurThread(worker);
  let done = false;
  const entering = vcall(ctor, "enter", "(Ljava/lang/Object;)V", obj).then(() => { done = true; });
  await flush(); expect(done).toBe(false);
  setCurThread(mainThread); rt.mx(obj);
  await entering; expect(done).toBe(true);
  await expect(vcall(ctor, "enter", "(Ljava/lang/Object;)V", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});

test("Object.wait releases and reacquires full recursion depth before returning or interrupting", async () => {
  const obj = await newObj("java/lang/Object"), worker = new JThread();
  rt.me(obj); rt.me(obj);
  const waiting = vcall(obj, "wait", "()V");
  setCurThread(worker); expect(rt.me(obj)).toBeUndefined();
  await vcall(obj, "notify", "()V");
  let done = false; waiting.then(() => { done = true; });
  await flush(); expect(done).toBe(false);
  rt.mx(obj); await waiting;
  setCurThread(mainThread); rt.mx(obj);
  expect(rt.monitors.holds(obj, mainThread)).toBe(true);
  rt.mx(obj);

  setCurThread(worker); rt.me(obj); rt.me(obj);
  const interrupted = vcall(obj, "wait", "()V");
  let error: unknown;
  const caught = interrupted.catch((e: unknown) => { error = e; });
  setCurThread(mainThread); rt.me(obj);
  worker.interrupted = 1; worker.wake?.();
  await flush(); expect(error).toBeUndefined();
  rt.mx(obj); await caught;
  expect(error).toBeInstanceOf(rt.link("java/lang/InterruptedException").ctor);
  setCurThread(worker); rt.mx(obj);
  expect(rt.monitors.holds(obj, worker)).toBe(true);
  rt.mx(obj);
});

test("wait validates ownership and timeout and preserves a pre-interrupted lock", async () => {
  const obj = await newObj("java/lang/Object");
  await expect(vcall(obj, "wait", "(J)V", 1n)).rejects.toBeInstanceOf(rt.link("java/lang/IllegalMonitorStateException").ctor);
  rt.me(obj); rt.me(obj);
  await expect(vcall(obj, "wait", "(JI)V", 0n, 1000000)).rejects.toBeInstanceOf(rt.link("java/lang/IllegalArgumentException").ctor);
  const contender = new JThread();
  setCurThread(contender);
  const entering = rt.me(obj);
  setCurThread(mainThread);
  mainThread.interrupted = 1;
  await expect(vcall(obj, "wait", "()V")).rejects.toBeInstanceOf(rt.link("java/lang/InterruptedException").ctor);
  expect(mainThread.interrupted).toBe(0);
  expect(rt.monitors.holds(obj, mainThread)).toBe(true);
  expect(rt.monitors.holds(obj, contender)).toBe(false);
  rt.mx(obj); expect(rt.monitors.holds(obj, mainThread)).toBe(true);
  rt.mx(obj); await entering;
  setCurThread(contender); rt.mx(obj);
  setCurThread(mainThread); rt.me(obj);
  await vcall(obj, "wait", "(J)V", 1n);
  expect(rt.monitors.holds(obj, mainThread)).toBe(true);
  rt.mx(obj);
  expect(rt.nativeOracle()("java/lang/Object", "wait()V")).toBe(true);
});

test("notified string monitors remain mutually exclusive while waiters reacquire", async () => {
  const obj = "monitor string", other = new JThread();
  rt.me(obj);
  const methods = rt.link("java/lang/Object").ctor.prototype;
  const parked: Promise<void> = methods[mangleMethod("wait", "()V")].call(obj);
  setCurThread(other); rt.me(obj);
  methods[mangleMethod("notifyAll", "()V")].call(obj); rt.mx(obj);
  rt.me(obj);
  let done = false; parked.then(() => { done = true; });
  await flush(); expect(done).toBe(false);
  rt.mx(obj); await parked;
  setCurThread(mainThread); expect(rt.monitors.holds(obj, mainThread)).toBe(true); rt.mx(obj);
});
