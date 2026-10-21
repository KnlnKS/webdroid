// The Wasm tier booted headless as a page boots it, for the tools and tests that run Java through its seam (tier.loadDex, jentry) rather than a World of their own.
import { loadPlatformJar, mountPlatformJar } from "../src/android/framework.ts";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";
import { loadTier } from "../src/jvm/tier.ts";
import { mountPlatformData } from "../src/shell/apex.ts";
import { AOSP, localPlatformData, platformJarBytes } from "./aosp.ts";

/** the tier with the boot class path of `aosp` (the checkout's) on the device, the classes of `jars` (all of them by default) loaded, and its /apex data mounted */
export async function bootTier({ aosp = AOSP, jars = PLATFORM_JARS }: { aosp?: string; jars?: readonly string[] } = {}): Promise<void> {
  await loadTier();
  platformJarBytes(aosp).forEach((bytes, i) => {
    if (!bytes) throw new Error(`no ${aosp}/${PLATFORM_JARS[i]} — run: pnpm gen-framework`);
    (jars.includes(PLATFORM_JARS[i]) ? loadPlatformJar : mountPlatformJar)(bytes, i);
  });
  mountPlatformData(localPlatformData(aosp));
}
