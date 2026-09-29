import { rt } from "../src/jvm/runtime";

export { scall } from "../src/jvm/natives/jlang";

/** framework.jar on the platform class path, as a booted page has it */
export async function loadFrameworkJar(): Promise<void> {
  const { jarDexes } = await import("../src/android/framework");
  if (rt.dexIndex.has("android/app/Activity")) return;
  const jar = new Uint8Array(await Bun.file(new URL("../vendor/aosp/framework.jar", import.meta.url)).arrayBuffer());
  for (const dex of jarDexes(jar, "framework.jar")) rt.loadDex(dex, true);
}

/** libcore's own jars (core-oj, core-libart, core-icu4j), for platform classes that forward to natives */
export async function loadLibcore(): Promise<void> {
  const { loadPlatformJar } = await import("../src/android/framework");
  const { PLATFORM_JARS } = await import("../src/jvm/provenance");
  if (rt.dexIndex.has("libcore/io/Linux")) return;
  for (const jar of ["boot/core-oj.jar", "boot/core-libart.jar", "boot/core-icu4j.jar"]) {
    const i = PLATFORM_JARS.indexOf(jar);
    loadPlatformJar(new Uint8Array(await Bun.file(new URL(`../vendor/aosp/${jar}`, import.meta.url)).arrayBuffer()), i);
  }
}

/** Styles in a Resources with no table behind it: each entry is (attribute, type, data), a
 *  TYPE_STRING's data indexing `strings`, which stand in for the package's value pool. */
export async function fakeStyles(strings: string[], styles: Record<number, [number, number, number][]>) {
  const { Resources, Bag } = await import("../src/android/res");
  const res = new Resources(null, {});
  res.arsc = { values: { get: (i: number) => strings[i] }, specFlags: () => 0 } as never;
  for (const [id, entries] of Object.entries(styles)) {
    const sorted = entries.slice().sort((a, b) => a[0] - b[0]);
    res.bagCache.set(+id, new Bag(res, 0, 0, Int32Array.from(sorted, (e) => e[0]), Uint8Array.from(sorted, (e) => e[1]),
      Int32Array.from(sorted, (e) => e[2]), new Int32Array(sorted.length).fill(+id)));
  }
  return res;
}
