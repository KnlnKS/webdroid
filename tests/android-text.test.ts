import { expect, test, describe, beforeAll } from "bun:test";
import { loadLibcore, loadSystemFonts, fakeStyles, scall } from "./java.ts";
import "../src/natives.ts";
import { rt, JObj, declaredField } from "../src/jvm/runtime.ts";
import { newObj, vcall, vcallAsync, iof } from "../src/jvm/natives/jentry.ts";
import { newPaint, paintOf } from "../src/android/paint.ts";
import { NativeTheme, resolveAttributes, STYLE_NUM_ENTRIES } from "../src/android/res.ts";
import { TV } from "../src/android/axml.ts";
import type { TextStyle } from "../src/android/minikin.ts";
import { withFonts } from "../src/android/fonts.ts";

beforeAll(loadSystemFonts);
/** a TextPaint's public field */
const textPaintField = (p: object, name: string) => (p as Record<string, number>)[declaredField("android/text/TextPaint", name)];

describe("locale-span", () => {
  test("LocaleSpan retains locale order through paint copies and parcel round trips", async () => {
    await loadLibcore();
    const locales = await scall("android/os/LocaleList", "forLanguageTags", "(Ljava/lang/String;)Landroid/os/LocaleList;", "ja-JP,en-US");
    const span = await newObj("android/text/style/LocaleSpan", "(Landroid/os/LocaleList;)V", locales);
    expect(iof(span, "android/text/style/MetricAffectingSpan")).toBe(true);
    const paint = await newObj("android/text/TextPaint");
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
    expect(await vcall(copy, "getTextLocales", "()Landroid/os/LocaleList;")).toBe(locales);
    expect(paintOf(copy).language).toBe("ja-JP");
    const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(span, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await newObj("android/text/style/LocaleSpan", "(Landroid/os/Parcel;)V", parcel);
    const list = await vcall(restored, "getLocales", "()Landroid/os/LocaleList;");
    expect(await vcall(list, "toLanguageTags", "()Ljava/lang/String;")).toBe("ja-JP,en-US");
    expect(await vcall(restored, "getSpanTypeId", "()I")).toBe(23);
    const empty = await newObj("android/text/style/LocaleSpan", "(Ljava/util/Locale;)V", null);
    expect(await vcall(empty, "getLocale", "()Ljava/util/Locale;")).toBeNull();
    await expect(vcallAsync(empty, "updateDrawState", "(Landroid/text/TextPaint;)V", paint)).rejects.toMatchObject({ msg: "locales cannot be null or empty" });
  });
});

describe("metric-spans", () => {

  test("style spans preserve existing italics for drawing and measurement", async () => {
    const italic = await scall("android/graphics/Typeface", "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "serif", 2);
    const span = await newObj("android/text/style/StyleSpan", "(I)V", 1);
    for (const method of ["updateDrawState", "updateMeasureState"]) {
      const paint = await newObj("android/text/TextPaint", "()V");
      await vcall(paint, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", italic);
      await vcall(span, method, "(Landroid/text/TextPaint;)V", paint);
      const face = await vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;");
      expect(await vcall(face, "getStyle", "()I")).toBe(3);
      expect(await vcall(face, "getWeight", "()I")).toBe(700);
    }
    expect(await vcall(italic, "getStyle", "()I")).toBe(2);
  });

  test("style span weight adjustment clamps to Android's supported range", async () => {
    for (const [adjustment, weight] of [[900, 1000], [-900, 1]]) {
      const paint = await newObj("android/text/TextPaint", "()V");
      const span = await newObj("android/text/style/StyleSpan", "(II)V", 1, adjustment);
      await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
      const face = await vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;");
      expect(await vcall(face, "getWeight", "()I")).toBe(weight);
    }
  });

  test("relative size spans multiply the current size for drawing and measurement", async () => {
    const span = await newObj("android/text/style/RelativeSizeSpan", "(F)V", 1.5);
    expect(await vcall(span, "getSizeChange", "()F")).toBe(1.5);
    for (const method of ["updateDrawState", "updateMeasureState"]) {
      const paint = await newObj("android/text/TextPaint", "()V");
      await vcall(paint, "setTextSize", "(F)V", 20);
      await vcall(span, method, "(Landroid/text/TextPaint;)V", paint);
      expect(await vcall(paint, "getTextSize", "()F")).toBe(30);
    }
  });
});

describe("spanned-append", () => {
  class RangeSequence extends JObj {}
  rt.register({ name: "test/RangeSequence", ctor: RangeSequence, ifaces: ["java/lang/CharSequence"], methods: {
    "<init>()V": () => {},
    "length()I": () => 6,
    "charAt(I)C": (index: number) => "abcabc".charCodeAt(index),
    "toString()Ljava/lang/String;": () => { throw new Error("range append must not stringify the whole sequence"); },
  } });

  test("StringBuilder appends a CharSequence range through charAt", async () => {
    const builder = await newObj("java/lang/StringBuilder", "()V");
    const sequence = await newObj("test/RangeSequence", "()V");
    await vcall(builder, "append", "(Ljava/lang/CharSequence;II)Ljava/lang/StringBuilder;", sequence, 1, 5);
    expect(await vcall(builder, "toString", "()Ljava/lang/String;")).toBe("bcab");
  });
});

describe("style-wrap", () => {
  test("style wrappers remain distinct while forwarding draw and measure state", async () => {
    const wrap = (style: unknown) => scall("android/text/style/CharacterStyle", "wrap", "(Landroid/text/style/CharacterStyle;)Landroid/text/style/CharacterStyle;", style);
    const style = await newObj("android/text/style/AbsoluteSizeSpan", "(I)V", 23);
    const first = await wrap(style), second = await wrap(first);
    expect(second).not.toBe(first);
    expect(iof(second, "android/text/style/MetricAffectingSpan")).toBe(true);
    expect(await vcall(second, "getUnderlying", "()Landroid/text/style/CharacterStyle;")).toBe(style);
    expect(await vcall(second, "getUnderlying", "()Landroid/text/style/MetricAffectingSpan;")).toBe(style);
    const paint = await newPaint("android/text/TextPaint");
    await vcall(second, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(paintOf(paint).textSize).toBe(23);
    const color = await newObj("android/text/style/ForegroundColorSpan", "(I)V", -65536);
    const colorWrapper = await wrap(color);
    expect(iof(colorWrapper, "android/text/style/MetricAffectingSpan")).toBe(false);
    await vcall(colorWrapper, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    expect(await vcall(paint, "getColor", "()I")).toBe(-65536);
  });
});

describe("styled-null", () => {
  test("explicit style arrays mask null font values", async () => {
    const S = 0x7f0f0000, A = 0x7f010001;
    const res = await fakeStyles(["fallback", "custom-family"], {
      [S]: [[A, TV.STRING, 0], [A + 3, TV.REFERENCE, 0]],
      [S + 1]: [[A, TV.REFERENCE, 0], [A + 1, TV.STRING, 1], [A + 2, TV.ATTRIBUTE, A + 3]],
    }), theme = new NativeTheme(res);
    theme.apply(S);
    const out = new Int32Array(3 * STYLE_NUM_ENTRIES), indices = new Int32Array(4);
    resolveAttributes(res, theme, null, 0, 0, S + 1, new Int32Array([A, A + 1, A + 2]), null, out, indices);
    expect([out[0], out[2 * STYLE_NUM_ENTRIES]]).toEqual([TV.NULL, TV.NULL]);
    expect([out[STYLE_NUM_ENTRIES], out[STYLE_NUM_ENTRIES + 1]]).toEqual([TV.STRING, 1]);
    expect([...indices.subarray(0, 2)]).toEqual([1, 1]);
  });
});

describe("text-appearance-span", () => {
  test("text appearances combine font style and apply state colors", async () => {
    const valueOf = (c: number) => scall("android/content/res/ColorStateList", "valueOf", "(I)Landroid/content/res/ColorStateList;", c | 0);
    const color = await valueOf(0xff123456), link = await valueOf(0xffabcdef);
    const span = await newObj("android/text/style/TextAppearanceSpan", "(Ljava/lang/String;IILandroid/content/res/ColorStateList;Landroid/content/res/ColorStateList;)V", null, 1, 28, color, link);
    const paint = await newPaint("android/text/TextPaint");
    await vcall(paint, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", await scall("android/graphics/Typeface", "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "serif", 2));
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(await vcall(vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;"), "getStyle", "()I")).toBe(3);
    expect(paintOf(paint).textSize).toBe(28);
    expect(await vcall(paint, "getColor", "()I")).not.toBe(0xff123456 | 0);
    await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    expect(await vcall(paint, "getColor", "()I")).toBe(0xff123456 | 0);
    expect(textPaintField(paint, "linkColor")).toBe(0xffabcdef | 0);
    expect(await vcall(span, "getTextColor", "()Landroid/content/res/ColorStateList;")).toBe(color);
    expect(iof(span, "android/text/style/MetricAffectingSpan")).toBe(true);
  });


  test("SuperscriptSpan shifts the existing baseline by half the ascent without resizing text", async () => {
    const span = await newObj("android/text/style/SuperscriptSpan", "()V");
    const paint = await newPaint("android/text/TextPaint");
    (paint as unknown as Record<string, number>)[declaredField("android/text/TextPaint", "baselineShift")] = 3;
    paintOf(paint).textSize = 24;
    const half = Math.trunc(await vcall(paint, "ascent", "()F") / 2);
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(textPaintField(paint, "baselineShift")).toBe(3 + half);
    await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    expect(textPaintField(paint, "baselineShift")).toBe(3 + 2 * half);
    expect(paintOf(paint).textSize).toBe(24);
    expect(await vcall(span, "getSpanTypeId", "()I")).toBe(14);
    expect(iof(span, "android/text/style/MetricAffectingSpan")).toBe(true);
  });
});

describe("text-platform", () => {

  test("TypefaceSpan retains and applies a supplied typeface", async () => {
    const typeface = await scall("android/graphics/Typeface", "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "monospace", 1);
    const span = await newObj("android/text/style/TypefaceSpan", "(Landroid/graphics/Typeface;)V", typeface);
    expect(await vcall(span, "getTypeface", "()Landroid/graphics/Typeface;")).toBe(typeface);
    expect(await vcall(span, "getFamily", "()Ljava/lang/String;")).toBeNull();

    const paint = await newPaint("android/text/TextPaint");
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;")).toBe(typeface);
  });
});

describe("tts-span", () => {

  test("TtsSpan builders preserve pronunciation arguments and parcel values", async () => {
    for (const name of ["Text", "Verbatim"]) {
      const builder = await newObj(`android/text/style/TtsSpan$${name}Builder`, "(Ljava/lang/String;)V", "Golden Gate Bridge");
      const span = await vcall(builder, "build", "()Landroid/text/style/TtsSpan;");
      expect(await vcall(span, "getType", "()Ljava/lang/String;")).toBe("android.type." + name.toLowerCase());
      const args = await vcall(span, "getArgs", "()Landroid/os/PersistableBundle;");
      expect(await vcall(args, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "android.arg." + name.toLowerCase())).toBe("Golden Gate Bridge");
      const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
      await vcall(span, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
      await vcall(parcel, "setDataPosition", "(I)V", 0);
      const copy = await newObj("android/text/style/TtsSpan", "(Landroid/os/Parcel;)V", parcel);
      const copyArgs = await vcall(copy, "getArgs", "()Landroid/os/PersistableBundle;");
      expect(await vcall(copyArgs, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "android.arg." + name.toLowerCase())).toBe("Golden Gate Bridge");
      await vcall(parcel, "recycle", "()V");
    }
  });
});

describe("minikin", () => {
  test("hyphenation points are minikin's over the reference build's patterns", async () => {
    const { initHyphenators, hyphenatorFor, hyphenate } = await import("../src/android/hyphenator.ts");
    initHyphenators();
    const types = async (lang: string, word: string) =>
      Array.from(await rt.drive(function* () { return yield* hyphenate(word, yield* hyphenatorFor(lang)); }()) as Uint8Array);
    // minikin's HyphenatorTest, each case under the language the registry maps it to
    expect(await types("en-US", "table")).toEqual([0, 0, 1, 0, 0]);
    expect(await types("ml", "കകകകക")).toEqual([0, 0, 5, 5, 0]);
    expect(await types("ca", "ll·ll")).toEqual([0, 0, 0, 6, 0]);
    expect(await types("ca", "l·l")).toEqual([0, 0, 0]);
    expect(await types("pl", "x‐y")).toEqual([0, 0, 7]);
    expect(await types("pl", "α‐α")).toEqual([0, 0, 5]);
    expect(await types("pl", "x–y")).toEqual([0, 0, 5]);
    expect(await types("sl", "x‐y")).toEqual([0, 0, 7]);
    expect(await types("en-US", "x­y")).toEqual([0, 0, 1]);
    expect(await types("en-US", "­y")).toEqual([0, 0]);
    expect(await types("en-US", "ക­ക")).toEqual([0, 0, 5]);
    expect(await types("en-US", "ա­ա")).toEqual([0, 0, 2]);
    expect(await types("en-US", "ᐁ­ᐁ")).toEqual([0, 0, 4]);
    // HyphenatorMapTest: aliases, dropped subtags and script fallbacks
    const same = async (a: string, b: string) => expect(await rt.drive(hyphenatorFor(a))).toBe(await rt.drive(hyphenatorFor(b)));
    await same("en-AS", "en-US"); await same("en-Latn-US", "en-US"); await same("en-CA", "en-GB"); await same("de", "de-1996");
    await same("de-LI-1901", "de-CH-1901"); await same("no", "nb"); await same("ti", "und-Ethi"); await same("sa-Deva", "hi");
  });
  test("line breaking over the reference device's advances breaks where the device does", async () => {
    await loadLibcore();
    const { computeBreaks, LineWidth, TabStops } = await import("../src/android/minikin.ts");
    const rows = (await Bun.file(new URL("fixtures/textlayout-device.txt", import.meta.url)).text()).trim().split("\n");
    const cases = rows.filter((r) => r.startsWith("case ")).map((r) => {
      const [, text, width, size, , frequency] = r.split("\t");
      return { text: text.replace(/\\n/g, "\n").replace(/\\t/g, "\t"), width: +width, size: +size, hyphenated: !!+(frequency ?? 0) };
    });
    const advances = new Map(rows.filter((r) => r.startsWith("advances ")).map((r) => {
      const [, i, spacing, ...a] = r.split(" ");
      return [`${i} ${spacing}`, Float32Array.from(a, Number)];
    }));
    const mismatches: string[] = [];
    for (const row of rows.filter((r) => /^\d/.test(r))) {
      const [i, strategy, spacing, ...lines] = row.split(" "), { text, width, size, hyphenated } = cases[+i], adv = advances.get(`${i} ${spacing}`)!;
      if (hyphenated) continue; // hyphenation points are measured with their hyphens: textcmp compares these
      // line breaking reads only the size, scale and spacing of a run's style
      const style = { size, scaleX: 1, letterSpacing: +spacing * Math.fround(0.05) * size, wordSpacing: 0 } as TextStyle;
      const breaks: number[] = [];
      // StaticLayout breaks each paragraph, its newline included, on its own
      for (let start = 0; start < text.length;) {
        const end = text.indexOf("\n", start) + 1 || text.length, para = text.slice(start, end);
        const m = { text: para, widths: adv.slice(start, end), extents: new Float32Array(para.length * 2), runs: [{ start: 0, end: para.length, style, width: 0, lang: "en-US", lbStyle: 0, lbWordStyle: 0, hyphenate: false }], hyphenBreaks: [] };
        const b = { strategy: +strategy, frequency: 0, justified: false, indents: new Float32Array(0), useBounds: false };
        const result = await computeBreaks(b, m, para.length, new LineWidth(width, 1, width, b.indents, 0), new TabStops(null, 20));
        breaks.push(...result.breaks.map((o) => o + start));
        start = end;
      }
      const want = lines.map((l) => +l.split(":")[0]);
      if (breaks.join() !== want.join()) mismatches.push(`${i} ${strategy} ${spacing}: ${breaks} device ${want}`);
    }
    expect(mismatches).toEqual([]);
  });

  test("Paint's advances are the reference device's", async () => {
    await loadLibcore();
    const { styleOf, advances } = await import("../src/android/minikin.ts");
    const rows = (await Bun.file(new URL("fixtures/textlayout-device.txt", import.meta.url)).text()).trim().split("\n");
    const cases = rows.filter((r) => r.startsWith("case ")).map((r) => r.split("\t")).map(([, text, , size]) => ({ text: text.replace(/\\n/g, "\n").replace(/\\t/g, "\t"), size: +size }));
    const paint = await newPaint("android/text/TextPaint"), mismatches: string[] = [];
    for (const [, i, spacing, ...device] of rows.filter((r) => r.startsWith("advances ")).map((r) => r.split(" "))) {
      const { text, size } = cases[+i];
      await vcall(paint, "setTextSize", "(F)V", size);
      await vcall(paint, "setLetterSpacing", "(F)V", Math.fround(+spacing * 0.05));
      const out = new Float32Array(text.length);
      await withFonts(() => advances(styleOf(paintOf(paint)), text, 0, text.length, out));
      out.forEach((a, k) => { if (Math.abs(a - +device[k]) > 0.01) mismatches.push(`${i} ${spacing} @${k}: ${a} device ${device[k]}`); });
    }
    expect(mismatches).toEqual([]);
  });
});
