// List every framework method ref in the APK that our natives don't implement.
// bun scripts/audit.ts <apk> [prefix-filter]
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";
import { rt } from "../src/jvm/runtime";
import "../src/natives";
import { mangleMethod, descToName } from "../src/jvm/abi";

const [apk, filter] = process.argv.slice(2);
const zip = unzipSync(new Uint8Array(await Bun.file(apk).arrayBuffer()), {
  filter: (f) => /classes\d*\.dex$/.test(f.name),
});
for (const name of [...rt.natives.keys()]) {
  try { rt.link(name); } catch { /* */ }
}
const missing = new Map<string, number>();
const missingClasses = new Map<string, number>();
for (const [dn, b] of Object.entries(zip)) {
  const dex = new DexFile(b, dn);
  rt.loadDex(dex);
  for (let i = 0; ; i++) {
    let m;
    try { m = dex.method(i); } catch { break; }
    if (m.cls >= dex.typeCount) break;
    let clsName: string;
    try { clsName = descToName(dex.type(m.cls)); } catch { break; }
    if (!/^(android|java|javax|dalvik|org\/xmlpull|org\/json)\//.test(clsName)) continue;
    if (filter && !clsName.startsWith(filter)) continue;
    if (clsName[0] === "[") continue;
    if (rt.dexIndex.has(clsName)) continue; // app provides it
    const p = dex.proto(m.proto);
    const desc = "(" + p.params.map((t) => dex.type(t)).join("") + ")" + dex.type(p.ret);
    let info;
    try { info = rt.link(clsName); } catch { continue; }
    if (!info.native) continue;
    const mangled = mangleMethod(m.name, desc);
    const has = info.ctor && (mangled in info.ctor.prototype || mangled in info.ctor ||
      (m.name === "<clinit>"));
    if (!has) {
      const key = clsName + "." + m.name + desc;
      missing.set(key, (missing.get(key) ?? 0) + 1);
      if (rt.missing.has("class " + clsName)) missingClasses.set(clsName, (missingClasses.get(clsName) ?? 0) + 1);
    }
  }
}
const stubClasses = [...missingClasses.entries()].sort((a, b) => b[1] - a[1]);
console.log("=== auto-stubbed classes (no native impl):", stubClasses.length);
for (const [c, n] of stubClasses) console.log(`  ${c} (${n} method refs)`);
const rows = [...missing.entries()].filter(([k]) => !stubClasses.some(([c]) => k.startsWith(c + ".")));
console.log("\n=== missing methods on EXISTING native classes:", rows.length);
for (const [k] of rows.sort()) console.log("  " + k);
