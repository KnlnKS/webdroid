// Dex loading through the repo's own parser, without scripts/lib.ts (which drags in the runtime).
import { dexesIn, isDexEntry, type DexFile } from "../../../src/jvm/dex.ts";
import { zipTree } from "../../../src/jvm/natives/jzip.ts";
import { openInstall } from "../../../src/shell/install.ts";

export const ROOT = new URL("../../../", import.meta.url).pathname;

export async function openDexes(path: string): Promise<DexFile[]> {
  const bytes = new Uint8Array(await Bun.file(path.startsWith("/") ? path : ROOT + path).arrayBuffer());
  let zip: Record<string, Uint8Array> = zipTree(bytes);
  if (!Object.keys(zip).some(isDexEntry)) zip = openInstall(bytes).zip;
  return Object.keys(zip).filter(isDexEntry).flatMap((n) => dexesIn(zip[n], n));
}
