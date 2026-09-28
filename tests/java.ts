import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

/** A static Java method call: statics live on the class constructor under their mangled names. */
export const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => vcall(rt.link(cls).ctor, name, desc, ...args);

/** framework.jar on the platform class path, as a booted page has it */
export async function loadFrameworkJar(): Promise<void> {
  const { jarDexes } = await import("../src/android/framework");
  if (rt.dexIndex.has("android/app/Activity")) return;
  const jar = new Uint8Array(await Bun.file(new URL("../vendor/aosp/framework.jar", import.meta.url)).arrayBuffer());
  for (const dex of jarDexes(jar, "framework.jar")) rt.loadDex(dex, true);
}
