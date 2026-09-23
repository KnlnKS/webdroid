import { existsSync } from "node:fs";
import { resolve, dirname, relative, extname } from "node:path";
import { FLOWS } from "../tests/e2e/flows";
import { apkHashes, expectedScreens, flowSchemaHash, gitExecutable, parseCoverageIndex } from "../tests/e2e/coverage";

const root = resolve(import.meta.dir, "..");
const deterministic = FLOWS.filter((flow) => flow.clock !== "live");
const allFlows = deterministic.map((flow) => flow.app);
const broad = ["src/native/", "src/jvm/", "src/guest-clock.ts", "src/shell/process", "src/main.ts", "src/process.ts", "src/natives.ts",
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
  ...new Bun.Glob("{src,tests,scripts,vendor}/**/*.ts").scanSync({ cwd: root }),
  ...new Bun.Glob("{src,tests,scripts,vendor}/**/*.tsx").scanSync({ cwd: root }),
])];
const sourceSet = new Set(sourceFiles);
const reverse = new Map<string, string[]>();
const transpiler = new Bun.Transpiler({ loader: "ts" });
let graphIncomplete = false;
for (const file of sourceFiles) {
  const text = await Bun.file(resolve(root, file)).text();
  for (const imported of transpiler.scanImports(text)) {
    if (!imported.path.startsWith(".")) continue;
    const base = relative(root, resolve(root, dirname(file), imported.path));
    const extension = extname(base);
    const candidates = !extension
      ? [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
      : extension === ".js"
        ? [base, `${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`]
        : [base];
    const dependency = candidates.find((candidate) => sourceSet.has(candidate));
    if (!dependency) {
      if (!extension || extension === ".js" || extension === ".ts" || extension === ".tsx") graphIncomplete = true;
      continue;
    }
    const files = reverse.get(dependency) ?? [];
    if (!files.includes(file)) files.push(file);
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
const broadChange = changed.find((file) => broad.some((prefix) => file === prefix || file.startsWith(prefix)));
let widenedBecause = graphIncomplete ? "incomplete import graph" : broadChange ? `broad input ${broadChange}` : "";
let widened = !!widenedBecause;
if (!widened && existsSync(indexPath)) {
  try {
    const index = parseCoverageIndex(await Bun.file(indexPath).json());
    const [currentApks, currentScreens, sinceIndex] = await Promise.all([
      apkHashes(deterministic),
      expectedScreens(deterministic),
      gitNames(["diff", "--name-only", `${index.sourceRevision}..HEAD`]),
    ]);
    const expectedUnsupported = deterministic.filter((flow) => flow.sourceCoverage === "unsupported").map((flow) => flow.app).sort();
    const indexedUnsupported = [...index.unsupportedFlows].sort();
    const sourceChanged = sinceIndex.some((file) => file.startsWith("src/") ||
      (file.startsWith("tests/e2e/") && file !== "tests/e2e/coverage-index.json") ||
      file.startsWith("apks/") || file === "server.ts" || file === "package.json" || file === "tsconfig.json");
    const invalidFlow = Object.values(index.files).flat().some((flow) => !allFlows.includes(flow));
    if (!index.complete || index.schemaHash !== flowSchemaHash(deterministic) || sourceChanged || invalidFlow ||
        expectedUnsupported.join("\n") !== indexedUnsupported.join("\n") ||
        deterministic.some((flow) => !(flow.app in index.flows) || index.apkHashes[flow.app] !== currentApks[flow.app] ||
          index.screens[flow.app] !== currentScreens[flow.app])) {
      widened = true;
      widenedBecause = "stale or invalid coverage index";
    }
    else {
      for (const file of affected) for (const flow of index.files[file] ?? []) selected.add(flow);
      if (changed.some((file) => file.startsWith("src/")))
        for (const flow of index.unsupportedFlows) selected.add(flow);
    }
  } catch (error) {
    widened = true;
    widenedBecause = `unusable coverage index: ${String((error as Error).message ?? error)}`;
  }
} else if (!widened) {
  widened = true;
  widenedBecause = "coverage index missing";
}
if (!selected.size && !widened) {
  widened = true;
  widenedBecause = "changed code has no recorded flow";
}
if (widened) selected = new Set(allFlows);

console.log(`changed: ${changed.join(", ")}`);
console.log(`unit: ${tests.length ? tests.join(", ") : "none"}`);
console.log(`fast e2e: ${[...selected].join(", ")}${widened ? ` (conservative: ${widenedBecause})` : ""}`);

if (tests.length) {
  const unit = Bun.spawn(["bun", "test", ...tests], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await unit.exited) process.exit(1);
}
const e2eArgs = [...selected].flatMap((flow) => ["--test", flow]);
const e2e = Bun.spawn(["bun", "run", "e2e", "--", ...e2eArgs], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exit(await e2e.exited);
