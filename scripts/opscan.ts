// Walk every method body in the given APKs; histogram opcodes; validate the walker.
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";
import { OPS, insnLen } from "../src/jvm/opcodes";

const hist = new Map<number, number>();
for (const path of process.argv.slice(2)) {
  const zip = unzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()), {
    filter: (f) => /classes\d*\.dex$/.test(f.name),
  });
  for (const [name, bytes] of Object.entries(zip)) {
    const dex = new DexFile(bytes, name);
    let bodies = 0, units = 0;
    for (let i = 0; i < dex.classDefCount; i++) {
      const def = dex.classDef(i);
      for (const m of [...def.directMethods, ...def.virtualMethods]) {
        if (!m.codeOff) continue;
        const code = dex.code(m.codeOff);
        bodies++;
        let pc = 0;
        while (pc < code.insns.length) {
          const op = code.insns[pc] & 0xff;
          if (!(op === 0 && code.insns[pc] >> 8)) hist.set(op, (hist.get(op) ?? 0) + 1);
          const len = insnLen(code.insns, pc);
          pc += len;
          units += len;
        }
        if (pc !== code.insns.length) throw new Error(`walk overrun in ${path} ${name} method ${m.methodIdx}: ${pc} != ${code.insns.length}`);
      }
    }
    console.log(`${path} ${name}: ${bodies} bodies, ${units} code units ok`);
  }
}
const rows = [...hist.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n${rows.length} distinct opcodes used`);
for (const [op, n] of rows.slice(0, 10)) console.log(`  ${OPS[op]?.[0]} ${n}`);
const exotic = rows.filter(([op]) => op >= 0xfa);
console.log("exotic (invoke-polymorphic/custom etc):", exotic.map(([op, n]) => `${OPS[op]?.[0]}=${n}`).join(" ") || "none");
