import { existsSync } from "node:fs";
import { dexesIn, DexFile } from "../src/jvm/dex";
import { zipTree } from "../src/jvm/natives/jzip";
import { openInstall } from "../src/shell/install";
import { rt } from "../src/jvm/runtime";
import type { XmlNode } from "../src/android/axml";

type Zip = Record<string, Uint8Array>;

const DEX_RE = /^classes\d*\.dex$/;

/** an apk or a split install, as the one merged tree the shell boots — entries materialise on
 *  read, so there is nothing for a caller to filter down to */
export async function openApk(path: string): Promise<Zip> {
  return openInstall(new Uint8Array(await Bun.file(path).arrayBuffer())).zip;
}

export function dexesOf(zip: Zip): DexFile[] {
  return Object.keys(zip)
    .filter((name) => DEX_RE.test(name))
    .flatMap((name) => dexesIn(zip[name], name));
}

export async function openDexes(path: string): Promise<DexFile[]> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const zip = zipTree(bytes);
  return dexesOf(Object.keys(zip).some((name) => DEX_RE.test(name)) ? zip : openInstall(bytes).zip);
}

export async function loadDexes(path: string): Promise<DexFile[]> {
  const dexes = await openDexes(path);
  for (const d of dexes) rt.loadDex(d);
  return dexes;
}

export async function loadJarDexes(path: string): Promise<DexFile[]> {
  if (!existsSync(path)) throw new Error(`no ${path} — run \`bun run gen-framework\` with the reference AVD booted`);
  return loadDexes(path);
}

export function dumpXml(n: XmlNode, maxDepth = Infinity, depth = 0, out: string[] = []): string[] {
  const attrs = n.attrs.map((a) => `${a.name}=${a.str != null ? JSON.stringify(a.str) : "0x" + (a.data >>> 0).toString(16)}`).join(" ");
  out.push("  ".repeat(depth) + `<${n.name} ${attrs}>`);
  if (depth < maxDepth) for (const c of n.children) dumpXml(c, maxDepth, depth + 1, out);
  return out;
}
