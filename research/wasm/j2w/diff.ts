// Differential test: every static method of W.java runs as Wasm (this compiler), on the JDK and on the production JS tier;
// results must be bit-identical. Needs javac, d8 and java on PATH. Run: bun diff.ts [method-name-filter]
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileModule, instantiate, loadDexes } from "./build";
import { Program } from "./program";
import { exportName } from "./j2w";
import { jsTier, natives } from "./oracle";
import { compare, genCases } from "./cases";

const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-"));
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd: out });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(here, "java/W.java"), join(here, "java/Ref.java")]);
sh(["d8", "--release", "--output", out, join(out, "W.class")]);

const dex = join(out, "classes.dex");
const methods = new Program(loadDexes(dex)).require("W").methods.filter((m) => m.isStatic && m.codeOff);
const { bytes, cx } = compile([dex], methods.map((m) => ["W", m.name, m.desc]), natives);
if (cx.gaps.size || cx.r.unresolved.size) throw new Error("compile gaps: " + JSON.stringify([...cx.gaps.keys(), ...cx.r.unresolved]));
const js = await jsTier(loadDexes(dex));
const instance = await instantiate(await compileModule(bytes), cx);
const small: Record<string, number[]> = {
  fib: [0, 1, 2, 10, 20], sieve: [0, 1, 2, 10, 1000, 100000], xorshift: [0, 1, 10, 1000], mandel: [0, 1, 5, 24], swsum: [0, 1, 7, 100, 1000],
  floats: [0, 1, 10, 1000, 100000], collatz: [1, 2, 3, 27, 1000], nested: [0, 1, 5, 12, 30], mix: [0, 1, 10, 1000], arrays: [0, 1, 5, 100], objs: [0, 1, 5, 100], tryNeg: [-1, 0, 5, -100],
};
const cases = genCases(methods.filter((m) => !process.argv[2] || m.name.includes(process.argv[2])), small);
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `W.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
const { bad, explained } = await compare(cases, (m) => exportName(m.cls, m.name, m.desc), instance.exports as any, js, jdk);
console.log(`${cases.length - bad}/${cases.length} cases match across ${methods.length} methods (wasm, js tier, jdk)${explained ? `; ${explained} js-tier results explained by JSC wording` : ""}`);
process.exit(bad ? 1 : 0);
