// The entry seam (B1): host code calls Java through jentry's names over a World, and the answers, the exceptions that leave the calls and the identity
// of the objects must be the ones entrycases.ts states. (entrytier.ts then runs them through the tier's own loading.) Run: pnpm wasm entry
import { rt } from "../../src/jvm/runtime.ts";
import { mangleField } from "../../src/jvm/abi.ts";
import { JThread, newObj, resumeAs } from "../../src/jvm/natives/jentry.ts";
import { perf } from "../../src/perf.ts";
import { runningThread, wasmEntry } from "../../src/wasm/host/entry.ts";
import { UInfo } from "../../src/wasm/compiler/info.ts";
import { world } from "./lib.ts";
import { mountPlatform } from "./harness.ts";
import { ROOT, platformJars } from "./paths.ts";
import { entryCases, entryDex } from "./entrycases.ts";
import { checker } from "./tools.ts";

const dex = entryDex(), jars = platformJars("core-oj", "core-libart", "framework", "core-icu4j");
await mountPlatform(ROOT);

const w = world([dex, ...jars]), gaps: string[] = [];
w.onGap = (gap) => gaps.push(gap);
const entry = wasmEntry(w);
const missesBefore = perf.wasmFacadeMisses;
const failures = await entryCases();
const facade = (await newObj("E")) as Record<string, unknown>;
void facade.noSuchField;
const counted = perf.wasmFacadeMisses - missesBefore === 1 && rt.missing.has("facade E.noSuchField") && perf.wasmEntries > 0;

const suite = checker("entry"), { fail } = suite;
for (const failure of failures) fail(failure);
if (!counted) fail("a read no field backs is not counted in perf and the missing entries");
// a facade read outside any native's scope (a looper callback reading vsync data) copies the array in a scope of its own and leaves no scope open
const scope = w.bridge as unknown as { scopes: unknown[]; live: Map<object, unknown> };
let copies = 0;
for (let i = 0; i < 1000; i++) copies += +((facade[mangleField("E", "slots")] as Int32Array)[2] === 3);
if (copies !== 1000 || scope.scopes.length || scope.live.size) fail(`unscoped facade reads: ${copies} copies, ${scope.scopes.length} open scopes, ${scope.live.size} live`);
// An allocation may wait before newObj enters its constructor. Another completion owns the
// host turn then; the constructor still belongs to the allocating caller, including a non-main caller.
const ownerFailures = suite.failed;
const origin = Object.assign(new JThread(), { jname: "allocation-origin" });
const background = Object.assign(new JThread(), { jname: "interposed-background" });
const current = await entry.callOn(origin, () => entry.scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;"));
await entry.callOn(origin, () => entry.initClass("E$Owner"));
await entry.callOn(origin, () => entry.newObj("E$Owner"));
const immediate = w.sched.synchronous(() => entry.callOn(origin, () => entry.newObj("E$Owner")));
if (immediate instanceof Promise) fail("warm synchronous constructor became asynchronous");
const immediateObject = await immediate;
if (await entry.callOn(origin, () => entry.vcall(immediateObject, "owner", "()Ljava/lang/Thread;")) !== current) fail("synchronous constructor caller");
const originalCall = w.helpers.callFn;
// newObj allocates through the suspending invoker of the class's allocator (host/entry.ts alloc); `then` runs before that allocation answers
const ownerAlloc = w.host.info(UInfo.AllocInstance, w.idOf("E$Owner"), 0);
let delayedAllocs = 0;
const delayAllocation = (then: () => void) => {
  w.helpers.callFn = (key, ...a) => {
    const f = originalCall.call(w.helpers, key, ...a);
    return key !== "invs:>L" ? f : (s, slot, ...args) => slot !== ownerAlloc ? f(s, slot, ...args) : Promise.resolve(f(s, slot, ...args)).then(value => {
      delayedAllocs++; then(); return value;
    });
  };
};
try {
  delayAllocation(() => { w.sched.idle(); resumeAs(background.root); });
  const delayed = await entry.callOn(origin, () => entry.newObj("E$Owner"));
  if (delayedAllocs !== 1) fail(`the allocation was delayed ${delayedAllocs} times, not once`);
  if (await entry.callOn(origin, () => entry.vcall(delayed, "owner", "()Ljava/lang/Thread;")) !== current) fail("asynchronous constructor lost allocating caller");
} finally { w.helpers.callFn = originalCall; }
if (suite.failed === ownerFailures) console.log("3/3 constructor ownership checks pass");
const parentFailures = suite.failed;
const originRec = entry.callOn(origin, () => runningThread(w)), backgroundRec = entry.callOn(background, () => runningThread(w));
await entry.callOn(background, () => entry.scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;"));
const parent = w.sched.strand(originRec), interposed = w.sched.strand(backgroundRec);
const lock = w.bridge.toJava(facade, "LE;") as object;
let constructorParent: typeof parent | null = null;
const originalInvoke = w.bridge.invokeOn;
try {
  w.sched.monitors.tryEnter(lock, parent);
  w.bridge.invokeOn = function (s, m, ...a) {
    if (m.cls === "E$Owner" && m.name === "<init>") constructorParent = s.parent;
    return originalInvoke.call(this, s, m, ...a);
  };
  delayAllocation(() => w.sched.become(interposed));
  for (const reentry of [true, false]) {
    w.sched.become(reentry ? parent : interposed);
    const construct = () => entry.newObj("E$Owner", "(Ljava/lang/Object;)V", facade);
    const object = await (reentry ? construct() : entry.callOn(origin, construct));
    const keptParent = constructorParent === (reentry ? parent : null);
    w.sched.idle();
    const held = await entry.callOn(origin, () => entry.vcall(object, "held", "()Z"));
    if (!keptParent || !!held !== reentry) fail(`constructor ${reentry ? "reentry" : "thread switch"} parent/monitor ownership`);
  }
  if (delayedAllocs !== 3) fail(`the parent/monitor allocations were delayed ${delayedAllocs - 1} times, not twice`);
} finally {
  w.helpers.callFn = originalCall; w.bridge.invokeOn = originalInvoke;
  w.sched.monitors.exit(lock, parent); parent.end(); interposed.end(); w.sched.idle();
}
if (suite.failed === parentFailures) console.log("2/2 constructor parent/monitor contexts pass");
if (gaps.length) fail(`gaps hit: ${[...new Set(gaps)].join("; ")}`);
suite.done("the entry calls answer as stated on a World");
