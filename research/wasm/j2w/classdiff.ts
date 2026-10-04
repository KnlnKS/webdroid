// Class-model differential test: the static int(int) methods of java/C.java, compiled to Wasm over the AOSP boot dex, against
// the production JS tier and the JDK. Each method runs once (class initialization state persists in every tier).
// Needs javac, d8 and java on PATH. Run: bun classdiff.ts [method-name-filter]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { compile, hostImports, loadDexes, program } from "./build";
import { exportName } from "./j2w";
import { jsTier } from "./oracle";
import { compare, genCases } from "./cases";

const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-c-"));
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd: out });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(here, "java/C.java"), join(here, "java/Ref.java")]);
sh(["d8", "--release", "--min-api", "26", "--output", out, ...new Bun.Glob("C*.class").scanSync(out).toArray().map((f) => join(out, f))]);

const dex = join(out, "classes.dex"), jars = PLATFORM_JARS.slice(0, 2).map((j) => join(here, "../../../vendor/aosp", j));
const prog = program([dex, ...jars]);
const only = process.argv[2];
const methods = prog.require("C").methods.filter((m) => m.isStatic && m.codeOff && m.name !== "<clinit>" && (!only || m.name.includes(only)));
const { bytes, cx } = compile(prog, methods.map((m) => ["C", m.name, m.desc]));
const js = await jsTier(loadDexes(dex));
const hit: number[] = [], gapAt = [...cx.gaps.keys()];
const { instance } = await WebAssembly.instantiate(bytes, hostImports((id) => hit.push(id)));
console.log(`${methods.length} methods, ${cx.r.methods.size} reached, ${(bytes.length / 1024).toFixed(0)} KB; ${cx.gaps.size} gaps, ${cx.r.unresolved.size} unresolved`);
const cases = genCases(methods, Object.fromEntries(methods.map((m) => [m.name, [0]])));
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `C.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
// Methods named jsWrong_* pin behaviour the JS tier gets wrong: Wasm must match the JDK there, and the JS tier is expected to differ.
let bad = 0, pinned = 0;
for (const [i, c] of cases.entries()) {
  const exp = jdk[i], name = `C.${c.m.name}`, wrong = c.m.name.startsWith("jsWrong_");
  const got = async (f: () => unknown) => { try { return String(await f()); } catch { return "throw"; } };
  const wasm = await got(() => (instance.exports as any)[exportName(c.m.cls, c.m.name, c.m.desc)](0)), tier = await got(() => js(c.m.cls, c.m.name, c.m.desc, [0]));
  if (wasm !== exp) { bad++; console.log(`MISMATCH wasm/jdk ${name}: jdk=${exp} wasm=${wasm}`); }
  if (wrong) { pinned++; if (tier === exp) console.log(`${name}: the JS tier now agrees; drop the jsWrong_ prefix`); }
  else if (tier !== wasm) { bad++; console.log(`MISMATCH wasm/js ${name}: js=${tier} wasm=${wasm}`); }
}
if (hit.length) console.log("gaps hit at run time: " + [...new Set(hit)].map((i) => gapAt[i]).join("; "));
console.log(`${cases.length - bad}/${cases.length} cases ok (wasm = jdk everywhere, wasm = js tier except ${pinned} pinned js-tier divergences)`);
process.exit(bad ? 1 : 0);
