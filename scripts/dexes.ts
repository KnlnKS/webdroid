import { readFileSync } from "node:fs";
import { dexesIn, dexesOfZip, isDexEntry, type DexFile } from "../src/jvm/dex.ts";
import { zipTree } from "../src/zip.ts";
import { openInstall } from "../src/shell/install.ts";

/** the dex files of a dex, a jar or an apk, or of a split install's merged tree */
export function dexesFrom(bytes: Uint8Array, path: string): DexFile[] {
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return dexesOfZip(Object.keys(zip).some(isDexEntry) ? zip : openInstall(bytes).zip);
}
/** the dex files of the file at `path`, as dexesFrom reads them */
export const loadDexes = (path: string): DexFile[] => dexesFrom(new Uint8Array(readFileSync(path)), path);
