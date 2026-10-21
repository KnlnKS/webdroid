// The probe dex under tests/fixtures, committed so the tests that load them need neither Java nor the Android SDK, rebuilt from their sources, and
// SerializationProbe.hex, the JDK's stream of its Graph. (InputProbe.dex is the one gen-framework's inputProbe recorder runs on the device.)
//   pnpm ts scripts/probes.ts [probe ...]
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "./args.ts";
import { fixture, java, type Fixture } from "./java.ts";

const PROBES: Record<string, Fixture> = {
  FloatHandlerProbe: { release: 17, android: true, minApi: 26 },
  // without desugaring, VarHandle and MethodHandle calls stay invoke-polymorphic and record methods invoke-custom, as in AOSP's jars
  InvokeProbe: { release: 17, flags: ["-XDstringConcat=inline"], android: true, minApi: 35, debug: true, d8: ["--no-desugaring"] },
  JniProbe: { release: 11, android: true, minApi: 26, debug: true },
  JvmTierProbe: { release: 9, android: true, minApi: 26, debug: true },
  SerializationProbe: { release: 17, minApi: 28, debug: true },
};
const usage = "pnpm ts scripts/probes.ts [probe ...]";
const { positionals } = cli(usage, {});
for (const name of positionals.length ? positionals : Object.keys(PROBES)) {
  if (!PROBES[name]) { console.error(`no probe ${name}: ${Object.keys(PROBES).join(", ")}\nusage: ${usage}`); process.exit(2); }
  const out = fixture({ sources: [`tests/fixtures/${name}.java`], ...PROBES[name] });
  copyFileSync(join(out, "classes.dex"), `tests/fixtures/${name}.dex`);
  if (name === "SerializationProbe") writeFileSync("tests/fixtures/SerializationProbe.hex", java(out, name, ["graph"]));
  console.log(`tests/fixtures/${name}.dex`);
}
