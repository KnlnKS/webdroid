// The platform font index a page loads in place of reading every system font and parsing the font
// configuration (src/android/fonts.ts): each face's FaceInfo, and the system font map AOSP builds
// from font_fallback.xml and the font updates, serialized as the system server serializes it for apps.
// Java runs on the Wasm tier, which reads V8's frames: under Bun the script runs itself under node.
//   bun scripts/font-index.ts > font-index.json
import { runUnderNode } from "./wasm/undernode.ts";

if (process.versions.bun) process.exit(await runUnderNode(import.meta.path, []));
console.log = console.error; // stdout is the index
await import("../tests/platform.ts");
const { rt, awaited } = await import("../src/jvm/runtime.ts");
await import("../src/natives.ts");
await (await import("../src/android/mainloop.ts")).startMainLooper();
const { platformFontIndex, preloadFonts, systemFontMap } = await import("../src/android/fonts.ts");
const { vcall, callOn, mainThread } = await import("../src/jvm/natives/jentry.ts");
const { fdInt } = await import("../src/jvm/natives/jio.ts");
const { fdContents } = await import("../src/android/os.ts");
const fontMap = await callOn(mainThread, () => rt.drive(function* () {
  yield* preloadFonts();
  const memory = yield* systemFontMap();
  return yield* awaited(fdContents(fdInt(yield vcall(memory, "getFileDescriptor", "()Ljava/io/FileDescriptor;"))));
}()));
process.stdout.write(JSON.stringify({ faces: await platformFontIndex(), fontMap: Buffer.from(fontMap!).toString("base64") }));
process.exit(0);
