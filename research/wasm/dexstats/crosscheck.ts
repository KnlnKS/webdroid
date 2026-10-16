// Cross-check: this prototype's resolution of const / const-wide against the repo's own constant typing
// (prepared.ts annotateConstants -> constKind "F" | "D"). bun crosscheck.ts <jar-or-apk>
import { openDexes } from "./load.ts";
import { inferMethod, F, D } from "./infer.ts";
import { decodeInstructions, prepareMethod } from "../../../src/jvm/prepared.ts";
const path = process.argv[2];
let both = 0, repoF = 0, mineF = 0, agreeF = 0, repoD = 0, mineD = 0, agreeD = 0, consts = 0, mineAmbig = 0;
const diffs: string[] = [];
for (const dex of await openDexes(path)) for (let i = 0; i < dex.classDefCount; i++) {
  const def = dex.classDef(i), cls = dex.type(def.typeIdx);
  for (const em of [...def.directMethods, ...def.virtualMethods]) {
    if (!em.codeOff) continue;
    const code = dex.code(em.codeOff), desc = dex.methodDesc(em.methodIdx), st = !!(em.flags & 8);
    let prep; try { prep = prepareMethod(dex, code, desc, st); } catch { continue; }
    const mine = new Map<number, number>();
    inferMethod(dex, code, desc, st, decodeInstructions(code.insns), mine);
    for (const x of prep.instructions) {
      if (x.op < 0x12 || x.op > 0x19) continue;
      consts++;
      const m = mine.get(x.pc) ?? 0;
      if (x.op <= 0x15) {
        const a = x.constKind === "F", b = m === F;
        if (a) repoF++; if (b) mineF++; if (a && b) agreeF++;
        if (m !== F && m !== 1 && m !== 3 && m !== 7 && m !== 5 && m !== 2) mineAmbig++;
        if (a !== b && diffs.length < 8) diffs.push(`${cls}.${dex.method(em.methodIdx).name} pc ${x.pc} repo=${x.constKind ?? "-"} mine mask=${m} value=${x.b}`);
      } else {
        const a = x.constKind === "D", b = m === D;
        if (a) repoD++; if (b) mineD++; if (a && b) agreeD++;
        if (a !== b && diffs.length < 8) diffs.push(`${cls}.${dex.method(em.methodIdx).name} pc ${x.pc} wide repo=${x.constKind ?? "-"} mine mask=${m}`);
      }
      both++;
    }
  }
}
console.log({ consts, repoF, mineF, agreeF, repoD, mineD, agreeD });
console.log(diffs.join("\n"));
