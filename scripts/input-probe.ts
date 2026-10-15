// Records InputProbe's output on the reference AVD (booted, `adb` reachable) into
// tests/fixtures/input-probe.txt, and keeps its dex as tests/fixtures/InputProbe.dex, which fwtest
// runs against our input natives and compares line by line.
import { probeSdk, runDex } from "./adb";

const out = await runDex("scripts/InputProbe.java", { sdk: probeSdk(), keep: "tests/fixtures/InputProbe.dex" });
await Bun.write("tests/fixtures/input-probe.txt", out + "\n");
console.log(`tests/fixtures/input-probe.txt: ${out.split("\n").length} lines`);
