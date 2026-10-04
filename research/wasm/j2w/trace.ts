// The checks that need V8, so lazytest.ts runs this under node: JavaScriptCore reports no wasm frame offsets for stack traces, and its
// stack overflow behaves differently. The Java frames of a throwable thrown three calls deep must come back as method, DEX pc and source line.
// Run by hand: bun build trace.ts --target=node --outfile=/tmp/trace.mjs && node /tmp/trace.mjs <Ex dex> <boot jar>...
import { world } from "./build";
import { decodeInstructions } from "../../../src/jvm/prepared";

const [dex, ...jars] = process.argv.slice(2), w = world([dex, ...jars]);
let failed = 0;
const check = (what: string, got: unknown, want: unknown) => { if (got !== want) { failed++; console.log(`FAIL ${what}: got ${String(got)}, want ${String(want)}`); } };

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
let overflow: unknown;
try { w.entry("Ex", "deep", "(I)I")(0); } catch (e) { overflow = e; }
const thrown = w.throwable(overflow);
check("stack overflow reaches the edge as a StackOverflowError", thrown && w.classNameOf(thrown), "java/lang/StackOverflowError");
console.log(failed ? `${failed} failures` : "trace: all pass", JSON.stringify(frames.slice(0, 4)));
process.exit(failed ? 1 : 0);
