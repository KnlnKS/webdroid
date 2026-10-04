// What the suites share to build their Java fixtures with javac and d8.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { androidPlatform, androidTool } from "../android-sdk";

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
