// Java for the scripts: the JDK they build and run fixtures with, javac and the SDK's d8 over it, and the shell and scratch directories those run in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidPlatform, androidTool } from "./android-sdk.ts";

const HOMEBREW = "/opt/homebrew/opt";
/** JAVA_HOME, else Homebrew's openjdk (the newest of its versions; macOS's /usr/bin/javac is a stub without one), else none: PATH's tools */
const JDK = process.env.JAVA_HOME ?? (existsSync(HOMEBREW) ? readdirSync(HOMEBREW) : []).filter((f) => /^openjdk(@\d+)?$/.test(f))
  .sort((a, b) => (+b.slice(8) || 1e9) - (+a.slice(8) || 1e9)).map((f) => `${HOMEBREW}/${f}`).find((home) => existsSync(`${home}/bin/javac`));
/** the environment commands run in: the JDK first on PATH, for d8 and the other tools that start java themselves */
const JDK_ENV: NodeJS.ProcessEnv = JDK ? { ...process.env, JAVA_HOME: JDK, PATH: `${JDK}/bin:${process.env.PATH}` } : process.env;
/** the JDK's `name` tool (javac, java, jar) */
export const jdkTool = (name: string): string => JDK ? `${JDK}/bin/${name}` : name;

/** runs `cmd` in `cwd` (feeding it `input`) and answers its stdout; a failure throws with its stderr */
export function shellIn(cwd: string, env = JDK_ENV) {
  return (cmd: string[], input?: string): string => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd, env, input, encoding: "utf8", maxBuffer: 1 << 28 });
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

export interface JavacOptions { release?: number; classpath?: string[]; android?: boolean; flags?: string[] }
/** compiles `sources` into `out` with javac at Java `release`, against `classpath` (and the SDK's android.jar for `android`) */
export function javac(out: string, sources: string[], { release = 8, classpath = [], android = false, flags = [] }: JavacOptions = {}): void {
  mkdirSync(out, { recursive: true });
  const cp = [...classpath, ...android ? [`${androidPlatform(35)}/android.jar`] : []];
  sh(["javac", "--release", String(release), "-Xlint:-options", ...flags, ...cp.length ? ["-cp", cp.join(":")] : [], "-d", out, ...sources]);
}

/** `classes` are the class files dexed (those of `out` whose names match, or these paths); `debug` is d8 without --release; `d8` adds arguments */
export type Fixture = JavacOptions & { sources?: string[]; classes?: RegExp | string[]; minApi?: number; debug?: boolean; d8?: string[]; out?: string };
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
