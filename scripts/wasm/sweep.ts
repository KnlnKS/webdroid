// Validation sweep: every method with code in the given jars or APKs (default: the first six boot jars, up to framework.jar, and apks/FitNotes.apk) is compiled alone by the
// Wasm compiler against the whole boot class path, and each failure is reported by cause: a gap (a construct with no translation, recorded by
// Compiler.gap), a compiler exception, or a module the selected engine rejects. The exit status is non-zero when a cause outside KNOWN occurs.
// Run from the repository root: pnpm wasm sweep [path ...] [-v]
import { join, resolve } from "node:path";
import { world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { externs } from "../../src/wasm/link/intrinsics.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { Compiler } from "../../src/wasm/compiler/j2w.ts";
import { natives } from "./harness.ts";
import { mid } from "../../src/wasm/compiler/ids.ts";
import { compileModule, COMPILE_OPTIONS } from "../../src/wasm/link/module.ts";
import { ROOT, platformJars } from "./paths.ts";
import { PLATFORM_PATHS } from "../aosp.ts";

const KNOWN = [/^native: /];
// Validate discarded units without allocating executable code; compilation supplies rejection diagnostics.
const validate = WebAssembly.validate as unknown as (bytes: BufferSource, options: typeof COMPILE_OPTIONS) => boolean;

const verbose = process.argv.includes("-v"), args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// Check methods separately as well as in their AOT groups, since grouping changes inlining and imports.
const targets = args.length ? args.map((a) => resolve(a)) : [...platformJars("core-oj", "core-libart", "okhttp", "bouncycastle", "apache-xml", "framework"), join(ROOT, "apks/FitNotes.apk")];
const jars = PLATFORM_PATHS;
let unexplained = 0;
for (const target of targets) {
  // the boot class path comes first, as in ART: an app's stubs of platform classes (R8 API outlines) never shadow the platform's, and an app sees only the platform
  const dexes = jars.includes(target) ? jars.map(loadDexes) : [...jars.map(loadDexes), loadDexes(target)];
  const mine = new Set(dexes.at(jars.includes(target) ? jars.indexOf(target) : -1)), prog = new Program(dexes.flat());
  prog.addExterns(externs);
  const w = world(prog, { natives, compileOnly: true });
  const names = new Set([...prog.all()].filter((c) => c.dex && mine.has(c.dex)).map((c) => c.name));
  const causes = new Map<string, string[]>();
  let total = 0, clean = 0, bodyless = 0;
  const linked = new Map<string, number>();
  const t0 = performance.now();
  for (const name of names) for (const m of w.prog.get(name)?.methods ?? []) {
    if (!m.codeOff) { bodyless++; continue; }
    total++;
    const id = mid(m), fail = (cause: string) => (causes.get(cause) ?? (causes.set(cause, []), causes.get(cause)!)).push(id);
    try {
      const cx = new Compiler(w), { bytes } = cx.buildUnit([m]);
      for (const t of new Set(cx.linkErrors)) linked.set(t, (linked.get(t) ?? 0) + 1);
      if (cx.gaps.length) for (const g of new Set(cx.gaps.map((g) => (g.startsWith(id + ": ") ? g.slice(id.length + 2) : g).replace(/\d+/g, "N")))) fail(g);
      else {
        try {
          if (!validate(bytes as BufferSource, COMPILE_OPTIONS)) {
            compileModule(bytes);
            throw new Error("validator rejected module accepted by compiler");
          }
          clean++;
        } catch (e) { fail("invalid module: " + (e as Error).message.replace(/.*?: /, "").replace(/@\+\d+/g, "").replace(/\d+/g, "N")); }
      }
    } catch (e) { fail("compiler crash: " + (e as Error).message.replace(/\d+/g, "N")); }
  }
  console.log(`${target}: ${total} methods with code (${bodyless} without), ${clean} validate clean, ${total - clean} fail in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  if (linked.size) console.log(`  ${[...linked.values()].reduce((a, b) => a + b, 0)} methods throw a link error at a site, as ART does (${[...linked].map(([t, n]) => `${t} ${n}`).join(", ")}), counted as validated`);
  if (verbose) for (const msg of w.numbers.links.messages) console.log("    link error: " + msg);
  for (const [cause, ms] of [...causes].sort((a, b) => b[1].length - a[1].length)) {
    const known = KNOWN.some((k) => k.test(cause));
    if (!known) unexplained += ms.length;
    console.log(`  ${String(ms.length).padStart(6)} ${known ? "known      " : "UNEXPLAINED"} ${cause}  e.g. ${ms[0]}`);
    if (verbose) for (const id of ms) console.log("           " + id);
  }
}
console.log(unexplained ? `${unexplained} failures without an explained cause` : "no unexplained failures");
process.exit(unexplained ? 1 : 0);
