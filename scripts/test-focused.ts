import { existsSync } from "node:fs";
import { resolve, dirname, relative, extname } from "node:path";
import { FLOWS } from "../tests/e2e/flows";
import { apkHashes, flowSchemaHash, gitExecutable, type CoverageIndex } from "../tests/e2e/coverage";

const root = resolve(import.meta.dir, "..");
const deterministic = FLOWS.filter((flow) => flow.clock !== "live");
const allFlows = deterministic.map((flow) => flow.app);
const broad = ["src/native/", "src/jvm/", "src/shell/process", "src/main.ts", "src/process.ts", "src/natives.ts",
  "src/shell/config.ts", "tests/e2e/", "server.ts", "package.json", "tsconfig.json"];

async function gitNames(args: string[]): Promise<string[]> {
  const process = Bun.spawn([gitExecutable(), ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code) throw new Error(stderr.trim() || `git ${args[0]} failed with ${code}`);
  return stdout.split("\n").filter(Boolean);
}

async function changedWorkingTree(): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitNames(["diff", "--name-only", "HEAD"]),
    gitNames(["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...new Set([...tracked, ...untracked])];
}

async function changedSince(base: string): Promise<string[]> {
  return [...new Set([...await gitNames(["diff", "--name-only", `${base}...HEAD`]), ...await changedWorkingTree()])];
}

async function inputs(args: string[]): Promise<string[]> {
  const baseAt = args.indexOf("--base");
  if (baseAt >= 0) {
    const base = args[baseAt + 1];
    if (!base) throw new Error("--base requires a git revision");
    return changedSince(base);
  }
  if (args.some((arg) => arg.startsWith("-"))) throw new Error("usage: bun run test:focused -- [--base revision | paths...]");
  if (args.length) return args;
  return changedWorkingTree();
}

const sourceFiles = [...new Set([
  ...new Bun.Glob("{src,tests}/**/*.ts").scanSync({ cwd: root }),
  ...new Bun.Glob("{src,tests}/**/*.tsx").scanSync({ cwd: root }),
])];
const sourceSet = new Set(sourceFiles);
const reverse = new Map<string, string[]>();
const importPattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g;
for (const file of sourceFiles) {
  const text = await Bun.file(resolve(root, file)).text();
  for (const match of text.matchAll(importPattern)) {
    const base = relative(root, resolve(root, dirname(file), match[1]));
    const candidates = extname(base) ? [base] : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    const dependency = candidates.find((candidate) => sourceSet.has(candidate));
    if (!dependency) continue;
    const files = reverse.get(dependency) ?? [];
    files.push(file);
    reverse.set(dependency, files);
  }
}

function dependants(paths: string[]): Set<string> {
  const seen = new Set(paths);
  const queue = [...paths];
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const dependant of reverse.get(file) ?? []) if (!seen.has(dependant)) { seen.add(dependant); queue.push(dependant); }
  }
  return seen;
}

const changed = (await inputs(process.argv.slice(2))).map((path) => relative(root, resolve(root, path)));
if (!changed.length) {
  console.log("No changed paths; nothing to run.");
  process.exit(0);
}
const affected = dependants(changed);
const tests = [...affected].filter((file) => /\.test\.ts$/.test(file));

const indexPath = resolve(root, "tests/e2e/coverage-index.json");
let selected = new Set<string>();
let widened = changed.some((file) => broad.some((prefix) => file === prefix || file.startsWith(prefix)));
if (!widened && existsSync(indexPath)) {
  const index = await Bun.file(indexPath).json() as CoverageIndex;
  const currentApks = await apkHashes(deterministic);
  if (!index.complete || index.schemaHash !== flowSchemaHash(deterministic) ||
      index.mode !== "v8-precise-sourcemap" ||
      deterministic.some((flow) => !(flow.app in index.flows) || index.apkHashes[flow.app] !== currentApks[flow.app])) widened = true;
  else for (const file of affected) for (const flow of index.files[file] ?? []) selected.add(flow);
} else widened = true;
if (!selected.size) widened = true;
if (widened) selected = new Set(allFlows);

console.log(`changed: ${changed.join(", ")}`);
console.log(`unit: ${tests.length ? tests.join(", ") : "none"}`);
console.log(`fast e2e: ${[...selected].join(", ")}${widened ? " (conservative expansion)" : ""}`);

if (tests.length) {
  const unit = Bun.spawn(["bun", "test", ...tests], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await unit.exited) process.exit(1);
}
const e2eArgs = [...selected].flatMap((flow) => ["--test", flow]);
const e2e = Bun.spawn(["bun", "run", "e2e:fast", "--", ...e2eArgs], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exit(await e2e.exited);
