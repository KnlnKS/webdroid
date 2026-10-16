// Lists methods with underdetermined webs: bun undet.ts <jar-or-apk> [n]
import { openDexes } from "./load.ts";
import { inferMethod } from "./infer.ts";
const [path, n = "5"] = process.argv.slice(2);
let shown = 0;
for (const dex of await openDexes(path)) for (let i = 0; i < dex.classDefCount && shown < +n; i++) {
  const def = dex.classDef(i), cls = dex.type(def.typeIdx);
  for (const em of [...def.directMethods, ...def.virtualMethods]) {
    if (!em.codeOff || shown >= +n) continue;
    const r = inferMethod(dex, dex.code(em.codeOff), dex.methodDesc(em.methodIdx), !!(em.flags & 8));
    if (r.underdetermined) { console.log(cls + "." + dex.method(em.methodIdx).name + dex.methodDesc(em.methodIdx), r.underdetermined); shown++; }
  }
}
