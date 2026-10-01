import { existsSync } from "node:fs";
import { dexesIn, isDexEntry, DexFile } from "../src/jvm/dex";
import { zipTree } from "../src/jvm/natives/jzip";
import { openInstall } from "../src/shell/install";
import { rt } from "../src/jvm/runtime";
import type { XmlNode } from "../src/android/axml";

type Zip = Record<string, Uint8Array>;

/** an apk or a split install, as the one merged tree the shell boots — entries materialise on
 *  read, so there is nothing for a caller to filter down to */
/** the reference build's files (ICU, tz, bionic) at their device paths, read from vendor/aosp */
export async function mountLocalPlatformData(): Promise<void> {
  const { mountPlatformData } = await import("../src/shell/apex");
  mountPlatformData((path, size) => ({ size, read: async (at, length) => new Uint8Array(await Bun.file(`vendor/aosp${path}`).slice(at, at + length).arrayBuffer()) }));
}

export async function openApk(path: string): Promise<Zip> {
  return openInstall(new Uint8Array(await Bun.file(path).arrayBuffer())).zip;
}

export function dexesOf(zip: Zip): DexFile[] {
  return Object.keys(zip)
    .filter(isDexEntry)
    .flatMap((name) => dexesIn(zip[name], name));
}

export async function openDexes(path: string): Promise<DexFile[]> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const zip = zipTree(bytes);
  return dexesOf(Object.keys(zip).some(isDexEntry) ? zip : openInstall(bytes).zip);
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
