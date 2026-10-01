// Records InputProbe's output on the reference AVD (booted, `adb` reachable) into
// tests/fixtures/input-probe.txt, and keeps its dex as tests/fixtures/InputProbe.dex, which fwtest
// runs against our input natives and compares line by line.
import { androidPlatform, androidTool } from "./android-sdk";

const adb = (...args: string[]) => {
  const r = Bun.spawnSync([androidTool("adb"), ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode) throw new Error(`adb ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};
const dir = (await Bun.$`mktemp -d`.text()).trim(), javac = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
const jar = `${androidPlatform(35)}/android.jar`;
await Bun.$`${javac} --release 17 -cp ${jar} -d ${dir} scripts/InputProbe.java`.quiet();
await Bun.$`${androidTool("d8")} --min-api 34 --lib ${jar} --output ${dir} ${dir}/InputProbe.class`.quiet();
const remote = "/data/local/tmp/input-probe.dex";
adb("push", `${dir}/classes.dex`, remote);
const out = adb("shell", `CLASSPATH=${remote} app_process / InputProbe`);
await Bun.write("tests/fixtures/InputProbe.dex", Bun.file(`${dir}/classes.dex`));
await Bun.write("tests/fixtures/input-probe.txt", out.trim() + "\n");
console.log(`tests/fixtures/input-probe.txt: ${out.trim().split("\n").length} lines`);
