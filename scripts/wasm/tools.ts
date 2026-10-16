// What the suites share: building their Java fixtures with javac and d8, running them on the JDK, and checking answers.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { androidPlatform, androidTool } from "../android-sdk.ts";

/** runs `cmd` in `cwd` (feeding it `input`) and answers its stdout; a failure throws with its stderr */
export function shellIn(cwd: string) {
  return (cmd: string[], input?: string): string => {
    const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd });
    if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
    return r.stdout.toString();
  };
}

/** the files of `dir` whose names match `re` */
export const filesIn = (dir: string, re: RegExp) => readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));

/** the JDK's answer to each `Class.method args` line, run by the Ref fixture on the class path `cp` */
export const onJdk = (sh: ReturnType<typeof shellIn>, cp: string, calls: string[]): string[] =>
  sh(["java", "-cp", cp, "Ref"], calls.join("\n") + "\n").trim().split("\n");

/** a workload is a `case "x": body` line of Bench.run; its body becomes `static int w_x()` so each compiles on its own */
export function cutWorkloads(text: string): { names: string[]; source: string } {
  const names: string[] = [];
  const methods = text.split("\n").flatMap((l) => {
    const m = /^\s*((?:case "\w+": )+)(.*)$/.exec(l); if (!m) return [];
    return [...m[1].matchAll(/"(\w+)"/g)].map((x) => (names.push(x[1]), `static int w_${x[1]}() throws Exception { String w = "${x[1]}"; ${m[2]} }`));
  });
  return { names, source: text.replace(/}\s*$/, methods.join("\n") + "\n}\n") };
}

/** compiles the sources of `dir` (names) against android.jar and dexes every class there */
export function dexAndroid(sh: ReturnType<typeof shellIn>, dir: string, sources: string[]): void {
  sh(["javac", "--release", "11", "-cp", `${androidPlatform(35)}/android.jar`, "-d", dir, ...sources]);
  sh([androidTool("d8"), "--min-api", "26", "--output", dir, ...filesIn(dir, /\.class$/)]);
}

/** a suite's failures: `fail` prints and counts one, `check` compares a value with the one wanted */
export function checker() {
  const t = {
    failed: 0, checks: 0,
    fail(what: string) { t.failed++; console.log("FAIL " + what); },
    check(what: string, got: unknown, want: unknown) { t.checks++; if (got !== want) t.fail(`${what}: got ${String(got)}, want ${String(want)}`); },
  };
  return t;
}

/** the lines a fixture's expected file records */
export const recorded = (path: string): string[] => readFileSync(path, "utf8").trimEnd().split("\n");

/** a failure for each answer that is not the recorded line, and for a different number of answers */
export function unlike(want: string[], got: string[]): string[] {
  const out = want.flatMap((line, i) => got[i] === line ? [] : [`${line.split(":")[0]}\n  want  ${line}\n  wasm  ${got[i]}`]);
  if (got.length !== want.length) out.push(`${got.length} answers for ${want.length}`);
  return out;
}
