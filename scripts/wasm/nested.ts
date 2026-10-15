// Natives that enter Java (File.list0 asks the File for its path): each entry takes a JSPI stack of its own, which the engine frees only when the stack the native runs on waits
// and refuses past about 1,400. A Java loop of 3,000 File.list() calls in one entry must not end in StackOverflowError. Run: bun run wasm nested
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { world } from "./lib";
import { mountPlatform, natives, startProcess } from "./harness";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths";
import { filesIn, shellIn } from "./tools";

const out = mkdtempSync(join(tmpdir(), "j2w-nest-")), sh = shellIn(out);
sh(["javac", "--release", "11", "-Xlint:-options", "-d", out, join(JAVA, "Nest.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", out, ...filesIn(out, /\.class$/)]);
const dex = join(out, "classes.dex");
await mountPlatform(ROOT);
const w = world([dex, ...[0, 1, 12].map((i) => PLATFORM_PATHS[i])], { natives });
await startProcess(w);
const listed = await w.entryAsync("Nest", "loop", "(I)I")(3) as number;
let failed = 0;
for (const n of [100, 3000, 10000]) {
  try { const got = await w.entryAsync("Nest", "loop", "(I)I")(n) as number; if (got !== listed / 3 * n) { failed++; console.log(`FAIL ${n} calls: ${got}`); } }
  catch (e) { failed++; console.log(`FAIL ${n} calls: ${w.throwable(e) ? w.classNameOf(w.throwable(e)!) : e}`); }
}
console.log(failed ? `${failed} failures` : "nested entries: all pass");
process.exit(failed ? 1 : 0);
