// The descriptor checks of the Wasm tier's own additions; the registered specs and JNI delegates are scripts/desccheck.ts's, whose mismatches must be
// the accepted ones in tests/fixtures/desccheck-baseline.json. What the Wasm tier adds: every intrinsic (a method run as generated code instead of its body or a
// native) is keyed by class, name and descriptor, and a key the platform class does not declare never applies and nothing says so.
// Run: bun run wasm desccheck
import { readFileSync } from "node:fs";
import { externs, intrinsics } from "../../src/wasm/link/intrinsics";
import { BASELINE, descriptorMismatches, hasPlatformJars, withoutHint } from "../desccheck";
import { program } from "./lib";
import { PLATFORM_PATHS } from "./paths";

if (!hasPlatformJars()) throw new Error("no vendor/aosp platform jars: run bun run gen-framework");
let bad = 0;
const accepted: Record<string, string[]> = JSON.parse(readFileSync(BASELINE, "utf8"));
for (const [cls, found] of descriptorMismatches()) {
  const news = found.map(withoutHint).filter((m) => !accepted[cls]?.includes(m));
  for (const m of news) { bad++; console.log(`new mismatch ${cls}: ${m}`); }
}
const prog = program(PLATFORM_PATHS);
const skip = new Set(externs);
for (const key of intrinsics.keys()) {
  if (skip.has(key)) continue;
  const dot = key.indexOf("."), cls = key.slice(0, dot), sig = key.slice(dot + 1);
  if (!prog.get(cls)?.byKey.has(sig)) { bad++; console.log(`intrinsic ${key} names no method of the platform class`); }
}
console.log(bad ? `${bad} problems` : `descriptors match the baseline; ${intrinsics.size} intrinsics name platform methods`);
process.exit(bad ? 1 : 0);
