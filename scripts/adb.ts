// The reference device over adb, for the scripts that record from it.
import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { androidTool } from "./android-sdk.ts";
import { fixture } from "./java.ts";

export function adb(...args: string[]): string {
  const r = spawnSync(androidTool("adb"), args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`adb ${args.join(" ")} failed:\n${(r.stderr || String(r.error)).trim()}`);
  return r.stdout.trim();
}
export type Adb = (...args: string[]) => Promise<Buffer>;
/** adb on the device `serial` (else the one connected) for callers that wait on it: a command's output, or a throw when it fails or outlives `timeout` ms */
export function adbOn(serial?: string, timeout?: number): Adb {
  const on = serial ? ["-s", serial] : [];
  return async (...args) => (await promisify(execFile)(androidTool("adb"), [...on, ...args], { encoding: "buffer", maxBuffer: 1 << 30, timeout })).stdout;
}
/** the build of the oracle `serial` that `adb` reaches, which must be the reference's API 35 */
export async function oracleIdentity(adb: Adb, serial: string): Promise<{ sdk: string; fingerprint: string }> {
  const [sdk, fingerprint] = await Promise.all(["ro.build.version.sdk", "ro.build.fingerprint"].map(async (p) => (await adb("shell", "getprop", p)).toString().trim()));
  if (sdk !== "35") throw new Error(`oracle ${serial} is API ${sdk}, expected API 35`);
  return { sdk, fingerprint };
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
