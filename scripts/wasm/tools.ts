// What the suites share besides their Java fixtures (../java.ts): checking answers, cutting workloads out of Bench, and bundling the harnesses pages run.
import { join } from "node:path";
import { bundle } from "../bundle.ts";

/** `entry` as one script for node, or for a page (g1.ts, boot-probe.ts) whose node:fs is the files it preloaded (g1fs.ts) */
export const bundleFor = (platform: "node" | "browser", entry: string): Promise<string> =>
  bundle(entry, platform === "node" ? { platform } : { alias: { "node:fs": join(import.meta.dirname, "g1fs.ts") } });

/** a workload is a `case "x": body` line of Bench.run; its body becomes `static int w_x()` so each compiles on its own */
export function cutWorkloads(text: string): { names: string[]; source: string } {
  const names: string[] = [];
  const methods = text.split("\n").flatMap((l) => {
    const m = /^\s*((?:case "\w+": )+)(.*)$/.exec(l); if (!m) return [];
    return [...m[1].matchAll(/"(\w+)"/g)].map((x) => (names.push(x[1]), `static int w_${x[1]}() throws Exception { String w = "${x[1]}"; ${m[2]} }`));
  });
  return { names, source: text.replace(/}\s*$/, methods.join("\n") + "\n}\n") };
}

/** a suite's outcome: `fail` prints and counts a failure, `check` compares a value with the one wanted (and answers whether it is),
 *  `done` prints the result and exits, with status 1 after any failure */
export function checker(name: string) {
  const t = {
    failed: 0, checks: 0,
    fail(what: string) { t.failed++; console.log("FAIL " + what); },
    check(what: string, got: unknown, want: unknown): boolean { t.checks++; if (got === want) return true; t.fail(`${what}: got ${String(got)}, want ${String(want)}`); return false; },
    done(passed = "all pass"): never { console.log(`${name}: ${t.failed ? `${t.failed} failures` : passed}`); process.exit(t.failed ? 1 : 0); },
  };
  return t;
}
export type Suite = ReturnType<typeof checker>;

