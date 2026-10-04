// Java workloads timed in V8 (Bun's JSC times Java code differently): Bench.java compiles to a dex,
// runner.ts is bundled for node, and each workload runs in its own process.
//   bun run jbench [workload ...] [--reps n] [--cut <prefixes>]
// A cut (WEBDROID_BYTECODE) A/Bs the same tree; to compare trees, run it from each worktree with
// its own JBENCH_OUT, since conform-cache is shared between checkouts.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { androidPlatform, androidTool } from "../android-sdk";
import { consume } from "../args";

const args = process.argv.slice(2);
const { option } = consume(args);
const reps = option("--reps") ?? "100", cut = option("--cut");
const out = process.env.JBENCH_OUT ?? "conform-cache/jbench", dex = `${out}/classes.dex`, src = `${import.meta.dir}/Bench.java`;
const JAVA_HOME = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@21";
const run = (cmd: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(cmd, { env: { ...process.env, JAVA_HOME, PATH: `${JAVA_HOME}/bin:${process.env.PATH}`, ...env }, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd[0]} failed:\n${p.stderr.toString()}`);
  return p.stdout.toString();
};
mkdirSync(`${out}/classes`, { recursive: true });
if (!existsSync(dex) || statSync(dex).mtimeMs < statSync(src).mtimeMs) {
  run(["javac", "--release", "11", "-cp", `${androidPlatform(35)}/android.jar`, "-d", `${out}/classes`, src]);
  run([androidTool("d8"), "--min-api", "26", "--output", out, `${out}/classes/Bench.class`]);
}
run(["bun", "build", "--target=node", `--outfile=${out}/runner.js`, `${import.meta.dir}/runner.ts`]);
// Node before 25 ships the base64 Uint8Array methods the core loader uses behind a V8 flag
const base64 = run(["node", "-p", "typeof Uint8Array.fromBase64"]).trim() === "function" ? [] : ["--js-base-64"];
const all = [...(await Bun.file(src).text()).matchAll(/case "(\w+)":/g)].map((m) => m[1]);
for (const w of args.filter((a) => !a.startsWith("--")).length ? args.filter((a) => !a.startsWith("--")) : all) {
  process.stdout.write(run(["node", ...base64, `${out}/runner.js`, w, reps], { JBENCH_DEX: dex, ...(cut ? { WEBDROID_BYTECODE: cut } : {}) })
    .split("\n").filter((l) => l.startsWith("{")).join("\n") + "\n");
}
