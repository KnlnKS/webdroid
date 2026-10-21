// Fonts and shaping: Font, FontFamily, FontFileUtil, Typeface and TextRunShaper over the reference
// build's /system/fonts.
import { readFileSync } from "node:fs";
import { newObj, vcall, scall, linkInit } from "../../src/jvm/natives/jentry.ts";
import { familyOf, typefaceOf } from "../../src/android/fonts.ts";
import { loadSystemFonts } from "../../tests/java.ts";
import { exercise, same, tokens, outcome, fontMetrics, ltrb } from "./harness.ts";

// Expected values are the reference AVD's for its variable Roboto (OS/2 weight 400, revision 196936,
// hhea 1900/-500/0 and head yMax/yMin 2163/-555 over 2048 units) and Noto Serif Bold.
await exercise("Font, FontFamily, FontFileUtil (device values)", async () => {
  await loadSystemFonts();
  const F = "Landroid/graphics/fonts/Font;", FB = "Landroid/graphics/fonts/Font$Builder;", BB = "Ljava/nio/ByteBuffer;";
  const bytes = (file: string) => new Uint8Array(readFileSync(`vendor/aosp/system/fonts/${file}`));
  const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/system/fonts/Roboto-Regular.ttf");
  const regular = await vcall(await newObj("android/graphics/fonts/Font$Builder", "(Ljava/io/File;)V", file), "build", `()${F}`);
  const style = async (f: unknown) => vcall(await vcall(f, "getStyle", "()Landroid/graphics/fonts/FontStyle;"), "toString", "()Ljava/lang/String;");
  same("from a file", [await style(regular), await vcall(regular, "getTtcIndex", "()I"), (await vcall(regular, "getAxes", "()[Landroid/graphics/fonts/FontVariationAxis;")).length,
    await vcall(await vcall(regular, "getFile", "()Ljava/io/File;"), "getPath", "()Ljava/lang/String;"), await vcall(await vcall(regular, "getLocaleList", "()Landroid/os/LocaleList;"), "isEmpty", "()Z"),
    await vcall(await vcall(regular, "getBuffer", `()${BB}`), "capacity", "()I")],
    ["FontStyle { weight=400, slant=0}", 0, 0, "/system/fonts/Roboto-Regular.ttf", 1, 2371712]);
  const boldBytes = bytes("NotoSerif-Bold.ttf"), direct = await scall("java/nio/ByteBuffer", "allocateDirect", `(I)${BB}`, boldBytes.length);
  await vcall(direct, "put", `([B)${BB}`, new Int8Array(boldBytes.buffer));
  const bold = await vcall(await newObj("android/graphics/fonts/Font$Builder", `(${BB})V`, direct), "build", `()${F}`);
  same("from a direct buffer", await style(bold), "FontStyle { weight=700, slant=0}");
  const heap = await scall("java/nio/ByteBuffer", "wrap", `([B)${BB}`, new Int8Array(boldBytes.buffer));
  same("a heap buffer", (await outcome(() => newObj("android/graphics/fonts/Font$Builder", `(${BB})V`, heap))).includes("direct"), true);
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
  same("invalid data", await outcome(() => vcall(bad, "build", `()${F}`)), "java.lang.IllegalArgumentException: Failed to create internal object. maybe invalid font data.");

  const FF = "Landroid/graphics/fonts/FontFamily;", FFB = "Landroid/graphics/fonts/FontFamily$Builder;";
  const builder = await newObj("android/graphics/fonts/FontFamily$Builder", `(${F})V`, regular);
  await vcall(builder, "addFont", `(${F})${FFB}`, bold);
  same("a second regular", (await outcome(() => vcall(builder, "addFont", `(${F})${FFB}`, regular))).endsWith("has already been added"), true);
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
    await scall("android/graphics/fonts/FontFileUtil", "isPostScriptType1Font", `(${BB}I)I`, buffer, 0)], [196936, "Roboto-Regular", 0]);
});

// Expected values are the reference AVD's app process (API 35), whose Roboto is one variable font:
// every weight has Roboto-Regular's metrics. An alias deserialized from the system font map is its
// own Typeface, so arial is not DEFAULT.
await exercise("Typeface (system font map, styles, weights, builders; device values)", async () => {
  await loadSystemFonts();
  const T = "Landroid/graphics/Typeface;", info = await linkInit("android/graphics/Typeface");
  const d = async (t: unknown) => `${await vcall(t, "getStyle", "()I")}/${await vcall(t, "getWeight", "()I")}`;
  const statics = (name: string) => info.static(name, T) as object;
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
    "sans-serif-thin 0/100 1/400 2/100 false", "sans-serif-black 0/900 1/1000 2/900 false", "arial 0/400 1/700 2/400 false",
    "no-such-family 0/400 1/700 2/400 true"]);
  same("exact weights", [await d(await weighted(null, 550, true)), await d(await weighted(DEFAULT, 650, false)), await d(await weighted(DEFAULT, 0, false)),
    await d(await weighted(DEFAULT, 1000, false))], ["2/550", "1/650", "0/1", "1/1000"]);
  const medium = await named("sans-serif-medium", 0);
  same("derived", [await d(await weighted(medium, 300, false)), await d(await scall("android/graphics/Typeface", "create", `(${T}I)${T}`, medium, 3)),
    await d(await scall("android/graphics/Typeface", "defaultFromStyle", `(I)${T}`, 3))], ["0/300", "3/800", "3/700"]);
  same("identity", [await vcall(await named("arial", 0), "equals", "(Ljava/lang/Object;)Z", DEFAULT),
    await scall("android/graphics/Typeface", "create", `(${T}I)${T}`, DEFAULT, 1) === BOLD], [0, true]);

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
  const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/system/fonts/NotoSerif-Bold.ttf");
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
// under the same paints, over the same fonts.
await exercise("TextRunShaper, PositionedGlyphs, Font.getGlyphBounds (device values)", async () => {
  await loadSystemFonts();
  const P = "Landroid/graphics/Paint;", F = "Landroid/graphics/fonts/Font;", T = "Landroid/graphics/Typeface;";
  const paint = await newObj("android/graphics/Paint", "(I)V", 1);
  const set = (name: string, desc: string, v: unknown) => vcall(paint, name, desc, typeof v === "number" ? Math.fround(v) : v);
  // numbers match to a float ulp: the device sums positions in float, rounding each step
  const ulp = { rel: 2 ** -23, abs: 0 };
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
    tokens(text, out.join(" | "), want, ulp);
  };
  await set("setTextSize", "(F)V", 40);
  await shaped("Hello, World!", "225.39453 -37.109375 9.765625 | 45@0 Roboto-Regular.ttf | 74@29 | 81@50 | 81@60 | 84@70 | 17@93 | 5@101 | 60@111 | 84@145.39453 | 87@168.39453 | 81@182.39453 | 73@192.39453 | 6@215.39453");
  await shaped("AVATAR To Ty Wa", "317.78906 -37.109375 9.765625 | 38@0 Roboto-Regular.ttf | 59@24.300781 | 38@47.835938 | 57@71.31641 | 38@93.77344 | 55@119.77344 | 5@144.77344 | 57@154.77344 | 84@176.83984 | 5@199.83984 | 57@209.83984 | 94@232.4336 | 5@251.4336 | 60@261.4336 | 70@295.78906");
  const chars = Uint16Array.from("xHello worldx", (c) => c.charCodeAt(0));
  const context = await scall("android/graphics/text/TextRunShaper", "shapeTextRun", `([CIIIIFFZ${P})Landroid/graphics/text/PositionedGlyphs;`, chars, 1, 11, 0, 13, 0, 0, 0, paint);
  const ids = [];
  for (let i = 0; i < await vcall(context, "glyphCount", "()I"); i++) ids.push(`${await vcall(context, "getGlyphId", "(I)I", i)}@${await vcall(context, "getGlyphX", "(I)F", i)}`);
  tokens("a char[] in context", `${await vcall(context, "getAdvance", "()F")} ${ids.join(" ")}`, "203 45@0 74@29 81@50 81@60 84@70 5@93 92@103 84@133 87@156 81@170 73@180", ulp);
  // the flags font has only bitmaps: its advances are unhinted, its descent its strike's (27 px at 109 ppem)
  await shaped("office fifty", "177 -37.109375 9.765625 | 84@0 Roboto-Regular.ttf | 1836@23 | 72@57 | 74@78 | 5@99 | 1834@109 | 75@131 | 89@145 | 94@158");
  await shaped("é ñ", "53 -37.109375 9.765625 | 2292@0 Roboto-Regular.ttf | 5@21 | 2299@31");
  // an app's emoji are the update GMS installed in place of the image's NotoColorEmoji.ttf, whose
  // Unicode 16 additions (fingerprint, face with bags under eyes, harp, splatter) the image lacks
  await shaped("a👍🏽b👨‍👩‍👧🇨🇦", "193.80469 -37.109375 9.9082575 | 70@0 Roboto-Regular.ttf | 571@22 NotoColorEmoji.ttf | 71@72 Roboto-Regular.ttf | 856@94 NotoColorEmoji.ttf | 65@144 NotoColorEmojiFlags.ttf");
  tokens("the emoji font", await vcall(await vcall(await vcall(glyphs, "getFont", `(I)${F}`, 1), "getFile", "()Ljava/io/File;"), "getPath", "()Ljava/lang/String;"),
    "/data/fonts/files/~~Nd6t1SNlfuHRxjD2O1nQ6A==/NotoColorEmoji.ttf", ulp);
  const available: string[] = [];
  for (const f of await vcall(await scall("android/graphics/fonts/SystemFonts", "getAvailableFonts", "()Ljava/util/Set;"), "toArray", "()[Ljava/lang/Object;"))
    available.push(await vcall(await vcall(f, "getFile", "()Ljava/io/File;"), "getPath", "()Ljava/lang/String;"));
  tokens("available emoji fonts", available.filter((p) => p.includes("Emoji")).sort().join(" "),
    "/data/fonts/files/~~Nd6t1SNlfuHRxjD2O1nQ6A==/NotoColorEmoji.ttf /system/fonts/NotoColorEmojiFlags.ttf", ulp);
  await shaped("🫆🫩🪉🫟", "200 -37.109375 9.765625 | 3254@0 NotoColorEmoji.ttf | 3280@50 | 3183@100 | 3270@150");
  await set("setTextSize", "(F)V", 20);
  await set("setLetterSpacing", "(F)V", 0.1);
  await shaped("AB AB", "65 -18.554688 4.8828125 | 38@1 Roboto-Regular.ttf | 39@16 | 5@30 | 38@37 | 39@52");
  await set("setLetterSpacing", "(F)V", 0.05);
  await shaped("office", "57 -18.554688 4.8828125 | 84@0.5 Roboto-Regular.ttf | 75@12.5 | 75@20.5 | 78@28.5 | 72@34.5 | 74@45.5");
  await set("setLetterSpacing", "(F)V", 0.02);
  await shaped("office", "50.600002 -18.554688 4.8828125 | 84@0.19999999 Roboto-Regular.ttf | 1836@11.599999 | 72@28.999998 | 74@39.4");
  await set("setLetterSpacing", "(F)V", 0);
  await set("setTextScaleX", "(F)V", 1.5);
  await shaped("AB AB", "85 -18.554688 4.8828125 | 38@0 Roboto-Regular.ttf | 39@20 | 5@39 | 38@46 | 39@66");
  await set("setTextScaleX", "(F)V", 1);
  await set("setTextSkewX", "(F)V", -0.25);
  await shaped("AB", "25.507812 -18.554688 4.8828125 | 38@0 Roboto-Regular.ttf | 39@13.046875");
  await set("setTextSkewX", "(F)V", 0);
  // kerning lands on minikin's 1/256 px grid: "oy" is -15 units, -37.5/256 px, rounded to -37/256
  await shaped("Hello you", "81.85547 -18.554688 4.8828125 | 90@0 Roboto-Regular.ttf | 84@11 | 94@21.855469 | 5@30.855469 | 84@35.85547 | 81@46.85547 | 81@51.85547 | 74@56.85547 | 45@67.85547", true);
  const typeface = async (t: unknown, text: string, want: string) => { await set("setTypeface", `(${T})${T}`, t); await shaped(text, want); };
  const create = (base: unknown, style: number) => scall("android/graphics/Typeface", "create", `(${T}I)${T}`, base, style);
  const medium = await scall("android/graphics/Typeface", "create", `(Ljava/lang/String;I)${T}`, "sans-serif-medium", 0);
  // the variable Roboto at wght 700, 500 and 900, and ital 1
  await typeface(await create(null, 1), "Bold", "40 -18.554688 4.8828125 | 39@0 Roboto-Regular.ttf | 84@13 | 81@24 | 73@29");
  await typeface(medium, "Med", "39 -18.554688 4.8828125 | 50@0 Roboto-Regular.ttf | 74@17 | 73@28");
  await typeface(await create(null, 2), "Ital", "27 -18.554688 4.8828125 | 46@0 Roboto-Regular.ttf | 89@5 | 70@11 | 81@22");
  // FreeType rounds l's advance at wght 900 (5.496 px) to 26.6 (5.5) and then to 6
  await typeface(await scall("android/graphics/Typeface", "create", `(${T}IZ)${T}`, medium, 900, 0), "Blk", "30 -18.554688 4.8828125 | 39@0 Roboto-Regular.ttf | 81@13 | 80@19");
  await set("setTypeface", `(${T})${T}`, null);
  await set("setFakeBoldText", "(Z)V", 1);
  await shaped("Fb", "22 -18.554688 4.8828125 | 43@0 Roboto-Regular.ttf | 71@11");
  await set("setFakeBoldText", "(Z)V", 0);
  await set("setFontFeatureSettings", "(Ljava/lang/String;)V", "\"smcp\" 1");
  await shaped("Small", "56 -18.554688 4.8828125 | 56@0 Roboto-Regular.ttf | 1886@12 | 1972@27 | 1887@38 | 1887@47");
  await set("setFontFeatureSettings", "(Ljava/lang/String;)V", null);

  // Skia's bounds of hinted outlines: at 13.5 px the device's hinting lifts j's dot a pixel (-11)
  await shaped("Agj", "29 -18.554688 4.8828125 | 38@0 Roboto-Regular.ttf | 76@13 | 79@24");
  // the variable Roboto is set to wght 400 and ital 0
  tokens("overrides", `${await vcall(glyphs, "getWeightOverride", "(I)F", 0)} ${await vcall(glyphs, "getItalicOverride", "(I)F", 0)}`, "400 0", ulp);
  const font = await vcall(glyphs, "getFont", `(I)${F}`, 0), rect = await newObj("android/graphics/RectF", "()V") as object;
  const bounds = [];
  for (const [size, scale, skew] of [[13.5, 1, 0], [40, 1, 0], [40, 1.5, -0.25]]) {
    await set("setTextSize", "(F)V", size); await set("setTextScaleX", "(F)V", scale); await set("setTextSkewX", "(F)V", skew);
    for (const glyph of [38, 76, 79]) bounds.push(`${await vcall(font, "getGlyphBounds", `(I${P}Landroid/graphics/RectF;)F`, glyph, paint, rect)} ${ltrb(rect, "RectF").join(" ")}`);
  }
  const want = ["9 0 -10 9 0", "8 0 -8 7 3", "3 -1 -10 3 3", "26 0 -29 26 0", "22 1 -22 20 9", "10 -2 -29 7 9",
    "39.140625 0 -29 39 0", "33.691406 3 -22 35 9", "14.355469 -4 -29 18 9"];
  tokens("getGlyphBounds", bounds.join(" | "), want.join(" | "), ulp);

  // text bounds, and metrics from the fonts the text uses: Noto Sans CJK's extent for CJK (the
  // device's hinting lifts the CJK bounds' top a pixel, to -35)
  await set("setTextSize", "(F)V", 40); await set("setTextScaleX", "(F)V", 1); await set("setTextSkewX", "(F)V", 0);
  const box = await newObj("android/graphics/Rect", "()V") as object, fmi = await newObj("android/graphics/Paint$FontMetricsInt", "()V");
  const textBounds = async (text: string) => { await vcall(paint, "getTextBounds", "(Ljava/lang/String;IILandroid/graphics/Rect;)V", text, 0, text.length, box); return ltrb(box).join(" "); };
  await vcall(paint, "getFontMetricsInt", "(Ljava/lang/CharSequence;IIIIZLandroid/graphics/Paint$FontMetricsInt;)V", "日本語", 0, 3, 0, 3, 0, fmi);
  tokens("text bounds and metrics", [await textBounds("Agj office"), await textBounds("日本語"), await vcall(paint, "measureText", "(Ljava/lang/String;)F", "日本語"),
    await vcall(fmi, "toString", "()Ljava/lang/String;")].join(" | "),
    "0 -31 166 9 | 7 -34 119 4 | 120 | FontMetricsInt: top=-47 ascent=-46 descent=12 bottom=12 leading=0", ulp);
});

// getTextWidths of printable ASCII in the default family across weights and sizes, hinting on and
// off, as `pnpm gen-framework --only textLayout` printed them on the reference AVD
await exercise("Paint.getTextWidths across weights and hinting (device values)", async () => {
  await loadSystemFonts();
  const ascii = Array.from({ length: 0x5e }, (_, i) => String.fromCharCode(0x21 + i)).join(""), T = "Landroid/graphics/Typeface;";
  const DEFAULT = await scall("android/graphics/Typeface", "defaultFromStyle", `(I)${T}`, 0);
  const rows = readFileSync("tests/fixtures/textwidths-device.txt", "utf8").trim().split("\n").map((l) => l.split(" "));
  const bad: string[] = [];
  for (const [, weight, size, hinting, ...want] of rows) {
    const paint = await newObj("android/graphics/Paint", "(I)V", 1);
    await vcall(paint, "setTypeface", `(${T})${T}`, await scall("android/graphics/Typeface", "create", `(${T}IZ)${T}`, DEFAULT, +weight, 0));
    await vcall(paint, "setTextSize", "(F)V", Math.fround(+size));
    await vcall(paint, "setHinting", "(I)V", +hinting);
    const widths = new Float32Array(ascii.length);
    await vcall(paint, "getTextWidths", "(Ljava/lang/String;[F)I", ascii, widths);
    widths.forEach((w, i) => { if (w !== Math.fround(+want[i])) bad.push(`${weight}/${size}/${hinting} '${ascii[i]}' ${w} device ${want[i]}`); });
  }
  if (process.env.FWTEST_WIDTHS) console.log(bad.join("\n"));
  if (bad.length) throw new Error(`${bad.length} of ${rows.length * ascii.length}: ${bad.slice(0, 6).join(", ")}`);
});
