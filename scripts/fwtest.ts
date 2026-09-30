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
const { rt, ACC, declaredField } = await import("../src/jvm/runtime");
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
    const msg = (e as { msg?: string })?.msg ?? (e instanceof Error ? String(e) : String(await vcall(e, "toString", "()Ljava/lang/String;")));
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
/** a Java Paint.FontMetrics' (or FontMetricsInt's) top, ascent, descent, bottom and leading */
const fontMetrics = (fm: object, cls = "FontMetrics") =>
  ["top", "ascent", "descent", "bottom", "leading"].map((k) => (fm as Record<string, number>)[declaredField(`android/graphics/Paint$${cls}`, k)]);
console.log("");

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
  same("getMetrics", fontMetrics(fm), [-2163, -1900, 500, 555, 0].map((v) => Math.fround(v * 20 / 2048)));

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
    metrics.push(fontMetrics(await vcall(paint, "getFontMetrics", "()Landroid/graphics/Paint$FontMetrics;")).join(" "));
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

// Expected values are the reference AVD's (API 35), from TextRunShaper and Font.getGlyphBounds
// under the same paints. Its sans-serif is one variable Roboto and ours its static instances
// (Roboto-Regular.ttf is the device's RobotoStatic-Regular), so a style's face is a separate file
// here; glyph ids differ where the fonts' versions do (noted), and positions agree.
await exercise("TextRunShaper, PositionedGlyphs, Font.getGlyphBounds (device values)", async () => {
  const { loadSystemFonts } = await import("../tests/java");
  await loadSystemFonts();
  const P = "Landroid/graphics/Paint;", F = "Landroid/graphics/fonts/Font;", T = "Landroid/graphics/Typeface;";
  const paint = await newObj("android/graphics/Paint", "(I)V", 1);
  const set = (name: string, desc: string, v: unknown) => vcall(paint, name, desc, typeof v === "number" ? Math.fround(v) : v);
  // numbers match to a float ulp: the device sums positions in float, rounding each step
  const NUM = /^-?\d+(\.\d+)?$/, near = (a: string, b: string) => a === b || NUM.test(a) && NUM.test(b) && Math.abs(+a - +b) <= Math.abs(+b) * 2 ** -23;
  const same = (what: string, got: string, want: string) => {
    const g = got.split(/[ |@]+/), w = want.split(/[ |@]+/);
    if (g.length !== w.length || g.some((t, i) => !near(t, w[i]))) throw new Error(`${what}: ${got}, not ${want}`);
  };
  let glyphs: unknown;
  const shaped = async (text: string, want: string, rtl = false) => {
    const g = glyphs = await scall("android/graphics/text/TextRunShaper", "shapeTextRun", `(Ljava/lang/CharSequence;IIIIFFZ${P})Landroid/graphics/text/PositionedGlyphs;`, text, 0, text.length, 0, text.length, 0, 0, +rtl, paint);
    const n = await vcall(g, "glyphCount", "()I"), out = [`${await vcall(g, "getAdvance", "()F")} ${await vcall(g, "getAscent", "()F")} ${await vcall(g, "getDescent", "()F")}`];
    let last = "";
    for (let i = 0; i < n; i++) {
      const file = await vcall(await vcall(await vcall(g, "getFont", `(I)${F}`, i), "getFile", "()Ljava/io/File;"), "getName", "()Ljava/lang/String;");
      out.push(`${await vcall(g, "getGlyphId", "(I)I", i)}@${await vcall(g, "getGlyphX", "(I)F", i)}${await vcall(g, "getGlyphY", "(I)F", i) ? "!" : ""}${file !== last ? " " + file : ""}`
        + `${await vcall(g, "getFakeBold", "(I)Z", i) ? " FB" : ""}${await vcall(g, "getFakeItalic", "(I)Z", i) ? " FI" : ""}`);
      last = file;
    }
    same(text, out.join(" | "), want);
  };
  await set("setTextSize", "(F)V", 40);
  await shaped("Hello, World!", "225.39453 -37.109375 9.765625 | 45@0 Roboto-Regular.ttf | 74@29 | 81@50 | 81@60 | 84@70 | 17@93 | 5@101 | 60@111 | 84@145.39453 | 87@168.39453 | 81@182.39453 | 73@192.39453 | 6@215.39453");
  await shaped("AVATAR To Ty Wa", "317.78906 -37.109375 9.765625 | 38@0 Roboto-Regular.ttf | 59@24.300781 | 38@47.835938 | 57@71.31641 | 38@93.77344 | 55@119.77344 | 5@144.77344 | 57@154.77344 | 84@176.83984 | 5@199.83984 | 57@209.83984 | 94@232.4336 | 5@251.4336 | 60@261.4336 | 70@295.78906");
  const chars = Uint16Array.from("xHello worldx", (c) => c.charCodeAt(0));
  const context = await scall("android/graphics/text/TextRunShaper", "shapeTextRun", `([CIIIIFFZ${P})Landroid/graphics/text/PositionedGlyphs;`, chars, 1, 11, 0, 13, 0, 0, 0, paint);
  const ids = [];
  for (let i = 0; i < await vcall(context, "glyphCount", "()I"); i++) ids.push(`${await vcall(context, "getGlyphId", "(I)I", i)}@${await vcall(context, "getGlyphX", "(I)F", i)}`);
  same("a char[] in context", `${await vcall(context, "getAdvance", "()F")} ${ids.join(" ")}`, "203 45@0 74@29 81@50 81@60 84@70 5@93 92@103 84@133 87@156 81@170 73@180");
  // the device's ligatures and precomposed letters are 1836, 1834, 2292 and 2299, its emoji 571 and 856;
  // the flags font has only bitmaps: its advances are unhinted, its descent its strike's (27 px at 109 ppem)
  await shaped("office fifty", "177 -37.109375 9.765625 | 84@0 Roboto-Regular.ttf | 1833@23 | 72@57 | 74@78 | 5@99 | 1831@109 | 75@131 | 89@145 | 94@158");
  await shaped("é ñ", "53 -37.109375 9.765625 | 2289@0 Roboto-Regular.ttf | 5@21 | 2296@31");
  await shaped("a👍🏽b👨‍👩‍👧🇨🇦", "193.80469 -37.109375 9.9082575 | 70@0 Roboto-Regular.ttf | 550@22 NotoColorEmoji.ttf | 71@72 Roboto-Regular.ttf | 820@94 NotoColorEmoji.ttf | 65@144 NotoColorEmojiFlags.ttf");
  await set("setTextSize", "(F)V", 20);
  await set("setLetterSpacing", "(F)V", 0.1);
  await shaped("AB AB", "65 -18.554688 4.8828125 | 38@1 Roboto-Regular.ttf | 39@16 | 5@30 | 38@37 | 39@52");
  await set("setLetterSpacing", "(F)V", 0.05);
  await shaped("office", "57 -18.554688 4.8828125 | 84@0.5 Roboto-Regular.ttf | 75@12.5 | 75@20.5 | 78@28.5 | 72@34.5 | 74@45.5");
  await set("setLetterSpacing", "(F)V", 0.02);
  await shaped("office", "50.600002 -18.554688 4.8828125 | 84@0.19999999 Roboto-Regular.ttf | 1833@11.599999 | 72@28.999998 | 74@39.4");
  await set("setLetterSpacing", "(F)V", 0);
  await set("setTextScaleX", "(F)V", 1.5);
  await shaped("AB AB", "85 -18.554688 4.8828125 | 38@0 Roboto-Regular.ttf | 39@20 | 5@39 | 38@46 | 39@66");
  await set("setTextScaleX", "(F)V", 1);
  await set("setTextSkewX", "(F)V", -0.25);
  await shaped("AB", "25.507812 -18.554688 4.8828125 | 38@0 Roboto-Regular.ttf | 39@13.046875");
  await set("setTextSkewX", "(F)V", 0);
  // the device's variable Roboto kerns "oy" by 14.8 units at its default instance, the static 15
  await shaped("Hello you", "81.853516 -18.554688 4.8828125 | 90@0 Roboto-Regular.ttf | 84@11 | 94@21.853516 | 5@30.853516 | 84@35.853516 | 81@46.853516 | 81@51.853516 | 74@56.853516 | 45@67.853516", true);
  const typeface = async (t: unknown, text: string, want: string) => { await set("setTypeface", `(${T})${T}`, t); await shaped(text, want); };
  const create = (base: unknown, style: number) => scall("android/graphics/Typeface", "create", `(${T}I)${T}`, base, style);
  const medium = await scall("android/graphics/Typeface", "create", `(Ljava/lang/String;I)${T}`, "sans-serif-medium", 0);
  // the device draws these from its variable Roboto at wght 700, 500 and 900, and ital 1
  await typeface(await create(null, 1), "Bold", "40 -18.554688 4.8828125 | 39@0 Roboto-Bold.ttf | 84@13 | 81@24 | 73@29");
  await typeface(medium, "Med", "40 -18.554688 4.8828125 | 50@0 Roboto-Medium.ttf | 74@18 | 73@29"); // the device's M at wght 500: 17
  await typeface(await create(null, 2), "Ital", "27 -18.554688 4.8828125 | 46@0 Roboto-Italic.ttf | 89@5 | 70@11 | 81@22");
  await typeface(await scall("android/graphics/Typeface", "create", `(${T}IZ)${T}`, medium, 900, 0), "Blk", "29 -18.554688 4.8828125 | 39@0 Roboto-Bold.ttf FB | 81@13 FB | 80@18 FB"); // the device: wght 900, no fakery, 30
  await set("setTypeface", `(${T})${T}`, null);
  await set("setFakeBoldText", "(Z)V", 1);
  await shaped("Fb", "22 -18.554688 4.8828125 | 43@0 Roboto-Regular.ttf | 71@11");
  await set("setFakeBoldText", "(Z)V", 0);
  await set("setFontFeatureSettings", "(Ljava/lang/String;)V", "\"smcp\" 1");
  await shaped("Small", "56 -18.554688 4.8828125 | 56@0 Roboto-Regular.ttf | 1883@12 | 1969@27 | 1884@38 | 1884@47"); // the device: 1886, 1972, 1887
  await set("setFontFeatureSettings", "(Ljava/lang/String;)V", null);

  // Skia's bounds of hinted outlines: at 13.5 px the device's hinting lifts j's dot a pixel (-11)
  await shaped("Agj", "29 -18.554688 4.8828125 | 38@0 Roboto-Regular.ttf | 76@13 | 79@24");
  // the device's variable Roboto is set to wght 400 and ital 0; a static face has no axes to set
  same("overrides", `${await vcall(glyphs, "getWeightOverride", "(I)F", 0)} ${await vcall(glyphs, "getItalicOverride", "(I)F", 0)}`, `${2 ** -149} ${2 ** -149}`);
  const font = await vcall(glyphs, "getFont", `(I)${F}`, 0), rect = await newObj("android/graphics/RectF", "()V") as Record<string, number>;
  const bounds = [];
  for (const [size, scale, skew] of [[13.5, 1, 0], [40, 1, 0], [40, 1.5, -0.25]]) {
    await set("setTextSize", "(F)V", size); await set("setTextScaleX", "(F)V", scale); await set("setTextSkewX", "(F)V", skew);
    for (const glyph of [38, 76, 79]) bounds.push(`${await vcall(font, "getGlyphBounds", `(I${P}Landroid/graphics/RectF;)F`, glyph, paint, rect)} ${rect.left} ${rect.top} ${rect.right} ${rect.bottom}`);
  }
  const want = ["9 0 -10 9 0", "8 0 -8 7 3", "3 -1 -10 3 3", "26 0 -29 26 0", "22 1 -22 20 9", "10 -2 -29 7 9",
    "39.140625 0 -29 39 0", "33.691406 3 -22 35 9", "14.355469 -4 -29 18 9"];
  same("getGlyphBounds", bounds.join(" | "), want.join(" | "));
});

// Expected values are the reference AVD's (API 35) for the same calls. Skia stores ovals, round
// rects and arcs as conics (K) and ours as cubics (C), so those compare by their end points.
// Expected values are the reference AVD's (API 35) under the same calls. Its serif, monospace, CJK,
// Arabic, Devanagari and symbol faces are not on the page, and its variable Roboto draws H and o
// with other contours than the page's static instances, so those cases are left out and text
// outlines compare by bounds. A device conic is our cubic, so circles are left out too.
await exercise("Paint, TextPaint, PathEffects, MaskFilters (device values)", async () => {
  const { loadSystemFonts } = await import("../tests/java");
  await loadSystemFonts();
  const P = "android/graphics/Paint", PL = "Landroid/graphics/Paint;", PATH = "android/graphics/Path", PE = "Landroid/graphics/PathEffect;";
  const statics = async (cls: string) => (await linkInit(cls)).ctor as Record<string, unknown>;
  const [Style, Align, Dir, PDStyle, Blur, TF] = await Promise.all(["Paint$Style", "Paint$Align", "Path$Direction", "PathDashPathEffect$Style",
    "BlurMaskFilter$Blur", "Typeface"].map((c) => statics("android/graphics/" + c)));
  const call = (o: unknown, name: string, desc: string, ...a: unknown[]): Promise<any> => vcall(o, name, desc, ...a);
  const paint = (...copy: unknown[]) => (copy.length ? newObj(P, `(${PL})V`, copy[0]) : newObj(P, "()V"));
  /** `got` against the device's `want`, token by token, numbers within float precision */
  const same = (what: string, got: string, want: string) => {
    const split = (t: string) => t.split(/[\s,[\]]+|(?<=[MLQKCZ])/).filter(Boolean), g = split(got), w = split(want);
    const ok = g.length === w.length && g.every((t, i) => t === w[i] || Math.abs(+t - +w[i]) <= 1e-4 * Math.max(1, Math.abs(+w[i])));
    if (!ok) throw new Error(`${what}: ${got}, not ${want}`);
  };
  const threw = async (f: () => Promise<unknown>) => {
    try { await f(); return "ok"; } catch (e) { return `${(e as { constructor: { $i: { name: string } } }).constructor.$i.name} ${await vcall(e, "getMessage", "()Ljava/lang/String;")}`; }
  };

  same("flags of new Paint(), Paint(0), TextPaint()", `${await call(await paint(), "getFlags", "()I")} ${await call(await newObj(P, "(I)V", 0), "getFlags", "()I")} ${await call(await newObj("android/text/TextPaint", "()V"), "getFlags", "()I")}`, "1283 1282 1283");
  const d = await paint();
  same("defaults", [await call(d, "getColorLong", "()J"), await call(d, "getTextSize", "()F"), await call(d, "getStrokeMiter", "()F"), await call(d, "getHinting", "()I"),
    await call(d, "getTextScaleX", "()F"), await call(d, "getWordSpacing", "()F"), await call(d, "getEndHyphenEdit", "()I"), await call(d, "hasShadowLayer", "()Z"),
    await call(d, "isDither", "()Z"), await call(d, "isFilterBitmap", "()Z"), await call(d, "isElegantTextHeight", "()Z")].join(" "), "-72057594037927936 12 4 1 1 0 0 0 0 1 1");
  const f = await paint(), flags = async (v: number) => { await call(f, "setFlags", "(I)V", v); return call(f, "getFlags", "()I"); };
  same("setFlags round trips", `${await flags(-1)} ${await flags(0x7ff)} ${await flags(0x10000)}`, "28159 1535 0");
  await call(f, "setHinting", "(I)V", 0);
  same("hinting off", `${await call(f, "getHinting", "()I")} ${await call(f, "getFlags", "()I")}`, "0 0");
  await call(f, "setHinting", "(I)V", 5);
  same("hinting 5", `${await call(f, "getHinting", "()I")}`, "1");
  const a = await paint(), getF = async (name: string) => call(a, "get" + name, "()F");
  for (const [set, v] of [["StrokeMiter", -1], ["StrokeWidth", -3], ["TextSize", -5]] as const) await call(a, "set" + set, "(F)V", v);
  same("negative miter, width and size ignored", `${await getF("StrokeMiter")} ${await getF("StrokeWidth")} ${await getF("TextSize")}`, "4 0 12");
  const shadow = async (r: number, c: number) => { await call(a, "setShadowLayer", "(FFFI)V", r, 1, 1, c); return call(a, "hasShadowLayer", "()Z"); };
  same("hasShadowLayer: radius 0, colour 0, both", `${await shadow(0, -16777216)} ${await shadow(2, 0)} ${await shadow(2, -16777216)}`, "0 1 1");
  await call(a, "setWordSpacing", "(F)V", 3); await call(a, "setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$RIGHT);
  await call(a, "setStartHyphenEdit", "(I)V", 1); await call(a, "setTextSize", "(F)V", 30);
  const copy = await paint(a);
  same("copy", `${await call(copy, "getTextSize", "()F")} ${await call(copy, "getWordSpacing", "()F")} ${await call(copy, "hasShadowLayer", "()Z")}`, "30 3 1");
  await call(a, "reset", "()V");
  // Paint::reset leaves the text layout state (spacing, alignment, hyphen edits, typeface) alone
  same("reset", `${await call(a, "getFlags", "()I")} ${await getF("TextSize")} ${await getF("WordSpacing")} ${await call(a, "hasShadowLayer", "()Z")} ${await call(a, "getStartHyphenEdit", "()I")}`
    + ` ${await call(await call(a, "getTextAlign", "()Landroid/graphics/Paint$Align;"), "name", "()Ljava/lang/String;")}`, "1283 12 3 0 1 RIGHT");
  const tpa = await newObj("android/text/TextPaint", "()V"), tpb = await newObj("android/text/TextPaint", "()V");
  await call(tpa, "setTextSize", "(F)V", 20);
  await call(tpb, "set", "(Landroid/text/TextPaint;)V", tpa);
  same("TextPaint.set", `${await call(tpb, "getTextSize", "()F")}`, "20");

  // metrics: Roboto's hhea and head, post's underline, hwui's strike-through constants, elegant height
  const metrics = async (m: unknown) => {
    return [...fontMetrics(await call(m, "getFontMetrics", "()Landroid/graphics/Paint$FontMetrics;")),
      ...fontMetrics(await call(m, "getFontMetricsInt", "()Landroid/graphics/Paint$FontMetricsInt;"), "FontMetricsInt"), await call(m, "getFontSpacing", "()F"),
      ...await Promise.all(["UnderlinePosition", "UnderlineThickness", "StrikeThruPosition", "StrikeThruThickness"].map((n) => call(m, `get${n}`, "()F")))].join(" ");
  };
  const DEVICE: Record<number, [string, string]> = {
    12: ["-12.673828 -11.1328125 2.9296875 3.2519531 0 -13 -11 3 4 0 14.0625 0.87890625 0.5859375 -3.7619052 0.6666667",
      "-14.6484375 -11.1328125 2.9296875 5.859375 0 -15 -11 3 6 0 14.0625 0.87890625 0.5859375 -3.7619052 0.6666667"],
    14.5: ["-15.314209 -13.452148 3.540039 3.9294434 0 -16 -13 4 4 0 16.992188 1.0620117 0.7080078 -4.545635 0.8055556",
      "-17.700195 -13.452148 3.540039 7.080078 0 -18 -13 4 8 0 16.992188 1.0620117 0.7080078 -4.545635 0.8055556"],
    40: ["-42.246094 -37.109375 9.765625 10.839844 0 -43 -37 10 11 0 46.875 2.9296875 1.953125 -12.539683 2.2222223",
      "-48.828125 -37.109375 9.765625 19.53125 0 -49 -37 10 20 0 46.875 2.9296875 1.953125 -12.539683 2.2222223"],
  };
  for (const [size, [plain, elegant]] of Object.entries(DEVICE)) {
    const m = await paint();
    await call(m, "setTextSize", "(F)V", +size);
    same(`metrics ${size}`, await metrics(m), plain);
    await call(m, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", TF.s$DEFAULT_BOLD);
    same(`metrics bold ${size}`, await metrics(m), plain);
    await call(m, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", null);
    await call(m, "setFakeBoldText", "(Z)V", 1); await call(m, "setTextScaleX", "(F)V", 2); await call(m, "setTextSkewX", "(F)V", -0.25);
    same(`metrics fake bold, scaled and skewed ${size}`, await metrics(m), plain);
    await call(m, "setElegantTextHeight", "(Z)V", 1);
    same(`metrics elegant ${size}`, await metrics(m), elegant);
  }

  // hasGlyph: well-formed text, variation sequences, one glyph for several characters
  const g = await paint(), glyphs: string[] = [];
  for (const s of ["A", "", "AB", "fi", "\u{1F600}", "☺️", "A️", "\uD83D", "é", "￿", " ", "é", "\u{1F1FA}\u{1F1F8}", "\uDE00"])
    glyphs.push(String(await call(g, "hasGlyph", "(Ljava/lang/String;)Z", s)));
  same("hasGlyph", glyphs.join(" "), "1 0 0 1 1 1 0 0 1 0 1 1 1 0");

  // equalsForTextMeasurement: what MinikinPaint compares
  const base = await paint();
  await call(base, "setTextSize", "(F)V", 20);
  const Locale = await statics("java/util/Locale"), eq: string[] = [];
  for (const [name, desc, v] of [["setColor", "(I)V", -65536], ["setTextSize", "(F)V", 21], ["setTextScaleX", "(F)V", 2], ["setTextSkewX", "(F)V", -0.25],
    ["setLetterSpacing", "(F)V", 0.1], ["setWordSpacing", "(F)V", 2], ["setFontFeatureSettings", "(Ljava/lang/String;)V", "\"liga\" 0"],
    ["setFakeBoldText", "(Z)V", 1], ["setUnderlineText", "(Z)V", 1], ["setStrikeThruText", "(Z)V", 1], ["setLinearText", "(Z)V", 1],
    ["setSubpixelText", "(Z)V", 1], ["setAntiAlias", "(Z)V", 0], ["setTextLocale", "(Ljava/util/Locale;)V", Locale.s$JAPAN], ["setElegantTextHeight", "(Z)V", 1],
    ["setEndHyphenEdit", "(I)V", 1], ["setStrokeWidth", "(F)V", 3], ["setHinting", "(I)V", 0], ["setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$CENTER]] as const) {
    const o = await paint(base);
    await call(o, name, desc, v);
    eq.push(String(await call(base, "equalsForTextMeasurement", `(${PL})Z`, o)));
  }
  same("equalsForTextMeasurement", eq.join(" "), "1 0 0 0 0 0 0 0 1 1 0 0 0 0 1 1 1 0 1");

  // path effects, through getFillPath: SkDashPathEffect, SkCornerPathEffect, SkDiscretePathEffect
  // (its seeded LCG), SkPath1DPathEffect's three styles, compose and sum
  const path = async (...ops: [string, string, ...unknown[]][]) => {
    const p = await newObj(PATH, "()V");
    for (const [name, desc, ...args] of ops) await call(p, name, desc, ...args);
    return p;
  };
  const dump = async (p: unknown) => {
    const it = await call(p, "getPathIterator", "()Landroid/graphics/PathIterator;"), pts = new Float32Array(8), out: string[] = [];
    while (await call(it, "hasNext", "()Z")) {
      const v = await call(it, "next", "([FI)I", pts, 0) as number;
      if (v === 6) break;
      out.push("MLQKCZ"[v] + [...pts.subarray(v ? 2 : 0, [2, 4, 6, 6, 8, 2][v])].join(","));
    }
    return out.join(" ");
  };
  const fill = async (p: unknown, src: unknown) => {
    const dst = await newObj(PATH, "()V");
    return `${await call(p, "getFillPath", "(Landroid/graphics/Path;Landroid/graphics/Path;)Z", src, dst)} ${await dump(dst)}`;
  };
  const line = await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 100, 0], ["lineTo", "(FF)V", 100, 50]);
  const rect = await path(["addRect", "(FFFFLandroid/graphics/Path$Direction;)V", 0, 0, 60, 40, Dir.s$CW]);
  const e = await paint(), fp = await paint();
  await call(e, "setStyle", "(Landroid/graphics/Paint$Style;)V", Style.s$STROKE);
  const effect = async (p: unknown, cls: string, desc: string, ...args: unknown[]) => call(p, "setPathEffect", `(${PE})${PE}`, await newObj("android/graphics/" + cls, desc, ...args));
  const dash = (iv: number[], phase: number) => newObj("android/graphics/DashPathEffect", "([FF)V", Float32Array.from(iv), phase);
  const corner = (r: number) => newObj("android/graphics/CornerPathEffect", "(F)V", r);
  await effect(e, "DashPathEffect", "([FF)V", Float32Array.of(10, 5), 3);
  same("dash line", await fill(e, line), "0 M0,0 L7,0 M12,0 L22,0 M27.000002,0 L37,0 M42,0 L52,0 M57,0 L67,0 M72,0 L82,0 M87,0 L97,0 M100,2 L100,12 M100,17 L100,27.000002 M100,32 L100,42 M100,47 L100,50");
  same("dash rect, the last dash joining the first", await fill(e, rect), "0 M12,0 L22,0 M27,0 L37,0 M42,0 L52,0 M57,0 L60,0 L60,7 M60,12 L60,22 M60,27 L60,37 M58,40 L48,40 M43,40 L33,40 M28,40 L18,40 M13,40 L3,40 M0,38 L0,28 M0,23 L0,13 M0,8 L0,0 L7,0");
  await effect(e, "DashPathEffect", "([FF)V", Float32Array.of(10, 5, 2, 5), -4);
  same("dash of four, negative phase", await fill(e, rect), "0 M4,0 L14,0 M19,0 L21,0 M26,0 L36,0 M41,0 L43,0 M48,0 L58,0 M60,3 L60,5 M60,10 L60,20 M60,25 L60,27 M60,32 L60,40 L58,40 M53,40 L51,40 M46,40 L36,40 M31,40 L29,40 M24,40 L14,40 M9,40 L7,40 M2,40 L0,40 L0,32 M0,27 L0,25 M0,20 L0,10 M0,5 L0,3");
  await effect(e, "DashPathEffect", "([FF)V", Float32Array.of(-1, 5), 0);
  same("invalid dash", await fill(e, line), "0 M0,0 L100,0 L100,50");
  await call(fp, "setPathEffect", `(${PE})${PE}`, await dash([10, 5], 3));
  same("dash on a fill", await fill(fp, line), "1 M0,0 L100,0 L100,50");
  await effect(e, "CornerPathEffect", "(F)V", 10);
  same("corner line", await fill(e, line), "0 M0,0 Q0,0,10,0 L90,0 Q100,0,100,10 L100,40 L100,50");
  same("corner rect", await fill(e, rect), "0 M10,0 L50,0 Q60,0,60,10 L60,30 Q60,40,50,40 L10,40 Q0,40,0,30 L0,10 Q0,0,10,0 Z");
  await effect(e, "CornerPathEffect", "(F)V", 30);
  same("corner past half the sides", await fill(e, rect), "0 M30,0 Q60,0,60,20 Q60,40,30,40 Q0,40,0,20 Q0,0,30,0 Z");
  await effect(e, "DiscretePathEffect", "(FF)V", 10, 3);
  same("discrete line", await fill(e, line), "0 M0,-0.5374603 L10,-1.0631104 L20,1.6429138 L30.000002,0.5774231 L40,-1.5262299 L50,1.8825531 L60.000004,-2.6483002 L70,-0.83102417 L80,-0.375412 L90,0.7796631 L100,-2.8143768 L100.07768,10 L99.12938,20 L97.692184,30.000002 L99.071884,40 L99.52933,50");
  same("discrete rect", await fill(e, rect), "0 M5,-0.24449158 L15,1.1396027 L25,-0.17037964 L35,0.105651855 L45,-1.2668152 L55,-0.24632263 L60.84366,5 L59.827972,15 L61.48503,25 L59.79689,35 L55,42.15909 L45,38.62845 L35,37.611526 L25,41.152695 L15,40.74904 L5,40.342957 L-1.37883,35 L0.7482605,25 L-0.56781006,15 L-2.1443024,5 Z");
  const stamp = await path(["addRect", "(FFFFLandroid/graphics/Path$Direction;)V", -2, -1, 2, 1, Dir.s$CW]);
  const stamps = (xs: number[][]) => xs.map(([l, t, r, b]) => `M${l},${t} L${r},${t} L${r},${b} L${l},${b} Z`).join(" ");
  for (const [style, want] of [
    ["TRANSLATE", stamps([[13, -1, 17, 1], [33, -1, 37, 1], [53, -1, 57, 1], [73, -1, 77, 1], [93, -1, 97, 1], [98, 14, 102, 16], [98, 34, 102, 36]])],
    ["ROTATE", stamps([[13, -1, 17, 1], [33, -1, 37, 1], [53, -1, 57, 1], [73, -1, 77, 1], [93, -1, 97, 1]]) + " M101,13 L101,17 L99,17 L99,13 Z M101,33 L101,37 L99,37 L99,33 Z"],
    ["MORPH", [13, 33, 53, 73, 93].map((x) => `M${x},-1 Q${x + 2},-1,${x + 4},-1 Q${x + 4},0,${x + 4},1 Q${x + 2},1,${x},1 Q${x},0,${x},-1 Z`).join(" ")
      + " " + [13, 33].map((y) => `M101,${y} Q101,${y + 2},101,${y + 4} Q100,${y + 4},99,${y + 4} Q99,${y + 2},99,${y} Q100,${y},101,${y} Z`).join(" ")],
  ] as const) {
    await effect(e, "PathDashPathEffect", "(Landroid/graphics/Path;FFLandroid/graphics/PathDashPathEffect$Style;)V", stamp, 20, 5, PDStyle["s$" + style]);
    same(`path dash ${style}`, await fill(e, line), "1 " + want);
  }
  await effect(e, "ComposePathEffect", `(${PE}${PE})V`, await dash([10, 5], 0), await corner(10));
  same("compose", await fill(e, rect), "0 M25,0 L35,0 M40,0 L50,0 M54.95655,0.8400003 Q59.547035,2.7134168,59.959316,8.765032 M60,13.872475 L60,23.872475 M60,28.872475 L60,30 Q60,35.554768,56.914455,38.02399 M52.388577,39.837273 Q51.275654,40,50,40 L42.25506,40 M37.25506,40 L27.255062,40 M22.255062,40 L12.255066,40 M7.1355715,39.758892 Q1.6163669,38.74435,0.36614323,33.46083 M0,28.382599 L0,18.382599 M0,13.382599 L0,10 Q0,5.9921975,1.6062481,3.590643 M5.5320435,0.65650177 Q7.437771,0,10,0 L20,0");
  await effect(e, "SumPathEffect", `(${PE}${PE})V`, await dash([10, 5], 0), await corner(10));
  same("sum", await fill(e, rect), "0 M15,0 L25,0 M30,0 L40,0 M45,0 L55,0 M60,0 L60,0 L60,10 M60,15 L60,25 M60,30 L60,40 M55,40 L45,40 M40,40 L30,40 M25,40 L15,40 M10,40 L0,40 M0,35 L0,25 M0,20 L0,10 M0,5 L0,0 L10,0 M10,0 L50,0 Q60,0,60,10 L60,30 Q60,40,50,40 L10,40 Q0,40,0,30 L0,10 Q0,0,10,0 Z");
  // stroking to a fill is CanvasKit's SkStroke, which a headless run has not loaded
  const s = await paint();
  await call(s, "setStyle", "(Landroid/graphics/Paint$Style;)V", Style.s$STROKE); await call(s, "setStrokeWidth", "(F)V", 4);
  same("stroke to fill, headless", (await threw(() => fill(s, line))).split(" ")[0], "java/lang/UnsupportedOperationException");

  // text outlines, as minikin lays the run out and aligns it
  const tp = await paint(), tpath = await newObj(PATH, "()V"), box = await newObj("android/graphics/RectF", "()V");
  await call(tp, "setTextSize", "(F)V", 20);
  const outline = async (text: string, x: number, y: number) => {
    await call(tp, "getTextPath", "(Ljava/lang/String;IIFFLandroid/graphics/Path;)V", text, 0, text.length, x, y, tpath);
    await call(tpath, "computeBounds", "(Landroid/graphics/RectF;Z)V", box, 1);
    return String(await call(box, "toShortString", "()Ljava/lang/String;"));
  };
  same("text path", await outline("Hi", 10, 30), "[11.650391,15.5859375][27.52539,30.0]");
  await call(tp, "setTextSkewX", "(F)V", -0.25); await call(tp, "setTextScaleX", "(F)V", 1.5);
  await outline("l", 0, 0);
  same("text path, scaled and skewed", await dump(tpath), "M8.759766,-15 L5.0097656,0 L2.2851562,0 L6.0351562,-15 L8.759766,-15 Z");
  await call(tp, "setTextSkewX", "(F)V", 0); await call(tp, "setTextScaleX", "(F)V", 1); await call(tp, "setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$CENTER);
  same("text path, centred", await outline("Hi", 10, 30), "[2.1503906,15.5859375][18.02539,30.0]");
  await call(tp, "setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$LEFT); await call(tp, "setLetterSpacing", "(F)V", 0.5);
  same("text path, letter-spaced", await outline("ll", 0, 0), "[6.5234375,-15.0][23.339844,0.0]");

  const mask = (cls: string, desc: string, ...args: unknown[]) => threw(() => newObj("android/graphics/" + cls, desc, ...args));
  same("mask filters refused", [await mask("BlurMaskFilter", "(FLandroid/graphics/BlurMaskFilter$Blur;)V", 0, Blur.s$NORMAL),
    await mask("EmbossMaskFilter", "([FFFF)V", Float32Array.of(1, 1), 0.5, 8, 3), await mask("EmbossMaskFilter", "([FFFF)V", Float32Array.of(1, 1, 1), 0.5, 8, 0),
    await mask("EmbossMaskFilter", "([FFFF)V", Float32Array.of(1, 1, 1), 0.5, 8, 3), await mask("TableMaskFilter", "([B)V", new Int8Array(256)),
    await threw(() => scall("android/graphics/TableMaskFilter", "CreateClipTable", "(II)Landroid/graphics/TableMaskFilter;", 10, 200)),
    await threw(() => scall("android/graphics/TableMaskFilter", "CreateGammaTable", "(F)Landroid/graphics/TableMaskFilter;", 2))].join(" "),
    "java/lang/IllegalArgumentException null java/lang/ArrayIndexOutOfBoundsException null java/lang/IllegalArgumentException null ok ok ok ok");
});

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

// Values recorded on the reference AVD: RenderProperties' defaults, which setters report a change
// (RP_SET), the clamped alpha, the implicit pivot and camera, and updateMatrix's 2D and 3D forms.
await exercise("RenderNode (properties, device values)", async () => {
  const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
  const near = (what: string, got: number[], want: number[]) => {
    if (got.length !== want.length || got.some((g, i) => Math.abs(g - want[i]) > 1e-5 * Math.max(1, Math.abs(want[i])))) throw new Error(`${what}: [${got}], not [${want}]`);
  };
  const call = (o: unknown, name: string, desc: string, ...a: unknown[]) => vcall(o, name, desc, ...a);
  const n = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "probe");
  const F = (name: string, v: number) => call(n, name, "(F)Z", v);
  same("defaults", [await call(n, "getAlpha", "()F"), await call(n, "getCameraDistance", "()F"), await call(n, "getPivotX", "()F"),
    await call(n, "getClipToBounds", "()Z"), await call(n, "hasIdentityMatrix", "()Z"), await call(n, "hasOverlappingRendering", "()Z"),
    await call(n, "isForceDarkAllowed", "()Z"), await call(n, "hasDisplayList", "()Z"), (await call(n, "getAmbientShadowColor", "()I")) >>> 0],
  [1, 8, 0, 1, 1, 0, 1, 0, 0xff000000]);
  same("alpha", [await F("setAlpha", 0.5), await F("setAlpha", 0.5), await F("setAlpha", 0.0005), await call(n, "getAlpha", "()F"),
    await F("setAlpha", 1.5), await F("setAlpha", 0.9995), await call(n, "getAlpha", "()F")], [1, 0, 1, 0, 1, 0, 1]);
  same("position", [await call(n, "setPosition", "(IIII)Z", 0, 0, 100, 50), await call(n, "setPosition", "(IIII)Z", 0, 0, 100, 50),
    await call(n, "getPivotX", "()F"), await call(n, "getPivotY", "()F"), await call(n, "offsetLeftAndRight", "(I)Z", 0)], [1, 0, 50, 25, 0]);
  same("pivot", [await F("setPivotX", 0), await F("setPivotX", 0), await call(n, "getPivotY", "()F"),
    await call(n, "resetPivot", "()Z"), await call(n, "resetPivot", "()Z"), await call(n, "getPivotX", "()F")], [1, 0, 25, 1, 0, 50]);
  same("camera", [await F("setCameraDistance", 8), await F("setCameraDistance", 10), await F("setCameraDistance", 10),
    await F("setCameraDistance", 1234.5), await call(n, "getCameraDistance", "()F")], [0, 1, 0, 1, 1234.5]);
  const rect = await newObj("android/graphics/Rect", "(IIII)V", 1, 2, 3, 4);
  const clipRect = (r: unknown) => call(n, "setClipRect", "(Landroid/graphics/Rect;)Z", r);
  same("clip", [await call(n, "setClipToBounds", "(Z)Z", 1), await clipRect(rect), await clipRect(rect), await clipRect(null), await clipRect(null)], [0, 1, 0, 1, 0]);
  const outline = await newObj("android/graphics/Outline", "()V");
  await call(outline, "setRoundRect", "(IIIIF)V", 0, 0, 100, 50, 8);
  await call(outline, "setAlpha", "(F)V", 0.5);
  same("outline, shadow", [await call(n, "setOutline", "(Landroid/graphics/Outline;)Z", outline), await call(n, "setOutline", "(Landroid/graphics/Outline;)Z", outline),
    await call(n, "hasShadow", "()Z"), await F("setElevation", 4), await F("setElevation", 4), await call(n, "hasShadow", "()Z"),
    await call(n, "setClipToOutline", "(Z)Z", 1), await call(n, "setClipToOutline", "(Z)Z", 1)], [1, 1, 0, 1, 0, 1, 1, 1]);
  const paint = await newObj("android/graphics/Paint", "()V");
  await call(paint, "setAlpha", "(I)V", 128);
  const layer = (on: number, p: unknown) => call(n, "setUseCompositingLayer", "(ZLandroid/graphics/Paint;)Z", on, p);
  same("layer", [await layer(1, null), await layer(1, null), await layer(1, paint), await layer(1, paint), await layer(0, paint), await layer(0, null)], [1, 0, 1, 0, 1, 1]);
  same("flags", [await call(n, "setHasOverlappingRendering", "(Z)Z", 1), await call(n, "setProjectBackwards", "(Z)Z", 0),
    await call(n, "setAmbientShadowColor", "(I)Z", 0xff000000 | 0), await call(n, "setForceDarkAllowed", "(Z)Z", 1),
    await call(n, "stretch", "(FFFF)Z", 0.1, 0, 100, 50), await call(n, "clearStretch", "()Z"), await call(n, "clearStretch", "()Z")], [1, 0, 0, 0, 1, 1, 0]);
  const t = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "t"), m = await newObj("android/graphics/Matrix", "()V"), v = new Float32Array(9);
  const matrix = async (name = "getMatrix") => { await call(t, name, "(Landroid/graphics/Matrix;)V", m); await call(m, "getValues", "([F)V", v); return [...v]; };
  await call(t, "setPosition", "(IIII)Z", 10, 20, 110, 70);
  same("identity after setPosition", await call(t, "hasIdentityMatrix", "()Z"), 1);
  for (const [name, value] of [["setRotationZ", 30], ["setScaleX", 2], ["setTranslationX", 5], ["setTranslationY", -3]] as const) await call(t, name, "(F)Z", value);
  near("2D", await matrix(), [1.7320508, -0.5, -19.10254, 1, 0.8660254, -49.650635, 0, 0, 1]);
  near("2D inverse", await matrix("getInverseMatrix"), [0.4330127, 0.25, 20.684301, -0.5, 0.8660254, 33.44744, 0, 0, 1]);
  await call(t, "setRotationX", "(F)Z", 20);
  near("3D", await matrix(), [1.6993926, -0.5282828, -16.762562, 0.92662936, 0.8024845, -44.39358, -5.9378496e-4, -5.1423284e-4, 1.0425451]);
  await call(t, "setCameraDistance", "(F)Z", 3);
  await call(t, "setRotationY", "(F)Z", -15);
  near("3D, camera", await matrix(), [1.4786806, -0.52741945, -5.7485485, 0.7086285, 0.84027576, -34.438316, -0.0035336704, -8.0830074e-4, 1.196891]);
  for (const [name, value] of [["setScaleX", 0], ["setRotationX", 0], ["setRotationY", 0]] as const) await call(t, name, "(F)Z", value);
  near("singular", [...await matrix(), ...await matrix("getInverseMatrix")], [0, -0.5, 67.5, 0, 0.8660254, 0.34936523, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
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

// Bitmap, BitmapFactory and BitmapRegionDecoder against the reference AVD: every expected value below
// was printed by the same calls there (images in tests/fixtures/images). Headless there is no image
// decoder, so a decode here gets a stand-in that has only the requested size: what these check is
// geometry, configs, flags, nine-patch data and the pixel API, not decoded pixels.
const { mangleStaticField } = await import("../src/jvm/abi");
const BITMAP = "android/graphics/Bitmap", BF = "android/graphics/BitmapFactory", OPTS = "android/graphics/BitmapFactory$Options";
const hex = (v: number) => (v >>> 0).toString(16);
const same = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
const configs = async () => (await linkInit(`${BITMAP}$Config`)).ctor as Record<string, unknown>;
const image = (name: string) => Bun.file(`tests/fixtures/images/${name}`).bytes().then((b) => new Int8Array(b.buffer, b.byteOffset, b.length));
/** "WxH CONFIG rb= bc= abc= alpha= premul= mut=", as the device probe printed it */
async function info(b: unknown): Promise<string> {
  if (!b) return "null";
  const i = (name: string) => vcall(b, name, "()I"), z = async (name: string) => !!(await vcall(b, name, "()Z"));
  const cfg = await vcall(await vcall(b, "getConfig", "()Landroid/graphics/Bitmap$Config;"), "name", "()Ljava/lang/String;");
  return `${await i("getWidth")}x${await i("getHeight")} ${cfg} rb=${await i("getRowBytes")} bc=${await i("getByteCount")} abc=${await i("getAllocationByteCount")}`
    + ` alpha=${await z("hasAlpha")} premul=${await z("isPremultiplied")} mut=${await z("isMutable")}`;
}
async function px(b: unknown): Promise<string> {
  const out: string[] = [], w = await vcall(b, "getWidth", "()I"), h = await vcall(b, "getHeight", "()I");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(hex(await vcall(b, "getPixel", "(II)I", x, y)));
  return out.join(" ");
}
async function thrown(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "ok"; } catch (e) { return String(await vcall(e, "toString", "()Ljava/lang/String;")); }
}
const create = async (w: number, h: number, config: string) =>
  scall(BITMAP, "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", w, h, (await configs())[`s$${config}`]);
const bufferBytes = async (b: unknown, n: number) => {
  const buf = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", n);
  await vcall(b, "copyPixelsToBuffer", "(Ljava/nio/Buffer;)V", buf);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await vcall(buf, "get", "(I)B", i)) & 0xff);
  return `${out.join(",")} pos=${await vcall(buf, "position", "()I")}`;
};
if (!HAS_DOM) (globalThis as Record<string, unknown>).createImageBitmap = async (source: Blob, ...args: unknown[]) => {
  const size = (args.length > 1 ? args[4] : args[0]) as ImageBitmapOptions | undefined, rect = args.length > 1 ? args as number[] : null;
  return { width: size?.resizeWidth ?? rect?.[2], height: size?.resizeHeight ?? rect?.[3], close() {} };
};

await exercise("Bitmap: pixels, configs, copies, buffers, parcels (device values)", async () => {
  const b = await create(3, 2, "ARGB_8888");
  same("create", await info(b), "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=true");
  const g0 = await vcall(b, "getGenerationId", "()I");
  for (const [x, y, c] of [[0, 0, 0x80FF0000], [1, 0, 0x01808080], [2, 0, 0x40123456], [0, 1, 0xff00ff00], [1, 1, 0x00ffffff], [2, 1, 0x7f7f7f7f]])
    await vcall(b, "setPixel", "(III)V", x, y, c | 0);
  same("generation", (await vcall(b, "getGenerationId", "()I")) !== g0, true);
  same("premultiplied round trip", await px(b), "80ff0000 1ffffff 40143458 ff00ff00 0 7f7e7e7e");
  const out = new Int32Array(8);
  await vcall(b, "getPixels", "([IIIIIII)V", out, 1, 4, 1, 0, 2, 2);
  same("getPixels", [...out].map(hex).join(" "), "0 1ffffff 40143458 0 0 0 7f7e7e7e 0");
  same("copyPixelsToBuffer", await bufferBytes(b, 24), "128,0,0,128,1,1,1,1,5,13,22,64,0,255,0,255,0,0,0,0,63,63,63,127 pos=24");
  const copy = async (config: string, mutable: number) => vcall(b, "copy", "(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;", (await configs())[`s$${config}`], mutable);
  const c565 = await copy("RGB_565", 1);
  same("copy 565", `${await info(c565)} | ${await px(c565)}`, "3x2 RGB_565 rb=6 bc=12 abc=12 alpha=false premul=false mut=true | ff840000 ff000000 ff080c18 ff00ff00 ff000000 ff424142");
  const cA8 = await copy("ALPHA_8", 0);
  same("copy A8", `${await info(cA8)} | ${await px(cA8)} | ${await vcall(cA8, "getColorSpace", "()Landroid/graphics/ColorSpace;")}`,
    "3x2 ALPHA_8 rb=3 bc=6 abc=6 alpha=true premul=true mut=false | 80000000 1000000 40000000 ff000000 0 7f000000 | null");
  const c4444 = await copy("ARGB_4444", 1);
  same("copy 4444", `${await info(c4444)} | ${await px(c4444)}`, "3x2 ARGB_4444 rb=6 bc=12 abc=12 alpha=true premul=true mut=true | 88ff0000 0 44004040 ff00ff00 0 77929292");
  const cF16 = await copy("RGBA_F16", 1);
  same("copy F16", `${await info(cF16)} | ${await px(cF16)}`, "3x2 RGBA_F16 rb=24 bc=48 abc=48 alpha=true premul=true mut=true | 80ff0000 1ffffff 40143458 ff00ff00 0 7f7f7f7f");
  same("F16 color space", await vcall(await vcall(cF16, "getColorSpace", "()Landroid/graphics/ColorSpace;"), "getName", "()Ljava/lang/String;"), "scRGB-nl IEC 61966-2-2:2003");
  same("copy HARDWARE", await info(await copy("HARDWARE", 0)), "3x2 HARDWARE rb=12 bc=24 abc=24 alpha=true premul=true mut=false");
  const c1010102 = await copy("RGBA_1010102", 1);
  same("copy 1010102", `${await info(c1010102)} | ${await px(c1010102)}`, "3x2 RGBA_1010102 rb=12 bc=24 abc=24 alpha=true premul=true mut=true | aac00000 0 550f2742 ff00ff00 0 55bdbdbd");
  same("create 4444 is 8888", await info(await create(2, 2, "ARGB_4444")), "2x2 ARGB_8888 rb=8 bc=16 abc=16 alpha=true premul=true mut=true");
  same("create HARDWARE", await thrown(() => create(2, 2, "HARDWARE")), "java.lang.IllegalArgumentException: can't create mutable bitmap with Config.HARDWARE");
  const a8 = await create(2, 1, "ALPHA_8");
  await vcall(a8, "setPixel", "(III)V", 0, 0, 0x80ff0000 | 0); await vcall(a8, "setPixel", "(III)V", 1, 0, 0xff123456 | 0);
  same("A8", `${await px(a8)} | ${await bufferBytes(a8, 2)}`, "80000000 ff000000 | 128,255 pos=2");
  const r565 = await create(2, 1, "RGB_565");
  await vcall(r565, "setPixel", "(III)V", 0, 0, 0x80ff8040 | 0); await vcall(r565, "setPixel", "(III)V", 1, 0, 0xff123456 | 0);
  await vcall(r565, "setHasAlpha", "(Z)V", 1);
  same("565", `${await px(r565)} | ${await bufferBytes(r565, 4)} | ${await vcall(r565, "hasAlpha", "()Z")}`, "ffff8242 ff103452 | 8,252,170,17 pos=4 | 0");
  const f16 = await create(1, 1, "RGBA_F16");
  await vcall(f16, "setPixel", "(III)V", 0, 0, 0x80ff4000 | 0);
  same("F16", `${await px(f16)} | ${await bufferBytes(f16, 8)}`, "80ff4000 | 4,56,8,48,0,0,4,56 pos=8");
  const e = await create(2, 1, "ARGB_8888");
  await vcall(e, "eraseColor", "(I)V", 0x7f00ff00);
  same("erase", await px(e), "7f00ff00 7f00ff00");
  await vcall(e, "eraseColor", "(J)V", await scall("android/graphics/Color", "pack", "(FFFF)J", 0.5, 0.25, 1, 1));
  same("erase long", await px(e), "ff8040ff ff8040ff");
  const p3 = await scall("android/graphics/ColorSpace", "get", "(Landroid/graphics/ColorSpace$Named;)Landroid/graphics/ColorSpace;",
    ((await linkInit("android/graphics/ColorSpace$Named")).ctor as Record<string, unknown>).s$DISPLAY_P3);
  await vcall(e, "eraseColor", "(J)V", await scall("android/graphics/Color", "pack", "(FFFFLandroid/graphics/ColorSpace;)J", 1, 0, 0, 1, p3));
  same("erase P3 red", await px(e), "ffff0000 ffff0000");
  const o = await create(1, 1, "ARGB_8888");
  await vcall(o, "setPixel", "(III)V", 0, 0, 0x80FF0000 | 0);
  await vcall(o, "setHasAlpha", "(Z)V", 0);
  same("opaque keeps the memory", `${await vcall(o, "hasAlpha", "()Z")} ${await px(o)} ${await vcall(o, "isPremultiplied", "()Z")}`, "0 80800000 0");
  const u = await create(1, 1, "ARGB_8888");
  await vcall(u, "setPremultiplied", "(Z)V", 0);
  await vcall(u, "setPixel", "(III)V", 0, 0, 0x01808080);
  same("unpremultiplied", `${await px(u)} | ${await bufferBytes(u, 4)}`, "1808080 | 128,128,128,1 pos=4");
  const from = await create(2, 1, "ARGB_8888");
  await vcall(from, "copyPixelsFromBuffer", "(Ljava/nio/Buffer;)V", await scall("java/nio/ByteBuffer", "wrap", "([B)Ljava/nio/ByteBuffer;", Int8Array.of(-128, 0, 0, -128, 10, 20, 30, 40)));
  same("copyPixelsFromBuffer", await px(from), "80ff0000 284080bf");
  const re = await create(3, 2, "ARGB_8888"), rg = await vcall(re, "getGenerationId", "()I");
  await vcall(re, "reconfigure", "(IILandroid/graphics/Bitmap$Config;)V", 2, 2, (await configs()).s$RGB_565);
  same("reconfigure", `${await info(re)} ${(await vcall(re, "getGenerationId", "()I")) !== rg}`, "2x2 RGB_565 rb=4 bc=8 abc=24 alpha=false premul=false mut=true true");
  same("reconfigure larger", await thrown(async () => vcall(re, "reconfigure", "(IILandroid/graphics/Bitmap$Config;)V", 4, 4, (await configs()).s$ARGB_8888)),
    "java.lang.IllegalArgumentException: Bitmap not large enough to support new configuration");
  const fromColors = await scall(BITMAP, "createBitmap", "([IIILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", Int32Array.of(0x80ff0000 | 0, 0xff00ff00 | 0, 0x01808080, 0), 2, 2, (await configs()).s$ARGB_8888);
  same("from colors", `${await info(fromColors)} | ${await px(fromColors)}`, "2x2 ARGB_8888 rb=8 bc=16 abc=16 alpha=true premul=true mut=false | 80ff0000 ff00ff00 1ffffff 0");
  const colors565 = await scall(BITMAP, "createBitmap", "([IIILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", Int32Array.of(0x80ff0000 | 0, 0xff00ff00 | 0), 2, 1, (await configs()).s$RGB_565);
  same("565 from colors", `${await info(colors565)} | ${await px(colors565)}`, "2x1 RGB_565 rb=4 bc=4 abc=4 alpha=false premul=false mut=false | ffff0000 ff00ff00");
  same("sameAs", [await vcall(b, "sameAs", "(Landroid/graphics/Bitmap;)Z", await copy("ARGB_8888", 0)), await vcall(b, "sameAs", "(Landroid/graphics/Bitmap;)Z", c565)], "1,0");
  const alpha = await vcall(b, "extractAlpha", "()Landroid/graphics/Bitmap;");
  same("extractAlpha", `${await info(alpha)} | ${await px(alpha)}`, "3x2 ALPHA_8 rb=4 bc=8 abc=8 alpha=true premul=true mut=true | 80000000 1000000 40000000 ff000000 0 7f000000");
  await vcall(b, "setDensity", "(I)V", 213);
  const parcel = await newObj("android/os/Parcel", "()V");
  await vcall(b, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const back = await vcall((await linkInit(BITMAP)).ctor[mangleStaticField("CREATOR")], "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel);
  same("parcel", `${await info(back)} dens=${await vcall(back, "getDensity", "()I")} | ${await px(back)} | ${await vcall(back, "sameAs", "(Landroid/graphics/Bitmap;)Z", b)}`,
    "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=true dens=213 | 80ff0000 1ffffff 40143458 ff00ff00 0 7f7e7e7e | 1");
  await vcall(b, "recycle", "()V");
  same("recycled", await thrown(() => vcall(b, "getPixel", "(II)I", 0, 0)), "java.lang.IllegalStateException: Can't call getPixel() on a recycled bitmap");
});

await exercise("BitmapFactory: bounds, sampling, density, configs, nine-patch, inBitmap (device values)", async () => {
  const opts = async (set: Record<string, unknown> = {}) => {
    const o = await newObj(OPTS, "()V") as Record<string, unknown>;
    for (const [k, v] of Object.entries(set)) o[declaredField(OPTS, k)] = k === "inPreferredConfig" && typeof v === "string" ? (await configs())[`s$${v}`] : v;
    return o;
  };
  const out = async (o: Record<string, unknown>) => {
    const f = (k: string) => o[declaredField(OPTS, k)];
    const cfg = f("outConfig") && await vcall(f("outConfig"), "name", "()Ljava/lang/String;");
    const cs = f("outColorSpace") && await vcall(f("outColorSpace"), "getName", "()Ljava/lang/String;");
    return `${f("outWidth")}x${f("outHeight")} ${f("outMimeType")} ${cfg ?? null} ${cs?.split(" ")[0] ?? null}`;
  };
  const decode = async (bytes: Int8Array, o: Record<string, unknown> | null) =>
    scall(BF, "decodeByteArray", "([BIILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", bytes, 0, bytes.length, o);
  const sampled: Record<string, string> = {
    "alpha.png": "10x6 5x3 3x2 2x1 2x1 1x1", "opaque.jpg": "10x6 5x3 3x2 3x2 2x1 2x1", "rotated.jpg": "10x6 5x3 3x2 3x2 2x1 2x1",
    "lossless.webp": "10x6 5x3 3x2 3x2 2x1 1x1", "anim.gif": "3x2 2x1 1x1 1x1 1x1 1x1", "patch.9.png": "48x48 24x24 16x16 12x12 9x9 6x6",
    "truncated.png": "64x64 32x32 21x21 16x16 12x12 8x8",
  };
  const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  for (const [name, want] of Object.entries(sampled)) {
    const bytes = await image(name), got: string[] = [];
    for (const sample of [1, 2, 3, 4, 5, 8]) {
      const o = await opts({ inJustDecodeBounds: 1, inSampleSize: sample });
      if (await decode(bytes, o) !== null) throw new Error("a bounds decode returned a bitmap");
      const [size, type, cfg, cs] = (await out(o)).split(" ");
      same(`${name} bounds`, `${type} ${cfg} ${cs}`, `${mime[name.split(".").pop()!]} ARGB_8888 sRGB`);
      got.push(size);
    }
    same(`${name} sampled`, got.join(" "), want);
  }
  const png = await image("alpha.png"), jpg = await image("opaque.jpg"), patch = await image("patch.9.png"), insets = await image("insets.9.png");
  const decoded = async (bytes: Int8Array, set: Record<string, unknown>) => {
    const o = await opts(set), b = await decode(bytes, o);
    return `${await info(b)} dens=${b && await vcall(b, "getDensity", "()I")} | ${await out(o)}`;
  };
  same("density 160 to 320", await decoded(png, { inDensity: 160, inTargetDensity: 320 }), "20x12 ARGB_8888 rb=80 bc=960 abc=960 alpha=true premul=true mut=false dens=320 | 10x6 image/png ARGB_8888 sRGB");
  same("density 480 to 320", await decoded(png, { inDensity: 480, inTargetDensity: 320 }), "7x4 ARGB_8888 rb=28 bc=112 abc=112 alpha=true premul=true mut=false dens=320 | 10x6 image/png ARGB_8888 sRGB");
  same("density and sample", await decoded(png, { inDensity: 480, inTargetDensity: 320, inSampleSize: 2 }), "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=false dens=320 | 5x3 image/png ARGB_8888 sRGB");
  same("unscaled", await decoded(png, { inDensity: 160, inTargetDensity: 320, inScaled: 0 }), "10x6 ARGB_8888 rb=40 bc=240 abc=240 alpha=true premul=true mut=false dens=160 | 10x6 image/png ARGB_8888 sRGB");
  same("opaque jpeg", await decoded(jpg, {}).then((s) => s.split(" dens")[0]), "10x6 ARGB_8888 rb=40 bc=240 abc=240 alpha=false premul=false mut=false");
  same("png as 565", await decoded(png, { inPreferredConfig: "RGB_565" }).then((s) => s.split(" | ")[1]), "10x6 image/png ARGB_8888 sRGB");
  same("jpeg as 565", await decoded(jpg, { inPreferredConfig: "RGB_565" }), "10x6 RGB_565 rb=20 bc=120 abc=120 alpha=false premul=false mut=false dens=" + await scall(BITMAP, "getDefaultDensity", "()I") + " | 10x6 image/jpeg RGB_565 sRGB");
  for (const [config, want] of [["ALPHA_8", "ARGB_8888"], ["HARDWARE", "HARDWARE"], ["ARGB_4444", "ARGB_8888"], [null, "ARGB_8888"]])
    same(`png as ${config}`, (await decoded(png, { inPreferredConfig: config })).split(" ")[1], want);
  same("mutable unpremultiplied", (await decoded(png, { inMutable: 1, inPremultiplied: 0 })).split(" dens")[0], "10x6 ARGB_8888 rb=40 bc=240 abc=240 alpha=true premul=false mut=true");
  const pad = await newObj("android/graphics/Rect", "(IIII)V", 7, 7, 7, 7) as Record<string, number>;
  const decodeStream = async (bytes: Int8Array, o: unknown) => scall(BF, "decodeStream", "(Ljava/io/InputStream;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;",
    await newObj("java/io/ByteArrayInputStream", "([B)V", bytes), pad, o);
  const padding = () => [pad.left, pad.top, pad.right, pad.bottom].join(",");
  await decodeStream(png, null);
  same("no nine-patch padding", padding(), "-1,-1,-1,-1");
  const np = await decodeStream(patch, null);
  same("nine-patch", `${await info(np)} pad ${padding()} chunk ${[...await vcall(np, "getNinePatchChunk", "()[B")]}`,
    "48x48 ARGB_8888 rb=192 bc=9216 abc=9216 alpha=false premul=false mut=false pad 0,0,0,0 chunk 1,2,2,9,32,0,0,0,40,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,48,0,0,0,24,0,0,0,25,0,0,0,41,0,0,0,42,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,34,34,34,-1,34,34,34,-1,34,34,34,-1,34,34,34,-1,34,34,34,-1,34,34,34,-1");
  const optical = async (b: unknown) => { const r = await newObj("android/graphics/Rect", "()V") as Record<string, number>; await vcall(b, "getOpticalInsets", "(Landroid/graphics/Rect;)V", r); return [r.left, r.top, r.right, r.bottom].join(","); };
  same("optical insets", [await optical(np), await optical(await decodeStream(insets, null))].join(" "), "0,0,0,0 1,2,3,4");
  same("nine-patch 160 to 240", `${(await info(await decodeStream(patch, await opts({ inDensity: 160, inTargetDensity: 240 })))).split(" ")[0]} pad ${padding()}`, "72x72 pad 0,0,0,0");
  const reuse = await create(10, 6, "ARGB_8888"), bigger = await create(20, 20, "ARGB_8888");
  same("inBitmap", (await decode(png, await opts({ inBitmap: reuse, inMutable: 1 }))) === reuse, true);
  same("inBitmap larger", `${(await decode(png, await opts({ inBitmap: bigger, inMutable: 1 }))) === bigger} ${await info(bigger)}`, "true 10x6 ARGB_8888 rb=40 bc=240 abc=1600 alpha=true premul=true mut=true");
  same("inBitmap too small", await thrown(async () => decode(png, await opts({ inBitmap: await create(4, 4, "ARGB_8888"), inMutable: 1 }))), "java.lang.IllegalArgumentException: Problem decoding into existing bitmap");
  same("inBitmap 565 for alpha", await thrown(async () => decode(png, await opts({ inBitmap: await create(10, 6, "RGB_565"), inMutable: 1 }))), "java.lang.IllegalArgumentException: Problem decoding into existing bitmap");
  const immutable = await decode(png, null);
  same("inBitmap immutable", (await decode(png, await opts({ inBitmap: immutable }))) !== immutable, true);
  const small = await create(5, 3, "ARGB_8888");
  same("inBitmap sampled", `${(await decode(png, await opts({ inBitmap: small, inMutable: 1, inSampleSize: 2 }))) === small} ${(await info(small)).split(" ")[0]}`, "true 5x3");
  const garbage = await opts();
  same("garbage", `${await decode(Int8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), garbage)} ${await out(garbage)}`, "null -1x-1 null null null");
  same("empty stream", await scall(BF, "decodeStream", "(Ljava/io/InputStream;)Landroid/graphics/Bitmap;", await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(0))), null);
  same("missing file", await scall(BF, "decodeFile", "(Ljava/lang/String;)Landroid/graphics/Bitmap;", "/data/local/tmp/nope.png"), null);
});

await exercise("BitmapRegionDecoder (device values)", async () => {
  const BRD = "android/graphics/BitmapRegionDecoder", png = await image("alpha.png");
  const open = async (bytes: Int8Array) => scall(BRD, "newInstance", "([BII)Landroid/graphics/BitmapRegionDecoder;", bytes, 0, bytes.length);
  const rd = await open(png), rect = (l: number, t: number, r: number, b: number) => newObj("android/graphics/Rect", "(IIII)V", l, t, r, b);
  const o = await newObj(OPTS, "()V") as Record<string, unknown>;
  o[declaredField(OPTS, "inSampleSize")] = 2;
  const region = await vcall(rd, "decodeRegion", "(Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", await rect(1, 1, 8, 6), o);
  same("region", `${await vcall(rd, "getWidth", "()I")}x${await vcall(rd, "getHeight", "()I")} ${await info(region)} ${o[declaredField(OPTS, "outWidth")]}x${o[declaredField(OPTS, "outHeight")]} ${o[declaredField(OPTS, "outMimeType")]}`,
    "10x6 3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=false 3x2 image/png");
  const partial = await vcall(rd, "decodeRegion", "(Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", await rect(-2, -2, 4, 4), null);
  same("partly outside", (await info(partial)).split(" ")[0], "6x6");
  same("outside", await thrown(async () => vcall(rd, "decodeRegion", "(Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;", await rect(20, 20, 30, 30), null)),
    "java.lang.IllegalArgumentException: rectangle is outside the image");
  same("gif", await thrown(async () => open(await image("anim.gif"))), "java.io.IOException: Image format not supported");
  same("garbage", await thrown(() => open(Int8Array.of(1, 2, 3))), "java.io.IOException: Image format not supported");
});

// text: expected values printed by the same calls on the reference AVD
const sameText = (what: string, got: unknown, want: unknown) => { if (String(got) !== String(want)) throw new Error(`${what}: ${got}, not ${want}`); };
await exercise("AndroidCharacter (device values)", async () => {
  const AC = "android/text/AndroidCharacter", chars = (s: string) => Uint16Array.from(s.split(""), (c) => c.charCodeAt(0));
  const widths: number[] = [];
  for (const c of [0x41, 0xa1, 0xff61, 0xff21, 0x3042, 0x20a9, 0x2026, 0xac00, 0x300, 0x1100, 0x4e00]) widths.push(await scall(AC, "getEastAsianWidth", "(C)I", c));
  sameText("getEastAsianWidth", widths, [4, 1, 2, 3, 5, 2, 1, 5, 1, 5, 5]);
  const mirrors: number[] = [];
  for (const c of "(>«a∈⁅〈»") mirrors.push(await scall(AC, "getMirror", "(C)C", c.charCodeAt(0)));
  sameText("getMirror", mirrors, [41, 60, 187, 97, 8715, 8262, 12297, 171]);
  const dirs = "aא1 ,٣‮😀א̀ا⁧\n\t", d = new Int8Array(dirs.length);
  await scall(AC, "getDirectionalities", "([C[BI)V", chars(dirs), d, dirs.length);
  sameText("getDirectionalities", d, [0, 1, 3, 12, 7, 6, 17, 13, 13, 1, 8, 2, -1, 10, 11]);
  const w = "aあ𠀀bｶ", ew = new Int8Array(w.length);
  await scall(AC, "getEastAsianWidths", "([CII[B)V", chars(w), 0, w.length, ew);
  sameText("getEastAsianWidths", ew, [4, 5, 5, 5, 4, 2]);
  const mc = chars("(a[b]<");
  sameText("mirror", [await scall(AC, "mirror", "([CII)Z", mc, 1, 4), String.fromCharCode(...mc), await scall(AC, "mirror", "([CII)Z", chars("abc"), 0, 3)], [1, "(a]b[<", 0]);
});
/** a Spanned's spans as the device probe prints them: name[start,end,flags in hex] */
async function spanList(text: unknown, name: (span: any) => Promise<string>): Promise<string> {
  const out: string[] = [];
  for (const span of await vcall(text, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, await vcall(text, "length", "()I"), rt.classFor("java/lang/Object")))
    out.push(`${await name(span)}[${await vcall(text, "getSpanStart", "(Ljava/lang/Object;)I", span)},${await vcall(text, "getSpanEnd", "(Ljava/lang/Object;)I", span)},${(await vcall(text, "getSpanFlags", "(Ljava/lang/Object;)I", span)).toString(16)}]`);
  return out.join(" ");
}
await exercise("SpannableStringBuilder, SpannableString, SpannedString, Selection (device values)", async () => {
  const { JObj } = await import("../src/jvm/runtime");
  const log: string[] = [];
  class Mark extends JObj { n = ""; }
  const text = async (t: unknown) => String(await vcall(t, "toString", "()Ljava/lang/String;")).replaceAll("\n", "|");
  const selection = (await linkInit("android/text/Selection")).ctor as Record<string, unknown>;
  const { mangleStaticField } = await import("../src/jvm/abi");
  const name = async (span: unknown) => span === selection[mangleStaticField("SELECTION_START")] ? "selStart"
    : span === selection[mangleStaticField("SELECTION_END")] ? "selEnd" : span instanceof Mark ? span.n : String(span);
  const note = (event: string) => async function (this: Mark, t: unknown, ...a: unknown[]) {
    const parts: unknown[] = [];
    for (const x of a) parts.push(typeof x === "number" ? x : await name(x));
    log.push(`${this.n}.${event}(${event === "add" || event === "rm" || event === "chg" ? "" : await text(t) + (a.length ? "," : "")}${parts.join(",")})`);
  };
  rt.register({ name: "fwtest/Mark", ctor: Mark, methods: { "toString()Ljava/lang/String;": function (this: Mark) { return this.n; } } });
  rt.register({ name: "fwtest/Watcher", ctor: class extends Mark {}, sup: "fwtest/Mark", ifaces: ["android/text/TextWatcher", "android/text/SpanWatcher"], methods: {
    "beforeTextChanged(Ljava/lang/CharSequence;III)V": note("before"), "onTextChanged(Ljava/lang/CharSequence;III)V": note("on"),
    "afterTextChanged(Landroid/text/Editable;)V": note("after"), "onSpanAdded(Landroid/text/Spannable;Ljava/lang/Object;II)V": note("add"),
    "onSpanRemoved(Landroid/text/Spannable;Ljava/lang/Object;II)V": note("rm"), "onSpanChanged(Landroid/text/Spannable;Ljava/lang/Object;IIII)V": note("chg"),
  } });
  const mark = (cls: string, n: string) => Object.assign(rt.make(cls) as Mark, { n });
  const events = () => log.splice(0).join(" ");
  const SET = "(Ljava/lang/Object;III)V", E = "Landroid/text/Editable;", b = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", "hello");
  const w1 = mark("fwtest/Watcher", "w1"), w2 = mark("fwtest/Watcher", "w2");
  await vcall(b, "setSpan", SET, w1, 0, 5, 0x12);
  await vcall(b, "setSpan", SET, w2, 0, 5, 0x12 | 100 << 16);
  sameText("added", events(), "w1.add(w1,0,5) w2.add(w2,0,5) w1.add(w2,0,5)");
  const filters = (...f: unknown[]) => Object.assign(f, { $t: "[Landroid/text/InputFilter;" });
  await vcall(b, "setFilters", "([Landroid/text/InputFilter;)V", filters(await newObj("android/text/InputFilter$LengthFilter", "(I)V", 8), await newObj("android/text/InputFilter$AllCaps", "()V")));
  await vcall(b, "replace", `(IILjava/lang/CharSequence;)${E}`, 5, 5, " world");
  sameText("filtered", `${await text(b)} | ${events()}`, "hello WO | w2.before(hello,5,0,3) w1.before(hello,5,0,3) w2.on(hello WO,5,0,3) w1.on(hello WO,5,0,3) " +
    "w2.after(hello WO) w1.after(hello WO) w2.chg(w1,0,8,0,8) w1.chg(w1,0,8,0,8) w2.chg(w2,0,8,0,8) w1.chg(w2,0,8,0,8)");
  const [ee, ei, ie, ii, pt, para] = ["ee", "ei", "ie", "ii", "pt", "para"].map((n) => mark("fwtest/Mark", n));
  await vcall(b, "setSpan", SET, ee, 2, 4, 0x21); await vcall(b, "setSpan", SET, ei, 2, 4, 0x22);
  await vcall(b, "setSpan", SET, ie, 2, 4, 0x11); await vcall(b, "setSpan", SET, ii, 2, 4, 0x12 | 5 << 16);
  await vcall(b, "setSpan", SET, pt, 3, 3, 0x22);
  await vcall(b, "setFilters", "([Landroid/text/InputFilter;)V", filters());
  for (const [at, s] of [[2, "<"], [5, ">"], [4, "\n"]] as const) await vcall(b, "insert", `(ILjava/lang/CharSequence;)${E}`, at, s);
  let thrown = "";
  try { await vcall(b, "setSpan", SET, para, 1, 4, 0x33); } catch (e) { thrown = String(await vcall(e, "toString", "()Ljava/lang/String;")); }
  sameText("paragraph boundary", thrown, "java.lang.RuntimeException: PARAGRAPH span must start at paragraph boundary (1 follows h)");
  await vcall(b, "setSpan", SET, para, 0, 5, 0x33);
  await vcall(b, "delete", `(II)${E}`, 0, 1);
  const spans = (t: unknown) => spanList(t, name);
  sameText("spans", `${await text(b)} ${await spans(b)}`, "e<l|l>o WO w2[0,10,640012] ii[1,6,50012] w1[0,10,12] ee[2,5,21] ei[2,6,22] ie[1,5,11] pt[4,4,22] para[0,4,33]");
  events();
  const OBJ = rt.classFor("java/lang/Object"), MARK = rt.classFor("fwtest/Mark"), length: number = await vcall(b, "length", "()I");
  sameText("nextSpanTransition", [await vcall(b, "nextSpanTransition", "(IILjava/lang/Class;)I", 0, length, OBJ), await vcall(b, "nextSpanTransition", "(IILjava/lang/Class;)I", 2, length, MARK)], [1, 4]);
  const S = "android/text/Selection", sel = async () => [await scall(S, "getSelectionStart", "(Ljava/lang/CharSequence;)I", b), await scall(S, "getSelectionEnd", "(Ljava/lang/CharSequence;)I", b)];
  await scall(S, "setSelection", "(Landroid/text/Spannable;II)V", b, 1, 3);
  const before = await sel();
  await vcall(b, "replace", `(IILjava/lang/CharSequence;)${E}`, 0, 2, "xyz");
  sameText("selection", [before, await sel()], [1, 3, 1, 4]);
  await scall(S, "selectAll", "(Landroid/text/Spannable;)V", b);
  sameText("selectAll", await sel(), [0, 11]);
  await scall(S, "removeSelection", "(Landroid/text/Spannable;)V", b);
  sameText("removeSelection", await sel(), [-1, -1]);
  const ss = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", b);
  sameText("SpannableString", `${await text(ss)} ${await spans(ss)}`, "xyzl|l>o WO w2[0,11,640012] ii[0,7,50012] w1[0,11,12] ee[3,6,21] ei[3,7,22] ie[0,6,11] pt[5,5,22] para[0,5,33]");
  const sd = await newObj("android/text/SpannedString", "(Ljava/lang/CharSequence;)V", await vcall(b, "subSequence", "(II)Ljava/lang/CharSequence;", 1, 6));
  sameText("SpannedString", `${await text(sd)} ${await spans(sd)}`, "yzl|l ii[0,5,50012] ee[2,5,21] ei[2,5,22] ie[0,5,11] pt[4,4,22] para[0,4,33]");
  sameText("valueOf", [await scall("android/text/SpannedString", "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannedString;", sd) === sd,
    await scall("android/text/SpannableString", "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannableString;", ss) === ss], [true, true]);
});

await exercise("Linkify.addLinks (device values)", async () => {
  const L = "android/text/util/Linkify", url = async (span: unknown) => `url:${await vcall(span, "getURL", "()Ljava/lang/String;")}`;
  const links = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "Visit example.com or https://www.android.com/path?q=1, mail user@example.com, not a@b");
  sameText("web and email", [await scall(L, "addLinks", "(Landroid/text/Spannable;I)Z", links, 3), await spanList(links, url)],
    [1, "url:http://example.com[6,17,21] url:https://www.android.com/path?q=1[21,53,21] url:mailto:user@example.com[60,76,21]"]);
  const tel = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "Call +1 650-253-0000 or 555.");
  sameText("phone", [await scall(L, "addLinks", "(Landroid/text/Spannable;I)Z", tel, 4), await spanList(tel, url)], [1, "url:tel:+16502530000[5,20,21]"]);
});
await exercise("ImageDecoder: headers, targets, allocators, partial input, drawables (device values)", async () => {
  const ID = "android/graphics/ImageDecoder", SRC = "Landroid/graphics/ImageDecoder$Source;";
  const source = (bytes: Int8Array) => scall(ID, "createSource", `([B)${SRC}`, bytes);
  /** a listener object answering `name` with `fn` */
  const listener = (name: string, desc: string, fn: (...a: any[]) => unknown) => Object.assign(rt.make("java/lang/Object"), { [mangleMethod(name, desc)]: fn });
  const onHeader = (fn: (decoder: unknown) => unknown) => listener("onHeaderDecoded", `(Landroid/graphics/ImageDecoder;Landroid/graphics/ImageDecoder$ImageInfo;${SRC})V`, fn);
  const bitmap = async (bytes: Int8Array, fn?: (decoder: unknown) => unknown) =>
    fn ? scall(ID, "decodeBitmap", `(${SRC}Landroid/graphics/ImageDecoder$OnHeaderDecodedListener;)Landroid/graphics/Bitmap;`, await source(bytes), onHeader(fn))
      : scall(ID, "decodeBitmap", `(${SRC})Landroid/graphics/Bitmap;`, await source(bytes));
  const withDensity = async (b: unknown) => `${await info(b)} dens=${await vcall(b, "getDensity", "()I")}`;
  const headers: Record<string, string> = {
    "alpha.png": "10x6 image/png false", "opaque.jpg": "10x6 image/jpeg false", "rotated.jpg": "6x10 image/jpeg false",
    "lossless.webp": "10x6 image/webp false", "anim.gif": "3x2 image/gif true", "patch.9.png": "48x48 image/png false",
  };
  for (const [name, want] of Object.entries(headers)) {
    const i = await scall(ID, "decodeHeader", `(${SRC})Landroid/graphics/ImageDecoder$ImageInfo;`, await source(await image(name)));
    const size = await vcall(i, "getSize", "()Landroid/util/Size;");
    same(`${name} header`, `${await vcall(size, "getWidth", "()I")}x${await vcall(size, "getHeight", "()I")} ${await vcall(i, "getMimeType", "()Ljava/lang/String;")} ${!!await vcall(i, "isAnimated", "()Z")}`, want);
  }
  const png = await image("alpha.png"), jpg = await image("opaque.jpg");
  same("default allocator", await withDensity(await bitmap(png)), "10x6 HARDWARE rb=40 bc=240 abc=240 alpha=true premul=true mut=false dens=0");
  same("EXIF orientation", await withDensity(await bitmap(await image("rotated.jpg"))), "6x10 HARDWARE rb=24 bc=240 abc=240 alpha=false premul=false mut=false dens=0");
  const crop = await newObj("android/graphics/Rect", "(IIII)V", 1, 1, 4, 3);
  same("target, crop, mutable", await info(await bitmap(png, async (d) => {
    await vcall(d, "setTargetSize", "(II)V", 5, 3); await vcall(d, "setCrop", "(Landroid/graphics/Rect;)V", crop);
    await vcall(d, "setMutableRequired", "(Z)V", 1); await vcall(d, "setAllocator", "(I)V", 1);
  })), "3x2 ARGB_8888 rb=12 bc=24 abc=24 alpha=true premul=true mut=true");
  same("sample size", await info(await bitmap(png, (d) => vcall(d, "setTargetSampleSize", "(I)V", 3))), "3x2 HARDWARE rb=12 bc=24 abc=24 alpha=true premul=true mut=false");
  same("alpha mask of colour", (await info(await bitmap(png, async (d) => { await vcall(d, "setDecodeAsAlphaMaskEnabled", "(Z)V", 1); await vcall(d, "setAllocator", "(I)V", 1); }))).split(" ")[1], "ARGB_8888");
  same("low RAM", await info(await bitmap(jpg, async (d) => { await vcall(d, "setMemorySizePolicy", "(I)V", 0); await vcall(d, "setAllocator", "(I)V", 1); })),
    "10x6 RGB_565 rb=20 bc=120 abc=120 alpha=false premul=false mut=false");
  const pad = await newObj("android/graphics/Rect", "()V") as Record<string, number>;
  await bitmap(await image("patch.9.png"), (d) => vcall(d, "setOutPaddingRect", "(Landroid/graphics/Rect;)V", pad));
  same("nine-patch padding", [pad.left, pad.top, pad.right, pad.bottom].join(","), "0,0,0,0");
  let seen = "";
  const partial = listener("onPartialImage", "(Landroid/graphics/ImageDecoder$DecodeException;)Z", async (e: unknown) => {
    seen = `${await vcall(e, "getError", "()I")} ${await vcall(e, "getMessage", "()Ljava/lang/String;")} ${await vcall(e, "getCause", "()Ljava/lang/Throwable;")}`;
    return 1;
  });
  const truncated = await image("truncated.png");
  same("partial image", `${await info(await bitmap(truncated, (d) => vcall(d, "setOnPartialImageListener", "(Landroid/graphics/ImageDecoder$OnPartialImageListener;)V", partial)))} seen ${seen}`,
    "64x64 HARDWARE rb=256 bc=16384 abc=16384 alpha=false premul=false mut=false seen 2 Input was incomplete. null");
  same("incomplete", await thrown(() => bitmap(truncated)), "android.graphics.ImageDecoder$DecodeException: Input was incomplete.");
  same("garbage", await thrown(() => bitmap(Int8Array.of(1, 2, 3, 4, 5, 6, 7, 8))),
    "android.graphics.ImageDecoder$DecodeException: Failed to create image decoder with message 'unimplemented'Input contained an error.");
  const buffer = await scall("java/nio/ByteBuffer", "wrap", "([B)Ljava/nio/ByteBuffer;", png);
  same("ByteBuffer source", await info(await scall(ID, "decodeBitmap", `(${SRC})Landroid/graphics/Bitmap;`, await scall(ID, "createSource", `(Ljava/nio/ByteBuffer;)${SRC}`, buffer))),
    "10x6 HARDWARE rb=40 bc=240 abc=240 alpha=true premul=true mut=false");
  const drawable = async (bytes: Int8Array) => {
    const d = await scall(ID, "decodeDrawable", `(${SRC})Landroid/graphics/drawable/Drawable;`, await source(bytes));
    const name = await vcall(await vcall(d, "getClass", "()Ljava/lang/Class;"), "getSimpleName", "()Ljava/lang/String;");
    return `${name} ${await vcall(d, "getIntrinsicWidth", "()I")}x${await vcall(d, "getIntrinsicHeight", "()I")}`;
  };
  same("drawables", [await drawable(png), await drawable(await image("patch.9.png")), await drawable(await image("anim.gif"))].join(", "),
    "BitmapDrawable 10x6, NinePatchDrawable 48x48, AnimatedImageDrawable 3x2");
});

// post-processing: the invalid answer is the device's; TRANSLUCENT's result is ImageDecoder.cpp's
await exercise("ImageDecoder post-processing", async () => {
  const ID = "android/graphics/ImageDecoder", SRC = "Landroid/graphics/ImageDecoder$Source;";
  const processor = (format: number) => Object.assign(rt.make("java/lang/Object"), { [mangleMethod("onPostProcess", "(Landroid/graphics/Canvas;)I")]: () => format });
  const decode = async (format: number) => scall(ID, "decodeBitmap", `(${SRC}Landroid/graphics/ImageDecoder$OnHeaderDecodedListener;)Landroid/graphics/Bitmap;`,
    await scall(ID, "createSource", `([B)${SRC}`, await image("opaque.jpg")),
    Object.assign(rt.make("java/lang/Object"), { [mangleMethod("onHeaderDecoded", `(Landroid/graphics/ImageDecoder;Landroid/graphics/ImageDecoder$ImageInfo;${SRC})V`)]:
      (d: unknown) => vcall(d, "setPostProcessor", "(Landroid/graphics/PostProcessor;)V", processor(format)) }));
  same("post-processed", await info(await decode(-3)), "10x6 HARDWARE rb=40 bc=240 abc=240 alpha=true premul=true mut=false");
  same("invalid format", await thrown(() => decode(-2)), "java.lang.IllegalArgumentException: invalid return from postProcess: -2");
}, true);

// PathParser and VectorDrawable against VectorDrawableProbe's output (scripts/vector-probe.ts)
const vectorDevice = (await Bun.file("tests/fixtures/vector-drawable.txt").text()).trim().split("\n");
const deviceLines = (tag: string) => vectorDevice.filter((l) => l.startsWith(tag + " ")).map((l) => l.slice(tag.length + 1));

// The resource natives, under AOSP's own Resources: the framework and an app installed as the
// package registry installs them, loaded through ApkAssets into an AssetManager, then read
// through Resources, Theme, TypedArray and XmlBlock as an app reads them.
if (existsSync("vendor/aosp/framework-res.apk") && existsSync("apks/FitNotes.apk")) {
  const { Arsc } = await import("../src/android/arsc");
  const { Resources } = await import("../src/android/res");
  const { PackageRecord, packages } = await import("../src/android/packages");
  const { parseAXML } = await import("../src/android/axml");
  const { openInstall } = await import("../src/shell/install");
  const read = async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer());
  (await import("../src/android/framework")).installFramework(await read("vendor/aosp/framework-res.apk"));
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
  await exercise("VectorDrawable: inflated tree, node properties, mutate, AnimatedVectorDrawable run (device values)", async () => {
    const d = await vcall(res, "getDrawable", `(I${T})Landroid/graphics/drawable/Drawable;`, await id("btn_checkbox_checked_mtrl", "drawable", "android"), theme);
    expect("opacity", await vcall(d, "getOpacity", "()I"), -3);
    const targets = new Map(vectorDevice.filter((l) => l.startsWith("target ")).map((l) => { const [, name, ...v] = l.split(" "); return [name, v.map(Number)]; }));
    const read = async (v: unknown) => {
      const group = rt.iof(v, "android/graphics/drawable/VectorDrawable$VGroup");
      const getters = group ? ["Rotation", "PivotX", "PivotY", "ScaleX", "ScaleY", "TranslateX", "TranslateY"]
        : ["StrokeWidth", "StrokeColor", "StrokeAlpha", "FillColor", "FillAlpha", "TrimPathStart", "TrimPathEnd", "TrimPathOffset"];
      return Promise.all(getters.map((g) => vcall(v, "get" + g, g.endsWith("Color") ? "()I" : "()F")));
    };
    for (const [name, want] of targets) {
      const got = (await read(await vcall(d, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", name))).map((x: number) => Number.isInteger(x) ? x : +x.toPrecision(6));
      expect(`target ${name}`, got.join(" "), want.join(" "));
    }
    // a mutated copy is a tree of its own: its changes stay out of the original
    const copy = await vcall(await vcall(d, "getConstantState", "()Landroid/graphics/drawable/Drawable$ConstantState;"), "newDrawable", "()Landroid/graphics/drawable/Drawable;");
    await vcall(copy, "mutate", "()Landroid/graphics/drawable/Drawable;");
    const path = await vcall(copy, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", "check_path_merged");
    await vcall(path, "setTrimPathEnd", "(F)V", 0.5);
    expect("copy trim", await vcall(path, "getTrimPathEnd", "()F"), 0.5);
    expect("original trim", await vcall(await vcall(d, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", "check_path_merged"), "getTrimPathEnd", "()F"), 1);
    // checked to unchecked on the render thread's animators, stepped as frames would step them:
    // the check fades out as the box's inner square fades in
    const avd = await vcall(res, "getDrawable", `(I${T})Landroid/graphics/drawable/Drawable;`, await id("btn_checkbox_checked_to_unchecked_mtrl_animation", "drawable", "android"), theme);
    const { animateRenderThread, windowRoot } = await import("../src/android/rtanimator");
    const field = (o: unknown, cls: string, name: string) => (o as Record<string, any>)[declaredField(cls, name)];
    const A = "android/graphics/drawable/AnimatedVectorDrawable";
    const vector = field(field(avd, A, "mAnimatedVectorState"), `${A}$AnimatedVectorDrawableState`, "mVectorDrawable");
    const target = (name: string) => vcall(vector, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", name);
    await vcall(avd, "start", "()V");
    // what a draw on an attached window's RecordingCanvas would record, which starts the animation
    const canvas = rt.make("android/graphics/RecordingCanvas");
    (canvas as Record<string, unknown>)[declaredField("android/graphics/RecordingCanvas", "mNode")] = windowRoot();
    await vcall(field(avd, A, "mAnimatorSet"), "onDraw", "(Landroid/graphics/Canvas;)V", canvas);
    expect("running", await vcall(avd, "isRunning", "()Z"), 1);
    animateRenderThread(1000);
    expect("check alpha at start", await vcall(await target("check_path_merged"), "getFillAlpha", "()F"), 1);
    animateRenderThread(1166);
    const scale = await vcall(await target("icon_null"), "getScaleX", "()F");
    if (!(scale < 0.2 && scale > 0.18)) throw new Error(`icon scale at 166 ms: ${scale}`);
    animateRenderThread(1600);
    expect("check alpha at end", await vcall(await target("check_path_merged"), "getFillAlpha", "()F"), 0);
    expect("box alpha at end", await vcall(await target("box_inner_merged"), "getFillAlpha", "()F"), 1);
    expect("icon scale at end", Math.fround(await vcall(await target("icon_null"), "getScaleX", "()F")), Math.fround(0.2));
    expect("stepping on", animateRenderThread(1616), false);
  });
  await exercise("AssetManager.list (the framework's assets under the app's)", async () => {
    const am = await vcall(res, "getAssets", "()Landroid/content/res/AssetManager;");
    const names: string[] = [...await vcall(am, "list", `(${S})[${S}`, "")];
    for (const dir of ["geoid_map", "images", "webkit"]) if (!names.includes(dir)) throw new Error(`list("") lacks ${dir}: ${names}`);
    expect("images/", [...await vcall(am, "list", `(${S})[${S}`, "images")].join(","), "android-logo-mask.png,android-logo-shine.png,clock_font.png,progress_font.png");
  });
}

await exercise("PathParser: parsing, errors, SkPath resolution (device values)", async () => {
  const P = "android/util/PathParser", S = "Ljava/lang/String;";
  const paths = deviceLines("path"), errors = deviceLines("error");
  const cases = ["M1,2 l3-4 h5 v6 c1 2 3 4 5 6 s1 2 3 4 q1 2 3 4 t5 6 a5 5 0 0 1 10 10 z",
    "M10 10 L20 10 L20 20 Z m5 5 l1-1.5.5e1 2 H2 V8 C0 0 1 1 2 2 S3 3 4 4 Q5 5 6 6 T7 7 A 3 4 30 1 0 12 14"];
  for (const [i, data] of cases.entries()) {
    const got: number[] = [...await vcall(await scall(P, "createPathFromPathData", `(${S})Landroid/graphics/Path;`, data), "approximate", "(F)[F", 0.5)];
    const want = paths[i].split(" ").map(Number);
    if (got.length !== want.length || got.some((g, k) => Math.abs(g - want[k]) > 1e-3 * Math.max(1, Math.abs(want[k]))))
      throw new Error(`path ${i}: [${got.slice(0, 12)}...] (${got.length}), not [${want.slice(0, 12)}...] (${want.length})`);
  }
  const bad = ["M1 2 x3 4", "   ", "M1 2 L3 4e99", "M1 2 L3"];
  for (const [i, data] of bad.entries()) {
    const got = await scall(P, "createPathFromPathData", `(${S})Landroid/graphics/Path;`, data).then(() => "parsed", async (e) => String(await vcall(e, "toString", "()Ljava/lang/String;")));
    if (got !== errors[i]) throw new Error(`${JSON.stringify(data)}: ${got}, not ${errors[i]}`);
  }
  const data = (s: string) => newObj("android/util/PathParser$PathData", `(${S})V`, s);
  const [a, b, c] = [await data("M0 0 L10 10"), await data("M4 4 L20 0"), await data("M0 0 C1 1 2 2 3 3")];
  if (!await scall(P, "canMorph", "(Landroid/util/PathParser$PathData;Landroid/util/PathParser$PathData;)Z", a, b)) throw new Error("canMorph(same verbs)");
  if (await scall(P, "canMorph", "(Landroid/util/PathParser$PathData;Landroid/util/PathParser$PathData;)Z", a, c)) throw new Error("canMorph(other verbs)");
  const out = await newObj("android/util/PathParser$PathData", "()V"), path = await newObj("android/graphics/Path", "()V");
  await scall(P, "interpolatePathData", "(Landroid/util/PathParser$PathData;Landroid/util/PathParser$PathData;Landroid/util/PathParser$PathData;F)Z", out, a, b, 0.25);
  await scall(P, "createPathFromPathData", "(Landroid/graphics/Path;Landroid/util/PathParser$PathData;)V", path, out);
  const mid = [...await vcall(path, "approximate", "(F)[F", 0.5)].join(",");
  if (mid !== "0,1,1,1,12.5,7.5") throw new Error(`interpolated: ${mid}`);
});

if (gaps.length) {
  console.log(`\n${gaps.length} declared natives with no delegate, first 30:`);
  for (const g of gaps.slice(0, 30)) console.log("  " + g);
}
