// The linker's own tests: CHA devirtualisation undone by a dex loaded later, the implicit exceptions with their messages, heap limits,
// StackOverflowError at the Java edge. Needs javac and d8. Run: bun lazytest.ts
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { loadDexes, world } from "./build";
import { HEAP_LIMIT } from "./exc";

const root = join(import.meta.dir, "../../.."), jars = PLATFORM_JARS.slice(0, 2).map((j) => join(root, "vendor/aosp", j));
const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-lz-"));
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { cwd: out }); if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`); };
const src = ["W", "Ex", "Lz", "Lz2"].map((n) => join(here, `java/${n}.java`));
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, ...src]);
const classes = (re: RegExp) => readdirSync(out).filter((f) => re.test(f)).map((f) => join(out, f));
sh(["d8", "--release", "--output", out, ...classes(/^(Ex|Lz)(\$\w+)?\.class$/)]);
sh(["mkdir", "-p", "out2"]);
sh(["d8", "--release", "--output", join(out, "out2"), "--classpath", out, ...classes(/^Lz2(\$\w+)?\.class$/)]);

let failed = 0;
const check = (what: string, got: unknown, want: unknown) => { if (got !== want) { failed++; console.log(`FAIL ${what}: got ${String(got)}, want ${String(want)}`); } };

// ---- CHA under open-world loading
{
  const w = world([join(out, "classes.dex"), ...jars]);
  check("Lz.test before", w.entry("Lz", "test", "()I")(), 11);
  const t = w.stats.units;
  check("Lz.test again compiles nothing", (w.entry("Lz", "test", "()I")(), w.stats.units - t), 0);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check("falsified assumption undone", w.stats.invalidated >= 1, true);
  check("Lz2.test after", w.entry("Lz2", "test", "()I")(), 12);
  check("Lz.test after", w.entry("Lz", "test", "()I")(), 11);
}

// ---- tiers: a method that uses up its budget is recompiled (here inside a loop, so the next call is the second tier) and answers the same
{
  const w = world([join(out, "classes.dex"), ...jars]), call = w.entry("Lz", "sum", "(I)I");
  let first = call(40000);
  // the second tier waits until the program has been hot for a few ms
  for (let i = 0; i < 1e4 && !w.stats.upgrades; i++) first = call(40000);
  const up = w.stats.upgrades;
  check("hot loop upgraded", up >= 1, true);
  check("second tier answers the same", call(40000), first);
  check("an upgraded method is not upgraded again", (call(40000), w.stats.upgrades), up);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check("a falsified assumption undoes the second tier too", w.stats.invalidated >= 1, true);
  check("and the method is compiled afresh", call(1000), 11 * 1000);
}

// ---- implicit exceptions: class (caught by Java code) and message (computed by the host)
{
  const w = world([join(out, "classes.dex"), ...jars], { heapUsed: () => 0 });
  const call = (name: string, desc: string, ...a: unknown[]) => w.entry("Ex", name, desc)(...a);
  check("div by zero", call("div", "(II)I", 5, 0), -1001); check("message", w.lastMessage, "divide by zero");
  check("div ok", call("div", "(II)I", 7, 2), 3);
  check("array index", call("idx", "(I)I", 7), -1002); check("message", w.lastMessage, "length=4; index=7");
  check("message stored in the Throwable", call("msgLen", "(I)I", 7), "length=4; index=7".length);
  check("negative index", call("idx", "(I)I", -1), -1002); check("message", w.lastMessage, "length=4; index=-1");
  check("class cast", call("cast", "(I)I", 0), -1003); check("message", w.lastMessage, "Ex$P cannot be cast to Ex$Q");
  check("class cast ok", call("cast", "(I)I", 1), 1);
  check("negative size", call("neg", "(I)I", -5), -1004); check("message", w.lastMessage, "-5");
  check("null receiver", call("npe", "(LEx$P;)I", call("mk", "(I)LEx$P;", 0)), -1005);
  check("non-null receiver", call("npe", "(LEx$P;)I", call("mk", "(I)LEx$P;", 1)), 1);
  check("array over the heap limit", call("oom", "(I)I", 1 << 30), -1006);
  check("message", w.lastMessage, `Failed to allocate a ${1 << 30} byte allocation with ${HEAP_LIMIT} free bytes`);
  check("array under it", call("oom", "(I)I", 1 << 20), 1 << 20);
  check("allocation-budget loop without a heap check failing", call("churn", "(I)I", 40), 40);
  check("instance-of past the fixed display depth", [call("deepTypes", "(I)I", 0), call("deepTypes", "(I)I", 1)].join(), "15,12");
  check("no stray gaps", w.gapList.filter((g) => !g.endsWith("static string value")).join("; "), "");
}
// ---- the heap check at the end of each allocation window decides an OutOfMemoryError
{
  let checks = 0;
  const w = world([join(out, "classes.dex"), ...jars], { heapUsed: () => (++checks > 3 ? HEAP_LIMIT + 1 : 0) });
  const n = w.entry("Ex", "churn", "(I)I")(1000) as number;
  check("churn runs out after a few windows", n < 0 && n > -20 ? "" : n, "");
}
// ---- stack overflow: V8 will not let Wasm catch it, so it surfaces as a StackOverflowError at the edge of the Java world
{
  const w = world([join(out, "classes.dex"), ...jars]);
  let thrown: unknown;
  try { w.entry("Ex", "deep", "(I)I")(0); } catch (e) { thrown = e; }
  const t = w.throwable(thrown);
  check("stack overflow becomes a StackOverflowError", t && w.classNameOf(t), "java/lang/StackOverflowError");
}
// ---- stack traces need V8 frame offsets: run trace.ts under node
const node = Bun.which("node");
if (node) {
  const built = await Bun.build({ entrypoints: [join(here, "trace.ts")], target: "node", outdir: out });
  const polyfill = "data:text/javascript,Uint8Array.fromBase64??=s=>new Uint8Array(Buffer.from(s,'base64'));Uint8Array.prototype.toHex??=function(){return Buffer.from(this).toString('hex')}";
  const r = Bun.spawnSync([node, "--import", polyfill, built.outputs[0].path, join(out, "classes.dex"), ...jars]);
  console.log(r.stdout.toString().trim() + r.stderr.toString().trim());
  if (r.exitCode) failed++;
} else console.log("trace: skipped, node (V8) not found");
console.log(failed ? `${failed} failures` : "lazytest: all pass");
process.exit(failed ? 1 : 0);
