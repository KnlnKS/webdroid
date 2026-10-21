// Natives that enter Java (File.list0 asks the File for its path): each entry takes a JSPI stack of its own, which the engine frees only when the stack the native runs on waits
// and refuses past about 1,400. A Java loop of 3,000 File.list() calls in one entry must not end in StackOverflowError. Run: pnpm wasm nested
import { join } from "node:path";
import { world } from "./lib.ts";
import { mountPlatform, startProcess } from "./harness.ts";
import { CORE_PATHS, JAVA, ROOT } from "./paths.ts";
import { checker } from "./tools.ts";
import { fixture } from "../java.ts";

const dex = join(fixture({ sources: [join(JAVA, "Nest.java")], release: 11, minApi: 34 }), "classes.dex");
await mountPlatform(ROOT);
const w = world([dex, ...CORE_PATHS]);
await startProcess(w);
const listed = await w.entryAsync("Nest", "loop", "(I)I")(3) as number;
const suite = checker("nested entries");
for (const n of [100, 3000, 10000]) {
  try { suite.check(`${n} calls`, await w.entryAsync("Nest", "loop", "(I)I")(n), listed / 3 * n); }
  catch (e) { suite.fail(`${n} calls: ${w.throwable(e) ? w.classNameOf(w.throwable(e)!) : e}`); }
}
suite.done();
