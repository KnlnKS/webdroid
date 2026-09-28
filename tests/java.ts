import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

/** A static Java method call: statics live on the class constructor under their mangled names,
 *  installed when the class initializes. */
export const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => {
  const info = rt.link(cls), pending = rt.initClass(info);
  return pending ? pending.then(() => vcall(info.ctor, name, desc, ...args)) : vcall(info.ctor, name, desc, ...args);
};

/** framework.jar on the platform class path, as a booted page has it */
export async function loadFrameworkJar(): Promise<void> {
  const { jarDexes } = await import("../src/android/framework");
  if (rt.dexIndex.has("android/app/Activity")) return;
  const jar = new Uint8Array(await Bun.file(new URL("../vendor/aosp/framework.jar", import.meta.url)).arrayBuffer());
  for (const dex of jarDexes(jar, "framework.jar")) rt.loadDex(dex, true);
}

/** libcore's own jars (core-oj, core-libart), for platform classes that forward to natives */
export async function loadLibcore(): Promise<void> {
  const { loadPlatformJar } = await import("../src/android/framework");
  const { PLATFORM_JARS } = await import("../src/jvm/provenance");
  if (rt.dexIndex.has("libcore/io/Linux")) return;
  for (const jar of ["boot/core-oj.jar", "boot/core-libart.jar"]) {
    const i = PLATFORM_JARS.indexOf(jar);
    loadPlatformJar(new Uint8Array(await Bun.file(new URL(`../vendor/aosp/${jar}`, import.meta.url)).arrayBuffer()), i);
  }
}
