import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BASELINE, descriptorMismatches, hasPlatformJars, withoutHint } from "../scripts/desccheck.ts";
import { dexesFrom } from "../scripts/dexes.ts";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";
import { Program } from "../src/wasm/compiler/program.ts";
import { externs, intrinsics } from "../src/wasm/link/intrinsics.ts";

// A registered descriptor AOSP does not declare is never reached by bytecode calling the real
// method. Accepted ones (extras shared across a hierarchy, other API levels) are in the baseline;
// `bun run desccheck --write-baseline` rewrites it.
test.skipIf(!hasPlatformJars())("registered descriptors match AOSP declarations, and the baseline holds no fixed ones", async () => {
  const accepted: Record<string, string[]> = await Bun.file(BASELINE).json();
  const found = new Set([...descriptorMismatches()].flatMap(([cls, msgs]) => msgs.map((msg) => `${cls}: ${withoutHint(msg)}`)));
  const baseline = new Set(Object.entries(accepted).flatMap(([cls, msgs]) => msgs.map((msg) => `${cls}: ${msg}`)));
  expect({ fresh: [...found].filter((m) => !baseline.has(m)), stale: [...baseline].filter((m) => !found.has(m)) }).toEqual({ fresh: [], stale: [] });
});

// An intrinsic (a method run as generated code instead of its body or a native) is keyed by class,
// name and descriptor, so a key its platform class does not declare never applies, silently.
test.skipIf(!hasPlatformJars())("every intrinsic names a method its platform class declares", () => {
  const jar = (name: string) => new URL(`../vendor/aosp/${name}`, import.meta.url).pathname;
  const prog = new Program(PLATFORM_JARS.flatMap((name) => dexesFrom(new Uint8Array(readFileSync(jar(name))), jar(name))));
  const extern = new Set(externs);
  const unmatched = [...intrinsics.keys()].filter((key) => {
    const dot = key.indexOf(".");
    return !extern.has(key) && !prog.get(key.slice(0, dot))?.byKey.has(key.slice(dot + 1));
  });
  expect(unmatched).toEqual([]);
});
