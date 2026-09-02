// bun scripts/inspect.ts <apk> — sanity-check parsers, dump manifest + dex stats
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";
import { parseAXML, type XmlNode } from "../src/android/axml";

const path = process.argv[2] ?? "apks/FitNotes.apk";
const zip = unzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()), {
  filter: (f) => /\.dex$|AndroidManifest\.xml$/.test(f.name),
});

const manifest = parseAXML(zip["AndroidManifest.xml"]);
function dump(n: XmlNode, d: number) {
  const attrs = n.attrs.map((a) => `${a.name}=${a.str ?? "0x" + a.data.toString(16)}`).join(" ");
  console.log("  ".repeat(d) + `<${n.name} ${attrs}>`);
  if (d < 3) for (const c of n.children) dump(c, d + 1);
}
dump(manifest, 0);

for (const [name, bytes] of Object.entries(zip)) {
  if (!name.endsWith(".dex")) continue;
  const t0 = performance.now();
  const dex = new DexFile(bytes, name);
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
