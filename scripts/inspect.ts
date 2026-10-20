import { openApk, dumpXml } from "./lib.ts";
import { dexesOfZip } from "../src/jvm/dex.ts";
import { parseAXML } from "../src/android/axml.ts";
import { cli } from "./args.ts";

const [path] = cli("pnpm inspect <apk>", {}, { min: 1 }).positionals;
const zip = openApk(path);

console.log(dumpXml(parseAXML(zip["AndroidManifest.xml"]), 3).join("\n"));

for (const dex of dexesOfZip(zip)) {
  const name = dex.name;
  const t0 = performance.now();
  const classes: string[] = [];
  let methods = 0;
  for (let i = 0; i < dex.classDefCount; i++) {
    const def = dex.classDef(i);
    classes.push(dex.type(def.typeIdx));
    methods += def.directMethods.length + def.virtualMethods.length;
  }
  console.log(`\n${name}: ${dex.classDefCount} classes, ${methods} methods, parsed in ${(performance.now() - t0).toFixed(1)}ms`);
  console.log("sample:", classes.filter((c) => !c.startsWith("Landroidx")).slice(0, 25).join(" "));
}
