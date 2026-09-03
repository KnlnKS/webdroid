// What the real framework dex contains, and what it would ask of us.
// bun scripts/fwscan.ts [vendor/aosp/framework.jar] [class-name-prefix]
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";
import { ACC } from "../src/jvm/runtime";
import { descToName, isWide } from "../src/jvm/abi";

const [jar = "vendor/aosp/framework.jar", prefix] = process.argv.slice(2);
const zip = unzipSync(new Uint8Array(await Bun.file(jar).arrayBuffer()), { filter: (f) => /classes\d*\.dex$/.test(f.name) });
const dexes = Object.entries(zip).map(([n, b]) => new DexFile(b, n));

let classes = 0, methods = 0, bodies = 0, natives = 0, fields = 0;
const nativesByPkg = new Map<string, number>();
const nativeList: string[] = [];
for (const dex of dexes) {
  for (let i = 0; i < dex.classDefCount; i++) {
    const name = descToName(dex.type(dex.classDef2Type(i)));
    if (prefix && !name.startsWith(prefix)) continue;
    classes++;
    const def = dex.classDef(i);
    fields += def.instanceFields.length + def.staticFields.length;
    for (const m of [...def.directMethods, ...def.virtualMethods]) {
      methods++;
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

// wide args exist in these descriptors; isWide is imported so the shim generator can
// reuse this file's parse without a second pass
void isWide;
