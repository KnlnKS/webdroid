// Compile sweep: every method with code in the given jars or APKs (default: the AOSP framework.jar and apks/FitNotes.apk) is compiled alone by the
// Wasm compiler against the whole boot class path, and each failure is reported by cause: a gap (a construct with no translation, recorded by
// Compiler.gap), a compiler exception, or a module V8 rejects. The exit status is non-zero when a cause outside KNOWN occurs.
// Run from the repository root: bun research/wasm/j2w/sweep.ts [path ...] [-v]
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { loadDexes, world } from "./build";
import { externs } from "./intrinsics";
import { Program } from "./program";
import { Compiler } from "./j2w";
import { natives } from "./oracle";
import { mid } from "./reach";

/** what is understood and not yet translated: natives with no host implementation, references to platform APIs the boot jars lack, String constructors strings.ts lacks, MethodHandle call sites
 *  and invoke-custom (poly.ts handles VarHandle only), and a body whose flow Flow proves irreducible */
const KNOWN = [/^native: /, /^unresolved reference to a /, /^String\.<init>\(/, /^invoke-custom$/, /^java\/lang\/invoke\/MethodHandle\.invoke/, /^unstructured: irreducible$/];

const root = join(import.meta.dir, "../../..");
const verbose = process.argv.includes("-v"), args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = args.length ? args : [join(root, "vendor/aosp/framework.jar"), join(root, "apks/FitNotes.apk")];
const jars = PLATFORM_JARS.map((j) => join(root, "vendor/aosp", j));
let unexplained = 0;
for (const target of targets) {
  // the boot class path comes first, as in ART: an app's stubs of platform classes (R8 API outlines) never shadow the platform's, and an app sees only the platform
  const dexes = jars.includes(target) ? jars.map(loadDexes) : [...jars.map(loadDexes), loadDexes(target)];
  const mine = new Set(dexes.at(jars.includes(target) ? jars.indexOf(target) : -1)), prog = new Program(dexes.flat());
  prog.addExterns(externs);
  const w = world(prog, { natives });
  const names = new Set([...prog.classes.values()].filter((c) => c.dex && mine.has(c.dex)).map((c) => c.name));
  // such a reference (an optional library, a newer SDK than this build, a field R8 left dangling) throws a link error in ART when it executes
  const causeOf = (what: string, m: string) => {
    const cause = what.startsWith(m + ": ") ? what.slice(m.length + 2) : what;
    const owner = /^(?:unresolved \w+|field not found) ([^.]+)\./.exec(cause)?.[1];
    return owner === undefined ? cause.replace(/\d+/g, "N") : `unresolved reference to a ${names.has(owner) ? "member its app class lacks" : "platform class or member the boot jars lack"}`;
  };
  const causes = new Map<string, string[]>();
  let total = 0, clean = 0, bodyless = 0;
  const t0 = performance.now();
  for (const name of names) for (const m of w.prog.get(name)?.methods ?? []) {
    if (!m.codeOff) { bodyless++; continue; }
    total++;
    const id = mid(m), fail = (cause: string) => (causes.get(cause) ?? (causes.set(cause, []), causes.get(cause)!)).push(id);
    try {
      const cx = new Compiler(w), { bytes } = cx.buildUnit([m]);
      if (cx.gaps.length) for (const g of new Set(cx.gaps.map((g) => causeOf(g, id)))) fail(g);
      else {
        try { new WebAssembly.Module(bytes as BufferSource); clean++; } catch (e) { fail("invalid module: " + (e as Error).message.replace(/.*?: /, "").replace(/@\+\d+/g, "").replace(/\d+/g, "N")); }
      }
    } catch (e) { fail("compiler crash: " + (e as Error).message.replace(/\d+/g, "N")); }
  }
  console.log(`${target}: ${total} methods with code (${bodyless} without), ${clean} compile clean, ${total - clean} fail in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  for (const [cause, ms] of [...causes].sort((a, b) => b[1].length - a[1].length)) {
    const known = KNOWN.some((k) => k.test(cause));
    if (!known) unexplained += ms.length;
    console.log(`  ${String(ms.length).padStart(6)} ${known ? "known      " : "UNEXPLAINED"} ${cause}  e.g. ${ms[0]}`);
    if (verbose) for (const id of ms) console.log("           " + id);
  }
}
console.log(unexplained ? `${unexplained} failures without an explained cause` : "no unexplained failures");
process.exit(unexplained ? 1 : 0);
