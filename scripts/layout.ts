// Dump a binary layout XML that references a given id, or a named layout.
// bun scripts/layout.ts <apk> <0xid|layoutName>
import { openApk, dumpXml } from "./lib.ts";
import { parseAXML, type XmlNode } from "../src/android/axml.ts";

const [apk, target] = process.argv.slice(2);
const zip = await openApk(apk);
const wantId = target.startsWith("0x") ? parseInt(target, 16) : 0;

function has(n: XmlNode, id: number): boolean {
  if (n.attrs.some((a) => a.name === "id" && a.data === id)) return true;
  return n.children.some((c) => has(c, id));
}
for (const path of Object.keys(zip)) {
  if (!path.startsWith("res/") || !path.endsWith(".xml")) continue;
  const bytes = zip[path];
  let root: XmlNode;
  try { root = parseAXML(bytes); } catch { continue; }
  const match = wantId ? has(root, wantId) : path.includes(target);
  if (!match) continue;
  console.log(`=== ${path}`);
  console.log(dumpXml(root).join("\n"));
  break;
}
