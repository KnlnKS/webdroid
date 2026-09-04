// bun scripts/inspect.ts <apk> — sanity-check parsers, dump manifest + dex stats
import { openApk, dexesOf, dumpXml } from "./lib";
import { parseAXML } from "../src/android/axml";

const path = process.argv[2] ?? "apks/FitNotes.apk";
const zip = await openApk(path);

console.log(dumpXml(parseAXML(zip["AndroidManifest.xml"]), 0, [], 3).join("\n"));

for (const dex of dexesOf(zip)) {
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
