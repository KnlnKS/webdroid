import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SYSTEM_PACKAGES, SYSTEM_PACKAGE_RELEASE } from "../src/shell/system-packages";

export const systemPackageDirectory = process.env.WEBDROID_PACKAGE_CACHE ?? join(homedir(), ".cache", "webdroid", "packages");
export function systemPackageFile(file: string): string { return join(systemPackageDirectory, file); }

export async function prepareSystemPackages(): Promise<void> {
  await mkdir(systemPackageDirectory, { recursive: true });
  for (const spec of SYSTEM_PACKAGES) {
    const file = Bun.file(systemPackageFile(spec.file));
    if (await file.exists() && new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex") === spec.sha256) continue;
    const response = await fetch(SYSTEM_PACKAGE_RELEASE + spec.file);
    if (!response.ok) throw new Error(`System package download failed: ${spec.file}: ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== spec.sha256) throw new Error(`System package digest mismatch: ${spec.file}`);
    await Bun.write(file, bytes);
  }
}
if (import.meta.main) await prepareSystemPackages();
