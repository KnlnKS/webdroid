// The link table a page replays instead of finding its gaps (src/jvm/codecache.ts): the natives
// linked over the platform, as a zygote links them, for the bytecode switch given, and the build:
// a hash of the source every emitted body depends on, which keys the code cache.
//   bun scripts/link-table.ts [prefix,prefix...] > link-table.json
import { BYTECODE } from "../src/jvm/provenance";

BYTECODE.push(...(process.argv[2] ?? "").split(",").filter(Boolean));
console.warn = () => {};
const { rt } = await import("../src/jvm/runtime");
await import("../src/natives");
const { loadPlatformJar } = await import("../src/android/framework");
const { PLATFORM_JARS } = await import("../src/jvm/provenance");
const { foundLinkTable } = await import("../src/jvm/codecache");
for (const [i, jar] of PLATFORM_JARS.entries()) loadPlatformJar(new Uint8Array(await Bun.file(`vendor/aosp/${jar}`).arrayBuffer()), i);
const fingerprint = rt.linkFingerprint();
rt.linkNatives();
let source = fingerprint;
for (const file of [...new Bun.Glob("src/**/*.ts").scanSync()].sort()) source += await Bun.file(file).text();
const build = Bun.hash(source).toString(36);
process.stdout.write(JSON.stringify({ fingerprint, build, gaps: foundLinkTable() ?? {} }));
