import { existsSync } from "node:fs";
import { unzipSync } from "fflate";
import { dexesIn, DexFile } from "../src/jvm/dex";
import { rt } from "../src/jvm/runtime";
import type { XmlNode } from "../src/android/axml";

type Zip = Record<string, Uint8Array>;

const DEX_RE = /^classes\d*\.dex$/;

export async function openApk(path: string, filter?: RegExp): Promise<Zip> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return unzipSync(bytes, filter ? { filter: (f) => filter.test(f.name) } : {});
}

export function dexesOf(zip: Zip): DexFile[] {
  return Object.entries(zip)
    .filter(([name]) => DEX_RE.test(name))
    .flatMap(([name, bytes]) => dexesIn(bytes, name));
}

export async function openDexes(path: string): Promise<DexFile[]> {
  return dexesOf(await openApk(path, DEX_RE));
}

export async function loadDexes(path: string): Promise<DexFile[]> {
  const dexes = await openDexes(path);
  for (const d of dexes) rt.loadDex(d);
  return dexes;
}

/** the same, for a framework jar: `bun run gen-framework` puts it at vendor/aosp/framework.jar */
export async function loadJarDexes(path: string): Promise<DexFile[]> {
  if (!existsSync(path)) throw new Error(`no ${path} — run \`bun run gen-framework\` with the reference AVD booted`);
  return loadDexes(path);
}

export function dumpXml(n: XmlNode, depth: number, out: string[], maxDepth = Infinity): string[] {
  const attrs = n.attrs.map((a) => `${a.name}=${a.str != null ? JSON.stringify(a.str) : "0x" + (a.data >>> 0).toString(16)}`).join(" ");
  out.push("  ".repeat(depth) + `<${n.name} ${attrs}>`);
  if (depth < maxDepth) for (const c of n.children) dumpXml(c, depth + 1, out, maxDepth);
  return out;
}
