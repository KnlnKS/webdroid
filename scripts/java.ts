// Java for the scripts: the JDK they build and run fixtures with, javac and the SDK's d8 over it, and the shell and scratch directories those run in.
import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { androidPlatform, androidTool } from "./android-sdk.ts";

const HOMEBREW = "/opt/homebrew/opt";
/** JAVA_HOME, else Homebrew's openjdk (the newest of its versions; macOS's /usr/bin/javac is a stub without one), else none: PATH's tools */
const JDK = process.env.JAVA_HOME ?? (existsSync(HOMEBREW) ? readdirSync(HOMEBREW) : []).filter((f) => /^openjdk(@\d+)?$/.test(f))
  .sort((a, b) => (+b.slice(8) || 1e9) - (+a.slice(8) || 1e9)).map((f) => `${HOMEBREW}/${f}`).find((home) => existsSync(`${home}/bin/javac`));
/** the environment commands run in: the JDK first on PATH, for d8 and the other tools that start java themselves */
const JDK_ENV: NodeJS.ProcessEnv = JDK ? { ...process.env, JAVA_HOME: JDK, PATH: `${JDK}/bin:${process.env.PATH}` } : process.env;

/** runs `cmd` in `cwd` (feeding it `input`, killing it after `timeout` ms) and answers its stdout; a failure throws with its stderr */
export function shellIn(cwd: string, env = JDK_ENV) {
  return (cmd: string[], input?: string, timeout?: number): string => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd, env, input, timeout, encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`${cmd[0]} failed: ${r.error ?? r.stderr}`);
    return r.stdout;
  };
}
const sh = shellIn(process.cwd());

/** a directory of this process's own, removed when it exits without failing (a failed run keeps its fixtures to look at) */
export function tempDir(prefix = "j2w-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", (code) => { if (!code) rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** the files of `dir` whose names match `re` */
export const filesIn = (dir: string, re: RegExp) => readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));

/** javac's, d8's and the Ref fixture's results, kept under what they read (the tool, its options and its inputs' contents); one no run has used for a
 *  month goes */
const CACHE = join(homedir(), ".cache/webdroid/java"), MONTH_MS = 30 * 86_400_000;
const JDK_KEY = JDK ? realpathSync(JDK) : "PATH";
let d8Path: string | undefined, pruned = false;
const fileDigests = new Map<string, string>();
/** `path`'s contents into `h`: a file's under its name, a directory's files under their relative paths, a missing one (a classpath may name it) as missing */
function digest(h: Hash, path: string, name = basename(path)): void {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) { h.update(name).update("\0missing"); return; }
  if (s.isDirectory()) {
    for (const f of readdirSync(path, { recursive: true, encoding: "utf8" }).sort()) if (statSync(join(path, f)).isFile()) digest(h, join(path, f), f);
    return;
  }
  const stamp = `${path}:${s.mtimeMs}:${s.size}`;
  let d = fileDigests.get(stamp);
  if (!d) fileDigests.set(stamp, d = createHash("sha256").update(readFileSync(path)).digest("hex"));
  h.update(name).update(d);
}
/** the directory `run` filled for `key` over `inputs`, made once */
function cached(key: string[], inputs: string[], run: (into: string) => void): string {
  const h = createHash("sha256").update(key.join("\0"));
  for (const path of inputs) digest(h, path);
  const dir = join(CACHE, h.digest("hex").slice(0, 32)), now = new Date();
  if (existsSync(dir)) { utimesSync(dir, now, now); return dir; }
  mkdirSync(CACHE, { recursive: true });
  if (!pruned) {
    pruned = true;
    for (const f of readdirSync(CACHE)) if (now.getTime() - statSync(join(CACHE, f)).mtimeMs > MONTH_MS) rmSync(join(CACHE, f), { recursive: true, force: true });
  }
  const into = mkdtempSync(dir + "-");
  try { run(into); renameSync(into, dir); } catch (e) {
    rmSync(into, { recursive: true, force: true });
    // another process made it meanwhile
    if (!existsSync(dir)) throw e;
  }
  return dir;
}

export interface JavacOptions { release?: number; classpath?: string[]; android?: boolean; flags?: string[] }
/** compiles `sources` into `out` with javac at Java `release`, against `classpath` (and the SDK's android.jar for `android`) */
export function javac(out: string, sources: string[], { release = 8, classpath = [], android = false, flags = [] }: JavacOptions = {}): void {
  const cp = [...classpath, ...android ? [`${androidPlatform(35)}/android.jar`] : []];
  const opts = ["--release", String(release), "-Xlint:-options", ...flags];
  mkdirSync(out, { recursive: true });
  cpSync(cached(["javac", JDK_KEY, ...opts], [...sources, ...cp], (into) => sh(["javac", ...opts, ...cp.length ? ["-cp", cp.join(":")] : [], "-d", into, ...sources])), out, { recursive: true });
}

/** `classes` are the class files dexed (those of `out` whose names match, or these paths); `debug` is d8 without --release; `d8` adds arguments */
export type Fixture = JavacOptions & { sources?: string[]; classes?: RegExp | string[]; minApi?: number; debug?: boolean; d8?: string[]; out?: string };
/** `sources` compiled into `out` (a new temporary directory by default) and its classes dexed with the SDK's d8 into its classes.dex; `classpath`
 *  and `android` reach d8 too, as classes it resolves but leaves out. Answers `out`. */
export function fixture({ sources = [], classes = /\.class$/, minApi, debug, d8 = [], out = tempDir(), ...javacOptions }: Fixture = {}): string {
  if (sources.length) javac(out, sources, javacOptions); else mkdirSync(out, { recursive: true });
  const lib = javacOptions.android ? [`${androidPlatform(35)}/android.jar`] : [], classpath = javacOptions.classpath ?? [];
  const opts = [...debug ? [] : ["--release"], ...minApi ? ["--min-api", String(minApi)] : [], ...d8];
  const inputs = Array.isArray(classes) ? classes : filesIn(out, classes), tool = d8Path ??= androidTool("d8");
  cpSync(cached([tool, ...opts, `lib:${lib.length}`, `cp:${classpath.length}`], [...lib, ...classpath, ...inputs], (into) =>
    sh([tool, ...opts, ...lib.flatMap((p) => ["--lib", p]), ...classpath.flatMap((p) => ["--classpath", p]), "--output", into, ...inputs])), out, { recursive: true });
  return out;
}
/** a fixture against the Android API, as an app's code is built */
export const androidFixture = (f: Fixture): string => fixture({ release: 11, android: true, minApi: 26, debug: true, ...f });

export interface JavaRun { args?: string[]; input?: string; jvm?: string[]; timeout?: number }
/** the output of `main` on the JDK (with `jvm` options) over the class path `cp`, given `args` and fed `input`; `timeout` ms ends a run that hangs */
export const java = (cp: string, main: string, { args = [], input, jvm = [], timeout }: JavaRun = {}): string => sh(["java", ...jvm, "-cp", cp, main, ...args], input, timeout);
/** the JDK's answer to each `Class.method args` line, run by the Ref fixture on the class path `cp`: kept, as it depends on nothing else */
export function onJdk(cp: string, calls: string[]): string[] {
  const input = calls.join("\n") + "\n";
  const dir = cached(["Ref", JDK_KEY, input], cp.split(":"), (into) => writeFileSync(join(into, "stdout"), java(cp, "Ref", { input })));
  return readFileSync(join(dir, "stdout"), "utf8").trim().split("\n");
}
