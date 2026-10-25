// android.graphics against the reference AVD: Matrix, the color filters, Paint and its effects, Path,
// Region, Camera, RenderNode, the interpolators, NinePatch, PathParser and SurfaceTexture.
import { newObj, vcall, scall } from "../../src/jvm/natives/jentry.ts";
import { deref } from "../../src/android/handles.ts";
import { SRC_ATOP } from "../../src/android/graphics.ts";
import { presentSurface, surfaceTextureOf } from "../../src/android/glsurface.ts";
import { loadSystemFonts } from "../../tests/java.ts";
import { exercise, same, near, tokens, outcome, statics, listener, fontMetrics, vectorProbeLines, ltrb } from "./harness.ts";

await exercise("Matrix (compose, map, invert, fit, poly, values)", async () => {
  const M = () => newObj("android/graphics/Matrix", "()V");
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
  const fit = await statics("android/graphics/Matrix$ScaleToFit");
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
  const native = async (f: unknown) => deref<{ matrix: Float32Array | null; color: number; mode: number }>(await vcall(f, "getNativeInstance", "()J"));
  const srcAtop = (await statics("android/graphics/PorterDuff$Mode")).s$SRC_ATOP;
  const porterDuff = await native(await newObj("android/graphics/PorterDuffColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", -65536, srcAtop));
  same("PorterDuffColorFilter", [porterDuff.color, porterDuff.mode, porterDuff.matrix], [-65536, SRC_ATOP, null]);
  const multiply = (await statics("android/graphics/BlendMode")).s$MULTIPLY;
  same("BlendModeColorFilter", (await native(await newObj("android/graphics/BlendModeColorFilter", "(ILandroid/graphics/BlendMode;)V", 7, multiply))).mode, 24); // SkBlendMode::kMultiply
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

// Expected values are the reference AVD's (API 35) under the same calls. Its serif, monospace, CJK,
// Arabic, Devanagari and symbol faces are not on the page, and its variable Roboto draws H and o
// with other contours than the page's static instances, so those cases are left out and text
// outlines compare by bounds. A device conic is our cubic, so circles are left out too.
await exercise("Paint, TextPaint, PathEffects, MaskFilters (device values)", async () => {
  await loadSystemFonts();
  const P = "android/graphics/Paint", PL = "Landroid/graphics/Paint;", PATH = "android/graphics/Path", PE = "Landroid/graphics/PathEffect;";
  const [Style, Align, Dir, PDStyle, Blur, TF] = await Promise.all(["Paint$Style", "Paint$Align", "Path$Direction", "PathDashPathEffect$Style",
    "BlurMaskFilter$Blur", "Typeface"].map((c) => statics("android/graphics/" + c)));
  const paint = (...copy: unknown[]) => (copy.length ? newObj(P, `(${PL})V`, copy[0]) : newObj(P, "()V"));

  tokens("flags of new Paint(), Paint(0), TextPaint()", `${await vcall(await paint(), "getFlags", "()I")} ${await vcall(await newObj(P, "(I)V", 0), "getFlags", "()I")} ${await vcall(await newObj("android/text/TextPaint", "()V"), "getFlags", "()I")}`, "1283 1282 1283");
  const d = await paint();
  tokens("defaults", [await vcall(d, "getColorLong", "()J"), await vcall(d, "getTextSize", "()F"), await vcall(d, "getStrokeMiter", "()F"), await vcall(d, "getHinting", "()I"),
    await vcall(d, "getTextScaleX", "()F"), await vcall(d, "getWordSpacing", "()F"), await vcall(d, "getEndHyphenEdit", "()I"), await vcall(d, "hasShadowLayer", "()Z"),
    await vcall(d, "isDither", "()Z"), await vcall(d, "isFilterBitmap", "()Z"), await vcall(d, "isElegantTextHeight", "()Z")].join(" "), "-72057594037927936 12 4 1 1 0 0 0 0 1 1");
  const f = await paint(), flags = async (v: number) => { await vcall(f, "setFlags", "(I)V", v); return vcall(f, "getFlags", "()I"); };
  tokens("setFlags round trips", `${await flags(-1)} ${await flags(0x7ff)} ${await flags(0x10000)}`, "28159 1535 0");
  await vcall(f, "setHinting", "(I)V", 0);
  tokens("hinting off", `${await vcall(f, "getHinting", "()I")} ${await vcall(f, "getFlags", "()I")}`, "0 0");
  await vcall(f, "setHinting", "(I)V", 5);
  tokens("hinting 5", `${await vcall(f, "getHinting", "()I")}`, "1");
  const a = await paint(), getF = async (name: string) => vcall(a, "get" + name, "()F");
  for (const [set, v] of [["StrokeMiter", -1], ["StrokeWidth", -3], ["TextSize", -5]] as const) await vcall(a, "set" + set, "(F)V", v);
  tokens("negative miter, width and size ignored", `${await getF("StrokeMiter")} ${await getF("StrokeWidth")} ${await getF("TextSize")}`, "4 0 12");
  const shadow = async (r: number, c: number) => { await vcall(a, "setShadowLayer", "(FFFI)V", r, 1, 1, c); return vcall(a, "hasShadowLayer", "()Z"); };
  tokens("hasShadowLayer: radius 0, colour 0, both", `${await shadow(0, -16777216)} ${await shadow(2, 0)} ${await shadow(2, -16777216)}`, "0 1 1");
  await vcall(a, "setWordSpacing", "(F)V", 3); await vcall(a, "setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$RIGHT);
  await vcall(a, "setStartHyphenEdit", "(I)V", 1); await vcall(a, "setTextSize", "(F)V", 30);
  const copy = await paint(a);
  tokens("copy", `${await vcall(copy, "getTextSize", "()F")} ${await vcall(copy, "getWordSpacing", "()F")} ${await vcall(copy, "hasShadowLayer", "()Z")}`, "30 3 1");
  await vcall(a, "reset", "()V");
  // Paint::reset leaves the text layout state (spacing, alignment, hyphen edits, typeface) alone
  tokens("reset", `${await vcall(a, "getFlags", "()I")} ${await getF("TextSize")} ${await getF("WordSpacing")} ${await vcall(a, "hasShadowLayer", "()Z")} ${await vcall(a, "getStartHyphenEdit", "()I")}`
    + ` ${await vcall(await vcall(a, "getTextAlign", "()Landroid/graphics/Paint$Align;"), "name", "()Ljava/lang/String;")}`, "1283 12 3 0 1 RIGHT");
  const tpa = await newObj("android/text/TextPaint", "()V"), tpb = await newObj("android/text/TextPaint", "()V");
  await vcall(tpa, "setTextSize", "(F)V", 20);
  await vcall(tpb, "set", "(Landroid/text/TextPaint;)V", tpa);
  tokens("TextPaint.set", `${await vcall(tpb, "getTextSize", "()F")}`, "20");

  // metrics: Roboto's hhea and head, post's underline, hwui's strike-through constants, elegant height
  const metrics = async (m: unknown) => {
    return [...fontMetrics(await vcall(m, "getFontMetrics", "()Landroid/graphics/Paint$FontMetrics;")),
      ...fontMetrics(await vcall(m, "getFontMetricsInt", "()Landroid/graphics/Paint$FontMetricsInt;"), "FontMetricsInt"), await vcall(m, "getFontSpacing", "()F"),
      ...await Promise.all(["UnderlinePosition", "UnderlineThickness", "StrikeThruPosition", "StrikeThruThickness"].map((n) => vcall(m, `get${n}`, "()F")))].join(" ");
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
    await vcall(m, "setTextSize", "(F)V", +size);
    tokens(`metrics ${size}`, await metrics(m), plain);
    await vcall(m, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", TF.s$DEFAULT_BOLD);
    tokens(`metrics bold ${size}`, await metrics(m), plain);
    await vcall(m, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", null);
    await vcall(m, "setFakeBoldText", "(Z)V", 1); await vcall(m, "setTextScaleX", "(F)V", 2); await vcall(m, "setTextSkewX", "(F)V", -0.25);
    tokens(`metrics fake bold, scaled and skewed ${size}`, await metrics(m), plain);
    await vcall(m, "setElegantTextHeight", "(Z)V", 1);
    tokens(`metrics elegant ${size}`, await metrics(m), elegant);
  }

  // hasGlyph: well-formed text, variation sequences, one glyph for several characters
  const g = await paint(), glyphs: string[] = [];
  for (const s of ["A", "", "AB", "fi", "\u{1F600}", "☺️", "A️", "\uD83D", "é", "￿", " ", "é", "\u{1F1FA}\u{1F1F8}", "\uDE00"])
    glyphs.push(String(await vcall(g, "hasGlyph", "(Ljava/lang/String;)Z", s)));
  tokens("hasGlyph", glyphs.join(" "), "1 0 0 1 1 1 0 0 1 0 1 1 1 0");

  // equalsForTextMeasurement: what MinikinPaint compares
  const base = await paint();
  await vcall(base, "setTextSize", "(F)V", 20);
  const Locale = await statics("java/util/Locale"), eq: string[] = [];
  for (const [name, desc, v] of [["setColor", "(I)V", -65536], ["setTextSize", "(F)V", 21], ["setTextScaleX", "(F)V", 2], ["setTextSkewX", "(F)V", -0.25],
    ["setLetterSpacing", "(F)V", 0.1], ["setWordSpacing", "(F)V", 2], ["setFontFeatureSettings", "(Ljava/lang/String;)V", "\"liga\" 0"],
    ["setFakeBoldText", "(Z)V", 1], ["setUnderlineText", "(Z)V", 1], ["setStrikeThruText", "(Z)V", 1], ["setLinearText", "(Z)V", 1],
    ["setSubpixelText", "(Z)V", 1], ["setAntiAlias", "(Z)V", 0], ["setTextLocale", "(Ljava/util/Locale;)V", Locale.s$JAPAN], ["setElegantTextHeight", "(Z)V", 1],
    ["setEndHyphenEdit", "(I)V", 1], ["setStrokeWidth", "(F)V", 3], ["setHinting", "(I)V", 0], ["setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$CENTER]] as const) {
    const o = await paint(base);
    await vcall(o, name, desc, v);
    eq.push(String(await vcall(base, "equalsForTextMeasurement", `(${PL})Z`, o)));
  }
  tokens("equalsForTextMeasurement", eq.join(" "), "1 0 0 0 0 0 0 0 1 1 0 0 0 0 1 1 1 0 1");

  // path effects, through getFillPath: SkDashPathEffect, SkCornerPathEffect, SkDiscretePathEffect
  // (its seeded LCG), SkPath1DPathEffect's three styles, compose and sum
  const path = async (...ops: [string, string, ...unknown[]][]) => {
    const p = await newObj(PATH, "()V");
    for (const [name, desc, ...args] of ops) await vcall(p, name, desc, ...args);
    return p;
  };
  const dump = async (p: unknown) => {
    const it = await vcall(p, "getPathIterator", "()Landroid/graphics/PathIterator;"), pts = new Float32Array(8), out: string[] = [];
    while (await vcall(it, "hasNext", "()Z")) {
      const v = await vcall(it, "next", "([FI)I", pts, 0) as number;
      if (v === 6) break;
      out.push("MLQKCZ"[v] + [...pts.subarray(v ? 2 : 0, [2, 4, 6, 6, 8, 2][v])].join(","));
    }
    return out.join(" ");
  };
  const fill = async (p: unknown, src: unknown) => {
    const dst = await newObj(PATH, "()V");
    return `${await vcall(p, "getFillPath", "(Landroid/graphics/Path;Landroid/graphics/Path;)Z", src, dst)} ${await dump(dst)}`;
  };
  const line = await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 100, 0], ["lineTo", "(FF)V", 100, 50]);
  const rect = await path(["addRect", "(FFFFLandroid/graphics/Path$Direction;)V", 0, 0, 60, 40, Dir.s$CW]);
  const e = await paint(), fp = await paint();
  await vcall(e, "setStyle", "(Landroid/graphics/Paint$Style;)V", Style.s$STROKE);
  const effect = async (p: unknown, cls: string, desc: string, ...args: unknown[]) => vcall(p, "setPathEffect", `(${PE})${PE}`, await newObj("android/graphics/" + cls, desc, ...args));
  const dash = (iv: number[], phase: number) => newObj("android/graphics/DashPathEffect", "([FF)V", Float32Array.from(iv), phase);
  const corner = (r: number) => newObj("android/graphics/CornerPathEffect", "(F)V", r);
  await effect(e, "DashPathEffect", "([FF)V", Float32Array.of(10, 5), 3);
  tokens("dash line", await fill(e, line), "0 M0,0 L7,0 M12,0 L22,0 M27.000002,0 L37,0 M42,0 L52,0 M57,0 L67,0 M72,0 L82,0 M87,0 L97,0 M100,2 L100,12 M100,17 L100,27.000002 M100,32 L100,42 M100,47 L100,50");
  tokens("dash rect, the last dash joining the first", await fill(e, rect), "0 M12,0 L22,0 M27,0 L37,0 M42,0 L52,0 M57,0 L60,0 L60,7 M60,12 L60,22 M60,27 L60,37 M58,40 L48,40 M43,40 L33,40 M28,40 L18,40 M13,40 L3,40 M0,38 L0,28 M0,23 L0,13 M0,8 L0,0 L7,0");
  await effect(e, "DashPathEffect", "([FF)V", Float32Array.of(10, 5, 2, 5), -4);
  tokens("dash of four, negative phase", await fill(e, rect), "0 M4,0 L14,0 M19,0 L21,0 M26,0 L36,0 M41,0 L43,0 M48,0 L58,0 M60,3 L60,5 M60,10 L60,20 M60,25 L60,27 M60,32 L60,40 L58,40 M53,40 L51,40 M46,40 L36,40 M31,40 L29,40 M24,40 L14,40 M9,40 L7,40 M2,40 L0,40 L0,32 M0,27 L0,25 M0,20 L0,10 M0,5 L0,3");
  await effect(e, "DashPathEffect", "([FF)V", Float32Array.of(-1, 5), 0);
  tokens("invalid dash", await fill(e, line), "0 M0,0 L100,0 L100,50");
  await vcall(fp, "setPathEffect", `(${PE})${PE}`, await dash([10, 5], 3));
  tokens("dash on a fill", await fill(fp, line), "1 M0,0 L100,0 L100,50");
  await effect(e, "CornerPathEffect", "(F)V", 10);
  tokens("corner line", await fill(e, line), "0 M0,0 Q0,0,10,0 L90,0 Q100,0,100,10 L100,40 L100,50");
  tokens("corner rect", await fill(e, rect), "0 M10,0 L50,0 Q60,0,60,10 L60,30 Q60,40,50,40 L10,40 Q0,40,0,30 L0,10 Q0,0,10,0 Z");
  await effect(e, "CornerPathEffect", "(F)V", 30);
  tokens("corner past half the sides", await fill(e, rect), "0 M30,0 Q60,0,60,20 Q60,40,30,40 Q0,40,0,20 Q0,0,30,0 Z");
  await effect(e, "DiscretePathEffect", "(FF)V", 10, 3);
  tokens("discrete line", await fill(e, line), "0 M0,-0.5374603 L10,-1.0631104 L20,1.6429138 L30.000002,0.5774231 L40,-1.5262299 L50,1.8825531 L60.000004,-2.6483002 L70,-0.83102417 L80,-0.375412 L90,0.7796631 L100,-2.8143768 L100.07768,10 L99.12938,20 L97.692184,30.000002 L99.071884,40 L99.52933,50");
  tokens("discrete rect", await fill(e, rect), "0 M5,-0.24449158 L15,1.1396027 L25,-0.17037964 L35,0.105651855 L45,-1.2668152 L55,-0.24632263 L60.84366,5 L59.827972,15 L61.48503,25 L59.79689,35 L55,42.15909 L45,38.62845 L35,37.611526 L25,41.152695 L15,40.74904 L5,40.342957 L-1.37883,35 L0.7482605,25 L-0.56781006,15 L-2.1443024,5 Z");
  const stamp = await path(["addRect", "(FFFFLandroid/graphics/Path$Direction;)V", -2, -1, 2, 1, Dir.s$CW]);
  const stamps = (xs: number[][]) => xs.map(([l, t, r, b]) => `M${l},${t} L${r},${t} L${r},${b} L${l},${b} Z`).join(" ");
  for (const [style, want] of [
    ["TRANSLATE", stamps([[13, -1, 17, 1], [33, -1, 37, 1], [53, -1, 57, 1], [73, -1, 77, 1], [93, -1, 97, 1], [98, 14, 102, 16], [98, 34, 102, 36]])],
    ["ROTATE", stamps([[13, -1, 17, 1], [33, -1, 37, 1], [53, -1, 57, 1], [73, -1, 77, 1], [93, -1, 97, 1]]) + " M101,13 L101,17 L99,17 L99,13 Z M101,33 L101,37 L99,37 L99,33 Z"],
    ["MORPH", [13, 33, 53, 73, 93].map((x) => `M${x},-1 Q${x + 2},-1,${x + 4},-1 Q${x + 4},0,${x + 4},1 Q${x + 2},1,${x},1 Q${x},0,${x},-1 Z`).join(" ")
      + " " + [13, 33].map((y) => `M101,${y} Q101,${y + 2},101,${y + 4} Q100,${y + 4},99,${y + 4} Q99,${y + 2},99,${y} Q100,${y},101,${y} Z`).join(" ")],
  ] as const) {
    await effect(e, "PathDashPathEffect", "(Landroid/graphics/Path;FFLandroid/graphics/PathDashPathEffect$Style;)V", stamp, 20, 5, PDStyle["s$" + style]);
    tokens(`path dash ${style}`, await fill(e, line), "1 " + want);
  }
  await effect(e, "ComposePathEffect", `(${PE}${PE})V`, await dash([10, 5], 0), await corner(10));
  tokens("compose", await fill(e, rect), "0 M25,0 L35,0 M40,0 L50,0 M54.95655,0.8400003 Q59.547035,2.7134168,59.959316,8.765032 M60,13.872475 L60,23.872475 M60,28.872475 L60,30 Q60,35.554768,56.914455,38.02399 M52.388577,39.837273 Q51.275654,40,50,40 L42.25506,40 M37.25506,40 L27.255062,40 M22.255062,40 L12.255066,40 M7.1355715,39.758892 Q1.6163669,38.74435,0.36614323,33.46083 M0,28.382599 L0,18.382599 M0,13.382599 L0,10 Q0,5.9921975,1.6062481,3.590643 M5.5320435,0.65650177 Q7.437771,0,10,0 L20,0");
  await effect(e, "SumPathEffect", `(${PE}${PE})V`, await dash([10, 5], 0), await corner(10));
  tokens("sum", await fill(e, rect), "0 M15,0 L25,0 M30,0 L40,0 M45,0 L55,0 M60,0 L60,0 L60,10 M60,15 L60,25 M60,30 L60,40 M55,40 L45,40 M40,40 L30,40 M25,40 L15,40 M10,40 L0,40 M0,35 L0,25 M0,20 L0,10 M0,5 L0,0 L10,0 M10,0 L50,0 Q60,0,60,10 L60,30 Q60,40,50,40 L10,40 Q0,40,0,30 L0,10 Q0,0,10,0 Z");
  // stroking to a fill: SkStroke, through CanvasKit
  const s = await paint();
  await vcall(s, "setStyle", "(Landroid/graphics/Paint$Style;)V", Style.s$STROKE); await vcall(s, "setStrokeWidth", "(F)V", 4);
  tokens("stroke to fill", `${await fill(s, line)} | ${await fill(s, rect)}`,
    "1 M0,-2 L102,-2 L102,50 L98,50 L98,0 L100,0 L100,2 L0,2 L0,-2 Z | 1 M-2,-2 L62,-2 L62,42 L-2,42 Z M2,2 L2,38 L58,38 L58,2 Z");

  // text outlines, as minikin lays the run out and aligns it
  const tp = await paint(), tpath = await newObj(PATH, "()V"), box = await newObj("android/graphics/RectF", "()V");
  await vcall(tp, "setTextSize", "(F)V", 20);
  const outline = async (text: string, x: number, y: number) => {
    await vcall(tp, "getTextPath", "(Ljava/lang/String;IIFFLandroid/graphics/Path;)V", text, 0, text.length, x, y, tpath);
    await vcall(tpath, "computeBounds", "(Landroid/graphics/RectF;Z)V", box, 1);
    return String(await vcall(box, "toShortString", "()Ljava/lang/String;"));
  };
  tokens("text path", await outline("Hi", 10, 30), "[11.650391,15.5859375][27.52539,30.0]");
  await vcall(tp, "setTextSkewX", "(F)V", -0.25); await vcall(tp, "setTextScaleX", "(F)V", 1.5);
  await outline("l", 0, 0);
  tokens("text path, scaled and skewed", await dump(tpath), "M8.759766,-15 L5.0097656,0 L2.2851562,0 L6.0351562,-15 L8.759766,-15 Z");
  await vcall(tp, "setTextSkewX", "(F)V", 0); await vcall(tp, "setTextScaleX", "(F)V", 1); await vcall(tp, "setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$CENTER);
  tokens("text path, centred", await outline("Hi", 10, 30), "[2.1503906,15.5859375][18.02539,30.0]");
  await vcall(tp, "setTextAlign", "(Landroid/graphics/Paint$Align;)V", Align.s$LEFT); await vcall(tp, "setLetterSpacing", "(F)V", 0.5);
  tokens("text path, letter-spaced", await outline("ll", 0, 0), "[6.5234375,-15.0][23.339844,0.0]");

  const mask = (cls: string, desc: string, ...args: unknown[]) => outcome(() => newObj("android/graphics/" + cls, desc, ...args));
  tokens("mask filters refused", [await mask("BlurMaskFilter", "(FLandroid/graphics/BlurMaskFilter$Blur;)V", 0, Blur.s$NORMAL),
    await mask("EmbossMaskFilter", "([FFFF)V", Float32Array.of(1, 1), 0.5, 8, 3), await mask("EmbossMaskFilter", "([FFFF)V", Float32Array.of(1, 1, 1), 0.5, 8, 0),
    await mask("EmbossMaskFilter", "([FFFF)V", Float32Array.of(1, 1, 1), 0.5, 8, 3), await mask("TableMaskFilter", "([B)V", new Int8Array(256)),
    await outcome(() => scall("android/graphics/TableMaskFilter", "CreateClipTable", "(II)Landroid/graphics/TableMaskFilter;", 10, 200)),
    await outcome(() => scall("android/graphics/TableMaskFilter", "CreateGammaTable", "(F)Landroid/graphics/TableMaskFilter;", 2))].join(" "),
    "java.lang.IllegalArgumentException java.lang.ArrayIndexOutOfBoundsException java.lang.IllegalArgumentException ok ok ok ok");
});

// Expected values are the reference AVD's (API 35) for the same calls. Skia stores ovals, round
// rects and arcs as conics (K) and ours as cubics (C), so those compare by their end points.
await exercise("Path, PathMeasure, PathIterator (device values)", async () => {
  const P = "Landroid/graphics/Path;", DIR = "Landroid/graphics/Path$Direction;", FT = "Landroid/graphics/Path$FillType;";
  const dirs = await statics("android/graphics/Path$Direction"), fts = await statics("android/graphics/Path$FillType");
  const CW = dirs.s$CW, CCW = dirs.s$CCW;
  const path = async (...ops: [string, string, ...unknown[]][]) => {
    const p = await newObj("android/graphics/Path", "()V");
    for (const [name, desc, ...args] of ops) await vcall(p, name, desc, ...args);
    return p;
  };
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
      if (e[0] === "K" && g[0] === "C") near(`${what} [${i}]`, [...gv.slice(0, 2), ...gv.slice(-2)], [...ev.slice(0, 2), ...ev.slice(-2)], 1e-3);
      else { same(`${what} [${i}] verb`, g[0], e[0]); near(`${what} [${i}]`, gv, ev, 1e-3); }
    });
  };
  const rectOf = (r: object) => ltrb(r, "RectF");

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
    [1, 100.791, 0.003, 1, 0.008, 1, 148.999, 36.851, 0.163, 0.987, 1, 118.639, 118.861, -0.708, 0.706, 1, 50, 150, -1, 0], 1e-3);
  const m = await newObj("android/graphics/Matrix", "()V"), values = new Float32Array(9);
  same("getMatrix", await vcall(measure, "getMatrix", "(FLandroid/graphics/Matrix;I)Z", len0 * 0.5, m, 3), 1);
  await vcall(m, "getValues", "([F)V", values);
  near("its values", [...values], [0.16263475, -0.98668635, 148.99881, 0.98668635, 0.16263475, 36.850677, 0, 0, 1], 1e-3);
  const seg = await newObj("android/graphics/Path", "()V");
  same("getSegment", await vcall(measure, "getSegment", `(FF${P}Z)Z`, len0 * 0.2, len0 * 0.7, seg, 1), 1);
  await verbs("segment", seg, "M67.164,0 L67.164,0,100,0 Q100,0,150,0,150,50 C150,50,150,67.628,143.785,85.255,133.547,100.692");
  const seg2 = await path(["moveTo", "(FF)V", 100, 100]);
  await vcall(measure, "getSegment", `(FF${P}Z)Z`, len0 * 0.1, len0 * 0.4, seg2, 0);
  await verbs("segment without moveTo", seg2, "M100,100 L100,100,100,0 Q100,0,120.659,0,132.782,8.535");
  same("closed/next", [await vcall(measure, "isClosed", "()Z"), await vcall(measure, "nextContour", "()Z")], [0, 1]);
  const len1 = await vcall(measure, "getLength", "()F") as number;
  near("contour 1 length", [len1], [341.42136], 1e-5);
  near("contour 1 pos/tan", await posTan(len1 * 0.77), [1, 255.527, 255.527, -0.707, -0.707], 1e-3);
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
  near("isRect open", await isRect(open4), [1, 0, 0, 10, 20], 1e-3);
  near("isRect 3 points", [await vcall(await path(["moveTo", "(FF)V", 0, 0], ["lineTo", "(FF)V", 10, 0], ["lineTo", "(FF)V", 10, 20]), "isRect", "(Landroid/graphics/RectF;)Z", rf) as number], [0], 1e-3);
  near("isRect addRect", await isRect(await path(["addRect", `(FFFF${DIR})V`, 1, 2, 3, 4, CCW])), [1, 1, 2, 3, 4], 1e-3);
  near("isRect oval", [await vcall(await path(["addOval", `(FFFF${DIR})V`, 1, 2, 3, 4, CCW]), "isRect", "(Landroid/graphics/RectF;)Z", rf) as number], [0], 1e-3);

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
  near("approximate empty", await approx(await path(), 0.5), [0, 0, 0, 1, 0, 0], 1e-3);
  near("approximate moveTo", await approx(await path(["moveTo", "(FF)V", 3, 4]), 0.5), [0, 3, 4, 1, 3, 4], 1e-3);

  await vcall(await path(["addArc", "(FFFFFF)V", 0, 0, 100, 100, 0, 45]), "computeBounds", "(Landroid/graphics/RectF;Z)V", rf, 1);
  near("arc bounds", rectOf(rf), [85.35534, 50, 100, 85.35534], 1e-3);

  // Path.op: SkPathOps' contours, curves and fill type (an inverse operand included). The device's
  // Skia keeps the disc's quarter as its conic (K5,5,10,5); here conicTo keeps the two quads
  // SkAutoConicToQuads makes of CanvasKit's conic.
  const ops = await statics("android/graphics/Path$Op");
  const o1 = await path(["addRect", `(FFFF${DIR})V`, 0, 0, 10, 10, CW]), o2 = await path(["addRect", `(FFFF${DIR})V`, 5, 5, 15, 15, CW]);
  const disc = await path(["addCircle", `(FFF${DIR})V`, 10, 10, 5, CW]), inverse = await path(["addRect", `(FFFF${DIR})V`, 0, 0, 10, 10, CW]);
  await vcall(inverse, "setFillType", `(${FT})V`, fts.s$INVERSE_WINDING);
  const op = async (a: unknown, b: unknown, o: string) => {
    const r = await newObj("android/graphics/Path", "()V");
    await vcall(r, "op", `(${P}${P}Landroid/graphics/Path$Op;)Z`, a, b, ops[`s$${o}`]);
    const fill = await vcall(await vcall(r, "getFillType", `()${FT}`), "name", "()Ljava/lang/String;");
    return `${fill} ${(await dump(r)).replace(/([LQKC])-?[\d.]+,-?[\d.]+,/g, "$1")}`;
  };
  same("op", [await op(o1, o2, "UNION"), await op(o1, o2, "REVERSE_DIFFERENCE"), await op(o1, disc, "DIFFERENCE"), await op(inverse, o2, "UNION")].join(" | "),
    ["EVEN_ODD M10,0 L0,0 L0,10 L5,10 L5,15 L15,15 L15,5 L10,5 L10,0 Z", "EVEN_ODD M5,10 L5,15 L15,15 L15,5 L10,5 L10,10 L5,10 Z",
      "EVEN_ODD M10,0 L0,0 L0,10 L5,10 Q5,7.928931713104248,6.464466094970703,6.464466094970703 Q7.928931713104248,5,10,5 L10,0 Z", "INVERSE_EVEN_ODD M10,0 L0,0 L0,10 L5,10 L5,5 L10,5 L10,0 Z"].join(" | "));
});

// Expected values are the reference AVD's (API 35) for the same calls.
await exercise("Region, RegionIterator (device values)", async () => {
  const R = "Landroid/graphics/Region;", OP = "Landroid/graphics/Region$Op;", P = "Landroid/graphics/Path;";
  const ops = await statics("android/graphics/Region$Op");
  const region = (...a: number[]) => a.length ? newObj("android/graphics/Region", "(IIII)V", ...a) : newObj("android/graphics/Region", "()V");
  const op = (r: unknown, l: number, t: number, rr: number, b: number, o: string) => vcall(r, "op", `(IIII${OP})Z`, l, t, rr, b, ops[`s$${o}`]);
  const rects = async (r: unknown) => {
    const it = await newObj("android/graphics/RegionIterator", `(${R})V`, r), rc = await newObj("android/graphics/Rect", "()V"), out: string[] = [];
    while (await vcall(it, "next", "(Landroid/graphics/Rect;)Z", rc)) out.push(ltrb(rc).join(","));
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
  const DIR = "Landroid/graphics/Path$Direction;", dirs = await statics("android/graphics/Path$Direction");
  const fts = await statics("android/graphics/Path$FillType");
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
  const creator = await statics("android/graphics/Region");
  same("from parcel", await rects(await vcall(creator.s$CREATOR, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel)), await rects(l));
});

await exercise("Camera (device values)", async () => {
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
  const n = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "probe");
  const F = (name: string, v: number) => vcall(n, name, "(F)Z", v);
  same("defaults", [await vcall(n, "getAlpha", "()F"), await vcall(n, "getCameraDistance", "()F"), await vcall(n, "getPivotX", "()F"),
    await vcall(n, "getClipToBounds", "()Z"), await vcall(n, "hasIdentityMatrix", "()Z"), await vcall(n, "hasOverlappingRendering", "()Z"),
    await vcall(n, "isForceDarkAllowed", "()Z"), await vcall(n, "hasDisplayList", "()Z"), (await vcall(n, "getAmbientShadowColor", "()I")) >>> 0],
  [1, 8, 0, 1, 1, 0, 1, 0, 0xff000000]);
  same("alpha", [await F("setAlpha", 0.5), await F("setAlpha", 0.5), await F("setAlpha", 0.0005), await vcall(n, "getAlpha", "()F"),
    await F("setAlpha", 1.5), await F("setAlpha", 0.9995), await vcall(n, "getAlpha", "()F")], [1, 0, 1, 0, 1, 0, 1]);
  same("position", [await vcall(n, "setPosition", "(IIII)Z", 0, 0, 100, 50), await vcall(n, "setPosition", "(IIII)Z", 0, 0, 100, 50),
    await vcall(n, "getPivotX", "()F"), await vcall(n, "getPivotY", "()F"), await vcall(n, "offsetLeftAndRight", "(I)Z", 0)], [1, 0, 50, 25, 0]);
  same("pivot", [await F("setPivotX", 0), await F("setPivotX", 0), await vcall(n, "getPivotY", "()F"),
    await vcall(n, "resetPivot", "()Z"), await vcall(n, "resetPivot", "()Z"), await vcall(n, "getPivotX", "()F")], [1, 0, 25, 1, 0, 50]);
  same("camera", [await F("setCameraDistance", 8), await F("setCameraDistance", 10), await F("setCameraDistance", 10),
    await F("setCameraDistance", 1234.5), await vcall(n, "getCameraDistance", "()F")], [0, 1, 0, 1, 1234.5]);
  const rect = await newObj("android/graphics/Rect", "(IIII)V", 1, 2, 3, 4);
  const clipRect = (r: unknown) => vcall(n, "setClipRect", "(Landroid/graphics/Rect;)Z", r);
  same("clip", [await vcall(n, "setClipToBounds", "(Z)Z", 1), await clipRect(rect), await clipRect(rect), await clipRect(null), await clipRect(null)], [0, 1, 0, 1, 0]);
  const outline = await newObj("android/graphics/Outline", "()V");
  await vcall(outline, "setRoundRect", "(IIIIF)V", 0, 0, 100, 50, 8);
  await vcall(outline, "setAlpha", "(F)V", 0.5);
  same("outline, shadow", [await vcall(n, "setOutline", "(Landroid/graphics/Outline;)Z", outline), await vcall(n, "setOutline", "(Landroid/graphics/Outline;)Z", outline),
    await vcall(n, "hasShadow", "()Z"), await F("setElevation", 4), await F("setElevation", 4), await vcall(n, "hasShadow", "()Z"),
    await vcall(n, "setClipToOutline", "(Z)Z", 1), await vcall(n, "setClipToOutline", "(Z)Z", 1)], [1, 1, 0, 1, 0, 1, 1, 1]);
  const paint = await newObj("android/graphics/Paint", "()V");
  await vcall(paint, "setAlpha", "(I)V", 128);
  const layer = (on: number, p: unknown) => vcall(n, "setUseCompositingLayer", "(ZLandroid/graphics/Paint;)Z", on, p);
  same("layer", [await layer(1, null), await layer(1, null), await layer(1, paint), await layer(1, paint), await layer(0, paint), await layer(0, null)], [1, 0, 1, 0, 1, 1]);
  same("flags", [await vcall(n, "setHasOverlappingRendering", "(Z)Z", 1), await vcall(n, "setProjectBackwards", "(Z)Z", 0),
    await vcall(n, "setAmbientShadowColor", "(I)Z", 0xff000000 | 0), await vcall(n, "setForceDarkAllowed", "(Z)Z", 1),
    await vcall(n, "stretch", "(FFFF)Z", 0.1, 0, 100, 50), await vcall(n, "clearStretch", "()Z"), await vcall(n, "clearStretch", "()Z")], [1, 0, 0, 0, 1, 1, 0]);
  const t = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "t"), m = await newObj("android/graphics/Matrix", "()V"), v = new Float32Array(9);
  const matrix = async (name = "getMatrix") => { await vcall(t, name, "(Landroid/graphics/Matrix;)V", m); await vcall(m, "getValues", "([F)V", v); return [...v]; };
  await vcall(t, "setPosition", "(IIII)Z", 10, 20, 110, 70);
  same("identity after setPosition", await vcall(t, "hasIdentityMatrix", "()Z"), 1);
  for (const [name, value] of [["setRotationZ", 30], ["setScaleX", 2], ["setTranslationX", 5], ["setTranslationY", -3]] as const) await vcall(t, name, "(F)Z", value);
  near("2D", await matrix(), [1.7320508, -0.5, -19.10254, 1, 0.8660254, -49.650635, 0, 0, 1]);
  near("2D inverse", await matrix("getInverseMatrix"), [0.4330127, 0.25, 20.684301, -0.5, 0.8660254, 33.44744, 0, 0, 1]);
  await vcall(t, "setRotationX", "(F)Z", 20);
  near("3D", await matrix(), [1.6993926, -0.5282828, -16.762562, 0.92662936, 0.8024845, -44.39358, -5.9378496e-4, -5.1423284e-4, 1.0425451]);
  await vcall(t, "setCameraDistance", "(F)Z", 3);
  await vcall(t, "setRotationY", "(F)Z", -15);
  near("3D, camera", await matrix(), [1.4786806, -0.52741945, -5.7485485, 0.7086285, 0.84027576, -34.438316, -0.0035336704, -8.0830074e-4, 1.196891]);
  for (const [name, value] of [["setScaleX", 0], ["setRotationX", 0], ["setRotationY", 0]] as const) await vcall(t, name, "(F)Z", value);
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
  /** Res_png_9patch, serialized: the header, then xDivs, yDivs and colors */
  const chunk = (xs: number[], ys: number[], colors: number[]) => {
    const b = new DataView(new ArrayBuffer(32 + (xs.length + ys.length + colors.length) * 4));
    b.setUint8(1, xs.length); b.setUint8(2, ys.length); b.setUint8(3, colors.length);
    [1, 2, 3, 4].forEach((v, i) => b.setInt32(12 + i * 4, v, true));
    [...xs, ...ys, ...colors].forEach((v, i) => b.setInt32(32 + i * 4, v, true));
    return new Int8Array(b.buffer);
  };
  const cfg = (await statics("android/graphics/Bitmap$Config")).s$ARGB_8888;
  const bmp = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", 30, 30, cfg);
  const rects = async (r: unknown) => {
    if (!r) return "null";
    const it = await newObj("android/graphics/RegionIterator", "(Landroid/graphics/Region;)V", r), rc = await newObj("android/graphics/Rect", "()V"), out: string[] = [];
    while (await vcall(it, "next", "(Landroid/graphics/Rect;)Z", rc)) out.push(ltrb(rc).join(","));
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

await exercise("PathParser: parsing, errors, SkPath resolution (device values)", async () => {
  const P = "android/util/PathParser", S = "Ljava/lang/String;";
  const paths = vectorProbeLines("path"), errors = vectorProbeLines("error");
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
    const got = await outcome(() => scall(P, "createPathFromPathData", `(${S})Landroid/graphics/Path;`, data));
    if (got !== errors[i]) throw new Error(`${JSON.stringify(data)}: ${got}, not ${errors[i]}`);
  }
  // VectorDrawable's own path-string JNI raises the same failure
  const vpath = await vcall(await newObj("android/graphics/drawable/VectorDrawable$VFullPath", "()V"), "getNativePtr", "()J");
  same("VectorDrawable.nSetPathString", await outcome(() => scall("android/graphics/drawable/VectorDrawable", "nSetPathString", `(J${S}I)V`, vpath, bad[0], bad[0].length)), errors[0]);
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

// SurfaceTexture outside a GL context, against StProbe on the reference AVD (the in-context latch is
// the browser egl-thread probe's)
await exercise("SurfaceTexture: states, errors and frame delivery without a context (device values)", async () => {
  const ST = "android/graphics/SurfaceTexture";
  const matrix = async (st: unknown) => { const m = new Float32Array(16); await vcall(st, "getTransformMatrix", "([F)V", m); return m.join(","); };
  const st = await newObj(ST, "(I)V", 5);
  same("fresh", [await matrix(st), await vcall(st, "getTimestamp", "()J"), await vcall(st, "getDataSpace", "()I"), await vcall(st, "isReleased", "()Z")],
    ["1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1", 0n, 0, 0]);
  same("update", await outcome(() => vcall(st, "updateTexImage", "()V")), "java.lang.IllegalStateException: Unable to update texture contents (see logcat for details)");
  same("releaseTexImage", await outcome(() => vcall(st, "releaseTexImage", "()V")), "java.lang.IllegalStateException: Unable to release texture contents (see logcat for details)");
  same("detach", await outcome(() => vcall(st, "detachFromGLContext", "()V")), "ok");
  same("attach", await outcome(() => vcall(st, "attachToGLContext", "(I)V", 3)), "java.lang.RuntimeException: Error during attachToGLContext (see logcat for details)");
  same("empty buffer size", await outcome(() => vcall(st, "setDefaultBufferSize", "(II)V", 0, 0)), "ok");
  const detached = await newObj(ST, "(Z)V", 0);
  same("detached detach", await outcome(() => vcall(detached, "detachFromGLContext", "()V")), "java.lang.RuntimeException: Error during detachFromGLContext (see logcat for details)");
  same("detached releaseTexImage", await outcome(() => vcall(detached, "releaseTexImage", "()V")), "ok");
  // a queued frame reaches the listener through postEventFromNative and the listener's Handler
  let heard: unknown = null;
  await vcall(detached, "setOnFrameAvailableListener", `(L${ST}$OnFrameAvailableListener;)V`, listener(`${ST}$OnFrameAvailableListener`, "onFrameAvailable", `(L${ST};)V`, (s: unknown) => { heard = s; }));
  presentSurface(surfaceTextureOf(detached)!.surface, { close() {} } as ImageBitmap);
  for (let i = 0; i < 50 && !heard; i++) await new Promise((r) => setTimeout(r, 10));
  same("onFrameAvailable", heard === detached, true);
  await vcall(detached, "release", "()V");
  same("released", [await vcall(detached, "isReleased", "()Z"), await outcome(() => vcall(detached, "updateTexImage", "()V")),
    await outcome(() => vcall(detached, "releaseTexImage", "()V")), await outcome(() => vcall(detached, "attachToGLContext", "(I)V", 1))],
  [1, "java.lang.RuntimeException: Error during updateTexImage (see logcat for details)", "java.lang.RuntimeException: Error during updateTexImage (see logcat for details)",
    "java.lang.RuntimeException: Error during attachToGLContext (see logcat for details)"]);
  await vcall(detached, "finalize", "()V");
  same("finalized", surfaceTextureOf(detached), null);
});
