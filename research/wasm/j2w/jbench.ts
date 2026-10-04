// Each scripts/jbench workload, cut out of Bench.java as its own static method, compiles to Wasm over the AOSP boot dex in one
// module and runs against the production JS tier; what blocks each workload is listed.
// Needs the Android SDK (android.jar, d8) and javac. Run: bun jbench.ts [workload ...] [-v]
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidPlatform, androidTool } from "../../../scripts/android-sdk";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { compile, hostImports, loadDexes, program } from "./build";
import { exportName, SEED_CLASSES } from "./j2w";
import { intrinsics } from "./intrinsics";
import { jsTier } from "./oracle";
import { reach } from "./reach";

const root = join(import.meta.dir, "../../..");
const text = readFileSync(join(root, "scripts/jbench/Bench.java"), "utf8"), out = mkdtempSync(join(tmpdir(), "j2w-jb-"));
const verbose = process.argv.includes("-v"), only = process.argv.slice(2).filter((a) => a !== "-v");
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
const { bytes, cx, ms } = compile(prog, todo.map((w) => ["Bench", `w_${w}`, "()I"]));
const module = await WebAssembly.compile(bytes);
console.log(`one module, ${todo.length} workloads: ${cx.r.methods.size} methods, ${(bytes.length / 1048576).toFixed(1)} MB, compiled in ${(ms / 1000).toFixed(1)} s; unstructured=${cx.stats.unstructured}`);
const gapAt = [...cx.gaps.keys()], bad = [...gapAt, ...[...cx.r.unresolved].filter((b) => b.includes(": ") || b.startsWith("missing"))];
const blockers = (reached: Iterable<string>) => { const set = new Set(reached); return bad.filter((b) => set.has(b.split(": ")[0]) || b.startsWith("missing")); };
const kind = (b: string) => (b.split(": ").slice(1).join(": ").split(" ").filter((w) => /^[a-z][a-z-]*(\/[a-z]+)?$/.test(w)).slice(0, 4).join(" ")) || b.split(" ")[0];
const tally = (bs: string[]) => { const c = new Map<string, number>(); for (const b of bs) c.set(kind(b), (c.get(kind(b)) ?? 0) + 1); return [...c].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}:${n}`).join(" "); };

const reaches = new Map(todo.map((w) => [w, reach(prog, [prog.resolve("Bench", `w_${w}`, "()I")!], { instantiate: SEED_CLASSES, methods: [] }, (m) => intrinsics.has(m.cls + "." + m.key)).methods] as const));
const union = new Set([...reaches.values()].flatMap((r) => [...r.keys()]));
console.log(`blockers in the ${union.size} methods the workloads reach: ${blockers(union).length} [${tally(blockers(union))}]`);
if (verbose) console.log("    " + blockers(union).join("\n    "));

for (const w of todo) {
  let want: string, got: string, hit: number[] = [];
  try { want = String(await js("Bench", `w_${w}`, "()I", [])); } catch (e) { want = "throw"; }
  try { got = String(((await WebAssembly.instantiate(module, hostImports((id) => hit.push(id)))).exports as any)[exportName("Bench", `w_${w}`, "()I")]()); } catch { got = "trap"; }
  console.log(`${w.padEnd(15)} reach=${String(reaches.get(w)!.size).padStart(5)} blockers=${String(blockers(reaches.get(w)!.keys()).length).padStart(4)}  js=${want} wasm=${got}${got === want ? " MATCH" : hit.length ? ` BLOCKED at ${gapAt[hit[0]]}` : " DIFF"}`);
  if (got !== want && !hit.length) process.exitCode = 1;
}
