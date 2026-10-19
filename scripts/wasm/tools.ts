// What the suites share: building their Java fixtures with javac and d8, running them on the JDK, checking answers, and bundling the harnesses pages run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidPlatform, androidTool } from "../android-sdk.ts";
import { bundle } from "../bundle.ts";

/** runs `cmd` in `cwd` (feeding it `input`) and answers its stdout; a failure throws with its stderr */
export function shellIn(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return (cmd: string[], input?: string): string => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd, env, input, encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`${cmd[0]} failed: ${r.error ?? r.stderr}`);
    return r.stdout;
  };
}

/** `entry` as one script for node, or for a page (g1.ts, boot-probe.ts) whose node:fs is the files it preloaded (g1fs.ts) */
export const bundleFor = (platform: "node" | "browser", entry: string): Promise<string> =>
  bundle(entry, platform === "node" ? { platform } : { alias: { "node:fs": join(import.meta.dirname, "g1fs.ts") } });

/** the files of `dir` whose names match `re` */
export const filesIn = (dir: string, re: RegExp) => readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));

const sh = shellIn(process.cwd());

/** a directory of this process's own, removed when it exits without failing (a failed run keeps its fixtures to look at) */
export function tempDir(prefix = "j2w-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", (code) => { if (!code) rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** compiles `sources` into `out` with javac at Java `release`, against `classpath` (and the SDK's android.jar for `android`) */
export function javac(out: string, sources: string[], { release = 8, classpath = [], android = false }: { release?: number; classpath?: string[]; android?: boolean } = {}): void {
  mkdirSync(out, { recursive: true });
  const cp = [...classpath, ...android ? [`${androidPlatform(35)}/android.jar`] : []];
  sh(["javac", "--release", String(release), "-Xlint:-options", ...cp.length ? ["-cp", cp.join(":")] : [], "-d", out, ...sources]);
}

/** `classes` are the class files dexed (those of `out` whose names match, or these paths); `debug` is d8 without --release; `d8` adds arguments */
export type Fixture = Parameters<typeof javac>[2] & { sources?: string[]; classes?: RegExp | string[]; minApi?: number; debug?: boolean; d8?: string[]; out?: string };
/** `sources` compiled into `out` (a new temporary directory by default) and its classes dexed with the SDK's d8 into its classes.dex; `classpath`
 *  and `android` reach d8 too, as classes it resolves but leaves out. Answers `out`. */
export function fixture({ sources = [], classes = /\.class$/, minApi, debug, d8 = [], out = tempDir(), ...javacOptions }: Fixture = {}): string {
  if (sources.length) javac(out, sources, javacOptions); else mkdirSync(out, { recursive: true });
  sh([androidTool("d8"), ...debug ? [] : ["--release"], ...minApi ? ["--min-api", String(minApi)] : [], ...javacOptions.android ? ["--lib", `${androidPlatform(35)}/android.jar`] : [],
    ...(javacOptions.classpath ?? []).flatMap((p) => ["--classpath", p]), ...d8, "--output", out, ...Array.isArray(classes) ? classes : filesIn(out, classes)]);
  return out;
}
/** a fixture against the Android API, as an app's code is built */
export const androidFixture = (f: Fixture): string => fixture({ release: 11, android: true, minApi: 26, debug: true, ...f });

/** the output of `main` on the JDK over the class path `cp`, fed `input` */
export const java = (cp: string, main: string, args: string[] = [], input?: string): string => sh(["java", "-cp", cp, main, ...args], input);
/** the JDK's answer to each `Class.method args` line, run by the Ref fixture on the class path `cp` */
export const onJdk = (cp: string, calls: string[]): string[] => java(cp, "Ref", [], calls.join("\n") + "\n").trim().split("\n");

/** a workload is a `case "x": body` line of Bench.run; its body becomes `static int w_x()` so each compiles on its own */
export function cutWorkloads(text: string): { names: string[]; source: string } {
  const names: string[] = [];
  const methods = text.split("\n").flatMap((l) => {
    const m = /^\s*((?:case "\w+": )+)(.*)$/.exec(l); if (!m) return [];
    return [...m[1].matchAll(/"(\w+)"/g)].map((x) => (names.push(x[1]), `static int w_${x[1]}() throws Exception { String w = "${x[1]}"; ${m[2]} }`));
  });
  return { names, source: text.replace(/}\s*$/, methods.join("\n") + "\n}\n") };
}

/** a suite's outcome: `fail` prints and counts a failure, `check` compares a value with the one wanted (and answers whether it is),
 *  `done` prints the result and exits, with status 1 after any failure */
export function checker(name: string) {
  const t = {
    failed: 0, checks: 0,
    fail(what: string) { t.failed++; console.log("FAIL " + what); },
    check(what: string, got: unknown, want: unknown): boolean { t.checks++; if (got === want) return true; t.fail(`${what}: got ${String(got)}, want ${String(want)}`); return false; },
    done(passed = "all pass"): never { console.log(`${name}: ${t.failed ? `${t.failed} failures` : passed}`); process.exit(t.failed ? 1 : 0); },
  };
  return t;
}
export type Suite = ReturnType<typeof checker>;

/** the lines a fixture's expected file records */
export const recorded = (path: string): string[] => readFileSync(path, "utf8").trimEnd().split("\n");

/** a failure for each answer that is not the recorded line, and for a different number of answers */
export function unlike(want: string[], got: string[]): string[] {
  const out = want.flatMap((line, i) => got[i] === line ? [] : [`${line.split(":")[0]}\n  want  ${line}\n  wasm  ${got[i]}`]);
  if (got.length !== want.length) out.push(`${got.length} answers for ${want.length}`);
  return out;
}
