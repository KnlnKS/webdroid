// The reference device over adb, for the scripts that record from it.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { androidTool } from "./android-sdk.ts";
import { fixture } from "./java.ts";

export function adb(...args: string[]): string {
  const r = spawnSync(androidTool("adb"), args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`adb ${args.join(" ")} failed:\n${(r.stderr || String(r.error)).trim()}`);
  return r.stdout.trim();
}
/** adbd as root, which reading the system's data and SELinux decisions needs */
export async function asRoot(): Promise<void> {
  if (!adb("root").includes("already")) await setTimeout(2000); // adbd restarts
  adb("wait-for-device");
}
/** a device file pulled to `file`, logged with its size, which it returns */
export async function pull(src: string, file: string): Promise<number> {
  mkdirSync(dirname(file), { recursive: true });
  adb("pull", src, file);
  const size = statSync(file).size;
  console.log(`  ${file} ${(size / 1e6).toFixed(1)}MB`);
  return size;
}
/** what a Java program's main prints on the device given `args`, compiled to dex (copied to `keep`) and run by app_process; `android`
 *  compiles it against API 35's android.jar for the reference device */
export function runDex(source: string, { android = false, args = [], keep }: { android?: boolean; args?: string[]; keep?: string } = {}): string {
  const cls = basename(source, ".java"), dex = `${fixture({ sources: [source], release: 17, android, minApi: android ? 34 : undefined, debug: true })}/classes.dex`;
  const remote = `/data/local/tmp/webdroid-${cls}.dex`;
  if (keep) copyFileSync(dex, keep);
  adb("push", dex, remote);
  return adb("shell", `CLASSPATH=${remote} app_process / ${[cls, ...args].join(" ")}`);
}
