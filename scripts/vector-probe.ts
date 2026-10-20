// Records VectorDrawableProbe's output on the reference AVD (booted, `adb` reachable) into
// tests/fixtures/vector-drawable.txt, which fwtest and the browser test compare against.
import { writeFileSync } from "node:fs";
import { runDex } from "./adb.ts";

const out = runDex("scripts/VectorDrawableProbe.java", { android: true });
writeFileSync("tests/fixtures/vector-drawable.txt", out + "\n");
console.log(`tests/fixtures/vector-drawable.txt: ${out.split("\n").length} lines`);
