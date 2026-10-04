// Each scripts/jbench workload, cut out of Bench.java as its own static method, runs lazily compiled over the AOSP boot dex against the
// production JS tier: only the methods a workload executes are compiled, and the first construct the compiler has no translation for is reported.
// --survey also compiles everything the workloads can reach (the old whole-program build) and lists what blocks it.
// VMStack.getStackClass (Reflection.getCallerClass, so MethodHandles.lookup and anything caller-sensitive) reads V8's wasm frames, which JavaScriptCore
// does not give: run under node with `bun build jbench.ts --target=node`, `import.meta.dir` replaced by this directory and `node --import ./nodeshim.mjs`.
// Needs the Android SDK (android.jar, d8) and javac. Run: bun jbench.ts [workload ...] [-v] [--survey]
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidPlatform, androidTool } from "../../../scripts/android-sdk";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { isIntrinsic, loadDexes, program, world } from "./build";
import { jsTier, natives } from "./oracle";
import { reach } from "./reach";

const root = join(import.meta.dir, "../../..");
const text = readFileSync(join(root, "scripts/jbench/Bench.java"), "utf8"), out = mkdtempSync(join(tmpdir(), "j2w-jb-"));
const verbose = process.argv.includes("-v"), survey = process.argv.includes("--survey"), only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { cwd: out }); if (r.exitCode) throw new Error(`${cmd[0]}: ${r.stderr}`); };

// a workload is a `case "x": body` line of Bench.run; its body becomes `static int w_x()` so each compiles on its own
const names: string[] = [];
const methods = text.split("\n").flatMap((l) => {
  const m = /^\s*((?:case "\w+": )+)(.*)$/.exec(l); if (!m) return [];
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => (names.push(x[1]), `static int w_${x[1]}() throws Exception { String w = "${x[1]}"; ${m[2]} }`));
});
writeFileSync(join(out, "Bench.java"), text.replace(/}\s*$/, methods.join("\n") + "\n}\n"));
sh(["javac", "--release", "11", "-cp", `${androidPlatform(35)}/android.jar`, "-d", out, "Bench.java"]);
sh([androidTool("d8"), "--min-api", "26", "--output", out, ...readdirSync(out).filter((f) => f.endsWith(".class")).map((f) => join(out, f))]);

const dex = join(out, "classes.dex"), prog = program([dex, ...PLATFORM_JARS.map((j) => join(root, "vendor/aosp", j))]), js = await jsTier(loadDexes(dex));
const todo = names.filter((n) => !only.length || only.includes(n));
const isIntr = isIntrinsic(natives);
const reaches = new Map<string, ReturnType<typeof reach>>();
if (survey) {
  for (const w of todo) reaches.set(w, reach(prog, [prog.resolve("Bench", `w_${w}`, "()I")!], { instantiate: [], methods: [] }, isIntr));
  const union = new Map([...reaches.values()].flatMap((r) => [...r.methods]));
  console.log(`${todo.length} workloads reach ${union.size} methods in the closed world`);
  const w = world(prog, { natives }), t0 = performance.now();
  const gaps = new Set([...union.values()].flatMap((m) => w.gapsOf(m)).concat([...reaches.values()].flatMap((r) => [...r.unresolved])));
  console.log(`closed-world compile of all ${union.size}: ${((performance.now() - t0) / 1000).toFixed(1)} s, ${gaps.size} blockers`);
  if (verbose) console.log("    " + [...gaps].join("\n    "));
}

// a fresh World per workload: its state (class initialisers cut short by a gap) must not leak into the next, and the numbers are cold-start costs
const total = { methods: 0, units: 0, compileMs: 0, instantiateMs: 0, classes: 0, classMs: 0 };
for (const name of todo) {
  let want: string, got: string, hit: number[] = [];
  const w = world(prog, { natives });
  w.onGap = (id) => hit.push(id);
  try { want = String(await js("Bench", `w_${name}`, "()I", [])); } catch (e) { want = "throw"; }
  const t0 = performance.now();
  try { got = String(w.entry("Bench", `w_${name}`, "()I")()); } catch (e) {
    got = "trap";
    const t = w.throwable(e);
    if (verbose && !hit.length) console.log("   ", t ? "uncaught " + w.classNameOf(t) : String(e).slice(0, 200));
  }
  const ms = performance.now() - t0;
  for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += w.stats[k];
  console.log(`${name.padEnd(15)} reach=${String(reaches.get(name)?.methods.size ?? "-").padStart(5)} compiled=${String(w.stats.methods).padStart(4)} classes=${String(w.stats.classes).padStart(3)} ${ms.toFixed(0).padStart(5)} ms  js=${want} wasm=${got}${got === want ? " MATCH" : hit.length ? ` BLOCKED at ${w.gapList[hit[0]]}` : " DIFF"}`);
  if (got !== want && !hit.length) process.exitCode = 1;
}
console.log(`total: ${total.methods} methods compiled in ${total.compileMs.toFixed(0)} ms (instantiate ${total.instantiateMs.toFixed(0)} ms), ${total.classes} class modules (${total.classMs.toFixed(0)} ms)`);
