// Prints the generated code of a method as text: runs a jbench workload (as g1.ts does) and disassembles (binaryen's wasm-dis) every unit module the linker
// built whose function names contain the filter. Run: bun run wasm watdump <workload> <method-name-filter> (needs the dex g1.ts builds)
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { program, world } from "./lib.ts";
import { mountPlatform, natives, startProcess } from "./harness.ts";
import { G1_DIR, PLATFORM_PATHS, ROOT } from "./paths.ts";

const [workload, filter] = process.argv.slice(2);
const dex = join(G1_DIR, "classes.dex");
await mountPlatform(ROOT);
const w = world(program([dex, ...PLATFORM_PATHS]), { natives });
await startProcess(w);
const units: Uint8Array[] = [];
const inst = (w as unknown as { instantiate(b: Uint8Array, i: unknown): unknown }).instantiate;
(w as unknown as { instantiate: unknown }).instantiate = function (this: unknown, bytes: Uint8Array, imports: unknown) { units.push(bytes); return inst.call(this, bytes, imports); };
const call = w.entryAsync(process.env.CLS ?? "Bench", `w_${workload}`, "()I"); for (let i = 0; i < Number(process.env.CALLS ?? 1); i++) await call();
const bin = join(ROOT, "research/wasm/node_modules/.bin/wasm-dis"), file = join(G1_DIR, "unit.wasm");
for (const bytes of units) {
  writeFileSync(file, bytes);
  const text = Bun.spawnSync([bin, "-all", file]).stdout.toString();
  for (const fn of text.split(/\n(?= \(func )/).filter((f) => f.startsWith(" (func") && !f.startsWith(" (func $stub:") && f.split("\n")[0].includes(filter))) console.log(fn);
}
