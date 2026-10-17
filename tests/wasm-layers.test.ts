import { expect, test } from "vite-plus/test";
import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// compiler <- link <- host: the compiler and the linker run in a page, a worker and node, so only host/ may reach the runtime, the natives and
// the services; and only src/jvm/tier.ts, by a dynamic import, may reach src/wasm, so a page loads the tier while the rest of its code starts.
const SHARED_FRONT_END = new Set(["abi.ts", "dex.ts", "opcodes.ts", "prepared.ts", "structure.ts"]);

test("src/wasm keeps its layers", () => {
  const root = resolve(import.meta.dirname, "..", "src");
  const violations: string[] = [];
  for (const file of globSync("**/*.ts", { cwd: root })) {
    if (file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
    const from = resolve(root, file), layer = file.startsWith("wasm/") ? file.split("/")[1] : "js";
    const text = readFileSync(from, "utf8");
    for (const [, spec] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)"([^"]+)"/gm)) {
      const bad = (why: string) => violations.push(`${relative(root, from)} imports ${spec}: ${why}`);
      if (spec.startsWith("node:")) { if (layer === "compiler" || layer === "link") bad("a pure layer"); continue; }
      if (!spec.startsWith(".")) continue;
      const to = relative(root, resolve(dirname(from), spec));
      if (layer === "js") { if (to.startsWith("wasm") && file !== "jvm/tier.ts") bad("only jvm/tier.ts reaches the Wasm tier"); continue; }
      if (to.startsWith("wasm/")) {
        const target = to.split("/")[1];
        if (target === "host" && layer !== "host") bad(`${layer} may not import host`);
        continue;
      }
      if (layer !== "host" && !(to.startsWith("jvm/") && SHARED_FRONT_END.has(to.split("/")[1]))) bad(`${layer} may import only the shared front end outside src/wasm`);
    }
  }
  expect(violations).toEqual([]);
});

test("host code holds Java objects only as the facades toHost makes", () => {
  const root = resolve(import.meta.dirname, "..", "src/wasm/host");
  const raw = globSync("*.ts", { cwd: root }).filter((file) => /\b(?:w|world)\.entry\(/.test(readFileSync(resolve(root, file), "utf8")));
  expect(raw).toEqual([]);
});
