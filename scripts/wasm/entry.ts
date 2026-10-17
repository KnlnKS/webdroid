// The entry seam (B1): host code calls Java through jentry's names over a World, and the answers, the exceptions that leave the calls and the identity
// of the objects must be the ones java/E.expected.txt records. (entrytier.ts then runs them through the tier's own loading.) Run: pnpm wasm entry
import { join } from "node:path";
import { rt } from "../../src/jvm/runtime.ts";
import { mangleField } from "../../src/jvm/abi.ts";
import { JThread, newObj, resumeAs } from "../../src/jvm/natives/jentry.ts";
import { perf } from "../../src/perf.ts";
import { runningThread, wasmEntry } from "../../src/wasm/host/entry.ts";
import { UInfo } from "../../src/wasm/link/unsafe.ts";
import { world } from "./lib.ts";
import { mountPlatform, natives } from "./harness.ts";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths.ts";
import { entryCases, entryDex } from "./entrycases.ts";
import { recorded, unlike } from "./tools.ts";

const dex = entryDex(), jars = [0, 1, 5, 12].map((i) => PLATFORM_PATHS[i]);
await mountPlatform(ROOT);
const expected = recorded(join(JAVA, "E.expected.txt"));

const w = world([dex, ...jars], { natives }), gaps: string[] = [];
w.onGap = (id) => gaps.push(w.gapList[id]);
const entry = wasmEntry(w);
const missesBefore = perf.wasmFacadeMisses;
const wasm = await entryCases();
const facade = (await newObj("E")) as Record<string, unknown>;
void facade.noSuchField;
const counted = perf.wasmFacadeMisses - missesBefore === 1 && rt.missing.has("facade E.noSuchField") && perf.wasmEntries > 0;

let failed = 0;
for (const failure of unlike(expected, wasm)) { failed++; console.log("FAIL " + failure); }
if (!counted) { failed++; console.log("FAIL a read no field backs is not counted in perf and the missing entries"); }
// a facade read outside any native's scope (a looper callback reading vsync data) copies the array in a scope of its own and leaves no scope open
const scope = w.bridge as unknown as { scopes: unknown[]; live: Map<object, unknown> };
let copies = 0;
for (let i = 0; i < 1000; i++) copies += +((facade[mangleField("E", "slots")] as Int32Array)[2] === 3);
if (copies !== 1000 || scope.scopes.length || scope.live.size) { failed++; console.log(`FAIL unscoped facade reads: ${copies} copies, ${scope.scopes.length} open scopes, ${scope.live.size} live`); }
// An allocation may wait before newObj enters its constructor. Another completion owns the
// host turn then; the constructor still belongs to the allocating caller, including a non-main caller.
const ownerFailures = failed;
const origin = Object.assign(new JThread(), { jname: "allocation-origin" });
const background = Object.assign(new JThread(), { jname: "interposed-background" });
const current = await entry.callOn(origin, () => entry.scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;"));
await entry.callOn(origin, () => entry.initClass("E$Owner"));
await entry.callOn(origin, () => entry.newObj("E$Owner"));
const immediate = w.synchronous(() => entry.callOn(origin, () => entry.newObj("E$Owner")));
if (immediate instanceof Promise) { failed++; console.log("FAIL warm synchronous constructor became asynchronous"); }
const immediateObject = await immediate;
if (await entry.callOn(origin, () => entry.vcall(immediateObject, "owner", "()Ljava/lang/Thread;")) !== current) { failed++; console.log("FAIL synchronous constructor caller"); }
const originalCall = w.callFn;
// newObj allocates through the suspending invoker of the class's allocator (host/entry.ts alloc); `then` runs before that allocation answers
const ownerAlloc = w.host.info(UInfo.AllocInstance, w.idOf("E$Owner"), 0);
let delayedAllocs = 0;
const delayAllocation = (then: () => void) => {
  w.callFn = (key, ...a) => {
    const f = originalCall.call(w, key, ...a);
    return key !== "invs:>L" ? f : (s, slot, ...args) => slot !== ownerAlloc ? f(s, slot, ...args) : Promise.resolve(f(s, slot, ...args)).then(value => {
      delayedAllocs++; then(); return value;
    });
  };
};
try {
  delayAllocation(() => { w.sched.idle(); resumeAs(background.root); });
  const delayed = await entry.callOn(origin, () => entry.newObj("E$Owner"));
  if (delayedAllocs !== 1) { failed++; console.log(`FAIL the allocation was delayed ${delayedAllocs} times, not once`); }
  if (await entry.callOn(origin, () => entry.vcall(delayed, "owner", "()Ljava/lang/Thread;")) !== current) { failed++; console.log("FAIL asynchronous constructor lost allocating caller"); }
} finally { w.callFn = originalCall; }
console.log(failed === ownerFailures ? "3/3 constructor ownership checks pass" : "FAIL constructor ownership checks");
const parentFailures = failed;
const originRec = entry.callOn(origin, () => runningThread(w)), backgroundRec = entry.callOn(background, () => runningThread(w));
await entry.callOn(background, () => entry.scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;"));
const parent = w.sched.strand(originRec), interposed = w.sched.strand(backgroundRec), globals = w.rtImports();
const lock = w.bridge.toJava(facade, "LE;") as object;
const activate = (s: typeof parent) => {
  globals.sid.value = s.id; globals.thr.value = s.thread.obj; globals.depth.value = 0;
  w.sched.running = s; w.sched.onThread?.(s.thread, false);
};
let constructorParent: typeof parent | null = null;
const originalInvoke = w.bridge.invokeOn;
try {
  w.sched.monitors.tryEnter(lock, parent);
  w.bridge.invokeOn = function (s, m, ...a) {
    if (m.cls === "E$Owner" && m.name === "<init>") constructorParent = s.parent;
    return originalInvoke.call(this, s, m, ...a);
  };
  delayAllocation(() => activate(interposed));
  for (const reentry of [true, false]) {
    activate(reentry ? parent : interposed);
    const construct = () => entry.newObj("E$Owner", "(Ljava/lang/Object;)V", facade);
    const object = await (reentry ? construct() : entry.callOn(origin, construct));
    const keptParent = constructorParent === (reentry ? parent : null);
    w.sched.idle();
    const held = await entry.callOn(origin, () => entry.vcall(object, "held", "()Z"));
    if (!keptParent || !!held !== reentry) { failed++; console.log(`FAIL constructor ${reentry ? "reentry" : "thread switch"} parent/monitor ownership`); }
  }
  if (delayedAllocs !== 3) { failed++; console.log(`FAIL the parent/monitor allocations were delayed ${delayedAllocs - 1} times, not twice`); }
} finally {
  w.callFn = originalCall; w.bridge.invokeOn = originalInvoke;
  w.sched.monitors.exit(lock, parent); parent.end(); interposed.end(); w.sched.idle();
}
console.log(failed === parentFailures ? "2/2 constructor parent/monitor contexts pass" : "FAIL constructor parent/monitor contexts");
if (gaps.length) { failed++; console.log(`FAIL gaps hit: ${[...new Set(gaps)].join("; ")}`); }
console.log(failed ? `${failed} failures` : `${expected.length} entry calls answer as recorded on a World`);
process.exit(failed ? 1 : 0);
