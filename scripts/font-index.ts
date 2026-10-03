// The platform font index a page loads in place of reading every system font and parsing the font
// configuration (src/android/fonts.ts): each face's FaceInfo, and the system font map AOSP's
// Typeface builds from font_fallback.xml, serialized as the system server serializes it for apps.
//   bun scripts/font-index.ts > font-index.json
import { mountLocalPlatformData } from "./lib";
import { loadFrameworkJar } from "../tests/java";

console.log = console.error; // stdout is the index
await mountLocalPlatformData();
const { rt, awaited } = await import("../src/jvm/runtime");
await import("../src/natives");
await loadFrameworkJar();
const { platformFontIndex, loadSystemFontMap } = await import("../src/android/fonts");
const { scall, vcall, callOn, mainThread } = await import("../src/jvm/natives/jlang");
const { fdInt } = await import("../src/jvm/natives/jio");
const { fdContents } = await import("../src/android/os");
const fontMap = await callOn(mainThread, () => rt.drive(function* () {
  yield* loadSystemFontMap();
  const map = yield scall("android/graphics/Typeface", "getSystemFontMap", "()Ljava/util/Map;");
  const memory = yield scall("android/graphics/Typeface", "serializeFontMap", "(Ljava/util/Map;)Landroid/os/SharedMemory;", map);
  return yield* awaited(fdContents(fdInt(yield vcall(memory, "getFileDescriptor", "()Ljava/io/FileDescriptor;"))));
}()));
process.stdout.write(JSON.stringify({ faces: await platformFontIndex(), fontMap: Buffer.from(fontMap!).toString("base64") }));
process.exit(0);
