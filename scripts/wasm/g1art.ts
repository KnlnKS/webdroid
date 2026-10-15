// The ART headroom ratio: g1.ts's workloads (Bench.java and G1.java, each case cut into its own method) as one dex, run by app_process on the
// reference device (booted, adb reachable) and timed per call as g1run times them, each run a fresh process. With --ref (a `g1 --json` report)
// each row shows how many times slower the Wasm tier is than ART, first call and steady state.
//   bun scripts/wasm/g1art.ts [workload ...] [--reps 100] [--runs 3] [--ref g1.json] [--engine chrome|node]
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adb } from "../adb";
import { JAVA, ROOT } from "./paths";
import { cutWorkloads, dexAndroid, shellIn } from "./tools";

const flag = (k: string, d: string) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const reps = +flag("--reps", "100"), runs = +flag("--runs", "3"), refPath = flag("--ref", ""), engine = flag("--engine", "chrome");
const only = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));

const dir = mkdtempSync(join(tmpdir(), "g1art-")), classOf = new Map<string, string>();
for (const [cls, file] of [["Bench", join(ROOT, "scripts/jbench/Bench.java")], ["G1", join(JAVA, "G1.java")]]) {
  const { names, source } = cutWorkloads(readFileSync(file, "utf8"));
  for (const n of names) classOf.set(n, cls);
  writeFileSync(join(dir, `${cls}.java`), source);
}
writeFileSync(join(dir, "G1Art.java"), `public class G1Art {
  public static void main(String[] a) throws Throwable {
    int reps = Integer.parseInt(a[0]);
    java.lang.reflect.Method m = Class.forName(a[1]).getDeclaredMethod("w_" + a[2]);
    m.setAccessible(true);
    StringBuilder sb = new StringBuilder();
    Object r = null;
    try { for (int i = 0; i <= reps; i++) { long t = System.nanoTime(); r = m.invoke(null); sb.append(' ').append((System.nanoTime() - t) / 1e6); } }
    catch (java.lang.reflect.InvocationTargetException e) { System.out.println("! " + e.getCause()); return; }
    System.out.println(r + " =" + sb);
  }
}
`);
dexAndroid(shellIn(dir), dir, ["Bench.java", "G1.java", "G1Art.java"]);
const remote = "/data/local/tmp/webdroid-g1art.dex";
adb("push", join(dir, "classes.dex"), remote);

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const refRows = new Map<string, { first: number[]; steady: number[]; result: string }>(refPath ? JSON.parse(readFileSync(refPath, "utf8")).engines[engine].rows.map((r: { w: string }) => [r.w, r]) : []);
const todo = [...classOf.keys()].filter((w) => only.length ? only.includes(w) : !refPath || refRows.has(w));
const ratios: number[] = [];
console.log("workload".padEnd(16), "result".padStart(12), "first".padStart(9), "steady".padStart(9), ...(refPath ? [`${engine} first x`.padStart(15), "steady x".padStart(9)] : []));
for (const w of todo) {
  const first: number[] = [], steady: number[] = [];
  let result = "", error = "";
  for (let i = 0; i < runs; i++) {
    const out = adb("shell", `CLASSPATH=${remote} app_process / G1Art ${reps} ${classOf.get(w)} ${w}`);
    if (out.startsWith("!")) { error = out; break; }
    const [answer, times] = out.split(" ="), t = times.trim().split(" ").map(Number);
    result = answer; first.push(t[0]); steady.push(med(t.slice(Math.max(1, t.length >> 1))));
  }
  if (error) { console.log(w.padEnd(16), "FAILED", error.slice(0, 120)); continue; }
  const ref = refRows.get(w), cells = [result.padStart(12), med(first).toFixed(3).padStart(9), med(steady).toFixed(3).padStart(9)];
  if (ref) {
    const xs = med(ref.steady) / med(steady);
    ratios.push(xs);
    cells.push((med(ref.first) / med(first)).toFixed(1).padStart(15), xs.toFixed(1).padStart(9), ref.result === result ? "" : `  (answer ${ref.result})`);
  }
  console.log(w.padEnd(16), ...cells);
}
if (ratios.length) console.log(`\ngeometric mean of the steady-state ratio (Wasm tier / ART) over ${ratios.length} workloads: ${Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length).toFixed(2)}x`);
