// Differential test: every static method of W.java, S.java and N.java runs as Wasm (this compiler, S and N over the AOSP boot dex) and on the
// JDK; results must be bit-identical. Needs javac and java on PATH. Run: pnpm wasm diff [method-name-filter]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { world } from "./lib.ts";
import { dexesIn } from "../../src/jvm/dex.ts";
import { descToName } from "../../src/jvm/abi.ts";
import { insnLen } from "../../src/jvm/opcodes.ts";
import { mountPlatform, natives, startProcess } from "./harness.ts";
import { ACC } from "../../src/wasm/compiler/program.ts";
import { caseLine, compare, genCases } from "./cases.ts";
import { CORE_PATHS, JAVA, ROOT } from "./paths.ts";
import { checker } from "./tools.ts";
import { fixture, onJdk } from "../java.ts";

const out = fixture({ sources: ["W", "S", "N", "Ref"].map((c) => join(JAVA, c + ".java")), classes: /^[WSN](\$\w+)?\.class$/ });

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
await mountPlatform(ROOT);
const w = world([dex, ...CORE_PATHS], { natives }), hit: string[] = [];
w.onGap = (gap) => hit.push(gap);
await startProcess(w);
const methods = ["W", "S", "N"].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && m.flags & ACC.PUBLIC));
// asynchronous, as a process enters Java: S and N reach natives that wait (files, the user database)
const entries = new Map(methods.map((m) => [m, w.entryAsync(m.cls, m.name, m.desc)]));
const small: Record<string, number[]> = {
  fib: [0, 1, 2, 10, 20], sieve: [0, 1, 2, 10, 1000, 100000], xorshift: [0, 1, 10, 1000], mandel: [0, 1, 5, 24], swsum: [0, 1, 7, 100, 1000],
  basics: [0, 1, 2, 5, 17], wide: [0, 1, 2, 9, 33], parts: [0, 1, 4, 9, 20], sb: [0, 1, 3, 12, 40], sw: [0, 1, 2, 3, 4, 7], cmp: [0, 1, 6, 15], bytes: [0, 1, 7, 64], chars: [0, 1, 4, 30],
  copy: [0, 1, 3, 8], fieldsInt: [0, 1, 5, 100], fieldsLong: [0, 1, 5], fieldsFloat: [0, 1, 5], fieldsFloatShort: [0, 5], fieldsFloatLong: [0], fieldsDouble: [0, 1, 5], fieldsOther: [0, 1, 5, 100], errWiden: [0], errType: [0], errNull: [0], errReceiver: [0], errRefType: [0], errNullBox: [0], errNarrow: [0], errFinal: [0], forName: [0], direct: [0, 1, 5, 40], directBulk: [0, 1, 5, 40], thread: [0, 3], unicode: [0, 1, 4, 30], refs: [0, 3], cat: [0, 1, 12, 120], mapKeys: [0, 1, 5, 40, 1000], enc: [0, 1, 5, 20], statics: [0, 5], dispatch: [0, 1, 2, 9], map: [0, 1, 5, 40], err: [-1, 0, 2, 3, 4], err2: [-1, 0, 4, 5], err3: [-1, 0, 2, 3, 5],
  floats: [0, 1, 10, 1000, 100000], collatz: [1, 2, 3, 27, 1000], nested: [0, 1, 5, 12, 30], mix: [0, 1, 10, 1000], arrays: [0, 1, 5, 100], objs: [0, 1, 5, 100], tryNeg: [-1, 0, 5, -100],
};
const cases = genCases(methods.filter((m) => !process.argv[2] || process.argv[2].split(",").some((f) => m.name.includes(f))), small);
const jdk = onJdk(out, cases.map(caseLine));
const suite = checker("diff"), { blocked } = await compare(suite, cases, (m) => entries.get(m)!, jdk, hit);
const wideCases = ["members", "annots"].map((name) => cases.findIndex((c) => c.m.cls === "N" && c.m.name === name)).filter((i) => i >= 0);
if (wideCases.length) {
  const wide = world([dex, ...CORE_PATHS], { natives });
  const wideEntry = wide.entryAsync.bind(wide);
  const a = wide.idOf("java/util/ArrayList"), b = wide.idOf("java/util/HashMap"), low = wide.selectorId("hashCode()I");
  if (b !== a + 1) throw new Error("full-width dispatch fixture requires adjacent class IDs");
  while (wide.numbers.selKeys.length < low + 65536) wide.selectorId("reserved" + wide.numbers.selKeys.length + "()I");
  const high = wide.selectorId("size()I");
  wide.host.imtMiss(a, high);
  const expected = wide.slotOf(wide.prog.implFor("java/util/HashMap", "hashCode", "()I")!);
  suite.check("full-width interface dispatch cache: distinct class/selector pairs remain distinct", wide.host.imtMiss(b, low), expected);
  while (wide.numbers.names.length < 65536) wide.idOf("reflection/reserved/" + wide.numbers.names.length);
  for (const i of wideCases) {
    const { m, args } = cases[i], call = wideEntry(m.cls, m.name, m.desc), got = await call(Number(args[0]));
    suite.check(`full-width reflection ${m.name}`, String(got), jdk[i]);
  }
}
console.log(`compiled ${w.stats.methods} methods (${w.stats.units} modules) in ${w.stats.compileMs.toFixed(0)} ms, ${w.stats.classes} class modules, instantiate ${w.stats.instantiateMs.toFixed(0)} ms`);
suite.done(`${cases.length - blocked} cases (${wideCases.length} full-width) match the JDK across ${methods.length} methods`);
