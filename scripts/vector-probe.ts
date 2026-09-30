// Records VectorDrawableProbe's output on the reference AVD (booted, `adb` reachable) into
// tests/fixtures/vector-drawable.txt, which fwtest and the browser test compare against.
import { androidPlatform, androidTool } from "./android-sdk";

const adb = (...args: string[]) => {
  const r = Bun.spawnSync([androidTool("adb"), ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode) throw new Error(`adb ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};
const dir = (await Bun.$`mktemp -d`.text()).trim(), javac = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
const jar = `${androidPlatform(35)}/android.jar`;
await Bun.$`${javac} --release 17 -cp ${jar} -d ${dir} scripts/VectorDrawableProbe.java`.quiet();
await Bun.$`${androidTool("d8")} --min-api 34 --lib ${jar} --output ${dir} ${dir}/VectorDrawableProbe.class`.quiet();
const remote = "/data/local/tmp/unit-d/vector-probe.dex";
adb("shell", "mkdir -p /data/local/tmp/unit-d");
adb("push", `${dir}/classes.dex`, remote);
const out = adb("shell", `CLASSPATH=${remote} app_process / VectorDrawableProbe`);
await Bun.write("tests/fixtures/vector-drawable.txt", out.trim() + "\n");
console.log(`tests/fixtures/vector-drawable.txt: ${out.trim().split("\n").length} lines`);
