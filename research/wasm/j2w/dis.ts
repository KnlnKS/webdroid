import { loadDexes } from "./build";
import { Program } from "./program";
import { decodeInstructions } from "../../../src/jvm/prepared";
const [path, cls, name] = process.argv.slice(2);
const prog = new Program(loadDexes(path));
const c = prog.require(cls);
for (const m of c.methods.filter((m) => m.name === name)) {
  console.log(m.cls + "." + m.key, "regs/ins", m.dex.code(m.codeOff).regs, m.dex.code(m.codeOff).ins);
  const code = m.dex.code(m.codeOff);
  for (const i of decodeInstructions(code.insns)) console.log(String(i.pc).padStart(4), i.name.padEnd(18), `a=${i.a} b=${i.b} c=${i.c}`, i.regs.length ? "regs=" + i.regs : "", i.name === "const-wide" ? i.wideLit : "");
}
