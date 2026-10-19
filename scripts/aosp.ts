// The reference build in a checkout's vendor/aosp: its platform jars and the /apex data, as node reads them (and a harness page, over the files it preloaded)
import { existsSync, openSync, readFileSync, readSync } from "node:fs";
import { mountPlatformData } from "../src/shell/apex.ts";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";

const LOCAL = new URL("../vendor/aosp", import.meta.url).pathname;

/** each platform jar's bytes in `aosp`, in class path order; a jar it lacks is undefined */
export const platformJarBytes = (aosp = LOCAL): (Uint8Array | undefined)[] =>
  PLATFORM_JARS.map((jar) => existsSync(`${aosp}/${jar}`) ? new Uint8Array(readFileSync(`${aosp}/${jar}`)) : undefined);

/** the reference build's files (ICU, tz, bionic) at their device paths, each opened at its first read from `aosp` */
export function mountLocalPlatformData(aosp = LOCAL): void {
  mountPlatformData((path, size) => {
    let fd: number | undefined;
    return { size, read: (at, length) => { const b = new Uint8Array(length); return b.subarray(0, readSync(fd ??= openSync(aosp + path, "r"), b, 0, length, at)); } };
  });
}
