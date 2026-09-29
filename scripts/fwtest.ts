// Run AOSP's own bytecode against our delegates, headless.
//
//   bun run fwtest [prefix ...]      # default: the graphics and resource cuts
//
// Provenance withholds our native spec for the named prefixes, the real classes load from
// vendor/aosp/framework.jar, and what they reach that we do not answer for is reported.
import { existsSync } from "node:fs";
import { BYTECODE, isBytecode } from "../src/jvm/provenance";
import { nativeMethodSupport } from "./native-surface";

const CUTS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
BYTECODE.push(...(CUTS.length ? CUTS : [
  "android/graphics/Paint", "android/graphics/Canvas", "android/graphics/BaseCanvas",
  "android/graphics/BaseRecordingCanvas", "android/graphics/Matrix", "android/graphics/Path",
  "android/graphics/Typeface", "android/graphics/Bitmap",
]));

// imported AFTER the policy is set: rt.register consults it, so the specs never land
const { rt, ACC } = await import("../src/jvm/runtime");
await import("../src/natives");

// the whole boot class path, as a page indexes it behind the app
const { loadPlatformJar } = await import("../src/android/framework");
const { PLATFORM_JARS } = await import("../src/jvm/provenance");
if (!existsSync("vendor/aosp/framework.jar")) throw new Error("no vendor/aosp/framework.jar — run `bun run gen-framework` with the reference AVD booted");
for (const [i, jar] of PLATFORM_JARS.entries()) loadPlatformJar(new Uint8Array(await Bun.file(`vendor/aosp/${jar}`).arrayBuffer()), i);
rt.linkNatives();
// the device's languages, which a booted page has before any app code runs
await (await import("../src/android/resnative")).initDeviceLocales();

console.log(`withheld ${BYTECODE.length} prefixes; ${rt.dexIndex.size} framework classes\n`);

// --- coverage: every native the dex declares under a cut, against what we registered ---
const declared = new Map<string, string[]>();
for (const name of rt.dexIndex.keys()) {
  if (!isBytecode(name)) continue;
  const info = rt.link(name);
  const { dex, def } = info;
  if (!dex || !def) continue;
  for (const m of [...def.directMethods, ...def.virtualMethods]) {
    if (m.codeOff || !(m.flags & ACC.NATIVE)) continue;
    (declared.get(name) ?? declared.set(name, []).get(name)!).push(dex.method(m.methodIdx).name + dex.methodDesc(m.methodIdx));
  }
}

let have = 0, total = 0;
const gaps: string[] = [];
for (const [cls, sigs] of [...declared].sort()) {
  const missing = sigs.map((signature) => `${cls}.${signature}`).filter((key) => nativeMethodSupport(rt, key) === "missing");
  const impl = sigs.length - missing.length;
  have += impl; total += sigs.length;
  gaps.push(...missing);
  console.log(`  ${String(impl).padStart(3)}/${String(sigs.length).padEnd(3)} ${cls}`);
}
console.log(`\ncoverage ${have}/${total} declared natives (${((have / (total || 1)) * 100).toFixed(0)}%)`);

// --- evidence: run the real bytecode and see what it actually reaches ---
const reached: string[] = [];
rt.onMissing = (w) => { reached.push(w); };

// Text measurement goes through an OffscreenCanvas 2D context, which bun does not have.
// Say so rather than reporting a delegate failure for a missing DOM.
const HAS_DOM = typeof (globalThis as { document?: unknown }).document !== "undefined";

async function exercise(name: string, fn: () => Promise<void>, needsDom = false) {
  if (needsDom && !HAS_DOM) { console.log(`skip ${name}  (needs a browser: Canvas2D text metrics)`); return; }
  const before = reached.length;
  try {
    await fn();
    const missed = reached.slice(before);
    console.log(`${missed.length ? "MISS" : "ok  "} ${name}${missed.length ? "  " + missed.slice(0, 3).join(" ") : ""}`);
  } catch (e) {
    const msg = (e as { msg?: string })?.msg ?? String(e);
    console.log(`FAIL ${name}  ${msg.split("\n")[0].slice(0, 150)}`);
  }
}

const { newObj, vcall, linkInit } = await import("../src/jvm/natives/jlang");
const { mangleMethod } = await import("../src/jvm/abi");
/** a static on a bytecode class: statics live on the constructor, mangled the same way */
async function scall(cls: string, name: string, desc: string, ...args: unknown[]): Promise<any> {
  const info = await linkInit(cls);
  const fn = (info.ctor as Record<string, unknown>)[mangleMethod(name, desc)];
  if (typeof fn !== "function") throw new Error(`no static ${cls}.${name}${desc}`);
  const r = (fn as (...a: unknown[]) => unknown)(...args);
  return r instanceof Promise ? await r : r;
}
console.log("");

await exercise("new Paint()", async () => {
  const p = await newObj("android/graphics/Paint", "()V");
  await vcall(p, "setColor", "(I)V", -65536);
  const c = await vcall(p, "getColor", "()I");
  if (c !== -65536) throw new Error(`getColor returned ${c}`);
  await vcall(p, "setTextSize", "(F)V", 24);
  await vcall(p, "setAntiAlias", "(Z)V", 1);
});

await exercise("Paint.measureText", async () => {
  const p = await newObj("android/graphics/Paint", "()V");
  await vcall(p, "setTextSize", "(F)V", 24);
  const w = await vcall(p, "measureText", "(Ljava/lang/String;)F", "hello");
  if (typeof w !== "number" || !(w > 0)) throw new Error(`measureText returned ${w}`);
}, true);

await exercise("new Matrix()", async () => {
  const m = await newObj("android/graphics/Matrix", "()V");
  await vcall(m, "setTranslate", "(FF)V", 3, 4);
  const id = await vcall(m, "isIdentity", "()Z");
  if (id) throw new Error("translated matrix reports identity");
});

await exercise("new Path()", async () => {
  const p = await newObj("android/graphics/Path", "()V");
  await vcall(p, "moveTo", "(FF)V", 0, 0);
  await vcall(p, "lineTo", "(FF)V", 10, 10);
  await vcall(p, "close", "()V");
});

await exercise("Bitmap.createBitmap + pixels", async () => {
  const cfg = await linkInit("android/graphics/Bitmap$Config");
  const argb = (cfg.ctor as Record<string, unknown>).s$ARGB_8888;
  if (!argb) throw new Error("no Bitmap.Config.ARGB_8888");
  const b = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", 4, 3, argb);
  const w = await vcall(b, "getWidth", "()I"), h = await vcall(b, "getHeight", "()I");
  if (w !== 4 || h !== 3) throw new Error(`created ${w}x${h}`);
  if (await vcall(b, "getRowBytes", "()I") !== 16) throw new Error("rowBytes is not 4 pixels");
  if (await vcall(b, "getConfig", "()Landroid/graphics/Bitmap$Config;") !== argb) throw new Error("config is not ARGB_8888");

  await vcall(b, "setPixel", "(III)V", 1, 2, -16711681);   // 0xff00ffff
  const got = await vcall(b, "getPixel", "(II)I", 1, 2);
  if (got !== -16711681) throw new Error(`getPixel returned 0x${(got >>> 0).toString(16)}`);
  if (await vcall(b, "getPixel", "(II)I", 0, 0) !== 0) throw new Error("an untouched pixel is not transparent");

  const out = new Int32Array(12);
  await vcall(b, "getPixels", "([IIIIIII)V", out, 0, 4, 0, 0, 4, 3);
  if (out[2 * 4 + 1] !== -16711681) throw new Error("getPixels disagrees with getPixel");
  await vcall(b, "eraseColor", "(I)V", -1);
  if (await vcall(b, "getPixel", "(II)I", 3, 0) !== -1) throw new Error("eraseColor did not reach every pixel");
  if (await vcall(b, "isRecycled", "()Z")) throw new Error("a fresh bitmap reports recycled");
});

// The resource natives, under AOSP's own Resources: the framework and an app installed as the
// package registry installs them, loaded through ApkAssets into an AssetManager, then read
// through Resources, Theme, TypedArray and XmlBlock as an app reads them.
if (isBytecode("android/content/res/Resources") && existsSync("vendor/aosp/framework-res.apk") && existsSync("apks/FitNotes.apk")) {
  const { Arsc } = await import("../src/android/arsc");
  const { Resources, setFramework } = await import("../src/android/res");
  const { PackageRecord, packages } = await import("../src/android/packages");
  const { centralDir, entryBytes } = await import("../src/jvm/natives/jzip");
  const { parseAXML } = await import("../src/android/axml");
  const { openInstall } = await import("../src/shell/install");
  const { mountPlatformData } = await import("../src/shell/apex");
  const read = async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer());
  // plurals select through ICU's PluralRules, which reads the apex ICU data
  mountPlatformData((path: string, size: number) => ({ size, read: async (at: number, length: number) => (await read(`vendor/aosp${path}`)).subarray(at, at + length) }));
  const fwApk = await read("vendor/aosp/framework-res.apk"), dir = centralDir(fwApk);
  const fwFiles = (path: string) => { const e = dir.get(path); return e ? entryBytes(fwApk, e) : null; };
  const fw = new Arsc(fwFiles("resources.arsc")!, fwFiles);
  setFramework(fw);
  packages.set("android", new PackageRecord(parseAXML(fwFiles("AndroidManifest.xml")!), new Resources(fw, {}, undefined, true),
    "/system/framework/framework-res.apk", 1000, async () => []));
  const app = openInstall(await read("apks/FitNotes.apk"));
  const appTable = new Arsc(app.zip["resources.arsc"], (path: string) => app.zip[path] ?? null);
  const manifest = parseAXML(app.zip["AndroidManifest.xml"]);
  const pkg = manifest.attrs.find((a) => a.name === "package")!.str!;
  packages.set(pkg, new PackageRecord(manifest, new Resources(appTable, app.zip, app.lazyEntries), "/data/app/base.apk", 10001, async () => []));
  const appTheme = manifest.children.find((n) => n.name === "application")!.attrs.find((a) => a.name === "theme")!.data;

  const S = "Ljava/lang/String;", T = "Landroid/content/res/Resources$Theme;";
  let res: unknown = null, theme: unknown = null;
  const id = (name: string, type: string, p: string): Promise<number> => vcall(res, "getIdentifier", `(${S}${S}${S})I`, name, type, p);
  await exercise("ApkAssets + AssetManager.Builder + Resources", async () => {
    const apk = await scall("android/content/res/ApkAssets", "loadFromPath", `(${S})Landroid/content/res/ApkAssets;`, "/data/app/base.apk");
    const builder = await newObj("android/content/res/AssetManager$Builder", "()V");
    await vcall(builder, "addApkAssets", "(Landroid/content/res/ApkAssets;)Landroid/content/res/AssetManager$Builder;", apk);
    const am = await vcall(builder, "build", "()Landroid/content/res/AssetManager;");
    const config = await newObj("android/content/res/Configuration", "()V");
    await vcall(config, "setToDefaults", "()V");
    res = await newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V",
      am, await newObj("android/util/DisplayMetrics", "()V"), config);
    theme = await vcall(res, "newTheme", `()${T}`);
    await vcall(theme, "applyStyle", "(IZ)V", appTheme, 1);
  });
  const expect = (what: string, got: unknown, want: unknown) => { if (got !== want) throw new Error(`${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`); };
  await exercise("Resources.getString (app and framework cookies)", async () => {
    expect("app_name", await vcall(res, "getString", `(I)${S}`, await id("app_name", "string", pkg)), "FitNotes");
    expect("android:ok", await vcall(res, "getString", `(I)${S}`, await id("ok", "string", "android")), "OK");
  });
  await exercise("Resources.getQuantityString (PluralRules over a bag)", async () => {
    const plural = appTable.findId("plurals", "exercise");
    expect("one", await vcall(res, "getQuantityString", `(II)${S}`, plural, 1), appTable.values.get(appTable.entry(plural)!.bag!.map.find((e) => e[0] === 0x01000006)![2]));
    expect("other", await vcall(res, "getQuantityString", `(II)${S}`, plural, 2), appTable.values.get(appTable.entry(plural)!.bag!.map.find((e) => e[0] === 0x01000004)![2]));
  });
  await exercise("Theme.obtainStyledAttributes (ApplyStyle over the theme)", async () => {
    const attrs = Int32Array.of(await id("colorBackground", "attr", "android"), await id("windowActionBar", "attr", "android"));
    const ta = await vcall(theme, "obtainStyledAttributes", "([I)Landroid/content/res/TypedArray;", attrs);
    const tv = await newObj("android/util/TypedValue", "()V");
    expect("resolveAttribute", await vcall(theme, "resolveAttribute", "(ILandroid/util/TypedValue;Z)Z", attrs[0], tv, 1), 1);
    expect("colorBackground", await vcall(ta, "getColor", "(II)I", 0, 7), (tv as { data: number }).data);
    expect("indices", await vcall(ta, "getIndexCount", "()I"), 2);
    await vcall(ta, "recycle", "()V");
  });
  await exercise("Resources.getLayout (XmlBlock walk, attribute strings from the block pool)", async () => {
    const parser = await vcall(res, "getLayout", "(I)Landroid/content/res/XmlResourceParser;", await id("activity_main", "layout", pkg));
    const tags: string[] = [];
    for (let ev = await vcall(parser, "next", "()I"); ev !== 1; ev = await vcall(parser, "next", "()I")) {
      if (ev !== 2) continue;
      tags.push(await vcall(parser, "getName", `()${S}`));
      // an XML string attribute comes back through the block's pool, cookie -1
      const ta = await vcall(res, "obtainAttributes", "(Landroid/util/AttributeSet;[I)Landroid/content/res/TypedArray;", parser, Int32Array.of(0x01010003));
      if (tags.length === 2) expect("fragment android:name", await vcall(ta, "getString", `(I)${S}`, 0), "com.github.jamesgay.fitnotes.feature.home.datenavigation.DateNavigationFragment");
      await vcall(ta, "recycle", "()V");
    }
    expect("tags", tags.join(","), "LinearLayout,fragment,androidx.viewpager.widget.ViewPager,ViewStub");
  });
  await exercise("Resources.getColorStateList (inflated from XML by ColorStateList)", async () => {
    const csl = await vcall(res, "getColorStateList", `(I${T})Landroid/content/res/ColorStateList;`, await id("primary_text_dark", "color", "android"), theme);
    expect("default", await vcall(csl, "getDefaultColor", "()I"), -1);
  });
}

if (gaps.length) {
  console.log(`\n${gaps.length} declared natives with no delegate, first 30:`);
  for (const g of gaps.slice(0, 30)) console.log("  " + g);
}
