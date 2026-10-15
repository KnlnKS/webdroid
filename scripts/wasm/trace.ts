// The checks that need V8, so lazytest.ts runs this under node: JavaScriptCore reports no wasm frame offsets for stack traces, and its
// stack overflow behaves differently. The Java frames of a throwable thrown three calls deep must come back as method, DEX pc and source line.
// Run by hand: bun build trace.ts --target=node --outfile=/tmp/trace.mjs && node /tmp/trace.mjs <Ex dex> <boot jar>...
import { world } from "./lib";
import { checker } from "./tools";
import { decodeInstructions } from "../../src/jvm/prepared";

const [dex, ...jars] = process.argv.slice(2), w = world([dex, ...jars]);
const suite = checker(), { check } = suite;

const exn = w.entry("Ex", "a", "(I)Ljava/lang/Throwable;")(1) as object;
const state = w.fieldReader("java/lang/Throwable", "backtrace", "Ljava/lang/Object;")(exn) as object;
const frames = w.stackTrace(state);
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
const callA = w.entry("Ex", "a", "(I)Ljava/lang/Throwable;");
for (let i = 0; i < 6000 || (!w.stats.upgrades && i < 1e6); i++) callA(0); // the second tier waits until the program has been hot for a few ms
check("methods were recompiled", w.stats.upgrades > 0, true);
const hot = w.stackTrace(w.fieldReader("java/lang/Throwable", "backtrace", "Ljava/lang/Object;")(callA(1) as object) as object);
check("frames after the second tier", hot.slice(0, 3).map((f) => `${f.cls}.${f.method}:${f.pc}:${f.line}`).join(" "), frames.slice(0, 3).map((f) => `${f.cls}.${f.method}:${f.pc}:${f.line}`).join(" "));
let top: unknown;
try { top = w.entry("Ex", "top", "([Ljava/lang/StackTraceElement;)I")(w.entry("java/lang/Throwable", "nativeGetStackTrace", "(Ljava/lang/Object;)[Ljava/lang/StackTraceElement;")(state)); } catch (e) { top = "threw " + (w.throwable(e) ? w.classNameOf(w.throwable(e)!) : e) + " gaps " + w.gapList.join("; "); }
check("getStackTrace builds StackTraceElements", top, 15);
let overflow: unknown;
try { w.entry("Ex", "deep", "(I)I")(0); } catch (e) { overflow = e; }
const thrown = w.throwable(overflow);
check("stack overflow reaches the edge as a StackOverflowError", thrown && w.classNameOf(thrown), "java/lang/StackOverflowError");
console.log(suite.failed ? `${suite.failed} failures` : "trace: all pass", JSON.stringify(frames.slice(0, 4)));
process.exit(suite.failed ? 1 : 0);
