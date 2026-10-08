import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidTool, androidPlatform } from "../scripts/android-sdk";
import { loadDexes } from "../scripts/wasm/lib";
import { jsTier } from "../scripts/wasm/oracle";
import { rt, runtimeOfDex } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { callOn, mainThread, scall } from "../src/jvm/natives/jentry";
import { setLazyMethods, entryBody, markedBody } from "../src/jvm/compiler";
import { codeKey, factorySource, useCode, type Factory } from "../src/jvm/codecache";
import { jvmProfiler } from "../src/jvm/profile";
import { perf } from "../src/perf";

let checks = 0, stage = "setup";
const deadline = setTimeout(() => { throw new Error(`caller-frame fixture stalled: ${stage}`); }, 20000);

const dir = mkdtempSync(join(tmpdir(), "caller-frames-"));
for (const name of ["classes", "dex"]) mkdirSync(join(dir, name));
// Compile-only signature stub. The DEX contains CallerFrames alone and runs real boot Reflection.
writeFileSync(join(dir, "Reflection.java"), "package sun.reflect; public class Reflection { public static Class<?> getCallerClass() { return null; } }");
const run = (cmd: string[]) => { const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
run(["javac", "--release", "8", "-d", join(dir, "classes"), join(dir, "Reflection.java"), join(import.meta.dir, "fixtures/CallerFrames.java")]);
run([androidTool("d8"), "--min-api", "26", "--lib", join(androidPlatform(35), "android.jar"), "--output", join(dir, "dex"), join(dir, "classes/CallerFrames.class")]);
stage = "jsTier"; await jsTier([]);
const dexes = loadDexes(join(dir, "dex/classes.dex")), originalTier = jvmProfiler.tier;
try {
  for (const mode of ["js", "cold", "eager", "persisted"] as const) {
    jvmProfiler.tier = mode === "cold" ? "cold" : "js";
    useCode({});
    const factories: Record<string, Factory> = {}, hits = { e: 0, r: 0 };
    const first = rt.fork(), second = rt.fork();
    for (const owner of [first, second]) for (const dex of dexes) owner.loadDex(dex);
    assert.notEqual(runtimeOfDex(dexes[0].id), second); checks++;
    const expected = [];
    const before = perf.methodsCold;
    for (const owner of [first, second]) {
      const info = owner.link("CallerFrames");
      owner.jni.set("CallerFrames|nativeFrame()Ljava/lang/Class;", () => scall("sun/reflect/Reflection", "getCallerClass", "()Ljava/lang/Class;"));
      let settle: (() => void) | undefined;
      owner.jni.set("CallerFrames|park()V", () => new Promise<void>(resolve => { settle = resolve; }));
      setLazyMethods(mode !== "eager");
      stage = `${mode}:init`;
      try { await owner.initClass(info); } finally { setLazyMethods(true); }
      const own = owner.classFor("CallerFrames"); expected.push(own);
      assert.equal(await callOn(mainThread, () => info.ctor[mangleMethod("literal", "()Ljava/lang/String;")]()), "function wd_fake( /* function wd_fake( */"); checks++;
      const invoke = (name: string) => callOn(mainThread, () => info.ctor[mangleMethod(name, "()Ljava/lang/Class;")]());
      stage = `${mode}:caller`;
      assert.ok(await invoke("caller") === own, `${mode}: caller defining identity`); checks++;
      // A second call must retain the native declaration after the JNI target is cached.
      stage = `${mode}:native`;
      for (let repeat = 0; repeat < 2; repeat++) { assert.ok(await invoke("nativeCaller") === own, `${mode}: native defining identity`); checks++; }
      stage = `${mode}:suspended`;
      const waiting = invoke("suspendedCaller");
      for (let spin = 0; spin < 32 && !settle; spin++) await Promise.resolve();
      assert.ok(settle); checks++; settle();
      assert.ok(await waiting === own, `${mode}: resumed defining identity`); checks++;
      if (mode === "persisted" && owner === first) {
        for (const rec of info.lazy ?? []) {
          if (!rec.m.codeOff) continue;
          const entry = entryBody(owner, info, rec.m.methodIdx)!;
          for (const [key, source, form] of [[entry[0], entry[1], "e"], [codeKey(rec.dex.id, rec.m.methodIdx, "r"), markedBody(owner, info, rec, "r"), "r"]] as const) {
            // Older factories have no frame tag. Binding must attach this execution's owner.
            const factory = new Function("return " + factorySource(source.replaceAll("R.frameMethod", "(fn=>fn)"), form))() as Factory;
            factories[key] = (...args) => { hits[form]++; return factory(...args); };
          }
        }
        useCode(factories);
      }
    }
    assert.ok(expected[0] !== expected[1]); checks++;
    if (mode === "persisted") { assert.ok(hits.e > 0 && hits.r > 0, "old entry and resumed factories executed"); checks++; }
    if (mode === "cold") { assert.ok(perf.methodsCold > before); checks++; }
    console.log(`${mode}: same DEX/two forks retain caller, native and resumed Class identity`);
  }
  assert.equal(rt.defines("CallerFrames"), false); checks++;
  assert.ok(!rt.missing.has("class CallerFrames")); checks++;
  console.log(`caller frames: ${checks} checks pass; root has no CallerFrames definition or missing-class telemetry`);
} finally { clearTimeout(deadline); useCode({}); setLazyMethods(true); jvmProfiler.tier = originalTier; }
