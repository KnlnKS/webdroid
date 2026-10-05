// Threads, monitors, waiting natives and class initialization waits on JSPI strands (plan S3): the static int(int) cases of java/Th.java run on
// the JDK, the production JS tier and the Wasm tier, and the pieces of the substrate that no Java case reaches are checked directly: natives that
// wait (async, generator, one that enters Java again), 1,000 suspended stacks, deep recursion off the main stack, and what happens to a native that
// answers a Promise or waits under a JS frame. Needs javac, d8 and java on PATH; node runs it with --experimental-wasm-jspi (run.ts).
// Run: bun run wasm threads [case,case,... | substrate]
import { mkdtempSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { loadDexes, world } from "./lib";
import { jsTier, processState } from "./oracle";
import { nativeSource } from "../../src/wasm/host/nativesource";
import { Natives } from "../../src/wasm/host/natives";
import { suspendedNatives } from "../../src/wasm/host/suspend";
import { perf } from "../../src/perf";
import type { HostFn, NativeSource } from "../../src/wasm/link/hostapi";
import { hasJspi } from "../../src/wasm/link/module";
import { AOSP, JAVA } from "./paths";
import { shellIn } from "./tools";

if (!hasJspi()) { console.error("threads needs JSPI: run it with bun run wasm threads (node --experimental-wasm-jspi)"); process.exit(2); }
const out = mkdtempSync(join(tmpdir(), "j2w-th-"));
const sh = shellIn(out);
sh(["javac", "--release", "11", "-Xlint:-options", "-d", out, join(JAVA, "Th.java"), join(JAVA, "Ref.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", out, ...readdirSync(out).filter((f) => /^Th.*\.class$/.test(f)).map((f) => join(out, f))]);

const dex = join(out, "classes.dex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const w = world([dex, ...[...PLATFORM_JARS.slice(0, 2), "boot/core-icu4j.jar"].map((j) => join(AOSP, j))], { natives: new Natives({
  ...nativeSource,
  find: (cls, key, isStatic, hasBody) => cls === "Th" ? TH[key] : nativeSource.find(cls, key, isStatic, hasBody),
} satisfies NativeSource) });
const TH: Record<string, HostFn> = {
  "await(I)I": async (x: number) => { await sleep(1); return x + 1; },
  "driven(I)I": Object.assign(() => { throw new Error("the generator form runs"); }, { $g: function* (x: number) { const v: number = yield Promise.resolve(x * 3); return v + 1; } }),
  "nested(I)I": async (x: number) => (await w.entryAsync("Th", "inner", "(I)I")(x) as number) + 1,
  "flagged(I)I": (x: number) => Promise.resolve(x),
  "viaJs(I)I": (x: number) => w.entry("Th", "trap", "(I)I")(x),
};
const gaps: string[] = [];
w.onGap = (id) => gaps.push(w.gapList[id]);
const js = await jsTier(loadDexes(dex));
processState(w);

let bad = 0, checks = 0;
const timed = <T,>(p: Promise<T>, ms = Number(process.env.J2W_TIMEOUT ?? 60000)): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms).unref())]);
const show = async (f: () => unknown) => { try { return String(await timed(Promise.resolve(f()))); } catch (e) { const t = w.throwable(e); return t ? "java " + w.classNameOf(t) : "throw " + String(e).slice(0, 100); } };
const expect = (what: string, got: unknown, want: unknown) => { checks++; if (String(got) !== String(want)) { bad++; console.log(`MISMATCH ${what}: want ${want}, got ${got}`); } };

// ---------- the Java cases against the JDK and the JS tier
const only = process.argv[2]?.split(","), substrate = !only || only.includes("substrate");
const CASES: [string, number][] = [
  ["reentrant", 5], ["deepLock", 300], ["deepLock", 10], ["imse", 0], ["contend", 200], ["pingPong", 30], ["notifyOne", 0], ["timedWait", 0],
  ["startJoin", 100], ["names", 3], ["names", 4], ["sleepOrder", 0], ["interruptSleep", 0], ["interruptWait", 0], ["interruptFlag", 0], ["joinTimeout", 0], ["uncaught", 4],
  ["states", 0], ["threadLocals", 7], ["spin", 0], ["spinStep", 0], ["spinTest", 0], ["parkUnpark", 0], ["permit", 0], ["parkNanos", 0], ["parkInterrupt", 0],
  ["executor", 0], ["chm", 300], ["latch", 0], ["lockCondition", 20], ["queue", 30], ["semaphore", 0], ["future", 21], ["timeout", 0], ["scheduled", 0], ["completable", 4],
  ["manyThreads", 100], ["atomics", 300], ["initRace", 0], ["initCycle", 0], ["initFail", 0], ["stackOverflow", 0], ["stackOverflowDeep", 0],
].filter(([n]) => !only || only.includes(n as string)) as [string, number][];
if (!CASES.length) CASES.push(["reentrant", 3]);
// a case that deadlocks the JDK is a bug in the case
const ref = spawnSync("java", ["-Xss512k", "-cp", out, "Ref"], { input: CASES.map(([n, a]) => `Th.${n} ${a}`).join("\n") + "\n", timeout: 120000, encoding: "utf8" });
if (ref.status !== 0) throw new Error(`the JDK run failed (${ref.error ?? ref.stderr})`);
const jdk = ref.stdout.trim().split("\n");
const jsDiffers: string[] = [];
for (const [i, [name, arg]] of CASES.entries()) {
  const gapsBefore = gaps.length, want = jdk[i] === "throw" ? "throw" : jdk[i];
  if (process.env.J2W_V) console.log("case", name, arg);
  const wasm = await show(() => w.entryAsync("Th", name, "(I)I")(arg));
  if (process.env.J2W_V) console.log("  wasm", wasm);
  const tier = await show(() => js("Th", name, "(I)I", [arg]));
  const norm = (v: string) => v.startsWith("java ") || v.startsWith("throw ") ? "throw" : v;
  checks++;
  if (norm(wasm) !== want) { bad++; console.log(`MISMATCH wasm/jdk Th.${name}(${arg}): jdk=${want} wasm=${wasm}${gaps.length > gapsBefore ? " gaps: " + [...new Set(gaps.slice(gapsBefore))].join("; ") : ""}`); }
  else if (norm(tier) !== want) jsDiffers.push(`Th.${name}(${arg}): jdk=${want} js=${tier}`);
}
if (jsDiffers.length) console.log(`the JS tier differs from the JDK on ${jsDiffers.length} cases, which the Wasm tier answers as the JDK does:\n  ${jsDiffers.join("\n  ")}`);

// ---------- the substrate, directly
if (substrate) {
  // natives that wait: async, a generator, one that enters Java through a promising entry that waits again
  expect("async native", await show(() => w.entryAsync("Th", "trap", "(I)I")(4)), 5);
  expect("generator native", await show(() => w.entryAsync("Th", "driven", "(I)I")(4)), 13);
  expect("nested promising entry", await show(() => w.entryAsync("Th", "nested", "(I)I")(4)), 11);
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
    expect(`${name} on ${entry} catches the overflow`, frames > 100, true);
  }
  // blocking where the stack cannot suspend (a plain entry) is an error that says so
  expect("blocking on a plain entry", await show(() => w.entry("Th", "pause", "()V")()), "java java/lang/IllegalStateException");
  expect("plain entry counted", w.sched.blockedPlain >= 1, true);
  // a plain entry that does not block is unchanged, between strands
  expect("plain entry after strands", await show(() => w.entry("Th", "reentrant", "(I)I")(3)), 3);
}
console.log(`${checks - bad}/${checks} threads checks ok; strands ${w.sched.strands.filter(Boolean).length} live, ${w.stats.methods} methods compiled`);
process.exit(bad ? 1 : 0);
