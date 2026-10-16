// What the real framework dex contains, and what it would ask of us.
// bun scripts/fwscan.ts [vendor/aosp/framework.jar] [class-name-prefix]
import { ACC } from "../src/jvm/dex.ts";
import { descToName } from "../src/jvm/abi.ts";
import { openDexes } from "./lib.ts";
import { frameworkSurface } from "./fuzz/catalog.ts";

const [jar = "vendor/aosp/framework.jar", prefix] = process.argv.slice(2);
const dexes = await openDexes(jar);

const surface = frameworkSurface(dexes);
const selected = (owner: string) => !prefix || owner.startsWith(prefix);
const classes = [...surface.classes].filter(selected).length;
const methods = [...surface.methods].filter((key) => selected(key.slice(0, key.indexOf(".")))).length;
const fields = [...surface.fields].filter((key) => selected(key.slice(0, key.indexOf(".")))).length;
let bodies = 0, natives = 0;
const nativesByPkg = new Map<string, number>();
const nativeList: string[] = [];
for (const dex of dexes) {
  for (let i = 0; i < dex.classDefCount; i++) {
    const name = descToName(dex.type(dex.classDef2Type(i)));
    if (prefix && !name.startsWith(prefix)) continue;
    const def = dex.classDef(i);
    for (const m of [...def.directMethods, ...def.virtualMethods]) {
      if (m.codeOff) bodies++;
      else if (m.flags & ACC.NATIVE) {
        natives++;
        const pkg = name.split("/").slice(0, 3).join("/");
        nativesByPkg.set(pkg, (nativesByPkg.get(pkg) ?? 0) + 1);
        if (prefix) nativeList.push(`${name}.${dex.method(m.methodIdx).name}${dex.methodDesc(m.methodIdx)}`);
      }
    }
  }
}

console.log(`${jar}${prefix ? ` [${prefix}]` : ""}: ${dexes.length} dex, ${classes} classes, ${methods} methods (${bodies} with bodies), ${fields} fields`);
console.log(`native methods: ${natives}`);
if (nativeList.length) for (const n of nativeList.sort()) console.log("  " + n);
else for (const [p, n] of [...nativesByPkg].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${n}\t${p}`);
