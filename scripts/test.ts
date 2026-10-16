// The unit tests. Java runs on the Wasm tier, which finds Java's frames in V8's stack, which JavaScriptCore does not name: each
// file runs in a node process of its own, bundled behind tests/platform.ts with bun:test resolved to tests/bun-test.ts. The
// *.browser.test.ts files drive Chrome over pages Bun.build bundles and Bun.serve serves, so `bun test` runs them.
//   bun run test [file ...]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { bundleForNode, removeBundle } from "./wasm/undernode.ts";
import "./preload.ts";

const root = resolve(import.meta.dir, "..");
/** a file whose process outlives its tests (a handle left open) is killed and fails */
const FILE_TIMEOUT_MS = 300_000;
const all = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f))
  : [...new Bun.Glob("{src,tests}/**/*.test.ts").scanSync({ cwd: root, absolute: true })].sort();
const browser = all.filter((f) => f.endsWith(".browser.test.ts")), files = all.filter((f) => !browser.includes(f));
const shim = join(root, "tests/bun-test.ts"), entries = mkdtempSync(join(tmpdir(), "webdroid-test-"));
/** bun:test as the shim, and a module imported with a query as an instance of its own, as Bun's runtime makes it */
const alias: Bun.BunPlugin = { name: "bun-test", setup: (b) => {
  b.onResolve({ filter: /^bun:test$/ }, () => ({ path: shim }));
  b.onResolve({ filter: /\?/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path), namespace: "instance" }));
  b.onLoad({ filter: /./, namespace: "instance" }, ({ path }) => {
    const file = path.slice(0, path.indexOf("?"));
    return { contents: readFileSync(file, "utf8"), loader: "ts", resolveDir: dirname(file) };
  });
} };

async function run(file: string, i: number): Promise<{ pass: number; fail: number; out: string }> {
  const entry = join(entries, `${i}.ts`);
  writeFileSync(entry, `import ${JSON.stringify(join(root, "tests/platform.ts"))};\nimport ${JSON.stringify(file)};\n`);
  const command = await bundleForNode(entry, [], [alias]).catch((e: Error) => e);
  if (command instanceof Error) return { pass: 0, fail: 1, out: command.message };
  const [node, ...flags] = command, bundle = flags.pop()!, nodeshim = flags.pop()!;
  const p = Bun.spawn([node, ...flags, "--test-reporter=spec", "--import", nodeshim, bundle], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: FILE_TIMEOUT_MS });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  removeBundle(command);
  const count = (k: string) => Number(new RegExp(`^ℹ ${k} (\\d+)`, "m").exec(out)?.[1] ?? 0);
  const pass = count("pass"), fail = count("fail") || (p.exitCode || p.signalCode ? 1 : 0);
  return { pass, fail, out: out + err + (p.signalCode ? `\nkilled (${p.signalCode}) after ${FILE_TIMEOUT_MS / 1000}s` : "") };
}

let next = 0, pass = 0, fail = 0;
const t0 = performance.now();
const browserRun = browser.length ? Bun.spawn(["bun", "test", ...browser], { cwd: root, stdout: "pipe", stderr: "pipe" }) : null;
await Promise.all(Array.from({ length: Math.max(1, availableParallelism() >> 1) }, async () => {
  for (let i = next++; i < files.length; i = next++) {
    const r = await run(files[i], i), name = relative(root, files[i]);
    pass += r.pass; fail += r.fail;
    console.log(`${r.fail ? "FAIL" : "ok  "} ${name}: ${r.pass} pass${r.fail ? `, ${r.fail} fail` : ""}`);
    if (r.fail) console.log(r.out.split("\n").filter((l) => !/^\s*(✔|ℹ)/.test(l)).join("\n"));
  }
}));
if (browserRun) {
  const out = (await Promise.all([new Response(browserRun.stdout).text(), new Response(browserRun.stderr).text()])).join("");
  const count = (k: string) => Number(new RegExp(`^ (\\d+) ${k}$`, "m").exec(out)?.[1] ?? 0);
  pass += count("pass"); fail += count("fail") || (await browserRun.exited ? 1 : 0);
  console.log(`${count("fail") || browserRun.exitCode ? `FAIL bun test (browser)\n${out}` : `ok   bun test (browser): ${count("pass")} pass`}`);
}
rmSync(entries, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail across ${all.length} files [${((performance.now() - t0) / 1000).toFixed(1)}s]`);
process.exit(fail ? 1 : 0);
