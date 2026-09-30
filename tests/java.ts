import { rt } from "../src/jvm/runtime";

export { scall } from "../src/jvm/natives/jlang";

/** framework.jar on the platform class path, as a booted page has it */
export async function loadFrameworkJar(): Promise<void> {
  const { jarDexes } = await import("../src/android/framework");
  if (rt.dexIndex.has("android/app/Activity")) return;
  const jar = new Uint8Array(await Bun.file(new URL("../vendor/aosp/framework.jar", import.meta.url)).arrayBuffer());
  for (const dex of jarDexes(jar, "framework.jar")) rt.loadDex(dex, true);
}

let fontMap: Promise<void> | null = null;
/** /system/fonts and the font map the zygote preloads (whose locale scripts are ICU's), as a booted
 *  page has them */
export function loadSystemFonts(): Promise<void> {
  return fontMap ??= (async () => {
    const { SYSTEM_FONT_FILES, mountSystemFonts, loadSystemFontMap } = await import("../src/android/fonts");
    (await import("../src/shell/apex")).mountPlatformData((path, size) => ({
      size, read: async (at, length) => new Uint8Array(await Bun.file(new URL(`../vendor/aosp${path}`, import.meta.url)).slice(at, at + length).arrayBuffer()),
    }));
    mountSystemFonts(await Promise.all(SYSTEM_FONT_FILES.map(async (file) =>
      new Uint8Array(await Bun.file(new URL(`../vendor/fonts/${file}`, import.meta.url)).arrayBuffer()))));
    await loadSystemFontMap();
  })();
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

/** AOSP's Resources over `res`, installed as an app at /data/app/`name`.apk beside framework-res */
export async function appResources(res: import("../src/android/res").Resources, name: string) {
  const { loadFramework } = await import("../src/android/framework");
  const { javaResources } = await import("../src/android/resources");
  await loadFrameworkJar();
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => url === "/vendor/aosp/framework-res.apk"
    ? new Response(Bun.file(new URL("../vendor/aosp/framework-res.apk", import.meta.url))) : fetch(url)) as typeof fetch;
  try { await loadFramework(); } finally { globalThis.fetch = fetch; }
  const { deviceConfiguration, initDeviceLocales } = await import("../src/android/resnative");
  if (!deviceConfiguration().locales.values.length) await initDeviceLocales();
  return javaResources(res, `/data/app/${name}.apk`);
}

/** a compiled XML document of `root`, as aapt writes one: a UTF-16 string pool, then each
 *  element's start and end chunks (attributes carry no resource ids) */
export function axmlBytes(root: import("../src/android/axml").XmlNode): Uint8Array {
  const strings: string[] = [], index = (s: string) => { let i = strings.indexOf(s); if (i < 0) i = strings.push(s) - 1; return i; };
  const chunks: number[][] = [];
  const u16 = (out: number[], v: number) => out.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (out: number[], v: number) => { u16(out, v & 0xffff); u16(out, v >>> 16); };
  const walk = (node: typeof root) => {
    const start: number[] = [];
    u16(start, 0x0102); u16(start, 16); u32(start, 36 + 20 * node.attrs.length); u32(start, 1); u32(start, 0xffffffff);
    u32(start, 0xffffffff); u32(start, index(node.name)); u16(start, 20); u16(start, 20); u16(start, node.attrs.length); u16(start, 0); u16(start, 0); u16(start, 0);
    for (const a of node.attrs) {
      u32(start, a.ns ? index(a.ns) : 0xffffffff); u32(start, index(a.name)); u32(start, a.str === null ? 0xffffffff : index(a.str));
      u16(start, 8); start.push(0, a.type); u32(start, a.data);
    }
    chunks.push(start);
    for (const child of node.children) walk(child);
    const end: number[] = [];
    u16(end, 0x0103); u16(end, 16); u32(end, 24); u32(end, 1); u32(end, 0xffffffff); u32(end, 0xffffffff); u32(end, index(node.name));
    chunks.push(end);
  };
  walk(root);
  const data: number[] = [];
  for (const s of strings) { u16(data, s.length); for (let i = 0; i < s.length; i++) u16(data, s.charCodeAt(i)); u16(data, 0); }
  while (data.length % 4) data.push(0);
  const pool: number[] = [];
  const offsets: number[] = [];
  for (let i = 0, at = 0; i < strings.length; at += 4 + 2 * strings[i].length, i++) offsets.push(at);
  u16(pool, 0x0001); u16(pool, 28); u32(pool, 28 + 4 * strings.length + data.length); u32(pool, strings.length); u32(pool, 0); u32(pool, 0);
  u32(pool, 28 + 4 * strings.length); u32(pool, 0);
  for (const o of offsets) u32(pool, o);
  pool.push(...data);
  const body = [pool, ...chunks].flat(), out: number[] = [];
  u16(out, 0x0003); u16(out, 8); u32(out, 8 + body.length);
  return Uint8Array.from([...out, ...body]);
}
