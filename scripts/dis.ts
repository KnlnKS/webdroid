// Disassemble a method: bun scripts/dis.ts <apk> <class> [methodName]
import { openDexes } from "./lib.ts";
import { OPS, insnLen, FMT_LEN } from "../src/jvm/opcodes.ts";
import { descToName } from "../src/jvm/abi.ts";

const [apk, clsName, methodName] = process.argv.slice(2);
for (const dex of await openDexes(apk)) {
  const dname = dex.name;
  for (let i = 0; i < dex.classDefCount; i++) {
    if (descToName(dex.type(dex.classDef2Type(i))) !== clsName) continue;
    const def = dex.classDef(i);
    console.log(`=== ${clsName} in ${dname} (super ${dex.type(def.superIdx)})`);
    for (const m of [...def.directMethods, ...def.virtualMethods]) {
      const mr = dex.method(m.methodIdx);
      if (methodName && mr.name !== methodName) continue;
      console.log(`\n--- ${mr.name}${dex.methodDesc(m.methodIdx)} codeOff=${m.codeOff}`);
      if (!m.codeOff) continue;
      const code = dex.code(m.codeOff);
      console.log(`regs=${code.regs} ins=${code.ins} tries=${JSON.stringify(code.tries)}`);
      let pc = 0;
      while (pc < code.insns.length) {
        const u = code.insns[pc];
        const op = u & 0xff;
        if (op === 0 && (u >> 8) !== 0) {
          console.log(`${pc}: payload(${u >> 8})`);
          pc += insnLen(code.insns, pc);
          continue;
        }
        const [name, fmt] = OPS[op]!;
        const words = [...code.insns.slice(pc, pc + FMT_LEN[fmt])].map((w) => w.toString(16).padStart(4, "0")).join(" ");
        let extra = "";
        if (name.includes("const-string")) {
          const index = code.insns[pc + 1] + (op === 0x1b ? code.insns[pc + 2] * 65536 : 0);
          extra = JSON.stringify(dex.string(index).slice(0, 40));
        }
        if (/invoke/.test(name)) {
          const mm = dex.method(code.insns[pc + 1]);
          extra = dex.type(mm.cls) + "." + mm.name + dex.methodDesc(code.insns[pc + 1]);
        }
        if (/^(check-cast|new-instance|const-class|instance-of|new-array|filled)/.test(name)) {
          extra = dex.type(code.insns[pc + 1]);
        }
        if (/^[is](get|put)/.test(name)) {
          const f = dex.field(code.insns[pc + 1]);
          extra = dex.type(f.cls) + "." + f.name + ":" + dex.type(f.type);
        }
        console.log(`${pc}: ${name} ${words} ${extra}`);
        pc += insnLen(code.insns, pc);
      }
    }
  }
}
