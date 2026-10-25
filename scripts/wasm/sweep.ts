// Validation sweep: every method with code in the given jars or APKs (default: the first six boot jars, up to framework.jar, and apks/FitNotes.apk) is compiled alone by the
// Wasm compiler against the whole boot class path, and each failure is reported by cause: a gap (a construct with no translation, recorded by
// Compiler.gap), a compiler exception, or a module the selected engine rejects. The exit status is non-zero when a cause outside KNOWN occurs.
// Each worker thread (sweepworker.ts) sweeps its share of every target's methods.
// Run from the repository root: pnpm wasm sweep [path ...] [-v] [--jobs n]
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { ROOT, platformJars } from "./paths.ts";
import { cli, jobsOf } from "../args.ts";
import type { Shard, Swept } from "./sweepworker.ts";

const KNOWN = [/^native: /];
const { values: { verbose, jobs }, positionals: args } = cli("pnpm wasm sweep [path ...] [-v] [--jobs n]", { verbose: { type: "boolean", short: "v" }, jobs: { type: "string" } });
// Check methods separately as well as in their AOT groups, since grouping changes inlining and imports.
const targets = args.length ? args.map((a) => resolve(a)) : [...platformJars("core-oj", "core-libart", "okhttp", "bouncycastle", "apache-xml", "framework"), join(ROOT, "apks/FitNotes.apk")];
const of = jobsOf(jobs, Math.min(availableParallelism(), 8));
const shards = await Promise.all(Array.from({ length: of }, (_, shard) => new Promise<Swept[]>((done, failed) => {
  new Worker(join(import.meta.dirname, "sweepworker.ts"), { workerData: { targets, shard, of, verbose: !!verbose } satisfies Shard }).once("message", done).once("error", failed);
})));
let unexplained = 0;
for (const [t, target] of targets.entries()) {
  const parts = shards.map((s) => s[t]), sum = (k: "total" | "clean" | "bodyless") => parts.reduce((n, p) => n + p[k], 0);
  const causes = new Map<string, string[]>(), linked = new Map<string, number>();
  for (const p of parts) {
    for (const [cause, ids] of Object.entries(p.causes)) causes.set(cause, [...causes.get(cause) ?? [], ...ids]);
    for (const [t, n] of Object.entries(p.linked)) linked.set(t, (linked.get(t) ?? 0) + n);
  }
  const total = sum("total"), clean = sum("clean");
  console.log(`${target}: ${total} methods with code (${sum("bodyless")} without), ${clean} validate clean, ${total - clean} fail in ${Math.max(...parts.map((p) => p.seconds)).toFixed(0)} s`);
  if (linked.size) console.log(`  ${[...linked.values()].reduce((a, b) => a + b, 0)} methods throw a link error at a site, as ART does (${[...linked].map(([t, n]) => `${t} ${n}`).join(", ")}), counted as validated`);
  if (verbose) for (const msg of new Set(parts.flatMap((p) => p.links))) console.log("    link error: " + msg);
  for (const [cause, ms] of [...causes].sort((a, b) => b[1].length - a[1].length)) {
    const known = KNOWN.some((k) => k.test(cause));
    if (!known) unexplained += ms.length;
    console.log(`  ${String(ms.length).padStart(6)} ${known ? "known      " : "UNEXPLAINED"} ${cause}  e.g. ${ms[0]}`);
    if (verbose) for (const id of ms) console.log("           " + id);
  }
}
console.log(unexplained ? `${unexplained} failures without an explained cause` : "no unexplained failures");
process.exit(unexplained ? 1 : 0);
