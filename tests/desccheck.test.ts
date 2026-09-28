import { expect, test } from "bun:test";
import { BASELINE, descriptorMismatches, hasPlatformJars, withoutHint } from "../scripts/desccheck";

// A registered descriptor AOSP does not declare is never reached by bytecode calling the real
// method. Accepted ones (extras shared across a hierarchy, other API levels) are in the baseline;
// `bun run desccheck --write-baseline` rewrites it.
test.skipIf(!hasPlatformJars())("registered descriptors match AOSP declarations", async () => {
  const accepted: Record<string, string[]> = await Bun.file(BASELINE).json();
  const fresh: string[] = [];
  for (const [cls, msgs] of descriptorMismatches()) {
    for (const msg of msgs) if (!accepted[cls]?.includes(withoutHint(msg))) fresh.push(`${cls}: ${msg}`);
  }
  expect(fresh).toEqual([]);
});
