// The reference device over adb, for the scripts that record from it.
import { basename } from "node:path";
import { androidPlatform, androidTool } from "./android-sdk.ts";

export function adb(...args: string[]): string {
  const r = Bun.spawnSync([androidTool("adb"), ...args], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`adb ${args.join(" ")} failed:\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}
/** adbd as root, which reading the system's data and SELinux decisions needs */
export async function asRoot(): Promise<void> {
  if (!adb("root").includes("already")) await Bun.sleep(2000); // adbd restarts
  adb("wait-for-device");
}
/** a device file pulled to `file`, logged with its size, which it returns */
export async function pull(src: string, file: string): Promise<number> {
  await Bun.$`mkdir -p ${file.slice(0, file.lastIndexOf("/"))}`.quiet();
  adb("pull", src, file);
  const size = Bun.file(file).size;
  console.log(`  ${file} ${(size / 1e6).toFixed(1)}MB`);
  return size;
}
/** the SDK the probes compile against: API 35's android.jar, for the reference device */
export const probeSdk = () => ({ jar: `${androidPlatform(35)}/android.jar`, minApi: 34 });
/** what a Java program's main prints on the device given `args`, compiled to dex (copied to `keep`)
 *  and run by app_process; `sdk` compiles it against an SDK's android.jar for a minimum API level */
export async function runDex(source: string, { sdk, args = [], keep }: { sdk?: { jar: string; minApi: number }; args?: string[]; keep?: string } = {}): Promise<string> {
  const cls = basename(source, ".java"), dir = (await Bun.$`mktemp -d`.text()).trim(), remote = `/data/local/tmp/webdroid-${cls}.dex`;
  const javac = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
  await Bun.$`${javac} --release 17 ${sdk ? ["-cp", sdk.jar] : []} -d ${dir} ${source}`.quiet();
  await Bun.$`${androidTool("d8")} ${sdk ? ["--min-api", String(sdk.minApi), "--lib", sdk.jar] : []} --output ${dir} ${dir}/${cls}.class`.quiet();
  if (keep) await Bun.write(keep, Bun.file(`${dir}/classes.dex`));
  adb("push", `${dir}/classes.dex`, remote);
  return adb("shell", `CLASSPATH=${remote} app_process / ${[cls, ...args].join(" ")}`);
}
