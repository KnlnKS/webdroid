// Walk every method body in the given APKs; histogram opcodes; validate the walker. pnpm opscan <apk|dex> ...
import { loadDexes } from "./dexes.ts";
import { OPS, insnLen } from "../src/jvm/opcodes.ts";
import { descToName } from "../src/jvm/abi.ts";
import type { DexFile } from "../src/jvm/dex.ts";
import { cli } from "./args.ts";

const hist = new Map<number, number>();
const boots = new Map<string, number>();

/** the bootstrap methods a dex's call_site_ids link through — what invoke-custom would need */
function scanCallSites(dex: DexFile) {
  for (let i = 0; ; i++) {
    let h;
    try { h = dex.callSite(i)[0]; } catch { return; }
    let key = "?";
    if (h && typeof h === "object" && "kind" in h && h.kind === "mhandle") {
      const m = dex.method(dex.methodHandle(h.idx).idx);
      key = descToName(dex.type(m.cls)) + "." + m.name;
    }
    boots.set(key, (boots.get(key) ?? 0) + 1);
  }
}
for (const path of cli("pnpm opscan <apk|dex> ...", {}, { min: 1 }).positionals) {
  for (const dex of loadDexes(path)) {
    const name = dex.name;
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
    scanCallSites(dex);
    console.log(`${path} ${name}: ${bodies} bodies, ${units} code units ok`);
  }
}
const rows = [...hist.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n${rows.length} distinct opcodes used`);
for (const [op, n] of rows.slice(0, 10)) console.log(`  ${OPS[op]?.[0]} ${n}`);
const exotic = rows.filter(([op]) => op >= 0xfa);
console.log("exotic (invoke-polymorphic/custom etc):", exotic.map(([op, n]) => `${OPS[op]?.[0]}=${n}`).join(" ") || "none");
console.log("call site bootstraps:", [...boots].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" ") || "none");
