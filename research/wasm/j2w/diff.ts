// Differential test: every static method of W.java and S.java runs as Wasm (this compiler, S over the AOSP boot dex), on the JDK and on the
// production JS tier; results must be bit-identical. Needs javac, d8 and java on PATH. Run: bun diff.ts [method-name-filter]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { loadDexes, world } from "./build";
import { jsTier, natives } from "./oracle";
import { ACC } from "./program";
import { compare, genCases } from "./cases";

const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-"));
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd: out });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(here, "java/W.java"), join(here, "java/S.java"), join(here, "java/Ref.java")]);
sh(["d8", "--release", "--output", out, join(out, "W.class"), join(out, "S.class")]);

const dex = join(out, "classes.dex");
const w = world([dex, ...PLATFORM_JARS.slice(0, 2).map((j) => join(here, "../../../vendor/aosp", j))], { natives }), hit: string[] = [];
w.onGap = (id) => hit.push(w.gapList[id]);
const methods = ["W", "S"].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && m.flags & ACC.PUBLIC));
const js = await jsTier(loadDexes(dex));
const entries = new Map(methods.map((m) => [m, w.entry(m.cls, m.name, m.desc)]));
const small: Record<string, number[]> = {
  fib: [0, 1, 2, 10, 20], sieve: [0, 1, 2, 10, 1000, 100000], xorshift: [0, 1, 10, 1000], mandel: [0, 1, 5, 24], swsum: [0, 1, 7, 100, 1000],
  basics: [0, 1, 2, 5, 17], wide: [0, 1, 2, 9, 33], parts: [0, 1, 4, 9, 20], sb: [0, 1, 3, 12, 40], sw: [0, 1, 2, 3, 4, 7], cmp: [0, 1, 6, 15], bytes: [0, 1, 7, 64], chars: [0, 1, 4, 30],
  copy: [0, 1, 3, 8], enc: [0, 1, 5, 20], statics: [0, 5], dispatch: [0, 1, 2, 9], map: [0, 1, 5, 40], err: [-1, 0, 2, 3, 4], err2: [-1, 0, 4, 5], err3: [-1, 0, 2, 3, 5],
  floats: [0, 1, 10, 1000, 100000], collatz: [1, 2, 3, 27, 1000], nested: [0, 1, 5, 12, 30], mix: [0, 1, 10, 1000], arrays: [0, 1, 5, 100], objs: [0, 1, 5, 100], tryNeg: [-1, 0, 5, -100],
};
const cases = genCases(methods.filter((m) => !process.argv[2] || m.name.includes(process.argv[2])), small);
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `${c.m.cls}.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
const { bad, explained, blocked } = await compare(cases, (m) => entries.get(m)!, js, jdk, hit);
console.log(`${cases.length - blocked - bad}/${cases.length - blocked} cases match across ${methods.length} methods (wasm, js tier, jdk)${explained ? `; ${explained} js-tier results explained by JSC wording` : ""}`);
console.log(`compiled ${w.stats.methods} methods (${w.stats.units} modules) in ${w.stats.compileMs.toFixed(0)} ms, ${w.stats.classes} class modules, instantiate ${w.stats.instantiateMs.toFixed(0)} ms`);
if (blocked) console.log(`${blocked} cases blocked by a compiler gap: ${[...new Set(hit)].join("; ")}`);
process.exit(bad ? 1 : 0);
