export {};
// Build vendor/framework-res.apk — the real android: resource package, compiled with aapt2 from
// the platform's own res tree. `-x` links it at package id 0x01, so every android.R.* id it
// carries is the one an app compiled against the same platform already refers to.
//
//   bun run gen-framework-res
//
// The device profile chooses the platform and the config filter, so there is no second place
// where the target device is described.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { device } from "../src/shell/config";

const OUT = "vendor/framework-res.apk";

const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? `${process.env.HOME}/Library/Android/sdk`;
// The res tree only has to be a superset of what the device can select, since anything it cannot
// is dropped at link time and again when the table is parsed. So: the device's own API level if
// that platform is installed, else the lowest one above it -- not the newest, whose values files
// can use build-flag syntax an older aapt2 refuses.
const levels = readdirSync(`${sdkRoot}/platforms`)
  .filter((d) => existsSync(`${sdkRoot}/platforms/${d}/data/res`))
  .map((d) => parseInt(d.slice(8)) || 0)
  .sort((a, b) => a - b);
const apiLevel = levels.find((l) => l >= device.sdk) ?? levels.pop();
if (!apiLevel) throw new Error(`no platform res tree under ${sdkRoot}/platforms — install one with:\n  sdkmanager "platforms;android-${device.sdk}"`);
const platform = `${sdkRoot}/platforms/android-${apiLevel}`;
// build-tools are forward compatible, so the newest installed one wins
const tools = readdirSync(`${sdkRoot}/build-tools`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const aapt2 = tools.map((v) => `${sdkRoot}/build-tools/${v}/aapt2`).filter(existsSync).pop();
if (!aapt2) throw new Error(`no aapt2 under ${sdkRoot}/build-tools — install it with:\n  sdkmanager "build-tools;35.0.1"`);

const run = (...args: string[]) => {
  const r = Bun.spawnSync([aapt2, ...args], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`aapt2 ${args[0]} failed:\n${r.stderr.toString().split("\n").slice(0, 12).join("\n")}`);
};

const tmp = mkdtempSync(join(tmpdir(), "wd-fw-"));
const flata = `${tmp}/res.zip`, manifest = `${tmp}/AndroidManifest.xml`, ids = `${tmp}/ids.txt`;
await Bun.write(manifest, `<?xml version="1.0" encoding="utf-8"?>\n<manifest package="android"/>\n`);

console.log(`compiling ${platform}/data/res (device reports API ${device.sdk})…`);
run("compile", "--dir", `${platform}/data/res`, "-o", flata);

// Every axis the device can never select is dropped here rather than shipped and skipped at
// runtime: the tablet wallpapers alone are 7MB.
console.log(`linking (density ${device.densityDpi}dpi, lang ${device.lang}, sw${device.widthDp}dp) …`);
run("link", "-x", "--manifest", manifest, "--min-sdk-version", String(apiLevel),
  "--preferred-density", `${device.densityDpi}dpi`, "-c", `${device.lang},sw${device.widthDp}dp`,
  "--emit-ids", ids, "-o", OUT, flata);

// The linked ids must be the frozen platform ones, or every android.R reference in every app is
// off. public-final.xml is the platform's own record of them, so compare against it directly.
const declared = new Map<string, number>();
for (const m of (await Bun.file(`${platform}/data/res/values/public-final.xml`).text())
  .matchAll(/<public\s+type="([^"]+)"\s+name="([^"]+)"\s+id="([^"]+)"/g)) {
  declared.set(`${m[1]}/${m[2]}`, parseInt(m[3], 16));
}
const linked = new Map<string, number>();
for (const line of (await Bun.file(ids).text()).split("\n")) {
  const m = /^android:(\S+) = (0x[0-9a-f]+)$/.exec(line.trim());
  if (m) linked.set(m[1], parseInt(m[2], 16));
}
// A retired resource keeps its index under a `removed_` name so later ids do not shift; aapt2 is
// free not to emit one. Any id that linked to a *different* value is always fatal.
const wrong = [...declared].filter(([k, v]) => (linked.get(k) ?? v) !== v || (!linked.has(k) && !/removed/.test(k)));
if (wrong.length) {
  throw new Error(`${wrong.length}/${declared.size} public ids do not match public-final.xml, e.g. ` +
    wrong.slice(0, 3).map(([k, v]) => `${k}=0x${v.toString(16)} linked 0x${(linked.get(k) ?? 0).toString(16)}`).join(", "));
}

const size = (await Bun.file(OUT).arrayBuffer()).byteLength;
console.log(`wrote ${OUT} ${(size / 1048576).toFixed(1)}MB — ${linked.size} resources, ${declared.size} public ids verified`);
