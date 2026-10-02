import { expect, test } from "bun:test";
import { BASELINE, descriptorMismatches, hasPlatformJars, withoutHint } from "../scripts/desccheck";

// A registered descriptor AOSP does not declare is never reached by bytecode calling the real
// method. Accepted ones (extras shared across a hierarchy, other API levels) are in the baseline;
// `bun run desccheck --write-baseline` rewrites it.
test.skipIf(!hasPlatformJars())("registered descriptors match AOSP declarations, and the baseline holds no fixed ones", async () => {
  const accepted: Record<string, string[]> = await Bun.file(BASELINE).json();
  const found = new Set([...descriptorMismatches()].flatMap(([cls, msgs]) => msgs.map((msg) => `${cls}: ${withoutHint(msg)}`)));
  const baseline = new Set(Object.entries(accepted).flatMap(([cls, msgs]) => msgs.map((msg) => `${cls}: ${msg}`)));
  expect({ fresh: [...found].filter((m) => !baseline.has(m)), stale: [...baseline].filter((m) => !found.has(m)) }).toEqual({ fresh: [], stale: [] });
});
