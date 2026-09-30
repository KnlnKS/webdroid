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
await (await import("../tests/java")).mountApexData();
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

// Text measurement and gradients go through an OffscreenCanvas 2D context, which bun does not have.
// Say so rather than reporting a delegate failure for a missing DOM.
const HAS_DOM = typeof (globalThis as { document?: unknown }).document !== "undefined";

async function exercise(name: string, fn: () => Promise<void>, needsDom = false) {
  if (needsDom && !HAS_DOM) { console.log(`skip ${name}  (needs a browser: a Canvas2D context)`); return; }
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

await exercise("Matrix (compose, map, invert, fit, poly, values)", async () => {
  const M = () => newObj("android/graphics/Matrix", "()V");
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  const str = (m: unknown) => vcall(m, "toString", "()Ljava/lang/String;");
  const rectF = (l: number, t: number, r: number, b: number) => newObj("android/graphics/RectF", "(FFFF)V", l, t, r, b);
  const m = await M();
  await vcall(m, "setTranslate", "(FF)V", 3, 4);
  await vcall(m, "preScale", "(FF)Z", 2, 2);
  await vcall(m, "postRotate", "(F)Z", 90);
  same("translate.scale then rotate", await str(m), "Matrix{[0.0, -2.0, -4.0][2.0, 0.0, 3.0][0.0, 0.0, 1.0]}");
  await vcall(m, "setRotate", "(FFF)V", 90, 10, 10);
  same("quarter turn", [await str(m), await vcall(m, "rectStaysRect", "()Z")], ["Matrix{[0.0, -1.0, 20.0][1.0, 0.0, 0.0][0.0, 0.0, 1.0]}", 1]);
  await vcall(m, "setSkew", "(FFFF)V", 0.5, 0.25, 4, 8);
  const pts = Float32Array.of(1, 2), vec = Float32Array.of(1, 2), rect = await rectF(0, 0, 10, 20);
  await vcall(m, "mapPoints", "([F)V", pts);
  await vcall(m, "mapVectors", "([F)V", vec);
  same("mapPoints/mapVectors", [...pts, ...vec], [-2, 1.25, 2, 2.25]);
  same("mapRect", [await vcall(m, "mapRect", "(Landroid/graphics/RectF;)Z", rect), await vcall(rect, "toShortString", "()Ljava/lang/String;")], [0, "[-4.0,-1.0][16.0,21.5]"]);
  const inv = await M(), product = await M();
  same("invert", await vcall(m, "invert", "(Landroid/graphics/Matrix;)Z", inv), 1);
  await vcall(product, "setConcat", "(Landroid/graphics/Matrix;Landroid/graphics/Matrix;)Z", m, inv);
  same("m * m^-1", await vcall(product, "isIdentity", "()Z"), 1);
  const fit = (await linkInit("android/graphics/Matrix$ScaleToFit")).ctor as Record<string, unknown>;
  same("setRectToRect CENTER", await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z",
    await rectF(0, 0, 100, 50), await rectF(10, 10, 210, 210), fit.s$CENTER), 1);
  same("its values", await str(m), "Matrix{[2.0, 0.0, 10.0][0.0, 2.0, 60.0][0.0, 0.0, 1.0]}");
  // four points need perspective
  const src = Float32Array.of(0, 0, 100, 0, 100, 100, 0, 100), dst = Float32Array.of(10, 10, 90, 20, 80, 90, 20, 80), out = new Float32Array(8);
  same("setPolyToPoly", [await vcall(m, "setPolyToPoly", "([FI[FII)Z", src, 0, dst, 0, 4), await vcall(m, "isAffine", "()Z")], [1, 0]);
  await vcall(m, "mapPoints", "([F[F)V", out, src);
  same("maps the quad", [...out].map((v) => +v.toFixed(3)), [...dst]);
  await vcall(m, "setValues", "([F)V", Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9));
  const copy = await newObj("android/graphics/Matrix", "(Landroid/graphics/Matrix;)V", m);
  same("equals a copy", await vcall(m, "equals", "(Ljava/lang/Object;)Z", copy), 1);
  await vcall(copy, "postTranslate", "(FF)Z", 1, 0);
  same("and not once changed", await vcall(m, "equals", "(Ljava/lang/Object;)Z", copy), 0);
});

await exercise("ColorFilters (native instances, updated in place)", async () => {
  const { deref } = await import("../src/android/handles");
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  const native = async (f: unknown) => deref<{ matrix: Float32Array | null; color: number; mode: string }>(await vcall(f, "getNativeInstance", "()J"));
  const srcAtop = ((await linkInit("android/graphics/PorterDuff$Mode")).ctor as Record<string, unknown>).s$SRC_ATOP;
  const porterDuff = await native(await newObj("android/graphics/PorterDuffColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", -65536, srcAtop));
  same("PorterDuffColorFilter", [porterDuff.color, porterDuff.mode, porterDuff.matrix], [-65536, "SRC_ATOP", null]);
  const multiply = ((await linkInit("android/graphics/BlendMode")).ctor as Record<string, unknown>).s$MULTIPLY;
  same("BlendModeColorFilter", (await native(await newObj("android/graphics/BlendModeColorFilter", "(ILandroid/graphics/BlendMode;)V", 7, multiply))).mode, "MULTIPLY");
  const lighting = await newObj("android/graphics/LightingColorFilter", "(II)V", 0x0080ff00, 0x00104020);
  const k = (await native(lighting)).matrix!;
  same("Lighting", [k[0], k[6], k[12], k[4], k[9], k[14], k[18]], [128 / 255, 1, 0, 16, 64, 32, 1].map(Math.fround));
  await vcall(lighting, "setColorAdd", "(I)V", 0x00010203);
  same("setColorAdd reaches the instance", [k[4], k[9], k[14]], [1, 2, 3]);
  const values = Float32Array.from({ length: 20 }, (_, i) => i);
  const matrix = await newObj("android/graphics/ColorMatrixColorFilter", "([F)V", values);
  const m = (await native(matrix)).matrix!;
  same("ColorMatrixColorFilter", [...m], [...values]);
  await vcall(matrix, "setColorMatrixArray", "([F)V", values.map((v) => -v));
  same("setColorMatrixArray reaches the instance", m[19], -19);
});

await exercise("Shaders (gradients, bitmap, compose; setLocalMatrix replaces the instance)", async () => {
  const { deref } = await import("../src/android/handles");
  const { NativeGradient, NativeBitmapShader, NativeComposeShader } = await import("../src/android/graphics");
  const clamp = ((await linkInit("android/graphics/Shader$TileMode")).ctor as Record<string, unknown>).s$CLAMP;
  const native = async (s: unknown) => deref<{ local: number[] | null }>(await vcall(s, "getNativeInstance", "()J"));
  const linear = await newObj("android/graphics/LinearGradient", "(FFFFIILandroid/graphics/Shader$TileMode;)V", 0, 0, 10, 0, -65536, -16776961, clamp);
  const first = await native(linear);
  if (!(first instanceof NativeGradient) || first.local) throw new Error("LinearGradient's instance is not an identity gradient");
  const m = await newObj("android/graphics/Matrix", "()V");
  await vcall(m, "setTranslate", "(FF)V", 5, 0);
  await vcall(linear, "setLocalMatrix", "(Landroid/graphics/Matrix;)V", m);
  const second = await native(linear);
  if (second === first || String(second.local) !== "1,0,0,1,5,0") throw new Error(`setLocalMatrix gave ${second.local}`);
  await newObj("android/graphics/RadialGradient", "(FFF[I[FLandroid/graphics/Shader$TileMode;)V", 5, 5, 5, Int32Array.of(-1, 0), null, clamp);
  await newObj("android/graphics/SweepGradient", "(FFII)V", 5, 5, -1, 0);
  const cfg = ((await linkInit("android/graphics/Bitmap$Config")).ctor as Record<string, unknown>).s$ARGB_8888;
  const bitmap = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", 2, 2, cfg);
  const bitmapShader = await newObj("android/graphics/BitmapShader", "(Landroid/graphics/Bitmap;Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V", bitmap, clamp, clamp);
  if (!(await native(bitmapShader) instanceof NativeBitmapShader)) throw new Error("BitmapShader's instance is not a bitmap shader");
  const srcOver = ((await linkInit("android/graphics/PorterDuff$Mode")).ctor as Record<string, unknown>).s$SRC_OVER;
  const compose = await newObj("android/graphics/ComposeShader", "(Landroid/graphics/Shader;Landroid/graphics/Shader;Landroid/graphics/PorterDuff$Mode;)V", linear, bitmapShader, srcOver);
  const composed = await native(compose);
  if (!(composed instanceof NativeComposeShader) || composed.dst !== second || composed.op !== "source-over") throw new Error("ComposeShader's instance does not compose its shaders");
  await vcall(m, "setTranslate", "(FF)V", 7, 0);
  await vcall(linear, "setLocalMatrix", "(Landroid/graphics/Matrix;)V", m);
  const recomposed = await native(compose);
  if (recomposed === composed || String((recomposed as InstanceType<typeof NativeComposeShader>).dst.local) !== "1,0,0,1,7,0") throw new Error("ComposeShader kept a replaced child");
}, true);

// Expected values are Roboto's own tables: OS/2 weight 400/700, head.fontRevision 0x22354, name ID 6
// "RobotoStatic-Regular", hhea 1900/-500/0 and head yMax/yMin 2163/-555 over 2048 units per em.
await exercise("Font, FontFamily, FontFileUtil", async () => {
  const { vfs } = await import("../src/shell/vfs");
  const { familyOf } = await import("../src/android/fonts");
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  const F = "Landroid/graphics/fonts/Font;", FB = "Landroid/graphics/fonts/Font$Builder;", BB = "Ljava/nio/ByteBuffer;";
  const bytes = async (file: string) => new Uint8Array(await Bun.file(`vendor/fonts/${file}`).arrayBuffer());
  for (const file of ["Roboto-Regular.ttf", "Roboto-Bold.ttf"]) vfs.write(`/system/fonts/${file}`, await bytes(file));
  const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/system/fonts/Roboto-Regular.ttf");
  const regular = await vcall(await newObj("android/graphics/fonts/Font$Builder", "(Ljava/io/File;)V", file), "build", `()${F}`);
  const style = async (f: unknown) => vcall(await vcall(f, "getStyle", "()Landroid/graphics/fonts/FontStyle;"), "toString", "()Ljava/lang/String;");
  same("from a file", [await style(regular), await vcall(regular, "getTtcIndex", "()I"), (await vcall(regular, "getAxes", "()[Landroid/graphics/fonts/FontVariationAxis;")).length,
    await vcall(await vcall(regular, "getFile", "()Ljava/io/File;"), "getPath", "()Ljava/lang/String;"), await vcall(await vcall(regular, "getLocaleList", "()Landroid/os/LocaleList;"), "isEmpty", "()Z"),
    await vcall(await vcall(regular, "getBuffer", `()${BB}`), "capacity", "()I")],
    ["FontStyle { weight=400, slant=0}", 0, 0, "/system/fonts/Roboto-Regular.ttf", 1, 305656]);
  const boldBytes = await bytes("Roboto-Bold.ttf"), direct = await scall("java/nio/ByteBuffer", "allocateDirect", `(I)${BB}`, boldBytes.length);
  await vcall(direct, "put", `([B)${BB}`, new Int8Array(boldBytes.buffer));
  const bold = await vcall(await newObj("android/graphics/fonts/Font$Builder", `(${BB})V`, direct), "build", `()${F}`);
  same("from a direct buffer", await style(bold), "FontStyle { weight=700, slant=0}");
  const thrown = async (fn: () => Promise<unknown>) => { try { await fn(); return "none"; } catch (e) { return (e as { msg?: string })?.msg ?? String(e); } };
  const heap = await scall("java/nio/ByteBuffer", "wrap", `([B)${BB}`, new Int8Array(boldBytes.buffer));
  same("a heap buffer", (await thrown(() => newObj("android/graphics/fonts/Font$Builder", `(${BB})V`, heap))).includes("direct"), true);
  const cloning = await newObj("android/graphics/fonts/Font$Builder", `(${F})V`, regular);
  await vcall(cloning, "setWeight", `(I)${FB}`, 500);
  await vcall(cloning, "setFontVariationSettings", `(Ljava/lang/String;)${FB}`, "'wght' 500, 'ital' 1");
  const clone = await vcall(cloning, "build", `()${F}`);
  const axes = await vcall(clone, "getAxes", "()[Landroid/graphics/fonts/FontVariationAxis;");
  same("a clone", [await style(clone), await scall("android/graphics/fonts/FontVariationAxis", "toFontVariationSettings", "([Landroid/graphics/fonts/FontVariationAxis;)Ljava/lang/String;", axes),
    await vcall(clone, "getSourceIdentifier", "()I") === await vcall(regular, "getSourceIdentifier", "()I"), await vcall(clone, "equals", "(Ljava/lang/Object;)Z", regular)],
    ["FontStyle { weight=500, slant=0}", "'wght' 500.0,'ital' 1.0", true, 0]);
  const garbage = await scall("java/nio/ByteBuffer", "allocateDirect", `(I)${BB}`, 64);
  const bad = await newObj("android/graphics/fonts/Font$Builder", `(${BB})V`, garbage);
  await vcall(bad, "setWeight", `(I)${FB}`, 400);
  await vcall(bad, "setSlant", `(I)${FB}`, 0);
  same("invalid data", await thrown(() => vcall(bad, "build", `()${F}`)), "Failed to create internal object. maybe invalid font data.");

  const FF = "Landroid/graphics/fonts/FontFamily;", FFB = "Landroid/graphics/fonts/FontFamily$Builder;";
  const builder = await newObj("android/graphics/fonts/FontFamily$Builder", `(${F})V`, regular);
  await vcall(builder, "addFont", `(${F})${FFB}`, bold);
  same("a second regular", (await thrown(() => vcall(builder, "addFont", `(${F})${FFB}`, regular))).endsWith("has already been added"), true);
  const family = await vcall(builder, "build", `()${FF}`);
  const first = await vcall(family, "getFont", `(I)${F}`, 0), again = await vcall(family, "getFont", `(I)${F}`, 0);
  same("the family", [await vcall(family, "getSize", "()I"), await style(await vcall(family, "getFont", `(I)${F}`, 1)), first === again,
    await vcall(first, "equals", "(Ljava/lang/Object;)Z", again), await vcall(first, "equals", "(Ljava/lang/Object;)Z", regular), familyOf(family).fonts.length],
    [2, "FontStyle { weight=700, slant=0}", false, 1, 1, 2]);

  const paint = await newObj("android/graphics/Paint", "()V");
  await vcall(paint, "setTextSize", "(F)V", 20);
  const fm = await newObj("android/graphics/Paint$FontMetrics", "()V");
  await vcall(regular, "getMetrics", "(Landroid/graphics/Paint;Landroid/graphics/Paint$FontMetrics;)V", paint, fm);
  same("getMetrics", [fm.top, fm.ascent, fm.descent, fm.bottom, fm.leading], [-2163, -1900, 500, 555, 0].map((v) => Math.fround(v * 20 / 2048)));

  const buffer = await vcall(regular, "getBuffer", `()${BB}`);
  same("FontFileUtil", [await scall("android/graphics/fonts/FontFileUtil", "getRevision", `(${BB}I)J`, buffer, 0),
    await scall("android/graphics/fonts/FontFileUtil", "getPostScriptName", `(${BB}I)Ljava/lang/String;`, buffer, 0),
    await scall("android/graphics/fonts/FontFileUtil", "isPostScriptType1Font", `(${BB}I)I`, buffer, 0)], [0x22354, "RobotoStatic-Regular", 0]);
  same("available fonts", await vcall(await scall("android/graphics/fonts/SystemFonts", "getAvailableFonts", "()Ljava/util/Set;"), "size", "()I"), 2);
});

// Expected values are the reference AVD's (API 35), whose Roboto is one variable font: every
// weight has Roboto-Regular's metrics.
await exercise("Typeface (system font map, styles, weights, builders; device values)", async () => {
  const { loadSystemFonts } = await import("../tests/java");
  const { familyOf, typefaceOf } = await import("../src/android/fonts");
  await loadSystemFonts();
  const T = "Landroid/graphics/Typeface;", info = await linkInit("android/graphics/Typeface");
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  const d = async (t: unknown) => `${await vcall(t, "getStyle", "()I")}/${await vcall(t, "getWeight", "()I")}`;
  const statics = (name: string) => (info.ctor as Record<string, object>)[info.staticFieldTable.get(`${name}:${T}`)!];
  const named = (name: string, style: number) => scall("android/graphics/Typeface", "create", `(Ljava/lang/String;I)${T}`, name, style);
  const weighted = (base: unknown, weight: number, italic: boolean) => scall("android/graphics/Typeface", "create", `(${T}IZ)${T}`, base, weight, +italic);
  const DEFAULT = statics("DEFAULT"), BOLD = statics("DEFAULT_BOLD");
  same("constants", [await d(DEFAULT), await d(BOLD), statics("SANS_SERIF") === DEFAULT], ["0/400", "1/700", true]);
  const families = [];
  for (const name of ["sans-serif-medium", "sans-serif-light", "sans-serif-thin", "sans-serif-black", "arial", "no-such-family"]) {
    const t = await named(name, 0);
    families.push(`${name} ${await d(t)} ${await d(await named(name, 1))} ${await d(await named(name, 2))} ${t === DEFAULT}`);
  }
  same("families", families, ["sans-serif-medium 0/500 1/800 2/500 false", "sans-serif-light 0/300 1/600 2/300 false",
    "sans-serif-thin 0/100 1/400 2/100 false", "sans-serif-black 0/900 1/1000 2/900 false", "arial 0/400 1/700 2/400 true",
    "no-such-family 0/400 1/700 2/400 true"]);
  same("exact weights", [await d(await weighted(null, 550, true)), await d(await weighted(DEFAULT, 650, false)), await d(await weighted(DEFAULT, 0, false)),
    await d(await weighted(DEFAULT, 1000, false))], ["2/550", "1/650", "0/1", "1/1000"]);
  const medium = await named("sans-serif-medium", 0);
  same("derived", [await d(await weighted(medium, 300, false)), await d(await scall("android/graphics/Typeface", "create", `(${T}I)${T}`, medium, 3)),
    await d(await scall("android/graphics/Typeface", "defaultFromStyle", `(I)${T}`, 3))], ["0/300", "3/800", "3/700"]);
  same("identity", [await vcall(await named("arial", 0), "equals", "(Ljava/lang/Object;)Z", DEFAULT),
    await scall("android/graphics/Typeface", "create", `(${T}I)${T}`, DEFAULT, 1) === BOLD], [1, true]);

  const paint = await newObj("android/graphics/Paint", "()V");
  same("a new Paint's typeface", await vcall(paint, "getTypeface", `()${T}`), null);
  await vcall(paint, "setTextSize", "(F)V", 20);
  const metrics = [];
  for (const t of [DEFAULT, BOLD, await scall("android/graphics/Typeface", "create", `(${T}I)${T}`, DEFAULT, 2), medium]) {
    await vcall(paint, "setTypeface", `(${T})${T}`, t);
    const fm = await vcall(paint, "getFontMetrics", "()Landroid/graphics/Paint$FontMetrics;") as Record<string, number>;
    metrics.push([fm.top, fm.ascent, fm.descent, fm.bottom, fm.leading].join(" "));
  }
  same("metrics", metrics, Array(4).fill([-2163, -1900, 500, 555, 0].map((v) => Math.fround(v * 20 / 2048)).join(" ")));

  // an app's font over the system fallback, and a Builder's style from the font's tables
  const F = "Landroid/graphics/fonts/Font;", FF = "Landroid/graphics/fonts/FontFamily;", CFB = "Landroid/graphics/Typeface$CustomFallbackBuilder;";
  const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/system/fonts/Roboto-Bold.ttf");
  const font = await vcall(await newObj("android/graphics/fonts/Font$Builder", "(Ljava/io/File;)V", file), "build", `()${F}`);
  const family = await vcall(await newObj("android/graphics/fonts/FontFamily$Builder", `(${F})V`, font), "build", `()${FF}`);
  const custom = async (style: unknown) => {
    const builder = await newObj("android/graphics/Typeface$CustomFallbackBuilder", `(${FF})V`, family);
    if (style) await vcall(builder, "setStyle", `(Landroid/graphics/fonts/FontStyle;)${CFB}`, style);
    return vcall(builder, "build", `()${T}`);
  };
  const styled = await custom(await newObj("android/graphics/fonts/FontStyle", "(II)V", 700, 1)), plain = await custom(null);
  const { families: members } = typefaceOf(styled).collection, system = typefaceOf(DEFAULT).collection.families;
  same("CustomFallbackBuilder", [await d(styled), await d(plain), members[0] === familyOf(family), members.length === 1 + system.length && system.every((f, i) => members[i + 1] === f)],
    ["3/700", "0/400", true, true]);
  same("Typeface.Builder", await d(await vcall(await newObj("android/graphics/Typeface$Builder", "(Ljava/io/File;)V", file), "build", `()${T}`)), "1/700");
});

// Expected values are the reference AVD's (API 35) for the same calls. Skia stores ovals, round
// rects and arcs as conics (K) and ours as cubics (C), so those compare by their end points.
await exercise("Path, PathMeasure, PathIterator (device values)", async () => {
  const P = "Landroid/graphics/Path;", DIR = "Landroid/graphics/Path$Direction;", FT = "Landroid/graphics/Path$FillType;";
  const statics = async (cls: string) => (await linkInit(cls)).ctor as Record<string, unknown>;
  const dirs = await statics("android/graphics/Path$Direction"), fts = await statics("android/graphics/Path$FillType");
  const CW = dirs.s$CW, CCW = dirs.s$CCW;
  const path = async (...ops: [string, string, ...unknown[]][]) => {
    const p = await newObj("android/graphics/Path", "()V");
    for (const [name, desc, ...args] of ops) await vcall(p, name, desc, ...args);
    return p;
  };
  const close = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  const near = (what: string, got: number[], want: number[], tol = 1e-3) => {
    if (got.length !== want.length || got.some((g, i) => !close(g, want[i], tol))) throw new Error(`${what}: [${got.map((v) => +v.toFixed(4))}], not [${want}]`);
  };
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  /** the path through PathIterator, as "M0,0 L0,0,10,0 Z" */
  const dump = async (p: unknown) => {
    const it = await vcall(p, "getPathIterator", "()Landroid/graphics/PathIterator;"), pts = new Float32Array(8), out: string[] = [];
    while (await vcall(it, "hasNext", "()Z")) {
      const v = await vcall(it, "next", "([FI)I", pts, 0) as number;
      out.push("MLQKCZ"[v] + [...pts.subarray(0, [2, 4, 6, 6, 8, 0][v])].join(","));
    }
    return out.join(" ");
  };
  /** compare dumps; a device conic against our cubic compares its end points */
  const verbs = async (what: string, p: unknown, want: string) => {
    const got = (await dump(p)).split(" ").filter(Boolean), exp = want ? want.split(" ") : [];
    if (got.length !== exp.length) throw new Error(`${what}: ${got.join(" ")}, not ${want}`);
    got.forEach((g, i) => {
      const e = exp[i], gv = g.slice(1).split(",").filter(Boolean).map(Number), ev = e.slice(1).split(",").filter(Boolean).map(Number);
      if (e[0] === "K" && g[0] === "C") near(`${what} [${i}]`, [...gv.slice(0, 2), ...gv.slice(-2)], [...ev.slice(0, 2), ...ev.slice(-2)]);
      else { same(`${what} [${i}] verb`, g[0], e[0]); near(`${what} [${i}]`, gv, ev); }
    });
  };
  const rectOf = (r: any) => [r.left, r.top, r.right, r.bottom] as number[];

  const mixed = await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 100, 0], ["quadTo", "(FFFF)V", 150, 0, 150, 50],
    ["cubicTo", "(FFFFFF)V", 150, 100, 100, 150, 50, 150], ["moveTo", "(FF)V", 5, 5], ["moveTo", "(FF)V", 200, 200],
    ["lineTo", "(FF)V", 300, 200], ["lineTo", "(FF)V", 300, 300], ["close", "()V"]);
  await verbs("mixed", mixed, "M0,0 L0,0,100,0 Q100,0,150,0,150,50 C150,50,150,100,100,150,50,150 M5,5 M200,200 L200,200,300,200 L300,200,300,300 Z");

  // PathMeasure: contours of zero length are skipped; positions and tangents on the curves themselves
  const measure = await newObj("android/graphics/PathMeasure", `(${P}Z)V`, mixed, 0);
  const posTan = async (d: number) => {
    const pos = new Float32Array(2), tan = new Float32Array(2);
    return [await vcall(measure, "getPosTan", "(F[F[F)Z", d, pos, tan), ...pos, ...tan];
  };
  const len0 = await vcall(measure, "getLength", "()F") as number;
  near("contour 0 length", [len0], [335.81967], 1e-5);
  near("contour 0 pos/tan", [...await posTan(len0 * 0.3), ...await posTan(len0 * 0.5), ...await posTan(len0 * 0.77), ...await posTan(len0 * 2)],
    [1, 100.791, 0.003, 1, 0.008, 1, 148.999, 36.851, 0.163, 0.987, 1, 118.639, 118.861, -0.708, 0.706, 1, 50, 150, -1, 0]);
  const m = await newObj("android/graphics/Matrix", "()V"), values = new Float32Array(9);
  same("getMatrix", await vcall(measure, "getMatrix", "(FLandroid/graphics/Matrix;I)Z", len0 * 0.5, m, 3), 1);
  await vcall(m, "getValues", "([F)V", values);
  near("its values", [...values], [0.16263475, -0.98668635, 148.99881, 0.98668635, 0.16263475, 36.850677, 0, 0, 1]);
  const seg = await newObj("android/graphics/Path", "()V");
  same("getSegment", await vcall(measure, "getSegment", `(FF${P}Z)Z`, len0 * 0.2, len0 * 0.7, seg, 1), 1);
  await verbs("segment", seg, "M67.164,0 L67.164,0,100,0 Q100,0,150,0,150,50 C150,50,150,67.628,143.785,85.255,133.547,100.692");
  const seg2 = await path(["moveTo", "(FF)V", 100, 100]);
  await vcall(measure, "getSegment", `(FF${P}Z)Z`, len0 * 0.1, len0 * 0.4, seg2, 0);
  await verbs("segment without moveTo", seg2, "M100,100 L100,100,100,0 Q100,0,120.659,0,132.782,8.535");
  same("closed/next", [await vcall(measure, "isClosed", "()Z"), await vcall(measure, "nextContour", "()Z")], [0, 1]);
  const len1 = await vcall(measure, "getLength", "()F") as number;
  near("contour 1 length", [len1], [341.42136], 1e-5);
  near("contour 1 pos/tan", await posTan(len1 * 0.77), [1, 255.527, 255.527, -0.707, -0.707]);
  same("closed/next", [await vcall(measure, "isClosed", "()Z"), await vcall(measure, "nextContour", "()Z")], [1, 0]);
  await vcall(measure, "setPath", `(${P}Z)V`, mixed, 1);
  near("forced closed", [await vcall(measure, "getLength", "()F") as number], [493.93353], 1e-5);
  const arc = await path(["addArc", "(FFFFFF)V", 0, 0, 100, 60, 30, 200]);
  await vcall(measure, "setPath", `(${P}Z)V`, arc, 0);
  const lenArc = await vcall(measure, "getLength", "()F") as number;
  // an elliptical arc measured over cubics rather than conics lands within a tenth of a pixel
  near("arc", [lenArc, ...await posTan(lenArc * 0.5)], [141.1977, 1, 26.584, 56.507, -0.953, -0.303], 3e-3);
  const empty = await newObj("android/graphics/PathMeasure", "()V");
  same("empty measure", [await vcall(empty, "getLength", "()F"), await vcall(empty, "getPosTan", "(F[F[F)Z", 0, new Float32Array(2), null),
    await vcall(empty, "getSegment", `(FF${P}Z)Z`, 0, 1, seg, 1), await vcall(empty, "isClosed", "()Z")], [0, 0, 0, 0]);

  // SkPath's point order for each shape, and its rules for relative verbs, arcs and the last point
  const shapes: [string, [string, string, ...unknown[]][], string][] = [
    ["rrCW", [["addRoundRect", `(FFFFFF${DIR})V`, 10, 20, 110, 80, 8, 6, CW]], "M10,74 L10,74,10,26 K10,26,10,20,18,20 L18,20,102,20 K102,20,110,20,110,26 L110,26,110,74 K110,74,110,80,102,80 L102,80,18,80 K18,80,10,80,10,74 Z"],
    ["rrCCW", [["addRoundRect", `(FFFFFF${DIR})V`, 10, 20, 110, 80, 8, 6, CCW]], "M10,26 L10,26,10,74 K10,74,10,80,18,80 L18,80,102,80 K102,80,110,80,110,74 L110,74,110,26 K110,26,110,20,102,20 L102,20,18,20 K18,20,10,20,10,26 Z"],
    ["rr8", [["addRoundRect", `(FFFF[F${DIR})V`, 10, 20, 110, 80, Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8), CW]], "M10,72 L10,72,10,22 K10,22,10,20,11,20 L11,20,107,20 K107,20,110,20,110,24 L110,24,110,74 K110,74,110,80,105,80 L105,80,17,80 K17,80,10,80,10,72 Z"],
    ["rr0", [["addRoundRect", `(FFFFFF${DIR})V`, 10, 20, 110, 80, 0, 6, CW]], "M10,80 L10,80,10,20 L10,20,110,20 L110,20,110,80 Z"],
    ["rrOval", [["addRoundRect", `(FFFFFF${DIR})V`, 10, 20, 110, 80, 50, 30, CW]], "M10,50 K10,50,10,20,60,20 K60,20,110,20,110,50 K110,50,110,80,60,80 K60,80,10,80,10,50 Z"],
    ["ovalCCW", [["addOval", `(FFFF${DIR})V`, 0, 0, 100, 50, CCW]], "M100,25 K100,25,100,0,50,0 K50,0,0,0,0,25 K0,25,0,50,50,50 K50,50,100,50,100,25 Z"],
    ["circleCCW", [["addCircle", `(FFF${DIR})V`, 50, 50, 10, CCW]], "M60,50 K60,50,60,40,50,40 K50,40,40,40,40,50 K40,50,40,60,50,60 K50,60,60,60,60,50 Z"],
    ["rectCCW", [["addRect", `(FFFF${DIR})V`, 0, 0, 10, 20, CCW]], "M0,0 L0,0,0,20 L0,20,10,20 L10,20,10,0 Z"],
    ["rectUnsorted", [["addRect", `(FFFF${DIR})V`, 10, 20, 0, 0, CW]], "M10,20 L10,20,0,20 L0,20,0,0 L0,0,10,0 Z"],
    ["arcTo", [["moveTo", "(FF)V", 0, 0], ["arcTo", "(FFFFFFZ)V", 0, 0, 100, 100, 180, 90, 0]], "M0,0 L0,0,0,50 K0,50,0,0,50,0"],
    ["arcToSame", [["moveTo", "(FF)V", 0, 50], ["arcTo", "(FFFFFFZ)V", 0, 0, 100, 100, 180, 90, 0]], "M0,50 K0,50,0,0,50,0"],
    ["arc360", [["addArc", "(FFFFFF)V", 0, 0, 100, 100, 0, 360]], "M100,50 K100,50,100,100,50,100 K50,100,0,100,0,50 K0,50,0,0,50,0 K50,0,100,0,100,50 Z"],
    ["addArc", [["moveTo", "(FF)V", 1, 1], ["addArc", "(FFFFFF)V", 0, 0, 100, 100, 10, 45]], "M1,1 M99.24,58.682 K99.24,58.682,95.644,79.078,78.679,90.958"],
    ["addArcNeg", [["addArc", "(FFFFFF)V", 0, 0, 100, 100, 10, -300]], "M99.24,58.682 K99.24,58.682,107.923,9.442,58.682,0.76 K58.682,0.76,9.442,-7.923,0.76,41.318 K0.76,41.318,-7.923,90.558,41.318,99.24 K41.318,99.24,54.512,101.567,67.101,96.985"],
    ["rel", [["moveTo", "(FF)V", 10, 10], ["lineTo", "(FF)V", 20, 10], ["close", "()V"], ["rLineTo", "(FF)V", 5, 5], ["rMoveTo", "(FF)V", 1, 1], ["rLineTo", "(FF)V", 1, 0]],
      "M10,10 L10,10,20,10 Z M10,10 L10,10,15,15 M16,16 L16,16,17,16"],
    ["relMove", [["moveTo", "(FF)V", 10, 10], ["lineTo", "(FF)V", 20, 10], ["close", "()V"], ["rMoveTo", "(FF)V", 1, 1]], "M10,10 L10,10,20,10 Z M11,11"],
    ["noMove", [["lineTo", "(FF)V", 5, 5]], "M0,0 L0,0,5,5"],
    ["relAfterRect", [["addRect", `(FFFF${DIR})V`, 0, 0, 10, 20, CW], ["rLineTo", "(FF)V", 1, 1]], "M0,0 L0,0,10,0 L10,0,10,20 L10,20,0,20 Z M0,0 L0,0,1,1"],
    ["setLastEmpty", [["setLastPoint", "(FF)V", 3, 4]], "M3,4"],
    ["setLastClose", [["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 5, 5], ["close", "()V"], ["setLastPoint", "(FF)V", 3, 4]], "M0,0 L0,0,3,4 Z"],
    ["setLastCircle", [["addCircle", `(FFF${DIR})V`, 0, 0, 5, CW], ["setLastPoint", "(FF)V", 3, 4]], "M5,0 K5,0,5,5,0,5 K0,5,-5,5,-5,0 K-5,0,-5,-5,0,-5 K0,-5,5,-5,3,4 Z"],
    ["circle0", [["addCircle", `(FFF${DIR})V`, 50, 50, 0, CCW]], ""],
  ];
  for (const [name, ops, want] of shapes) await verbs(name, await path(...ops), want);
  const mirror = await path(["addCircle", `(FFF${DIR})V`, 10, 10, 5, CW]), flip = await newObj("android/graphics/Matrix", "()V");
  await vcall(flip, "setScale", "(FF)V", -1, 1);
  await vcall(mirror, "transform", "(Landroid/graphics/Matrix;)V", flip);
  await verbs("mirrored circle", mirror, "M-15,10 K-15,10,-15,15,-10,15 K-10,15,-5,15,-5,10 K-5,10,-5,5,-10,5 K-10,5,-15,5,-15,10 Z");

  // generation IDs carry the fill type; reset keeps it (Java restores it) and returns to the empty ID
  const g = await newObj("android/graphics/Path", "()V"), gen = () => vcall(g, "getGenerationId", "()I") as Promise<number>;
  const g0 = await gen(); await vcall(g, "moveTo", "(FF)V", 1, 1);
  const g1 = await gen(); await vcall(g, "lineTo", "(FF)V", 2, 2);
  const g2 = await gen(); await vcall(g, "setFillType", `(${FT})V`, fts.s$EVEN_ODD);
  const g3 = await gen(); await vcall(g, "reset", "()V");
  const g4 = await gen(); await vcall(g, "offset", "(FF)V", 1, 1);
  same("generations", [g0, g1 > 1 && g1 !== g0, g2 !== g1, g3 === (g2 | 1 << 30), g4, await gen(), await vcall(g, "getFillType", `()${FT}`) === fts.s$EVEN_ODD],
    [1, true, true, true, 1 | 1 << 30, 1 | 1 << 30, true]);
  await vcall(g, "setFillType", `(${FT})V`, fts.s$INVERSE_EVEN_ODD);
  await vcall(g, "rewind", "()V");
  same("rewind", await vcall(g, "getFillType", `()${FT}`) === fts.s$WINDING, true);

  const rf = await newObj("android/graphics/RectF", "()V");
  const isRect = async (p: unknown) => [await vcall(p, "isRect", "(Landroid/graphics/RectF;)Z", rf), ...rectOf(rf)];
  const open4 = await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 10, 0], ["lineTo", "(FF)V", 10, 20], ["lineTo", "(FF)V", 0, 20]);
  near("isRect open", await isRect(open4), [1, 0, 0, 10, 20]);
  near("isRect 3 points", [await vcall(await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 10, 0], ["lineTo", "(FF)V", 10, 20]), "isRect", "(Landroid/graphics/RectF;)Z", rf) as number], [0]);
  near("isRect addRect", await isRect(await path(["addRect", `(FFFF${DIR})V`, 1, 2, 3, 4, CCW])), [1, 1, 2, 3, 4]);
  near("isRect oval", [await vcall(await path(["addOval", `(FFFF${DIR})V`, 1, 2, 3, 4, CCW]), "isRect", "(Landroid/graphics/RectF;)Z", rf) as number], [0]);

  const ia = await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 10, 0]), ib = await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 20, 10]);
  const io = await newObj("android/graphics/Path", "()V");
  same("interpolate", [await vcall(ia, "isInterpolatable", `(${P})Z`, ib), await vcall(ia, "interpolate", `(${P}F${P})Z`, ib, 0.25, io)], [1, 1]);
  await verbs("interpolated", io, "M0,0 L0,0,17.5,7.5");
  same("not interpolatable", await vcall(ia, "isInterpolatable", `(${P})Z`, await path(["moveTo", "(FF)V", 0, 0], ["quadTo", "(FFFF)V", 1, 1, 2, 2])), 0);

  const approx = async (p: unknown, e: number) => [...await vcall(p, "approximate", "(F)[F", e) as Float32Array];
  near("approximate quad", await approx(await path(["moveTo", "(FF)V", 0, 0], ["quadTo", "(FFFF)V", 50, 100, 100, 0]), 5),
    [0, 0, 0, 0.3086089, 25, 37.5, 0.5, 50, 50, 0.6913911, 75, 37.5, 1, 100, 0], 1e-6);
  near("approximate closed", await approx(await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 10, 0], ["lineTo", "(FF)V", 10, 10], ["close", "()V"]), 0.5),
    [0, 0, 0, 0.29289323, 10, 0, 0.58578646, 10, 10, 1, 0, 0], 1e-6);
  near("approximate empty", await approx(await path(), 0.5), [0, 0, 0, 1, 0, 0]);
  near("approximate moveTo", await approx(await path(["moveTo", "(FF)V", 3, 4]), 0.5), [0, 3, 4, 1, 3, 4]);

  await vcall(await path(["addArc", "(FFFFFF)V", 0, 0, 100, 100, 0, 45]), "computeBounds", "(Landroid/graphics/RectF;Z)V", rf, 1);
  near("arc bounds", rectOf(rf), [85.35534, 50, 100, 85.35534]);

  // Path.op: the same outline (our polygon may start elsewhere), reported even-odd
  const ops = await statics("android/graphics/Path$Op");
  const o1 = await path(["addRect", `(FFFF${DIR})V`, 0, 0, 10, 10, CW]), o2 = await path(["addRect", `(FFFF${DIR})V`, 5, 5, 15, 15, CW]);
  const corners = async (p: unknown) => (await dump(p)).split(" ").filter((v) => v[0] === "L").map((v) => v.slice(1).split(",").slice(2).join(",")).sort().join(" ");
  const union = await newObj("android/graphics/Path", "()V");
  same("union", [await vcall(union, "op", `(${P}${P}Landroid/graphics/Path$Op;)Z`, o1, o2, ops.s$UNION), await vcall(union, "getFillType", `()${FT}`) === fts.s$EVEN_ODD], [1, true]);
  same("union outline", await corners(union), ["0,0", "0,10", "10,0", "10,5", "15,15", "15,5", "5,10", "5,15"].join(" "));
  const rev = await newObj("android/graphics/Path", "()V");
  await vcall(rev, "op", `(${P}${P}Landroid/graphics/Path$Op;)Z`, o1, o2, ops.s$REVERSE_DIFFERENCE);
  same("reverse difference outline", await corners(rev), ["10,10", "10,5", "15,15", "15,5", "5,10", "5,15"].join(" "));
});

// Expected values are the reference AVD's (API 35) for the same calls.
await exercise("Region, RegionIterator (device values)", async () => {
  const R = "Landroid/graphics/Region;", OP = "Landroid/graphics/Region$Op;", P = "Landroid/graphics/Path;";
  const ops = (await linkInit("android/graphics/Region$Op")).ctor as Record<string, unknown>;
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  const region = (...a: number[]) => a.length ? newObj("android/graphics/Region", "(IIII)V", ...a) : newObj("android/graphics/Region", "()V");
  const op = (r: unknown, l: number, t: number, rr: number, b: number, o: string) => vcall(r, "op", `(IIII${OP})Z`, l, t, rr, b, ops[`s$${o}`]);
  const rects = async (r: unknown) => {
    const it = await newObj("android/graphics/RegionIterator", `(${R})V`, r), rc = await newObj("android/graphics/Rect", "()V"), out: string[] = [];
    while (await vcall(it, "next", "(Landroid/graphics/Rect;)Z", rc)) out.push(`${rc.left},${rc.top},${rc.right},${rc.bottom}`);
    return out.join(" ");
  };
  const dump = async (p: unknown) => {
    const it = await vcall(p, "getPathIterator", "()Landroid/graphics/PathIterator;"), pts = new Float32Array(8), out: string[] = [];
    while (await vcall(it, "hasNext", "()Z")) {
      const v = await vcall(it, "next", "([FI)I", pts, 0) as number;
      out.push("MLQKCZ"[v] + [...pts.subarray(0, [2, 4, 6, 6, 8, 0][v])].join(","));
    }
    return out.join(" ");
  };
  const str = (r: unknown) => vcall(r, "toString", "()Ljava/lang/String;");
  const r = await region(0, 0, 100, 100);
  same("rect", [await rects(r), await vcall(r, "isRect", "()Z"), await vcall(r, "isComplex", "()Z"), await str(r)], ["0,0,100,100", 1, 0, "SkRegion((0,0,100,100))"]);
  await op(r, 20, 20, 50, 50, "DIFFERENCE");
  same("difference", [await rects(r), await vcall(r, "isRect", "()Z"), await vcall(r, "isComplex", "()Z")], ["0,0,100,20 0,20,20,50 50,20,100,50 0,50,100,100", 0, 1]);
  same("toString", await str(r), "SkRegion((0,0,100,20)(0,20,20,50)(50,20,100,50)(0,50,100,100))");
  same("contains", [await vcall(r, "contains", "(II)Z", 10, 10), await vcall(r, "contains", "(II)Z", 30, 30), await vcall(r, "contains", "(II)Z", 99, 99), await vcall(r, "contains", "(II)Z", 100, 50)], [1, 0, 1, 0]);
  same("quick", [await vcall(r, "quickContains", "(IIII)Z", 0, 0, 10, 10), await vcall(r, "quickReject", "(IIII)Z", 200, 0, 300, 10), await vcall(r, "quickReject", "(IIII)Z", 20, 20, 30, 30)], [0, 1, 0]);
  const u = await region(0, 0, 10, 10);
  await op(u, 10, 0, 20, 10, "UNION");
  await op(u, 0, 10, 20, 20, "UNION");
  same("touching unions", await rects(u), "0,0,20,20");
  const x = await region(0, 0, 10, 10);
  await op(x, 5, 5, 15, 15, "XOR");
  same("xor", await rects(x), "0,0,10,5 0,5,5,10 10,5,15,10 5,10,15,15");
  const rd = await region(0, 0, 10, 10);
  same("reverse difference", [await op(rd, 5, 5, 15, 15, "REVERSE_DIFFERENCE"), await rects(rd)], [1, "10,5,15,10 5,10,15,15"]);
  const inter = await region(0, 0, 10, 10);
  same("empty intersection", [await op(inter, 20, 20, 30, 30, "INTERSECT"), await vcall(inter, "isEmpty", "()Z"), await str(inter)], [0, 1, "SkRegion()"]);
  const two = await region();
  same("rect op region", [await vcall(two, "op", `(Landroid/graphics/Rect;${R}${OP})Z`, await newObj("android/graphics/Rect", "(IIII)V", 0, 0, 30, 30), x, ops.s$DIFFERENCE), await rects(two)],
    [1, "10,0,30,5 5,5,10,10 15,5,30,10 0,10,5,15 15,10,30,15 0,15,30,30"]);
  same("empty rect", [await vcall(await region(), "set", "(IIII)Z", 5, 5, 5, 10), await vcall(await region(1, 1, 0, 5), "isEmpty", "()Z")], [0, 1]);
  const bp = await newObj("android/graphics/Path", "()V");
  same("boundary", [await vcall(r, "getBoundaryPath", `(${P})Z`, bp), await dump(bp)],
    [1, "M0,20 L0,20,0,0 L0,0,100,0 L100,0,100,100 L100,100,0,100 L0,100,0,20 Z M20,20 L20,20,20,50 L20,50,50,50 L50,50,50,20 Z"]);
  const pre = await newObj("android/graphics/Path", "()V");
  await vcall(pre, "moveTo", "(FF)V", 1, 1); await vcall(pre, "lineTo", "(FF)V", 2, 2);
  await vcall(x, "getBoundaryPath", `(${P})Z`, pre);
  same("boundary appended", await dump(pre), "M1,1 L1,1,2,2 M0,5 L0,5,0,0 L0,0,10,0 L10,0,10,5 L10,5,5,5 L5,5,5,10 L5,10,0,10 L0,10,0,5 Z M5,15 L5,15,5,10 L5,10,10,10 L10,10,10,5 L10,5,15,5 L15,5,15,15 Z");
  same("boundary of a rect", await dump(await vcall(await region(1, 2, 3, 4), "getBoundaryPath", `()${P}`)), "M1,2 L1,2,3,2 L3,2,3,4 L3,4,1,4 Z");
  const l = await region(0, 0, 30, 10);
  await op(l, 0, 10, 10, 30, "UNION"); await op(l, 20, 20, 40, 40, "UNION");
  same("boundary L", await dump(await vcall(l, "getBoundaryPath", `()${P}`)),
    "M0,10 L0,10,0,0 L0,0,30,0 L30,0,30,10 L30,10,10,10 L10,10,10,30 L10,30,0,30 L0,30,0,10 Z M20,30 L20,30,20,20 L20,20,40,20 L40,20,40,40 L40,40,20,40 L20,40,20,30 Z");
  const sc = await newObj("android/graphics/Region", `(${R})V`, r), sc2 = await region();
  await vcall(sc, "scale", "(F)V", 1.5);
  await vcall(r, "scale", `(F${R})V`, 0.333, sc2);
  same("scale", [await rects(sc), await rects(sc2)], ["0,0,150,30 0,30,30,75 75,30,150,75 0,75,150,150", "0,0,33,7 0,7,7,17 17,7,33,17 0,17,33,33"]);
  const t = await newObj("android/graphics/Region", `(${R})V`, r);
  await vcall(t, "translate", "(II)V", 5, -3);
  same("translate", await rects(t), "5,-3,105,17 5,17,25,47 55,17,105,47 5,47,105,97");
  same("equals", [await vcall(await newObj("android/graphics/Region", `(${R})V`, r), "equals", "(Ljava/lang/Object;)Z", r), await vcall(r, "equals", "(Ljava/lang/Object;)Z", x)], [1, 0]);
  const q = await region(0, 0, 10, 10);
  same("quickReject(Region)", [await vcall(q, "quickReject", `(${R})Z`, await region(10, 0, 20, 10)), await vcall(q, "quickReject", `(${R})Z`, await region(9, 9, 20, 10)), await vcall(q, "quickReject", `(${R})Z`, await region())], [1, 0, 1]);

  // setPath: SkScan's non-anti-aliased fill
  const DIR = "Landroid/graphics/Path$Direction;", dirs = (await linkInit("android/graphics/Path$Direction")).ctor as Record<string, unknown>;
  const fts = (await linkInit("android/graphics/Path$FillType")).ctor as Record<string, unknown>;
  const path = async (...calls: [string, string, ...unknown[]][]) => {
    const p = await newObj("android/graphics/Path", "()V");
    for (const [name, desc, ...args] of calls) await vcall(p, name, desc, ...args);
    return p;
  };
  const clip = await region(0, 0, 1000, 1000), sp = await region();
  const setPath = async (p: unknown, c: unknown = clip) => [await vcall(sp, "setPath", `(${P}${R})Z`, p, c), await rects(sp)].join(" ");
  const rp = await path(["addRect", `(FFFF${DIR})V`, 0.3, 0.5, 10.5, 10.49, dirs.s$CW]);
  same("fractional rect", await setPath(rp), "1 0,1,11,10");
  same("triangle", await setPath(await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 10, 0], ["lineTo", "(FF)V", 0, 10], ["close", "()V"])),
    "1 0,0,10,1 0,1,9,2 0,2,8,3 0,3,7,4 0,4,6,5 0,5,5,6 0,6,4,7 0,7,3,8 0,8,2,9 0,9,1,10");
  const ring = "1 0,0,20,5 0,5,5,15 15,5,20,15 0,15,20,20";
  same("even-odd", await setPath(await path(["addRect", `(FFFF${DIR})V`, 0, 0, 20, 20, dirs.s$CW], ["addRect", `(FFFF${DIR})V`, 5, 5, 15, 15, dirs.s$CW], ["setFillType", "(Landroid/graphics/Path$FillType;)V", fts.s$EVEN_ODD])), ring);
  same("winding", await setPath(await path(["addRect", `(FFFF${DIR})V`, 0, 0, 20, 20, dirs.s$CW], ["addRect", `(FFFF${DIR})V`, 5, 5, 15, 15, dirs.s$CCW])), ring);
  same("inverse", await setPath(await path(["addRect", `(FFFF${DIR})V`, 5, 5, 15, 15, dirs.s$CW], ["setFillType", "(Landroid/graphics/Path$FillType;)V", fts.s$INVERSE_WINDING]), await region(0, 0, 20, 20)), ring);
  same("complex clip", await setPath(rp, x), "1 0,1,10,5 0,5,5,10 10,5,11,10");
  same("empty path", await setPath(await path()), "0 ");
  same("circle", await setPath(await path(["addCircle", `(FFF${DIR})V`, 10, 10, 8, dirs.s$CW])), "1 7,2,13,3 6,3,14,4 4,4,16,6 3,6,17,7 2,7,18,13 3,13,17,14 4,14,16,16 6,16,14,17 7,17,13,18");
  same("clipped circle", await setPath(await path(["addCircle", `(FFF${DIR})V`, 10, 10, 8, dirs.s$CW]), await region(0, 0, 10, 10)), "1 7,2,10,3 6,3,10,4 4,4,10,6 3,6,10,7 2,7,10,10");
  same("quad", await setPath(await path(["moveTo", "(FF)V", 0, 0], ["quadTo", "(FFFF)V", 20, 0, 20, 20], ["lineTo", "(FF)V", 0, 20], ["close", "()V"])),
    "1 0,0,5,1 0,1,9,2 0,2,11,3 0,3,13,4 0,4,14,5 0,5,15,6 0,6,16,7 0,7,17,9 0,9,18,11 0,11,19,15 0,15,20,20");

  // a parcel carries the rects as one int array
  const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
  await vcall(l, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  same("parcel", [...await vcall(parcel, "createIntArray", "()[I") as Int32Array], [0, 0, 30, 10, 0, 10, 10, 20, 0, 20, 10, 30, 20, 20, 40, 30, 20, 30, 40, 40]);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const creator = (await linkInit("android/graphics/Region")).ctor as Record<string, unknown>;
  same("from parcel", await rects(await vcall(creator.s$CREATOR, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel)), await rects(l));
});

await exercise("Camera (device values)", async () => {
  const near = (what: string, got: number[], want: number[]) => {
    if (got.length !== want.length || got.some((g, i) => Math.abs(g - want[i]) > 1e-5 * Math.max(1, Math.abs(want[i])))) throw new Error(`${what}: [${got}], not [${want}]`);
  };
  const c = await newObj("android/graphics/Camera", "()V"), m = await newObj("android/graphics/Matrix", "()V"), values = new Float32Array(9);
  const matrixOf = async (cam: unknown) => { await vcall(cam, "getMatrix", "(Landroid/graphics/Matrix;)V", m); await vcall(m, "getValues", "([F)V", values); return [...values]; };
  const dots = async (cam: unknown) => [await vcall(cam, "dotWithNormal", "(FFF)F", 0, 0, 1), await vcall(cam, "dotWithNormal", "(FFF)F", 1, 2, 3)] as number[];
  const location = async (cam: unknown) => [await vcall(cam, "getLocationX", "()F"), await vcall(cam, "getLocationY", "()F"), await vcall(cam, "getLocationZ", "()F")] as number[];
  near("identity", [...await matrixOf(c), ...await location(c)], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -8]);
  await vcall(c, "rotateX", "(F)V", 30);
  const rotX = [1, 0, 0, 0, 0.8660254, 0, 0, -8.6805556e-4, 1];
  near("rotateX", [...await matrixOf(c), ...await dots(c)], [...rotX, -0.8660254, -0.8660253]);
  await vcall(c, "save", "()V");
  await vcall(c, "rotateY", "(F)V", 45);
  await vcall(c, "translate", "(FFF)V", 10, 20, 30);
  near("rotateY, translate", [...await matrixOf(c), ...await dots(c)],
    [0.667153, 0, -13.3430605, 0.3335765, 0.81709224, -2.9987836, 0.0010030754, -8.190077e-4, 1, -0.6123724, 0.09473443]);
  await vcall(c, "restore", "()V");
  near("restored", await matrixOf(c), rotX);
  await vcall(c, "rotateZ", "(F)V", 90);
  await vcall(c, "rotate", "(FFF)V", 10, 20, 30);
  await vcall(c, "setLocation", "(FFF)V", 1, 2, -4);
  near("rotate, setLocation", [...await matrixOf(c), ...await location(c)],
    [-0.44096962, 0.88256407, -72, -0.51550823, -0.39788473, 144, 0.002551072, 8.6991704e-4, 1, 1, 2, -4]);
  const far = await newObj("android/graphics/Camera", "()V");
  await vcall(far, "translate", "(FFF)V", 0, 0, 100);
  near("translate z", await matrixOf(far), [0.852071, 0, 0, 0, 0.852071, 0, 0, 0, 1]);
  const turned = await newObj("android/graphics/Camera", "()V");
  await vcall(turned, "rotateY", "(F)V", 180);
  near("facing away", [await vcall(turned, "dotWithNormal", "(FFF)F", 0, 0, 1) as number], [1]);
});

await exercise("Interpolator (device values)", async () => {
  const run = async (ip: unknown, cases: [number, string][], out: Float32Array) => {
    for (const [time, want] of cases) {
      const result = await vcall(ip, "timeToValues", "(I[F)Landroid/graphics/Interpolator$Result;", time, out);
      const got = `${await vcall(result, "name", "()Ljava/lang/String;")} ${[...out].join(" ")}`;
      if (got !== want) throw new Error(`at ${time}: ${got}, not ${want}`);
    }
  };
  const two = new Float32Array(2), one = new Float32Array(1);
  const ip = await newObj("android/graphics/Interpolator", "(II)V", 2, 3);
  await vcall(ip, "setKeyFrame", "(II[F)V", 0, 100, Float32Array.of(0, 10));
  await vcall(ip, "setKeyFrame", "(II[F)V", 1, 200, Float32Array.of(1, 20));
  await vcall(ip, "setKeyFrame", "(II[F[F)V", 2, 400, Float32Array.of(3, 0), Float32Array.of(0, 0, 1, 1));
  await run(ip, [[0, "FREEZE_START 0 10"], [100, "NORMAL 0 10"], [125, "NORMAL 0.2500610351562 12.500610351562"],
    [199, "NORMAL 0.990051269531 19.900512695312"], [200, "NORMAL 1 20"], [250, "NORMAL 1.500122070312 14.998779296875"],
    [399, "NORMAL 2.990112304687 0.098876953125"], [400, "FREEZE_END 3 0"], [1000, "FREEZE_END 3 0"]].map(([t, s]) => [t as number, fl(s as string)]), two);
  await vcall(ip, "setRepeatMirror", "(FZ)V", 2.5, 1);
  await run(ip, [[350, "NORMAL 2.500122070312 4.998779296875"], [450, "NORMAL 2.500122070312 4.998779296875"], [550, "NORMAL 1.500122070312 14.998779296875"],
    [650, "NORMAL 0.5000610351562 15.000610351562"], [800, "NORMAL 1 20"], [900, "FREEZE_END 1.500122070312 14.998779296875"]].map(([t, s]) => [t as number, fl(s as string)]), two);
  await vcall(ip, "setRepeatMirror", "(FZ)V", 2, 0);
  await run(ip, [[450, "NORMAL 0.5000610351562 15.000610351562"], [700, "FREEZE_END 3 0"]].map(([t, s]) => [t as number, fl(s as string)]), two);
  const eased = await newObj("android/graphics/Interpolator", "(I)V", 1);
  await vcall(eased, "setKeyFrame", "(II[F)V", 0, 0, Float32Array.of(255));
  await vcall(eased, "setKeyFrame", "(II[F[F)V", 1, 250, Float32Array.of(0), Float32Array.of(0.25, 0.1, 0.25, 1));
  // a negative time is a large unsigned one
  await run(eased, [[-10, "FREEZE_END 0"], [0, "NORMAL 255"], [30, "NORMAL 224.38568"], [60, "NORMAL 193.78693"], [125, "NORMAL 127.484436"],
    [200, "NORMAL 51.003113"], [250, "FREEZE_END 0"]].map(([t, s]) => [t as number, fl(s as string)]), one);
});
/** "NAME a b" with each number as the float nearest the device's printed value */
function fl(s: string) { const [name, ...v] = s.split(" "); return [name, ...v.map((x) => Math.fround(+x))].join(" "); }

await exercise("NinePatch (device values)", async () => {
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  /** Res_png_9patch, serialized: the header, then xDivs, yDivs and colors */
  const chunk = (xs: number[], ys: number[], colors: number[]) => {
    const b = new DataView(new ArrayBuffer(32 + (xs.length + ys.length + colors.length) * 4));
    b.setUint8(1, xs.length); b.setUint8(2, ys.length); b.setUint8(3, colors.length);
    [1, 2, 3, 4].forEach((v, i) => b.setInt32(12 + i * 4, v, true));
    [...xs, ...ys, ...colors].forEach((v, i) => b.setInt32(32 + i * 4, v, true));
    return new Int8Array(b.buffer);
  };
  const cfg = ((await linkInit("android/graphics/Bitmap$Config")).ctor as Record<string, unknown>).s$ARGB_8888;
  const bmp = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", 30, 30, cfg);
  const rects = async (r: unknown) => {
    if (!r) return "null";
    const it = await newObj("android/graphics/RegionIterator", "(Landroid/graphics/Region;)V", r), rc = await newObj("android/graphics/Rect", "()V"), out: string[] = [];
    while (await vcall(it, "next", "(Landroid/graphics/Rect;)Z", rc)) out.push(`${rc.left},${rc.top},${rc.right},${rc.bottom}`);
    return out.join(" ");
  };
  const transparent = async (np: unknown, ...dst: number[]) =>
    rects(await vcall(np, "getTransparentRegion", "(Landroid/graphics/Rect;)Landroid/graphics/Region;", await newObj("android/graphics/Rect", "(IIII)V", ...dst)));
  const centre = chunk([10, 20], [10, 20], [1, 1, 1, 1, 0, 1, 1, 0, 1]);
  const np = await newObj("android/graphics/NinePatch", "(Landroid/graphics/Bitmap;[B)V", bmp, centre);
  same("transparent patches", await transparent(np, 0, 0, 100, 50), "10,10,90,50");
  same("shrunk away", await transparent(np, 5, 5, 20, 20), "null");
  same("none transparent", await transparent(await newObj("android/graphics/NinePatch", "(Landroid/graphics/Bitmap;[B)V", bmp, chunk([10, 20], [10, 20], [1, 1, 1, 1, 1, 1, 1, 1, 1])), 0, 0, 100, 50), "null");
  same("edge divs", await transparent(await newObj("android/graphics/NinePatch", "(Landroid/graphics/Bitmap;[B)V", bmp, chunk([0, 10], [10, 30], [0, 1, 1, 0])), 0, 0, 100, 50), "0,0,80,10 80,10,100,50");
  const isChunk = (c: Int8Array | null) => scall("android/graphics/NinePatch", "isNinePatchChunk", "([B)Z", c);
  same("isNinePatchChunk", [await isChunk(centre), await isChunk(new Int8Array(10)), await isChunk(null)], [1, 0, 0]);
  same("density and size", [await vcall(np, "getDensity", "()I"), await vcall(np, "getWidth", "()I"), await vcall(np, "getHeight", "()I")],
    [await vcall(bmp, "getDensity", "()I"), 30, 30]);
  let thrown = "";
  try { await newObj("android/graphics/NinePatch", "(Landroid/graphics/Bitmap;[B)V", bmp, new Int8Array(8)); }
  catch (e) { thrown = String(await vcall(e, "toString", "()Ljava/lang/String;")); }
  same("short chunk", thrown, "java.lang.RuntimeException: Array too small for chunk.");
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
if (existsSync("vendor/aosp/framework-res.apk") && existsSync("apks/FitNotes.apk")) {
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
