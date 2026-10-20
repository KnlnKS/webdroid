// The reference build in a checkout's vendor/aosp: its platform jars and the /apex data, as node reads them (and a harness page, over the files it preloaded).
// It imports no runtime module, so a script that needs only these paths (aot-key.ts, and through it the production build) does not load the emulator.
import { existsSync, openSync, readFileSync, readSync } from "node:fs";
import type { FileSource } from "../src/shell/lazyfile.ts";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";

/** the checkout's vendor/aosp */
export const AOSP = decodeURIComponent(new URL("../vendor/aosp", import.meta.url).pathname);
/** every platform jar in the checkout, in class path order */
export const PLATFORM_PATHS: string[] = PLATFORM_JARS.map((jar) => `${AOSP}/${jar}`);
export const hasPlatformJars = (): boolean => PLATFORM_PATHS.every((path) => existsSync(path));

/** each platform jar's bytes in `aosp`, in class path order; a jar it lacks is undefined */
export const platformJarBytes = (aosp = AOSP): (Uint8Array | undefined)[] =>
  PLATFORM_JARS.map((jar) => existsSync(`${aosp}/${jar}`) ? new Uint8Array(readFileSync(`${aosp}/${jar}`)) : undefined);

/** the reference build's files (ICU, tz, bionic) for apex.ts's `mountPlatformData`: each read from `aosp`, opened at its first read */
export const localPlatformData = (aosp = AOSP) => (path: string, size: number): FileSource => {
  let fd: number | undefined;
  return { size, read: (at, length) => { const b = new Uint8Array(length); return b.subarray(0, readSync(fd ??= openSync(aosp + path, "r"), b, 0, length, at)); } };
};
