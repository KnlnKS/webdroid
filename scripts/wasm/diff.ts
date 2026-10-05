// Differential test: every static method of W.java and S.java (S and N need V8's stack frames, so not under Bun) runs as Wasm (this compiler, S over the AOSP boot dex), on the JDK and on the
// production JS tier; results must be bit-identical. Needs javac, d8 and java on PATH. Run: bun run wasm diff [method-name-filter]
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { loadDexes, world } from "./lib";
import { dexesIn } from "../../src/jvm/dex";
import { descToName } from "../../src/jvm/abi";
import { insnLen } from "../../src/jvm/opcodes";
import { jsTier, natives } from "./oracle";
import { ACC } from "../../src/wasm/compiler/program";
import { namesWasmFrames } from "../../src/wasm/link/exc";
import { compare, genCases } from "./cases";
import { AOSP, JAVA } from "./paths";
import { shellIn } from "./tools";

const out = mkdtempSync(join(tmpdir(), "j2w-"));
const sh = shellIn(out);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(JAVA, "W.java"), join(JAVA, "S.java"), join(JAVA, "N.java"), join(JAVA, "Ref.java")]);
sh(["d8", "--release", "--output", out, ...readdirSync(out).filter((f) => /^[WSN](\$\w+)?\.class$/.test(f)).map((f) => join(out, f))]);

const dex = join(out, "classes.dex");
// the d8 that built the apps ended a try range at the invoke, leaving its move-result outside (a block of its own, Doodle Jump's RamLogger.Append); this one keeps it inside: end every range that way
{
  const bytes = new Uint8Array(readFileSync(dex)), view = new DataView(bytes.buffer);
  for (const d of dexesIn(bytes)) for (let i = 0; i < d.classDefCount; i++) {
    const def = d.classDef(i);
    if (descToName(d.type(d.classDef2Type(i))) !== "W") continue;
    for (const m of [...def.directMethods, ...def.virtualMethods]) {
      if (!m.codeOff) continue;
      const code = d.code(m.codeOff), moves = new Set<number>();
      for (let pc = 0; pc < code.insns.length; pc += insnLen(code.insns, pc)) if ((code.insns[pc] & 0xff) >= 0x0a && (code.insns[pc] & 0xff) <= 0x0c) moves.add(pc);
      const items = m.codeOff + 16 + code.insns.length * 2 + (code.insns.length & 1) * 2;
      code.tries.forEach((t, k) => { if (moves.has(t.end - 1)) view.setUint16(items + k * 8 + 4, t.end - t.start - 1, true); });
    }
  }
  writeFileSync(dex, bytes);
}
const w = world([dex, ...[...PLATFORM_JARS.slice(0, 2), "boot/core-icu4j.jar"].map((j) => join(AOSP, j))], { natives }), hit: string[] = [];
w.onGap = (id) => hit.push(w.gapList[id]);
// S and N run String, StringBuilder and the natives over the boot dex, whose System.<clinit> reads its caller from the frames of the Wasm stack: V8 only
const methods = ["W", ...(namesWasmFrames() ? ["S", "N"] : [])].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && m.flags & ACC.PUBLIC));
const js = await jsTier(loadDexes(dex));
(globalThis as any).__dbgw = w;
const entries = new Map(methods.map((m) => [m, w.entry(m.cls, m.name, m.desc)]));
const small: Record<string, number[]> = {
  fib: [0, 1, 2, 10, 20], sieve: [0, 1, 2, 10, 1000, 100000], xorshift: [0, 1, 10, 1000], mandel: [0, 1, 5, 24], swsum: [0, 1, 7, 100, 1000],
  basics: [0, 1, 2, 5, 17], wide: [0, 1, 2, 9, 33], parts: [0, 1, 4, 9, 20], sb: [0, 1, 3, 12, 40], sw: [0, 1, 2, 3, 4, 7], cmp: [0, 1, 6, 15], bytes: [0, 1, 7, 64], chars: [0, 1, 4, 30],
  copy: [0, 1, 3, 8], fieldsInt: [0, 1, 5, 100], fieldsLong: [0, 1, 5], fieldsFloat: [0, 1, 5], fieldsFloatShort: [0, 5], fieldsFloatLong: [0], fieldsDouble: [0, 1, 5], fieldsOther: [0, 1, 5, 100], errWiden: [0], errType: [0], errNull: [0], errReceiver: [0], errRefType: [0], errNullBox: [0], errNarrow: [0], errFinal: [0], forName: [0], direct: [0, 1, 5, 40], directBulk: [0, 1, 5, 40], thread: [0, 3], unicode: [0, 1, 4, 30], refs: [0, 3], cat: [0, 1, 12, 120], mapKeys: [0, 1, 5, 40, 1000], enc: [0, 1, 5, 20], statics: [0, 5], dispatch: [0, 1, 2, 9], map: [0, 1, 5, 40], err: [-1, 0, 2, 3, 4], err2: [-1, 0, 4, 5], err3: [-1, 0, 2, 3, 5],
  floats: [0, 1, 10, 1000, 100000], collatz: [1, 2, 3, 27, 1000], nested: [0, 1, 5, 12, 30], mix: [0, 1, 10, 1000], arrays: [0, 1, 5, 100], objs: [0, 1, 5, 100], tryNeg: [-1, 0, 5, -100],
};
const cases = genCases(methods.filter((m) => !process.argv[2] || process.argv[2].split(",").some((f) => m.name.includes(f))), small);
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `${c.m.cls}.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
// the production reflection skips Field's type and receiver checks (getBoolean of an int field answers a number): its results for these are not an oracle
const UNCHECKED = new Set(["inner", "members", "annots", "errType", "errReceiver", "errRefType", "errNullBox", "errNarrow"]), isUnchecked = (i: number) => UNCHECKED.has(cases[i].m.name);
const pick = <T,>(l: T[], unchecked: boolean) => l.filter((_, i) => isUnchecked(i) === unchecked);
const r1 = await compare(pick(cases, false), (m) => entries.get(m)!, js, pick(jdk, false), hit);
let at = 0;
const jdkOnly = async () => { const v = pick(jdk, true)[at++]; if (v === "throw") throw new Error("throw"); return Number(v); };
const r2 = await compare(pick(cases, true), (m) => entries.get(m)!, jdkOnly, pick(jdk, true), hit);
const bad = r1.bad + r2.bad, explained = r1.explained + r2.explained, blocked = r1.blocked + r2.blocked;
console.log(`${cases.length - blocked - bad}/${cases.length - blocked} cases match across ${methods.length} methods (wasm, js tier, jdk)${explained ? `; ${explained} js-tier results explained by JSC wording` : ""}`);
console.log(`compiled ${w.stats.methods} methods (${w.stats.units} modules) in ${w.stats.compileMs.toFixed(0)} ms, ${w.stats.classes} class modules, instantiate ${w.stats.instantiateMs.toFixed(0)} ms`);
if (blocked) console.log(`${blocked} cases blocked by a compiler gap: ${[...new Set(hit)].join("; ")}`);
process.exit(bad || blocked ? 1 : 0);
