// Compile existing G1 fixture methods without executing or timing them; count UTF-8 encoding inside binary builds.
// bun scripts/wasm/encode-work.ts <classes.dex> [Bench|G1]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Compiler } from "../../src/wasm/compiler/j2w";
import { ModuleBuilder } from "../../src/wasm/compiler/wasmbin";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { program, world } from "./lib";
import { natives } from "./oracle";
import { AOSP } from "./paths";
import { runUnderNode } from "./undernode";

if (process.versions.bun) process.exit(await runUnderNode(import.meta.path, process.argv.slice(2)));
const dex = process.argv[2];
if (!dex) throw new Error("fixture classes.dex required");
if (process.env.WEBDROID_AOT) throw new Error("compile-only control requires no AOT override");
const prog = program([dex, ...PLATFORM_JARS.map(jar => join(AOSP, jar))]);
const encode = TextEncoder.prototype.encode, build = ModuleBuilder.prototype.build;
let active = false, calls = 0, characters = 0, allocations = 0;
const modules: { bytes: number; sha256: string }[] = [];
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
TextEncoder.prototype.encode = function (text = "") {
  const result = encode.call(this, text);
  if (active) { calls++; characters += text.length; allocations += result.length; }
  return result;
};
ModuleBuilder.prototype.build = function (...args) {
  active = true;
  try { const bytes = build.apply(this, args); modules.push({ bytes: bytes.length, sha256: hash(bytes) }); return bytes; }
  finally { active = false; }
};
const roots: { method: string; sha256: string; traces: string; gaps: string[] }[] = [];
try {
  for (const cls of process.argv[3] ? [process.argv[3]] : ["Bench", "G1"]) {
    for (const method of prog.require(cls).methods.filter(m => m.isStatic && m.name.startsWith("w_") && m.desc === "()I")) {
      const cx = new Compiler(world(prog, { natives })), built = cx.buildUnit([method]);
      roots.push({ method: `${cls}.${method.name}`, sha256: hash(built.bytes), traces: hash(JSON.stringify(built.traces.map(t => ({ name: t.name, offsets: [...t.offsets], pcs: [...t.pcs] })))), gaps: cx.gaps });
    }
  }
  if (!roots.length || roots.some(root => root.gaps.length)) throw new Error("missing workload roots or compiler gaps");
} finally { TextEncoder.prototype.encode = encode; ModuleBuilder.prototype.build = build; }
console.log(JSON.stringify({ fixtureSha256: hash(readFileSync(dex)), timed: false, roots, modules, work: { encodeCalls: calls, encodedCharacters: characters, allocatedUtf8Bytes: allocations } }));
