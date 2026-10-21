// Threads, monitors, waiting natives and class initialization waits on JSPI strands: the static int(int) cases of java/Th.java run on
// the JDK and the Wasm tier, and the pieces of the substrate that no Java case reaches are checked directly: natives that
// wait (async, generator, one that enters Java again), 1,000 suspended stacks, deep recursion off the main stack, and what happens to a native that
// answers a Promise or waits under a JS frame. Needs javac and java on PATH.
// Run: pnpm wasm threads [case,case,... | substrate]
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { world } from "./lib.ts";
import { cli } from "../args.ts";
import { mountPlatform, startProcess } from "./harness.ts";
import { nativeSource } from "../../src/wasm/host/nativesource.ts";
import { Natives } from "../../src/wasm/host/natives.ts";
import { suspendedNatives } from "../../src/wasm/host/suspend.ts";
import { driven, rt, type Gen } from "../../src/jvm/runtime.ts";
import { perf } from "../../src/perf.ts";
import { fnRunnable } from "../../src/android/mainloop.ts";
import type { HostFn, NativeSource } from "../../src/wasm/link/hostapi.ts";
import { emitRestored } from "../../src/wasm/compiler/hostcalls.ts";
import { hostLoop } from "../../src/wasm/host/boot.ts";
import type { HostLoop } from "../../src/wasm/link/sched.ts";
import { onNestedStrand, wasmEntry } from "../../src/wasm/host/entry.ts";
import { resumeAs } from "../../src/jvm/natives/jentry.ts";
import { javaFrames } from "../../src/wasm/compiler/exc.ts";
import { HEAP_LIMIT } from "../../src/jvm/abi.ts";
import { T } from "../../src/wasm/compiler/wasmbin.ts";
import { classIntrinsics } from "../../src/wasm/link/classes.ts";

import { CORE_PATHS, JAVA, ROOT } from "./paths.ts";
import { checker } from "./tools.ts";
import { fixture, jdkTool } from "../java.ts";
import { ALLOC_WINDOW } from "../../src/wasm/compiler/consts.ts";
import { deadline } from "../util.ts";

const out = fixture({ sources: [join(JAVA, "Th.java"), join(JAVA, "Ref.java")], release: 11, minApi: 34, classes: /^Th.*\.class$/ });

const dex = join(out, "classes.dex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** the host loop as a case makes it while it is `probe`: a yield always due, each counted, and answered by its `yield` rather than the host's */
type LoopProbe = { turns: number; yield?: HostLoop["yield"] };
let probe: LoopProbe | undefined;
const w = world([dex, ...CORE_PATHS], { natives: new Natives({
  ...nativeSource,
  find: (cls, key, isStatic, hasBody) => cls === "Th" ? TH[key] : nativeSource.find(cls, key, isStatic, hasBody),
} satisfies NativeSource), loop: { ...hostLoop, due: () => !!probe || hostLoop.due(), yield: (soon) => {
  if (probe) probe.turns++;
  return (probe?.yield ?? hostLoop.yield)(soon);
} } });
const admission: LoopProbe = { turns: 0 }, arithmetic: LoopProbe = { turns: 0, yield: () => Promise.resolve() };
const rejecting: LoopProbe = { turns: 0, yield: () => Promise.reject(new Error("admission timer rejected")) };
/** admission where another entry completes between the admission reaction and the engine's resume */
const idling: LoopProbe = { turns: 0, yield: (soon) => {
  const pending = hostLoop.yield(soon), then = pending.then.bind(pending);
  pending.then = ((done: (value: void) => unknown, failed?: (error: unknown) => unknown) => then(value => {
    const result = done(value); queueMicrotask(() => w.sched.idle()); return result;
  }, failed)) as typeof pending.then;
  return pending;
} };
/** host imports only this suite's generated code calls */
const extra = w.host as Record<string, Function>;
// the natives that wait together are resumed from one Promise, so their continuations run one after another before any of the stacks does
let gate: Promise<void> | null = null;
const ordered: (() => void)[] = [];
let callbackOwner: typeof rt.cur | null = null;
const TH: Record<string, HostFn> = {
  "admissionIdentity()I": () => +!w.sched.current().root,
  "orderedWait(I)I": async (x: number) => { await new Promise<void>(resolve => { ordered[x] = resolve; }); return x; },
  "delayedCallback(I)I": async (x: number) => {
    callbackOwner = rt.cur;
    return await rt.drive((function* () {
      yield Promise.resolve();
      return callbackEntry.scall("Th", "callbackLock", "(I)I", x);
    })());
  },
  "await(I)I": async (x: number) => { await sleep(1); return x + 1; },
  "driven(I)I": driven(function* (x: number): Gen<number> { const v: number = yield Promise.resolve(x * 3); return v + 1; }),
  "drivenEnters(I)I": driven(function* (x: number): Gen {
    const v: number = yield Promise.resolve(x), u: number = yield v + 1;
    return callbackEntry.scall("Th", "onDriven", "(I)I", u);
  }),
  // async to import it as Suspending (flagged owns the plain import's report); `after` runs before it waits, where an `await` would lose the thread
  "afterEnters(I)I": async (x: number) => callbackEntry.after(sleep(1).then(() => x + 2), (v) => callbackEntry.scall("Th", "onDriven", "(I)I", v)),
  "nested(I)I": async (x: number) => (await w.entryAsync("Th", "inner", "(I)I")(x) as number) + 1,
  "flagged(I)I": (x: number) => Promise.resolve(x),
  "gapEcho([BI)[B": async (a: Int8Array, ms: number) => { await (gate ??= sleep(20 + ms).then(() => { gate = null; })); const r = Int8Array.from(a).reverse(); a[0] = a[0] + 1; return r; },
  "gapAlias([B[BZ)I": async (a: Int8Array, b: Int8Array, fail: boolean) => { await sleep(1); a[0] += 2; b[0] += 1; if (fail) throw rt.mkThrowable("java/lang/IllegalArgumentException", "array changed"); return a === b ? 9 : -1; },
  "viaJs(I)I": (x: number) => w.entry("Th", "trap", "(I)I")(x),
};
const gaps: string[] = [];
w.onGap = (gap) => gaps.push(gap);
await mountPlatform(ROOT);
await startProcess(w);
const callbackEntry = wasmEntry(w);

const suite = checker("threads");
const show = async (f: () => unknown) => { try { return String(await deadline(Promise.resolve(f()), Number(process.env.J2W_TIMEOUT ?? 60000))); } catch (e) { const t = w.throwable(e); return t ? "java " + w.classNameOf(t) : "throw " + String(e).slice(0, 100); } };
const expect = (what: string, got: unknown, want: unknown) => suite.check(what, String(got), String(want));

// ---------- the Java cases against the JDK
const only = cli("pnpm wasm threads [case,case,... | substrate]", {}).positionals[0]?.split(","), substrate = !only || only.includes("substrate");
if (substrate || only?.includes("nativeCallback")) {
  expect("native callback after a wait reenters its caller's monitor", await show(() => callbackEntry.scall("Th", "callbackOwner", "(I)I", 41)), "42");
  expect("settled native callback releases its strand", w.sched.strands.filter(Boolean).length, 1);
  const previous = rt.cur;
  resumeAs(callbackOwner!);
  try { expect("a callback token of an ended native is not reused", onNestedStrand(w, s => s.parent), null); }
  finally { resumeAs(previous); }
  for (const order of [[0, 1], [1, 0]]) {
    ordered.length = 0;
    const waits = [w.entryAsync("Th", "orderedWait", "(I)I")(0), w.entryAsync("Th", "orderedWait", "(I)I")(1)];
    // an entry reaches its native only once what it links first has settled
    while (!ordered[0] || !ordered[1]) await new Promise(r => setTimeout(r, 0));
    expect("unrelated host entry does not borrow a waiting native", onNestedStrand(w, s => s.parent), null);
    ordered[order[0]](); await waits[order[0]];
    expect("first settlement keeps the second native live", w.sched.strands.filter(Boolean).length, 2);
    ordered[order[1]](); await waits[order[1]];
    expect("settlement does not restore an ended native", onNestedStrand(w, s => s.parent), null);
  }
}
if (!only || only.includes("loopTrace")) {
  const m = { ...w.prog.resolve("Th", "loopTrace", "(I)I")!, cls: "legal/Owner#loop", name: "method#loop", key: "method#loop(I)I" };
  const name = "legal/Owner#loop.method#loop(I)I", traces = new Map([[name, { name, m, offsets: new Int32Array([16, 32]), pcs: new Int32Array([0, 8500]) }]]);
  const root = `at ${name} (wasm://wasm/a:wasm-function[1]:0x10)`;
  expect("legal #loop name has an exact Java trace", javaFrames(root, traces, Infinity, false)[0]?.method, "method#loop");
  const frames = javaFrames(`at ${name}#loop12 (wasm://wasm/a:wasm-function[2]:0x20)\n${root}\n${root}`, traces, Infinity, false);
  expect("only the generated suffix coalesces its root", frames.length, 2);
  expect("the chunk retains its owner's innermost PC", frames[0]?.pc, 8500);
}
const CASES: [string, number][] = [
  ["reentrant", 5], ["deepLock", 300], ["deepLock", 10], ["imse", 0], ["contend", 200], ["pingPong", 30], ["notifyOne", 0], ["timedWait", 0],
  ["startJoin", 100], ["names", 3], ["names", 4], ["sleepOrder", 0], ["interruptSleep", 0], ["interruptWait", 0], ["interruptFlag", 0], ["joinTimeout", 0], ["uncaught", 4],
  ["states", 0], ["threadLocals", 7], ["spin", 0], ["spinStep", 0], ["spinTest", 0], ["parkUnpark", 0], ["permit", 0], ["parkNanos", 0], ["parkInterrupt", 0],
  ["executor", 0], ["chm", 300], ["latch", 0], ["lockCondition", 20], ["queue", 30], ["semaphore", 0], ["future", 21], ["timeout", 0], ["scheduled", 0], ["completable", 4],
  ["manyThreads", 100], ["atomics", 300], ["initRace", 0], ["initCycle", 0], ["initFail", 0], ["stackOverflow", 0], ["stackOverflowDeep", 0], ["linkDeep", 0], ["fuelProgress", 0], ["fuelOverflow", 0], ["loopState", 0], ["loopTrace", 0],
].filter(([n]) => !only || only.includes(n as string)) as [string, number][];
if (!CASES.length) CASES.push(["reentrant", 3]);
// a case that deadlocks the JDK is a bug in the case
const ref = spawnSync(jdkTool("java"), ["-Xss512k", "-cp", out, "Ref"], { input: CASES.map(([n, a]) => `Th.${n} ${a}`).join("\n") + "\n", timeout: 120000, encoding: "utf8" });
if (ref.status !== 0) throw new Error(`the JDK run failed (${ref.error ?? ref.stderr})`);
const jdk = ref.stdout.trim().split("\n");
for (const [i, [name, arg]] of CASES.entries()) {
  const gapsBefore = gaps.length, want = jdk[i] === "throw" ? "throw" : jdk[i];
  if (process.env.J2W_V) console.log("case", name, arg);
  const wasm = await show(() => w.entryAsync("Th", name, "(I)I")(arg));
  if (process.env.J2W_V) console.log("  wasm", wasm);
  const norm = (v: string) => v.startsWith("java ") || v.startsWith("throw ") ? "throw" : v;
  if (!suite.check(`Th.${name}(${arg}) (${wasm})`, norm(wasm), want) && gaps.length > gapsBefore) console.log("  gaps: " + [...new Set(gaps.slice(gapsBefore))].join("; "));
}

// ---------- the substrate, directly
if (substrate) {
  for (const mode of ["bridge", "full", "recovered"] as const) {
    let full = false, turns = 0, bridge = 0;
    const heap = world(w.prog, { bare: true, heapUsed: () => full ? HEAP_LIMIT + 1 : 0, collect: () => {}, loop: {
      ...hostLoop, after: (ms, run) => hostLoop.after(ms, () => { turns++; if (mode === "recovered") full = false; run(); }),
    } });
    heap.bridge.toJava(new Int8Array(1), "[B");
    (heap.host as Record<string, Function>).heapBridge = () => { heap.bridge.toJava(new Int8Array(ALLOC_WINDOW), "[B"); };
    const allocate = heap.helpers.hostFn("substrate:heap:" + mode, [], "V", (cx, c) => {
      if (mode === "bridge") c.call(bridge);
      else { cx.emitNewArray(c, "[B", () => c.i32(ALLOC_WINDOW)); c.drop(); }
    }, cx => { bridge = cx.mb.importFunc("host", "heapBridge", cx.sig([], "V")); });
    const strand = heap.sched.strand();
    full = true;
    let result = "allocated";
    try { await strand.call(allocate); }
    catch (error) { const throwable = heap.throwable(error); result = throwable ? heap.classNameOf(throwable) : String(error); }
    finally { strand.end(); }
    expect(`${mode} heap pressure result`, result, mode === "recovered" ? "allocated" : "java/lang/OutOfMemoryError");
    expect(`${mode} heap pressure finalizer turns`, turns, mode === "bridge" ? 0 : mode === "full" ? 2 : 1);
    expect(`${mode} heap pressure releases its strand`, heap.sched.strands.filter(Boolean).length, 1);
  }
  const importStrand = w.sched.strand(w.sched.hostThread()), globals = w.rtImports();
  try {
    await importStrand.call(w.helpers.hostFn("substrate:import-thread", [], "L", (cx, c) => cx.callRt(c, "curThread")));
    for (const mode of ["immediate", "rejected", "interposed"] as const) {
      const deferred = mode !== "immediate";
      const error = new Error("suspending import failure");
      let fail = 0, prepare = 0, caught = 0;
      extra.importThrowPrepare = () => { globals.depth.value = 23; };
      extra.importThrow = w.sched.suspending(() => {
        if (!deferred) throw error;
        const p = Promise.reject(error);
        if (mode === "interposed") {
          const then = p.then.bind(p);
          p.then = ((ok, failed) => then(ok, e => {
            try { return failed!(e); }
            finally { queueMicrotask(() => w.sched.idle()); }
          })) as typeof p.then;
        }
        return p;
      });
      extra.importThrowCaught = () => {
        expect(`${mode} import catch retains strand`, w.sched.current().id, importStrand.id);
        expect(`${mode} import catch retains Thread`, globals.thr.value === importStrand.thread.obj, true);
        expect(`${mode} import catch retains depth`, globals.depth.value, 23);
      };
      const f = w.helpers.hostFn("substrate:import-throw:" + mode, [], "V", (_cx, c) => {
        c.call(prepare).block().block(T.exnref).tryTable(null, [[3, 0, 0]]);
        if (mode === "interposed") emitRestored(_cx, c, [], [], () => { c.call(fail); });
        else c.call(fail);
        c.end().br(1).end();
        c.call(caught).throwRef().end();
      }, cx => {
        prepare = cx.mb.importFunc("host", "importThrowPrepare", cx.sig([], "V"));
        fail = cx.mb.importFunc("host", "importThrow", cx.sig([], "V"));
        caught = cx.mb.importFunc("host", "importThrowCaught", cx.sig([], "V"));
      });
      const got = await importStrand.call(f).then(() => null, e => e);
      expect(`${mode} Wasm rethrow retains the host exception`, got === error, true);
    }
  } finally {
    importStrand.end();
    delete extra.importThrowPrepare; delete extra.importThrow; delete extra.importThrowCaught;
  }
  const lookupStrand = w.sched.strand(w.sched.hostThread()), lookupGlobals = w.rtImports();
  const oldLookup = w.host.classByName, oldWait = w.host.annotationWait, oldSuspending = w.sched.suspending;
  const lookupError = new Error("class lookup rejected");
  try {
    await lookupStrand.call(w.helpers.hostFn("substrate:lookup-thread", [], "L", (cx, c) => cx.callRt(c, "curThread")));
    // Interpose another completion after settle's rejection handler, before the engine's catch.
    const suspending = oldSuspending.bind(w.sched);
    w.sched.suspending = fn => suspending((...args) => {
      const p = fn(...args);
      if (p instanceof Promise) {
        const then = p.then.bind(p);
        p.then = ((ok, failed) => then(ok, e => {
          try { return failed!(e); }
          finally { queueMicrotask(() => w.sched.idle()); }
        })) as typeof p.then;
      }
      return p;
    });
    w.host.annotationWait = w.sched.settle();
    w.sched.suspending = oldSuspending;
    w.host.classByName = () => { w.sched.parkNative(Promise.reject(lookupError)); return 0; };
    extra.lookupPrepare = () => { lookupGlobals.depth.value = 23; };
    extra.lookupCaught = () => {
      expect("classForName rejected wait retains strand", w.sched.current().id, lookupStrand.id);
      expect("classForName rejected wait retains Thread", lookupGlobals.thr.value === lookupStrand.thread.obj, true);
      expect("classForName rejected wait retains depth", lookupGlobals.depth.value, 23);
    };
    let prepare = 0, caught = 0;
    const key = "java/lang/Class.classForName(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;";
    const m = w.prog.resolve("java/lang/Class", "classForName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;")!;
    const lookup = w.helpers.hostFn("substrate:lookup-reject", ["L", "I", "L"], "V", (cx, c) => {
      c.call(prepare).block().block(T.exnref).tryTable(null, [[3, 0, 0]]);
      classIntrinsics.get(key)!(cx, m, c); c.drop();
      c.end().br(1).end().call(caught).throwRef().end();
    }, cx => {
      prepare = cx.mb.importFunc("host", "lookupPrepare", cx.sig([], "V"));
      caught = cx.mb.importFunc("host", "lookupCaught", cx.sig([], "V"));
    });
    const got = await lookupStrand.call(lookup, w.javaString("missing.Type"), 0, null).then(() => null, e => e);
    expect("classForName rejected wait rethrows the same exception", got === lookupError, true);
  } finally {
    lookupStrand.end();
    w.host.classByName = oldLookup; w.host.annotationWait = oldWait; w.sched.suspending = oldSuspending;
    delete extra.lookupPrepare; delete extra.lookupCaught;
  }
  // the cases' common-pool workers stay parked across the probe
  const parked = w.sched.strands.filter(Boolean).length;
  probe = admission;
  try {
    probe = idling;
    try { expect("admitted Wasm restores ownership after another completion idles", await show(() => w.entryAsync("Th", "linkAdmissionIdentity", "(I)I")(0)), 1); }
    finally { probe = admission; }
    w.addHostClass(nativeSource.hostSpecs().find(spec => spec.name === "webdroid/FnRunnable")!);
    let runnableResult = 0;
    const runnable = fnRunnable(() => Promise.resolve(callbackEntry.scall("Th", "inner", "(I)I", 5)).then(value => { runnableResult = value as number; }));
    expect("host Runnable waits for its conditional Java callback", await show(() => callbackEntry.vcall(runnable, "run", "()V")), "undefined");
    expect("host Runnable completes its Java callback", runnableResult, 12);
    const inlineRunnable = fnRunnable(() => { runnableResult++; });
    expect("host Runnable also accepts an immediate callback", await show(() => callbackEntry.vcall(inlineRunnable, "run", "()V")), "undefined");
    expect("immediate Runnable callback completes once", runnableResult, 13);
    expect("lazy admission preserves initializer, thread and callback monitor", await show(() => w.entryAsync("Th", "linkAdmission", "(I)I")(0)), 49);
    expect("lazy links admit event-loop turns", admission.turns > 0, true);
    const methods = w.stats.methods;
    const sameSlot = w.entryAsync("Th", "linkAdmissionWinner", "(I)I");
    expect("two admitted callers observe the winning link", (await Promise.all([sameSlot(3), sameSlot(7)])).join(), "4,8");
    expect("the admitted slot is compiled only once", w.stats.methods - methods, 1);
    const before = admission.turns;
    const helper = w.helpers.hostFn("admission:plain", ["I"], "I", (cx, c) => {
      c.lget(0); cx.callMethod(c, w.prog.resolve("Th", "linkAdmissionPlain", "(I)I")!);
    });
    expect("fresh plain helper links synchronously with an exhausted budget", helper(0), 11);
    expect("plain host entry remains synchronous with an exhausted budget", w.entry("Th", "linkAdmissionPlain", "(I)I")(0), 11);
    expect("plain host entry does not admit a turn", admission.turns, before);
    const rejected = w.sched.strand(), globals = w.rtImports();
    globals.sid.value = rejected.id; globals.thr.value = rejected.thread.obj; globals.depth.value = 17;
    try {
      probe = rejecting;
      try { await w.sched.admitLink(() => { throw new Error("rejected admission ran link"); }); }
      catch (error) { expect("admission timer failure is retained", (error as Error).message, "admission timer rejected"); }
      expect("timer rejection restores its strand", w.sched.current(), rejected);
      expect("timer rejection restores frame depth", globals.depth.value, 17);
      probe = admission;
      try { await w.sched.admitLink(() => { throw new Error("link failed"); }); }
      catch (error) { expect("admitted link failure is retained", (error as Error).message, "link failed"); }
      expect("throwing link retains its strand", w.sched.current(), rejected);
      expect("throwing link retains frame depth", globals.depth.value, 17);
    } finally { probe = admission; rejected.end(); w.sched.idle(); }
    const readyStrand = w.sched.strand();
    globals.sid.value = readyStrand.id; globals.thr.value = readyStrand.thread.obj; globals.depth.value = 19;
    probe = undefined;
    try {
      let prepared = 0;
      await w.sched.admitLink(() => {
        expect("delivery admission restores its strand before linking", w.sched.current(), readyStrand);
        expect("delivery admission restores depth", globals.depth.value, 19);
      }, () => { prepared++; return Promise.resolve(); });
      expect("delivery admission waits without exhausted turn budget", prepared, 1);
      w.sched.synchronous(() => w.sched.admitLink(() => {}, () => { prepared++; return Promise.resolve(); }));
      expect("synchronous Java does not prepare delivery", prepared, 1);
      try { await w.sched.admitLink(() => { throw new Error("rejected preparation ran link"); }, () => Promise.reject(new Error("preparation rejected"))); }
      catch (error) { expect("preparation rejection is retained", (error as Error).message, "preparation rejected"); }
      expect("rejected preparation restores its strand", w.sched.current(), readyStrand);
      expect("rejected preparation restores depth", globals.depth.value, 19);
      w.sched.idle();
      w.sched.admitLink(() => {}, () => { prepared++; return Promise.resolve(); });
      expect("root host does not prepare delivery", prepared, 1);
    } finally { readyStrand.end(); w.sched.idle(); probe = admission; }
    expect("admission releases its strands", w.sched.strands.filter(Boolean).length, parked);
  } finally { probe = undefined; }
  const cold = world([dex, ...CORE_PATHS], { natives: new Natives(nativeSource) });
  expect("lazy linking near the stack limit", await cold.entryAsync("Th", "linkDeep", "(I)I")(0), 0);
  // natives that wait: async, a generator, one that enters Java through a promising entry that waits again
  expect("async native", await show(() => w.entryAsync("Th", "trap", "(I)I")(4)), 5);
  expect("generator native", await show(() => w.entryAsync("Th", "driven", "(I)I")(4)), 13);
  expect("generator native enters Java on its thread after a wait", await show(() => w.entryAsync("Th", "drivenThread", "(I)I")(4)), 5);
  expect("after enters Java on the native's thread once its Promise settles", await show(() => w.entryAsync("Th", "afterThread", "(I)I")(4)), 6);
  expect("nested promising entry", await show(() => w.entryAsync("Th", "nested", "(I)I")(4)), 11);
  // arrays given to and answered by natives that wait at the same time stay each strand's own
  expect("array arguments and results across a wait", await show(() => w.entryAsync("Th", "arrayGap", "(I)I")(300)), 0);
  expect("array alias and exceptional copy-back", await show(() => w.entryAsync("Th", "arrayAlias", "(I)I")(0)), 0);
  probe = arithmetic;
  try { expect("arithmetic loop answer", await show(() => w.entryAsync("Th", "fuelArithmetic", "(I)I")(100000)), 704982704); }
  finally { probe = undefined; }
  expect("arithmetic loop yields", arithmetic.turns > 0, true);
  // 1,000 stacks suspended in the same native at once
  { const t0 = performance.now(), r = await Promise.all(Array.from({ length: 1000 }, (_, i) => w.entryAsync("Th", "trap", "(I)I")(i))); const ms = performance.now() - t0;
    expect("1,000 suspended stacks", r.reduce((a: number, b) => a + (b as number), 0), 1000 * 999 / 2 + 1000);
    console.log(`1,000 stacks suspended in a native and resumed: ${ms.toFixed(0)} ms`); }
  // a plain native that answers a Promise on a strand: reported, and its call site waits for the value
  expect("plain native answering a Promise", await show(() => w.entryAsync("Th", "flagged", "(I)I")(1)), 1);
  expect("nativeSuspended reported", [...suspendedNatives].join(), "Th.flagged(I)I");
  expect("nativeSuspended in the stats", perf.wasmNativeSuspended, 1);
  // JS frames between the strand's entry and the import that waits: the engine refuses, and it is counted
  expect("native waiting under a JS frame", (await show(() => w.entryAsync("Th", "viaJs", "(I)I")(1))).split(":")[0], "throw SuspendError");
  expect("SuspendError counted", perf.wasmSuspendErrors, 1);
  // a stack overflow is the error Java code catches, on a strand's stack and on the host's, for light and heavy frames
  for (const [name, entry] of [["reach", "strand"], ["reachHeavy", "strand"], ["reach", "plain"], ["reachHeavy", "plain"]] as const) {
    const got = await show(() => entry === "strand" ? w.entryAsync("Th", name, "(I)I")(0) : w.entry("Th", name, "(I)I")(0)), frames = Number(got);
    console.log(`${name} on ${entry}: ${Number.isNaN(frames) ? got : frames + " frames"} before StackOverflowError`);
    if (process.env.J2W_V) console.log("last recursive counter", await show(() => w.entry("Th", "count", "(I)I")(0)));
    expect(`${name} on ${entry} catches the overflow`, frames > 100, true);
  }
  // blocking where the stack cannot suspend (a plain entry) is an error that says so
  expect("blocking on a plain entry", await show(() => w.entry("Th", "pause", "()V")()), "java java/lang/IllegalStateException");
  expect("plain entry counted", w.sched.blockedPlain >= 1, true);
  // a plain entry that does not block is unchanged, between strands
  expect("plain entry after strands", await show(() => w.entry("Th", "reentrant", "(I)I")(3)), 3);
}
suite.done(`${suite.checks} checks ok; strands ${w.sched.strands.filter(Boolean).length} live, ${w.stats.methods} methods compiled`);
