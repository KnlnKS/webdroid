// The reference device over adb, for the scripts that record from it.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { androidPlatform, androidTool } from "./android-sdk.ts";

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
/** the SDK the probes compile against: API 35's android.jar, for the reference device */
export const probeSdk = () => ({ jar: `${androidPlatform(35)}/android.jar`, minApi: 34 });
/** a scratch directory of its own under the system's temporary one */
export const tempDir = () => mkdtempSync(join(tmpdir(), "webdroid-"));
/** what a Java program's main prints on the device given `args`, compiled to dex (copied to `keep`)
 *  and run by app_process; `sdk` compiles it against an SDK's android.jar for a minimum API level */
export async function runDex(source: string, { sdk, args = [], keep }: { sdk?: { jar: string; minApi: number }; args?: string[]; keep?: string } = {}): Promise<string> {
  const cls = basename(source, ".java"), dir = tempDir(), remote = `/data/local/tmp/webdroid-${cls}.dex`;
  const javac = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
  execFileSync(javac, ["--release", "17", ...sdk ? ["-cp", sdk.jar] : [], "-d", dir, source], { stdio: "pipe" });
  execFileSync(androidTool("d8"), [...sdk ? ["--min-api", String(sdk.minApi), "--lib", sdk.jar] : [], "--output", dir, `${dir}/${cls}.class`], { stdio: "pipe" });
  if (keep) copyFileSync(`${dir}/classes.dex`, keep);
  adb("push", `${dir}/classes.dex`, remote);
  return adb("shell", `CLASSPATH=${remote} app_process / ${[cls, ...args].join(" ")}`);
}
