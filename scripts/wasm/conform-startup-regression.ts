// A cold World must finish the main thread's context loader after recursive loader startup.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { androidTool } from "../android-sdk";
import { ROOT } from "./paths";
import { bundleForNode } from "./undernode";

const out = mkdtempSync(join(ROOT, "conform-cache/startup-regression-")), classes = join(out, "classes");
mkdirSync(classes);
const source = join(out, "LoaderStartup.java");
await Bun.write(source, `
public class LoaderStartup {
    private static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void cancelContext() { Thread.currentThread().setContextClassLoader(null); }
    public static String run(String ignored, String filter) {
        // Loading the system loader first reaches Thread.currentThread through
        // DexPathList -> File.isDirectory -> BlockGuard before the loader exists.
        ClassLoader system = ClassLoader.getSystemClassLoader();
        Thread current = Thread.currentThread();
        check(system != null && current.getContextClassLoader() == (filter.equals("cancel") ? null : system));
        ClassLoader defining = LoaderStartup.class.getClassLoader();
        current.setContextClassLoader(null);
        check(Thread.currentThread() == current);
        check(ClassLoader.getSystemClassLoader() == system);
        check(current.getContextClassLoader() == null);
        check(new Thread().getContextClassLoader() == null);
        ClassLoader other = new ClassLoader(system) {};
        current.setContextClassLoader(other);
        check(Thread.currentThread().getContextClassLoader() == other);
        check(new Thread().getContextClassLoader() == other);
        check(LoaderStartup.class.getClassLoader() == defining);
        current.setContextClassLoader(system);
        return "P\\tloaderFirst\\nP\\texplicitNull\\nP\\tinheritedContext\\nP\\tdefiningLoaderIdentity\\n";
    }
    public static void main(String[] args) {
        String mode = args.length == 0 ? "" : args[0];
        if (mode.equals("cancel")) cancelContext();
        System.out.print("\\u0001" + run("", mode));
    }
}
`);
const javaHome = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@21";
const env = { ...process.env, JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${process.env.PATH}` };
async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new Error(`${command[0]}: ${stderr}`);
  return stdout;
}
await run(["javac", "--release", "17", "-XDstringConcat=inline", "-d", classes, source]);
await run([androidTool("d8"), "--min-api", "35", "--output", out, join(classes, "LoaderStartup.class"), join(classes, "LoaderStartup$1.class")]);
const expected = "P\tloaderFirst\nP\texplicitNull\nP\tinheritedContext\nP\tdefiningLoaderIdentity\n";
// Observe a real pending assignment and enter the real Java setter before the
// loader finishes. No peer or class-initialization state is fabricated.
const cancellationRunner = join(out, "cancel-context.ts");
const originalRunner = readFileSync(join(import.meta.dir, "conformone.ts"), "utf8")
  .replace(/from "(\.[^"]+)"/g, (_, path) => `from ${JSON.stringify(resolve(import.meta.dir, path))}`)
  .replace("let text: string;", `
let cancelled = false;
const sync = w.sched.sync.bind(w.sched);
w.sched.sync = (op, obj, a) => {
  const result = sync(op, obj, a);
  if (op === Sync.ContextDeferred && !cancelled) {
    cancelled = true;
    w.entry("LoaderStartup", "cancelContext", "()V")();
  }
  return result;
};
let text: string;`)
  .replace("// a pipe takes", `if (!cancelled) throw new Error("no pending context assignment observed");\n// a pipe takes`);
await Bun.write(cancellationRunner, `import { Sync } from ${JSON.stringify(join(ROOT, "src/wasm/link/sched"))};\n${originalRunner}`);
for (const [tier, command] of [
  ["jdk", ["java", "-cp", classes, "LoaderStartup"]],
  ["wasm", await bundleForNode(join(import.meta.dir, "conformone.ts"), [out, "LoaderStartup", "LoaderStartup"])],
  ["jdk explicit null", ["java", "-cp", classes, "LoaderStartup", "cancel"]],
  ["wasm explicit null during startup", await bundleForNode(cancellationRunner, [out, "LoaderStartup", "LoaderStartup", "cancel"])],
] as const) {
  const output = await run([...command]);
  await Bun.write(join(out, `${tier}.txt`), output);
  const marker = output.indexOf("\u0001");
  if (marker < 0 || output.slice(marker + 1) !== expected) throw new Error(`${tier}: unexpected startup results\n${output}`);
  console.log(`${tier}: 4 startup checks pass; explicit null, inheritance and defining loader identity preserved`);
}
