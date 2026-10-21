// android.view's input classes against the reference AVD: InputProbe (scripts/InputProbe.java) runs
// here over our natives and hosted IInputManager, and its output is compared line by line with
// what it printed on the device (tests/fixtures/input-probe.txt, pnpm gen-framework --only inputProbe).
import { readFileSync } from "node:fs";
import { DexFile } from "../../src/jvm/dex.ts";
import { jarray, mangleStaticField } from "../../src/jvm/abi.ts";
import { newObj, scall, vcall } from "../../src/jvm/natives/jentry.ts";
import { exercise, loader, statics } from "./harness.ts";

/** event ids are random; the AVD has input devices beyond the two this host models */
const comparable = (lines: string[]) => lines
  .filter((l) => !/^(device|devkcm) (?!-1 |12 )/.test(l))
  .map((l) => l.replace(/eventId=(0x[0-9a-f]+|-?\d+)/g, "eventId=*").replace(/^(mp parcel size=\d+ .{24}).{8}/, "$1********"));

await exercise("InputProbe: MotionEvent, VelocityTracker, KeyEvent, KeyCharacterMap, InputDevice (device values)", async () => {
  loader.loadDex(new DexFile(new Uint8Array(readFileSync("tests/fixtures/InputProbe.dex"))));
  const bytes = await newObj("java/io/ByteArrayOutputStream", "()V");
  const out = await newObj("java/io/PrintStream", "(Ljava/io/OutputStream;Z)V", bytes, 1);
  const previous = (await statics("java/lang/System"))[mangleStaticField("out")];
  await scall("java/lang/System", "setOut", "(Ljava/io/PrintStream;)V", out);
  try { await scall("InputProbe", "main", "([Ljava/lang/String;)V", jarray([], "Ljava/lang/String;")); }
  finally { await scall("java/lang/System", "setOut", "(Ljava/io/PrintStream;)V", previous); }
  const got = comparable(String(await vcall(bytes, "toString", "()Ljava/lang/String;")).trim().split("\n"));
  const want = comparable(readFileSync("tests/fixtures/input-probe.txt", "utf8").trim().split("\n"));
  const diff: string[] = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) diff.push(`  line ${i + 1}\n    got  ${got[i]}\n    want ${want[i]}`);
  }
  if (diff.length) { console.log(diff.join("\n")); throw new Error(`${diff.length} lines differ from the device's`); }
});
