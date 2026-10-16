// Debug helper: bun dbg.ts <apk> '<Lcls;.name>' — prints the method's disassembly and inference.
import { ROOT, openDexes } from "./load.ts";
import { decodeInstructions } from "../../../src/jvm/prepared.ts";
import { inferMethod } from "./infer.ts";
const [path, want] = process.argv.slice(2);
for (const dex of await openDexes(path)) for (let i = 0; i < dex.classDefCount; i++) {
  const def = dex.classDef(i), cls = dex.type(def.typeIdx);
  for (const em of [...def.directMethods, ...def.virtualMethods]) {
    if (!em.codeOff) continue;
    const name = cls + "." + dex.method(em.methodIdx).name;
    if (name !== want) continue;
    const code = dex.code(em.codeOff), desc = dex.methodDesc(em.methodIdx);
    console.log(name + desc, "regs", code.regs, "ins", code.ins, "tries", JSON.stringify(code.tries));
    for (const x of decodeInstructions(code.insns)) console.log(x.pc, x.name, x.a, x.b, x.c, x.regs.join(","));
    console.log(JSON.stringify(inferMethod(dex, code, desc, !!(em.flags & 8))));
  }
}
void ROOT;
