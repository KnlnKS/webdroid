export {};
// Pull the real android: framework off the reference device and prove the two halves match.
//
//   bun run gen-framework            # pull from a connected device/emulator, then verify
//   bun run gen-framework --verify   # verify what is already in vendor/aosp
//
// framework.jar carries android.* and com.android.internal.* as bytecode; framework-res.apk
// carries the resource table those classes' R ids were compiled against. Neither is usable
// without the other: com.android.internal.R.styleable.* are int[] built in <clinit>, and the
// index constants beside them (R.styleable.View_background = 13) are already inlined into the
// framework's own bytecode. Take the pair from one build and the ids agree by construction;
// synthesise either half and they do not.
//
// The reference AVD (tests/e2e/setup-avd.sh) is also what records tests/e2e/golden, so the
// bytecode we run and the screenshots we score against come from the same platform build.
import { existsSync } from "node:fs";
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";
import { rt } from "../src/jvm/runtime";
import "../src/natives";
import { mangleStaticField } from "../src/jvm/abi";
import { Arsc } from "../src/android/arsc";

const OUT = "vendor/aosp";
const JAR = `${OUT}/framework.jar`, RES = `${OUT}/framework-res.apk`;
const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? `${process.env.HOME}/Library/Android/sdk`;
const adb = `${sdkRoot}/platform-tools/adb`;

const sh = (...args: string[]) => {
  const r = Bun.spawnSync([adb, ...args], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`adb ${args.join(" ")} failed:\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

if (!process.argv.includes("--verify")) {
  if (!existsSync(adb)) throw new Error(`no adb at ${adb} — install platform-tools`);
  sh("wait-for-device");
  for (let i = 0; sh("shell", "getprop", "sys.boot_completed") !== "1"; i++) {
    if (i > 90) throw new Error("device never reported sys.boot_completed — boot it with `bun run e2e:boot`");
    await Bun.sleep(2000);
  }
  const fingerprint = sh("shell", "getprop", "ro.build.fingerprint");
  console.log(`pulling from ${fingerprint}`);
  await Bun.$`mkdir -p ${OUT}`.quiet();
  for (const [src, dst] of [["/system/framework/framework.jar", JAR], ["/system/framework/framework-res.apk", RES]]) {
    sh("pull", src, dst);
    console.log(`  ${dst} ${(Bun.file(dst).size / 1e6).toFixed(1)}MB`);
  }
  await Bun.write(`${OUT}/build.txt`, `${fingerprint}\nsdk ${sh("shell", "getprop", "ro.build.version.sdk")}\n`);
}

for (const f of [JAR, RES]) if (!existsSync(f)) throw new Error(`missing ${f} — run \`bun run gen-framework\` with the reference AVD booted`);

// --- verify: every id the framework's own R classes name must resolve in the paired table ---
const jarZip = unzipSync(new Uint8Array(await Bun.file(JAR).arrayBuffer()), { filter: (f) => /^classes\d*\.dex$/.test(f.name) });
for (const n of Object.keys(jarZip).sort()) rt.loadDex(new DexFile(jarZip[n], n));
// the R classes are dex, but their <clinit> runs on java.* natives
console.log(`${JAR}: ${Object.keys(jarZip).length} dex, ${rt.dexIndex.size} classes`);

const paired = new Arsc(unzipSync(new Uint8Array(await Bun.file(RES).arrayBuffer()), { filter: (f) => f.name === "resources.arsc" })["resources.arsc"]);

/** every (name, id) pair the R$<type> classes in the framework dex declare */
async function rIds(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const name of rt.dexIndex.keys()) {
    if (!/^(android|com\/android\/internal)\/R\$/.test(name)) continue;
    const type = name.slice(name.indexOf("$") + 1);
    const info = rt.link(name);
    await rt.initClass(info);
    const ctor = info.ctor as Record<string, unknown>;
    const { dex, def } = info;
    if (!dex || !def) continue;
    for (const sf of def.staticFields) {
      const f = dex.field(sf.fieldIdx).name;
      const v = ctor[mangleStaticField(f)];
      // styleables are int[]; the scalar ids are what a table has to answer for
      if (typeof v === "number" && v >>> 24 === 0x01) out.set(`${type}/${f}`, v);
    }
  }
  return out;
}

const ids = await rIds();
// "an entry exists at this id" is not the test — a table whose ids shifted still answers
// almost every one. The name at the id has to be the name the bytecode compiled against.
const check = (a: Arsc) => {
  let hit = 0, wrong = 0, absent = 0;
  const examples: string[] = [];
  for (const [k, id] of ids) {
    const e = a.entry(id);
    const want = k.slice(k.indexOf("/") + 1);
    // R.java spells an entry as a java identifier, so a dotted style name arrives underscored
    if (!e) absent++;
    else if (e.key.replace(/\./g, "_") === want) hit++;
    else { wrong++; if (examples.length < 6) examples.push(`0x${(id >>> 0).toString(16)} is "${e.key}", bytecode says "${want}"`); }
  }
  return { hit, wrong, absent, examples };
};

const report = (label: string, r: ReturnType<typeof check>) => {
  console.log(`  ${label}: ${r.hit} right (${((r.hit / ids.size) * 100).toFixed(1)}%), ${r.wrong} wrong name, ${r.absent} absent`);
  for (const e of r.examples) console.log(`      ${e}`);
};

console.log(`R ids declared by the framework dex: ${ids.size}`);
const p = check(paired);
report(RES, p);
if (existsSync("vendor/framework-res.apk")) {
  const relinked = new Arsc(unzipSync(new Uint8Array(await Bun.file("vendor/framework-res.apk").arrayBuffer()), { filter: (f) => f.name === "resources.arsc" })["resources.arsc"]);
  report("vendor/framework-res.apk (aapt2-relinked from the SDK res tree)", check(relinked));
}
if (p.wrong) throw new Error(`${p.wrong} ids name a different resource in ${RES} than in ${JAR} — the two halves are not from one build`);
