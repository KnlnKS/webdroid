import { loadPlatformJar } from "../../../src/android/framework";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";

/** core-oj.jar on the page's class path, for the libcore classes a probe uses (java.nio's buffers) */
export async function loadCoreOj(): Promise<void> {
  const i = PLATFORM_JARS.indexOf("boot/core-oj.jar");
  loadPlatformJar(new Uint8Array(await (await fetch(`/vendor/aosp/${PLATFORM_JARS[i]}`)).arrayBuffer()), i);
}
