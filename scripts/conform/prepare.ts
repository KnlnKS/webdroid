// Fetches a suite's jars and test sources and compiles them with ConformRunner to dex under conform-cache/<suite>
// (cached by runner source content), for scripts/wasm/conform.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { androidPlatform, androidTool } from "../android-sdk.ts";
import { SUITES } from "./suites.ts";

export const CACHE = "conform-cache";
export async function prepare(suiteName: string): Promise<{ suite: (typeof SUITES)[string]; classes: string[]; dexDir: string }> {
  const suite = SUITES[suiteName];
  if (!suite) throw new Error(`unknown suite ${suiteName}: ${Object.keys(SUITES).join("|")}`);
  const jarDir = `${CACHE}/jars`, dexDir = `${CACHE}/${suiteName}`;
  const JAVA_HOME = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@21";
  const run = (cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { env: { ...process.env, JAVA_HOME, PATH: `${JAVA_HOME}/bin:${process.env.PATH}` }, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed:\n${r.stderr.toString()}`);
  };

  mkdirSync(jarDir, { recursive: true });
  const jars = await Promise.all(suite.maven.map(async (coords) => {
    const [group, artifact, version] = coords.split(":"), file = `${jarDir}/${artifact}-${version}.jar`;
    if (!existsSync(file)) {
      const res = await fetch(`https://repo1.maven.org/maven2/${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}.jar`);
      if (!res.ok) throw new Error(`${coords}: HTTP ${res.status}`);
      await Bun.write(file, res);
    }
    return file;
  }));
  const sources: string[] = [];
  let classes = suite.classes ?? [];
  if (suite.source) {
    const srcDir = `${CACHE}/src/${suiteName}`, root = `${srcDir}/${suite.source.root}`;
    if (!existsSync(root)) {
      mkdirSync(srcDir, { recursive: true });
      let res = await fetch(suite.source.archive);
      for (let tries = 1; !res.ok && tries < 5; tries++) { await Bun.sleep(2000 * tries); res = await fetch(suite.source.archive); }
      if (!res.ok) throw new Error(`${suite.source.archive}: HTTP ${res.status}`);
      await Bun.write(`${srcDir}/src.tar.gz`, await res.arrayBuffer());
      run(["tar", "xzf", `${srcDir}/src.tar.gz`, "-C", srcDir]);
    }
    for (const f of new Bun.Glob("**/*.java").scanSync(root)) {
      if (suite.source.include && !suite.source.include.test(f) || suite.source.exclude?.test(f)) continue;
      sources.push(`${root}/${f}`);
      const base = f.slice(f.lastIndexOf("/") + 1);
      if (!suite.source.tests.test(base)) continue;
      // the package names the class: an archive may hold several source roots
      const pkg = /^package\s+([\w.]+)\s*;/m.exec(readFileSync(`${root}/${f}`, "utf8"))?.[1];
      classes.push((pkg ? pkg + "." : "") + base.slice(0, -5));
    }
    classes = classes.sort();
  }
  const out = `${dexDir}/classes`, stamp = `${dexDir}/runner-sources.json`;
  const runners = [`${import.meta.dir}/ConformRunner.java`, ...(suite.testng ? [`${import.meta.dir}/NgRunner.java`] : [])];
  const runnerSources = JSON.stringify(runners.map((file) => readFileSync(file, "utf8")));
  const fullBuild = !existsSync(`${dexDir}/classes.dex`) || !existsSync(out);
  const runnerChanged = !existsSync(stamp) || readFileSync(stamp, "utf8") !== runnerSources;
  if (fullBuild || runnerChanged) {
    mkdirSync(out, { recursive: true });
    // javac does not remove inner classes that disappeared from a runner's source.
    for (const file of readdirSync(out)) if (/^(ConformRunner|NgRunner)(\$.*)?\.class$/.test(file)) rmSync(`${out}/${file}`);
    // libcore's test sources also name android.* and test-selection annotations (scripts/conform/stubs)
    const stubs = [...new Bun.Glob("**/*.java").scanSync(`${import.meta.dir}/stubs`)].map((f) => `${import.meta.dir}/stubs/${f}`);
    // hidden platform APIs the tests call: compiled against, never dexed, so the platform's own classes answer
    const hidden = `${dexDir}/hidden`;
    if (fullBuild && suite.source) run(["javac", "--release", "17", "-nowarn", "-cp", `${androidPlatform(35)}/android.jar`, "-d", hidden,
      ...[...new Bun.Glob("**/*.java").scanSync(`${import.meta.dir}/hidden`)].map((f) => `${import.meta.dir}/hidden/${f}`)]);
    // hidden java.* classes cannot come from the class path; they patch java.base as sources javac only reads
    const patch = suite.source ? ["--patch-module", `java.base=${import.meta.dir}/patch/java.base`] : [];
    run(["javac", "--release", "17", "-XDstringConcat=inline", "-nowarn", ...patch, "-cp", [...jars, `${androidPlatform(35)}/android.jar`, hidden].join(":"),
      "-d", out, ...runners, ...(fullBuild ? [...(suite.source ? stubs : []), ...sources] : [])]);
    // Build separately: a smaller result must not leave classes2.dex from an older build.
    // Publish only after d8 succeeds; failed builds keep their old stamp and are retried.
    const nextDex = mkdtempSync(`${dexDir}/dex-`);
    try {
      run([androidTool("d8"), "--min-api", "35", "--lib", `${androidPlatform(35)}/android.jar`, "--output", nextDex, ...jars,
        ...[...new Bun.Glob("**/*.class").scanSync(out)].map((f) => `${out}/${f}`)]);
      for (const file of readdirSync(dexDir)) if (/^classes(\d+)?\.dex$/.test(file)) rmSync(`${dexDir}/${file}`);
      for (const file of readdirSync(nextDex)) renameSync(`${nextDex}/${file}`, `${dexDir}/${file}`);
      await Bun.write(stamp, runnerSources);
    } finally { rmSync(nextDex, { recursive: true, force: true }); }
  }
  // the suite's resource roots as a jar, which the system class loader reads
  if (suite.source?.resources?.length && !existsSync(`${dexDir}/resources.jar`)) {
    const roots = suite.source.resources.flatMap((r) => ["-C", `${CACHE}/src/${suiteName}/${suite.source!.root}/${r}`, "."]);
    run(["jar", "cf", `${dexDir}/resources.jar`, ...roots]);
  }
  return { suite, classes, dexDir };
}
