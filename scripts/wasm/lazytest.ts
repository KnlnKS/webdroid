// The linker's own tests: CHA devirtualisation undone by a dex loaded later, the implicit exceptions with their messages, heap limits,
// stack traces, StackOverflowError at the Java edge. Needs javac and d8. Run: pnpm wasm lazytest
import { join } from "node:path";
import { loadDexes, world } from "./lib.ts";
import { HEAP_LIMIT } from "../../src/jvm/abi.ts";
import { decodeInstructions } from "../../src/jvm/prepared.ts";
import { JAVA, platformJars } from "./paths.ts";
import { checker, filesIn, fixture } from "./tools.ts";
import { Natives } from "../../src/wasm/host/natives.ts";

const jars = platformJars("core-oj", "core-libart");
const out = fixture({ sources: ["W", "Ex", "Lz", "Lz2"].map((n) => join(JAVA, `${n}.java`)), classes: /^(Ex|Lz)(\$\w+)?\.class$/ });
fixture({ out: join(out, "out2"), classpath: [out], classes: filesIn(out, /^Lz2(\$\w+)?\.class$/) });

const suite = checker("lazytest"), { check } = suite;

// ---- CHA under open-world loading: the app's dexes join the hierarchy as they are added, another loader's classes once they are linked
for (const own of [false, true]) {
  const w = world([join(out, "classes.dex"), ...jars]), loader = own ? w.prog.newLoader(w.prog.root, null) : w.prog.root;
  check("Lz.test before", w.entry("Lz", "test", "()I")(), 11);
  const t = w.stats.units;
  check("Lz.test again compiles nothing", (w.entry("Lz", "test", "()I")(), w.stats.units - t), 0);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")), loader);
  check(`Lz2.test after${own ? " in its own loader" : ""}`, w.entry(own ? `Lz2@${loader.id}` : "Lz2", "test", "()I")(), 12);
  check("Lz.test after", w.entry("Lz", "test", "()I")(), 11);
}

for (const [hot, own] of [[false, false], [true, false], [true, true]]) {
  let loading = !hot;
  const late = Object.assign(() => {
    if (!loading) return w.entry("Lz", "first", "()LLz$A;")();
    const loader = own ? w.prog.newLoader(w.prog.root, null) : w.prog.root;
    w.addDexes(loadDexes(join(out, "out2/classes.dex")), loader);
    return w.entry(own ? `Lz2@${loader.id}` : "Lz2", "make", "()LLz$A;")();
  }, { javaValues: true });
  const w = world([join(out, "classes.dex"), ...jars], { natives: new Natives({
    find: (cls, key) => cls === "Lz" && key === "late()LLz$A;" ? late : undefined,
    thrown: () => undefined,
  }) });
  const call = w.entry("Lz", "active", "()I");
  if (hot) {
    check("active before loading", call(), 1);
    const slot = w.slotOf(w.prog.resolve("Lz", "active", "()I")!), initial = w.table.get(slot);
    for (let i = 0; i < 1e6 && w.table.get(slot) === initial; i++) call();
    check("active frame's method was promoted", w.table.get(slot) !== initial, true);
    loading = true;
  }
  check(`${hot ? "hot" : "cold"} active frame sees a native-loaded override${own ? " of its own loader" : ""}`, call(), 2);
}

// ---- tiers: a method that uses up its budget is recompiled (here inside a loop, so the next call is the second tier) and answers the same
{
  const w = world([join(out, "classes.dex"), ...jars]), call = w.entry("Lz", "sum", "(I)I");
  let first = call(40000);
  const slot = w.slotOf(w.prog.resolve("Lz", "sum", "(I)I")!), initial = w.table.get(slot);
  // the second tier waits until the program has been hot for a few ms
  if (w.upgradeJob(slot)) for (let i = 0; i < 1e4 && w.table.get(slot) === initial; i++) first = call(40000);
  const up = w.stats.upgrades;
  check("hot loop upgraded", up >= 1, true);
  check("second tier answers the same", call(40000), first);
  check("an upgraded method is not queued again", (call(40000), w.upgradeJob(slot)), undefined);
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
  check("no stray gaps", w.numbers.gapList.filter((g) => !g.endsWith("static string value")).join("; "), "");
}
// ---- the heap check at the end of each allocation window decides an OutOfMemoryError
{
  let checks = 0;
  const w = world([join(out, "classes.dex"), ...jars], { heapUsed: () => (++checks > 3 ? HEAP_LIMIT + 1 : 0) });
  const n = w.entry("Ex", "churn", "(I)I")(1000) as number;
  check("churn runs out after a few windows", n < 0 && n > -20 ? "" : n, "");
}
// ---- stack traces: the Java frames of a throwable thrown three calls deep come back as method, DEX pc and source line
{
  const w = world([join(out, "classes.dex"), ...jars]), callA = w.entry("Ex", "a", "(I)Ljava/lang/Throwable;");
  const backtrace = w.fieldReader("java/lang/Throwable", "backtrace", "Ljava/lang/Object;"), state = backtrace(callA(1) as object) as object;
  const frames = w.stackTrace(state), where = (fs: typeof frames) => fs.slice(0, 3).map((f) => `${f.cls}.${f.method}:${f.pc}:${f.line}`).join(" ");
  check("frames", frames.slice(0, 3).map((f) => `${f.cls}.${f.method}`).join(" "), "Ex.c Ex.b Ex.a");
  for (const f of frames.slice(0, 3)) {
    const m = w.prog.resolve("Ex", f.method, f.method === "a" ? "(I)Ljava/lang/Throwable;" : "(I)V")!;
    const ins = decodeInstructions(m.dex.code(m.codeOff).insns).find((i) => i.pc === f.pc);
    // the pc is that of a call: the exception's constructor in c, the next frame's method in b and a
    check(`pc of ${f.method} is an invoke`, ins?.name.startsWith("invoke"), true);
    check(`line of ${f.method}`, f.line > 0, true);
  }
  check("lines follow the source", frames[0].line < frames[1].line && frames[1].line < frames[2].line, true);
  // the same after the three methods have run enough to be recompiled with each other copied in (the frames of a copy carry the same names)
  for (let i = 0; i < 6000 || (!w.stats.upgrades && i < 1e6); i++) callA(0); // the second tier waits until the program has been hot for a few ms
  check("methods were recompiled", w.stats.upgrades > 0, true);
  check("frames after the second tier", where(w.stackTrace(backtrace(callA(1) as object) as object)), where(frames));
  let top: unknown;
  try { top = w.entry("Ex", "top", "([Ljava/lang/StackTraceElement;)I")(w.entry("java/lang/Throwable", "nativeGetStackTrace", "(Ljava/lang/Object;)[Ljava/lang/StackTraceElement;")(state)); }
  catch (e) { top = "threw " + (w.throwable(e) ? w.classNameOf(w.throwable(e)!) : e) + " gaps " + w.numbers.gapList.join("; "); }
  check("getStackTrace builds StackTraceElements", top, 15);
}
// ---- stack overflow: V8 will not let Wasm catch it, so it surfaces as a StackOverflowError at the edge of the Java world
{
  const w = world([join(out, "classes.dex"), ...jars]);
  let thrown: unknown;
  try { w.entry("Ex", "deep", "(I)I")(0); } catch (e) { thrown = e; }
  const t = w.throwable(thrown);
  check("stack overflow becomes a StackOverflowError", t && w.classNameOf(t), "java/lang/StackOverflowError");
}
suite.done();
