// Classes the host implements (B2): a Java object of a registered spec's class and its host object are one object to both sides. The cases of hostcases.ts run on a
// World with the registered classes added to it and must answer as java/hc/expected.txt records; then the Wasm tier's own rules: what dies together, and what the tables keep.
// Run: pnpm wasm hostclass
import { join } from "node:path";
import { rt } from "../../src/jvm/runtime.ts";
import { resumeAs, scall } from "../../src/jvm/natives/jentry.ts";
import { onNestedStrand, wasmEntry } from "../../src/wasm/host/entry.ts";
import { useWorld } from "../../src/wasm/host/boot.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { Compiler } from "../../src/wasm/compiler/j2w.ts";
import { Block, emitBlock } from "../../src/wasm/link/sched.ts";
import { St } from "../../src/wasm/link/monitor.ts";
import { compileModule } from "../../src/wasm/link/module.ts";
import { loadDexes, program, world } from "./lib.ts";
import { addHostClasses, mountPlatform, natives, startProcess } from "./harness.ts";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths.ts";
import { deref, handle, ownedHandle, release } from "../../src/android/handles.ts";
import { enter, hostCases, hostDex, JCounter } from "./hostcases.ts";
import { checker, recorded, unlike } from "./tools.ts";

const dex = hostDex(), jars = [0, 1, 2, 12].map((i) => PLATFORM_PATHS[i]);
await mountPlatform(ROOT);
const expected = recorded(join(JAVA, "hc/expected.txt"));

const w = addHostClasses(world([dex, ...jars], { natives, claim: (owner, handle) => rt.claimHandle?.(owner, handle) })), gaps: string[] = [];
w.onGap = (gap) => gaps.push(gap);
enter.call = async (cls, name, desc) => w.entryAsync(cls, name, desc)();
const wasm = await hostCases(enter.call);

const suite = checker(), { fail } = suite;
for (const failure of unlike(expected, wasm)) fail(failure);
if (gaps.length) fail(`gaps hit: ${[...new Set(gaps)].join("; ")}`);

{
  const array = w.bridge.toJava(new Int32Array(2), "[I") as object, before = handle(array), mark = w.bridge.begin();
  try {
    if (deref(before) === array) fail("a Wasm array handle did not produce a host view");
    release(before);
    const after = handle(array);
    try {
      if (after === before || deref(after) === undefined) fail("a released Wasm array retained its stale handle");
    } finally { release(after); }
  } finally { w.bridge.end(mark); }
}

{
  const worker = world([dex, ...jars], { natives, compileOnly: true }), instances = worker.stats.instances;
  addHostClasses(worker);
  worker.link("java/net/HttpURLConnection");
  worker.repairLinked();
  const method = worker.prog.get("Hc")!.byKey.get("http()Ljava/lang/String;")!;
  compileModule(new Compiler(worker).buildUnit([method]).bytes);
  if (worker.stats.instances !== instances) fail("a compile-only World instantiated host vtable repairs");
}

// Worlds over one platform Program, as the process frames of a tab are: the host classes are each World's own, the platform's classes are not changed, and every World behaves alike
{
  const platform = program(jars), mk = () => addHostClasses(world(new Program(loadDexes(dex), platform), { natives }));
  const worlds = [mk(), mk()], name = (x: typeof w) => x.hostClassNames().join();
  if (!name(worlds[0]) || name(worlds[0]) !== name(worlds[1])) fail("Worlds over one platform Program have different host classes");
  for (const cls of ["java/lang/StringBuilder", "java/util/concurrent/ThreadPoolExecutor", "java/util/concurrent/ScheduledThreadPoolExecutor"]) {
    const slots = w.vslots(cls);
    if (new Set(slots).size !== slots.length || slots.join("\n") !== worlds[0].vslots(cls).join("\n")) fail(`flat/shared dispatch layout differs for ${cls}`);
  }
  for (const x of [worlds[0], worlds[1], worlds[0]]) {
    useWorld(x);
    await startProcess(x);
    for (const m of ["runnable", "list", "http"]) {
      const got = String(await x.entryAsync("Hc", m, "()Ljava/lang/String;")()), want = expected.find((l) => l.startsWith("Hc." + m + ":"))!.slice(m.length + 8);
      if (got !== want) fail(`a World over a shared platform Program answers Hc.${m} ${got}, not ${want}`);
    }
  }
  if (!platform.get("java/net/HttpURLConnection")!.byKey.get("getRequestMethod()Ljava/lang/String;")!.codeOff) fail("a World changed a class of the platform Program");
  useWorld(w);
}

// lifetime: the Java object and the host object live and die together
const gc = globalThis.gc!;
const turn = () => new Promise((r) => setTimeout(r, 0));
async function collected(refs: WeakRef<object>[]): Promise<boolean> {
  for (let i = 0; i < 5 && refs.some((r) => r.deref()); i++) { await turn(); gc(); }
  return refs.every((r) => !r.deref());
}
async function made(): Promise<WeakRef<object>[]> {
  const host = new JCounter();
  await scall("Hc", "keep", "(Ljava/lang/Object;)Ljava/lang/Object;", host);
  await scall("Hc", "forget", "()V");
  return [new WeakRef(host), new WeakRef(w.hosts.shellOf(host)!)];
}
async function madeByJava(): Promise<WeakRef<object>[]> {
  const sub = await scall("Hc", "newSub", "()Ljava/lang/Object;") as JCounter;
  return [new WeakRef(sub), new WeakRef(w.hosts.shellOf(sub)!)];
}
await turn();
if (!await collected(await made())) fail("a host-made object and its Java object outlive their last reference");
if (!await collected(await madeByJava())) fail("a Java-made object and its host object outlive their last reference");
// The pending callFn path must release its result/throw globals after completion.
async function madeByPendingBridge(thrown: boolean): Promise<WeakRef<object>[]> {
  const java = thrown ? w.makeThrowable("java/lang/IllegalStateException", "lifetime") : w.bridge.toJava(new JCounter(), "Lwdtest/Counter;") as object;
  const later = w.callFn("lifetime:" + thrown, ["L"], thrown ? "V" : "L", (cx, c, arg) => {
    emitBlock(cx, c, Block.Yield, null, null, () => c.i32(1)); c.drop(); arg(0);
    if (thrown) c.throw_(cx.tag);
  });
  const strand = w.sched.strand();
  try {
    const pending = later(strand, java);
    if (!(pending instanceof Promise)) fail("lifetime bridge did not suspend");
    try { const result = await pending; if (thrown || result !== java) fail("pending bridge result identity"); }
    catch (e) { if (!thrown || w.throwable(e) !== java) fail("pending bridge throwable identity"); }
  } finally { strand.end(); }
  return [new WeakRef(java)];
}
if (!await collected(await madeByPendingBridge(false))) fail("pending bridge retains its last reference result");
if (!await collected(await madeByPendingBridge(true))) fail("pending bridge retains its last throwable");
// The World keeps the executable bridge, not the Compiler used to build it.
async function bridgeCompiler(): Promise<WeakRef<object>[]> {
  const refs: WeakRef<object>[] = [];
  const call = w.callFn("lifetime:compiler", [], "I", (_cx, c) => { c.i32(7); }, cx => refs.push(new WeakRef(cx)));
  const strand = w.sched.strand();
  try { if (await call(strand) !== 7) fail("compiler lifetime bridge result"); }
  finally { strand.end(); }
  return refs;
}
if (!await collected(await bridgeCompiler())) fail("callFn retains its helper Compiler");
// Java holds the object: the host object it stands for is the same one when the host asks again, however long it was not referenced
const kept = await (async () => { const h = new JCounter(); h.n = 3; scall("Hc", "keep", "(Ljava/lang/Object;)Ljava/lang/Object;", h); return new WeakRef(h); })();
await turn(); gc(); await turn(); gc();
if (kept.deref()?.n !== 3 || scall("Hc", "kept", "(I)Ljava/lang/Object;", 0) !== kept.deref()) fail("the Java object does not keep its host object");

// a handle stored in a long field of a class that frees it in finalize() lives as long as that object; in a class that does not, it is the table's
async function handleAfter(cls: "own" | "plain"): Promise<boolean> {
  const target = {}, h = ownedHandle(target);
  const once = (): bigint => { scall("Hc", cls, "(J)Ljava/lang/Object;", h); return h; };
  once();
  for (let i = 0; i < 8 && deref(h) !== undefined; i++) { await turn(); gc(); await turn(); }
  return deref(h) !== undefined;
}
if (await handleAfter("own")) fail("a handle stored in a field of a class that frees it in finalize() outlives the object");
if (!await handleAfter("plain")) fail("a handle stored in a field of a class that does not free it is released with the object");

{
  const callback = w.callFn("callback:context", [], "I", (_cx, c) => { c.i32(42); });
  const lock = w.hostFn("callback:lock", [], "L", (cx, c) => cx.emitNew(c, "java/lang/Object"))() as object;
  const owner = w.sched.strand();
  w.rtImports().sid.value = owner.id;
  w.sched.onThread?.(owner.thread, false);
  const caller = rt.cur;
  w.sched.idle(); resumeAs(caller);
  try {
    if (w.sched.monitors.tryEnter(lock, owner) !== St.Ok) fail("callback owner cannot acquire monitor");
    if (onNestedStrand(w, s => callback(s)) !== 42 || rt.cur !== caller) fail("synchronous JNI callback loses its host strand");
    onNestedStrand(w, s => {
      if (s.parent !== owner || w.sched.monitors.tryEnter(lock, s) !== St.Ok) fail("following JNI callback loses monitor reentry");
      else w.sched.monitors.exit(lock, s);
    });
  } finally { w.sched.monitors.exit(lock, owner); owner.end(); w.sched.idle(); }
}

{
  const fresh = addHostClasses(world([dex, ...jars], { natives }));
  fresh.sched.turnDue = () => true;
  const entry = wasmEntry(fresh);
  for (const name of ["Hc$Boot", "javax/net/ssl/HttpsURLConnection"]) {
    try {
      const object = entry.linkClass(name).new();
      if (object instanceof Promise || entry.classNameOf(object) !== name) fail(`linked allocation is not synchronous: ${name}`);
      if (fresh.initialized(name)) fail(`linked allocation initialized ${name}`);
    } catch (error) { fail(`linked allocation ${name}: ${String(error)}`); }
  }
}

console.log(suite.failed ? `${suite.failed} failures` : `${expected.length} cases answer as recorded on a World with host classes`);
process.exit(suite.failed ? 1 : 0);
