// Records VectorDrawableProbe's output on the reference AVD (booted, `adb` reachable) into
// tests/fixtures/vector-drawable.txt, which fwtest and the browser test compare against.
import { probeSdk, runDex } from "./adb.ts";

const out = await runDex("scripts/VectorDrawableProbe.java", { sdk: probeSdk() });
await Bun.write("tests/fixtures/vector-drawable.txt", out + "\n");
console.log(`tests/fixtures/vector-drawable.txt: ${out.split("\n").length} lines`);
