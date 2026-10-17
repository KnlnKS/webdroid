import { dexesIn, dexEntryNames, isDexEntry, type DexFile } from "../src/jvm/dex.ts";
import { zipTree } from "../src/jvm/natives/jzip.ts";
import { openInstall } from "../src/shell/install.ts";

export function dexesOf(zip: Record<string, Uint8Array>): DexFile[] {
  return dexEntryNames(Object.keys(zip)).flatMap((name) => dexesIn(zip[name], name));
}

export function dexesFrom(bytes: Uint8Array, path: string): DexFile[] {
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return dexesOf(Object.keys(zip).some(isDexEntry) ? zip : openInstall(bytes).zip);
}
