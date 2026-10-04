// Prints the generated code of a method as text: runs a jbench workload (as g1.ts does) and disassembles (binaryen's wasm-dis) every unit module the linker
// built whose function names contain the filter. Run: bun watdump.ts <workload> <method-name-filter> (needs the dex g1.ts builds)
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { program, world } from "./build";
import { jsTier, natives } from "./oracle";
import { loadDexes } from "./build";

const [workload, filter] = process.argv.slice(2), root = join(import.meta.dir, "../../..");
const dex = join(tmpdir(), "g1/classes.dex");
await jsTier(loadDexes(dex));
const w = world(program([dex, ...PLATFORM_JARS.map((j) => join(root, "vendor/aosp", j))]), { natives });
const units: Uint8Array[] = [];
const inst = (w as unknown as { instantiate(b: Uint8Array, i: unknown): unknown }).instantiate;
(w as unknown as { instantiate: unknown }).instantiate = function (this: unknown, bytes: Uint8Array, imports: unknown) { units.push(bytes); return inst.call(this, bytes, imports); };
const call = w.entry("Bench", `w_${workload}`, "()I"); for (let i = 0; i < Number(process.env.CALLS ?? 1); i++) call();
const bin = join(import.meta.dir, "../node_modules/.bin/wasm-dis"), file = join(tmpdir(), "g1/unit.wasm");
for (const bytes of units) {
  writeFileSync(file, bytes);
  const text = Bun.spawnSync([bin, "-all", file]).stdout.toString();
  for (const fn of text.split(/\n(?= \(func )/).filter((f) => f.startsWith(" (func") && !f.startsWith(" (func $stub:") && f.split("\n")[0].includes(filter))) console.log(fn);
}
