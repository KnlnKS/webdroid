// Dump a binary layout XML that references a given id, or a named layout.
// bun scripts/layout.ts <apk> <0xid|layoutName>
import { unzipSync } from "fflate";
import { parseAXML, type XmlNode } from "../src/android/axml";

const [apk, target] = process.argv.slice(2);
const zip = unzipSync(new Uint8Array(await Bun.file(apk).arrayBuffer()));
const wantId = target.startsWith("0x") ? parseInt(target, 16) : 0;

function dump(n: XmlNode, d: number, out: string[]) {
  const attrs = n.attrs.map((a) => `${a.name}=${a.str !== undefined && a.str !== null ? JSON.stringify(a.str) : "0x" + (a.data >>> 0).toString(16)}`).join(" ");
  out.push("  ".repeat(d) + `<${n.name} ${attrs}>`);
  for (const c of n.children) dump(c, d + 1, out);
}
function has(n: XmlNode, id: number): boolean {
  if (n.attrs.some((a) => a.name === "id" && a.data === id)) return true;
  return n.children.some((c) => has(c, id));
}
for (const [path, bytes] of Object.entries(zip)) {
  if (!path.startsWith("res/") || !path.endsWith(".xml")) continue;
  let root: XmlNode;
  try { root = parseAXML(bytes); } catch { continue; }
  const match = wantId ? has(root, wantId) : path.includes(target);
  if (!match) continue;
  const out: string[] = [];
  dump(root, 0, out);
  console.log(`=== ${path}`);
  console.log(out.join("\n"));
  break;
}
