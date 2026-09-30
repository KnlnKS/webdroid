import { expect, test, describe, beforeAll } from "bun:test";
import { loadLibcore, loadSystemFonts, fakeStyles, scall } from "./java";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { JLayout, JSpannable, JTextPaint, JSpanned } from "../src/android/text";
import { fillFontMetrics, measureText } from "../src/android/graphics";
import { JTheme, obtainStyled, rvString } from "../src/android/res";
import { TV } from "../src/android/axml";
import { JTextView, JEditText } from "../src/android/textview";
import { perf } from "../src/perf";

beforeAll(loadSystemFonts);

describe("linkify", () => {
  rt.linkNatives();

  test("Linkify adds URL spans and replaces stale links", async () => {
    const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "Visit example.com or mail user@example.com");
    const linkify = rt.link("android/text/util/Linkify").ctor;
    expect(await vcall(linkify, "addLinks", "(Landroid/text/Spannable;I)Z", text, 3)).toBe(1);
    const spans = await vcall(text, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, 43, rt.classFor("android/text/style/URLSpan"));
    expect(await Promise.all(spans.map((span: unknown) => vcall(span, "getURL", "()Ljava/lang/String;")))).toEqual(["http://example.com", "mailto:user@example.com"]);
    expect(await vcall(linkify, "addLinks", "(Landroid/text/Spannable;I)Z", text, 3)).toBe(1);
    const replaced = await vcall(text, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, 43, rt.classFor("android/text/style/URLSpan"));
    expect(replaced).toHaveLength(2);
  });
});

describe("span queries", () => {
  rt.linkNatives();

  test("getSpans reports empty spans at the query edges and nextSpanTransition stops at span edges", async () => {
    const text = await newObj("android/text/SpannableStringBuilder");
    const mark = await newObj("java/lang/Object"), point = await newObj("java/lang/Object"), style = await newObj("android/text/style/UnderlineSpan");
    await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", mark, 0, 0, 17);
    await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", point, 0, 0, 34);
    await vcall(text, "append", "(Ljava/lang/CharSequence;)Landroid/text/SpannableStringBuilder;", "abcd");
    await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", style, 1, 3, 33);
    const spans = (a: number, b: number) => vcall(text, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", a, b, rt.classFor("java/lang/Object"));
    expect(await spans(0, 4)).toEqual([mark, point, style]);
    expect(await spans(3, 4)).toEqual([point]);
    expect(await spans(3, 3)).toEqual([style]);
    const next = (a: number, b: number, cls: string) => vcall(text, "nextSpanTransition", "(IILjava/lang/Class;)I", a, b, rt.classFor(cls));
    expect([await next(0, 4, "java/lang/Object"), await next(1, 4, "android/text/style/UnderlineSpan"), await next(3, 4, "java/lang/Object")]).toEqual([1, 3, 4]);
  });
});

describe("locale-span", () => {
  rt.linkNatives();
  test("LocaleSpan retains locale order through paint copies and parcel round trips", async () => {
    await loadLibcore();
    const locales = await vcall(rt.link("android/os/LocaleList").ctor, "forLanguageTags", "(Ljava/lang/String;)Landroid/os/LocaleList;", "ja-JP,en-US");
    const span = await newObj("android/text/style/LocaleSpan", "(Landroid/os/LocaleList;)V", locales);
    expect(rt.iof(span, "android/text/style/MetricAffectingSpan")).toBe(1);
    const paint = await newObj("android/text/TextPaint");
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
    expect(await vcall(copy, "getTextLocales", "()Landroid/os/LocaleList;")).toBe(locales);
    expect(copy.language).toBe("ja-JP");
    const parcel = await newObj("android/os/Parcel");
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
  rt.linkNatives();

  test("paragraph spans use general layout and run before font padding", async () => {
    const paint = new JTextPaint(); paint.textSize = 48;
    const metrics = { top: 0, ascent: 0, descent: 0, bottom: 0, leading: 0, width: 0 };
    fillFontMetrics(paint, metrics, true);
    for (const pad of [false, true]) {
      const boring = await newObj("android/text/BoringLayout", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;Z)V",
        "", paint, 500, null, 1, 0, metrics, +pad);
      expect([await vcall(boring, "getHeight", "()I"), await vcall(boring, "getLineBaseline", "(I)I", 0)]).toEqual(pad ? [65, 51] : [57, 45]);
      for (const density of [false, true]) {
        const span = rt.make("android/text/style/LineHeightSpan" + (density ? "$WithDensity" : ""));
        const signature = "(Ljava/lang/CharSequence;IIIILandroid/graphics/Paint$FontMetricsInt;" + (density ? "Landroid/text/TextPaint;" : "") + ")V";
        Object.assign(span, { [mangleMethod("chooseHeight", signature)]:
          (_text: unknown, _start: number, _end: number, _spanY: number, _y: number, fm: typeof metrics, suppliedPaint?: JTextPaint) => {
            expect([fm.ascent, fm.descent]).toEqual([-45, 12]);
            if (density) expect(suppliedPaint).toBe(paint);
            fm.descent += Math.ceil((72 - (fm.descent - fm.ascent)) / 2);
            fm.ascent = fm.descent - 72;
          },
        });
        const text = new JSpannable(); text.text = "Afghanistan";
        text.spans.push({ span, start: 0, end: 11, flags: 18 });
        expect(await vcall(rt.link("android/text/BoringLayout").ctor, "isBoring", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)Landroid/text/BoringLayout$Metrics;", text, paint)).toBeNull();
        const layout = new JLayout(); layout.paint = paint; layout.src = text; layout.includePad = pad;
        await layout.lineUp(() => [{ start: 0, end: 11, text: text.text, width: 260 }]);
        expect([layout.lineTop(1), layout.baseline(0), -layout.padTop, layout.padBottom]).toEqual(pad ? [65, 51, 1, -6] : [72, 52, -0, 0]);
      }
    }
  });

  test("metric-affecting runs size lines, widths and replacements like the desired width", async () => {
    // a measuring context without a browser: each character half its font size wide
    if (typeof OffscreenCanvas === "undefined") Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: class {
      getContext() { return { font: "", measureText(this: { font: string }, s: string) { return { width: s.length * parseFloat(/([\d.]+)px/.exec(this.font)![1]) / 2 }; } }; }
    } });
    const paint = new JTextPaint(); paint.textSize = 14;
    const big = new JTextPaint(); big.textSize = 48;
    const [fm, bigFm] = [paint, big].map((p) => { const m = { top: 0, ascent: 0, descent: 0, bottom: 0, leading: 0 }; fillFontMetrics(p, m, true); return m; });
    const text = new JSpannable(); text.text = "Now $12 each";
    const replacement = rt.make("android/text/style/ReplacementSpan");
    let sizedWith = 0;
    Object.assign(replacement, {
      [mangleMethod("getSize", "(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I")]: (p: JTextPaint) => { sizedWith = p.textSize; return 30; },
    });
    text.spans.push({ span: await newObj("android/text/style/AbsoluteSizeSpan", "(I)V", 48), start: 4, end: 7, flags: 33 });
    text.spans.push({ span: replacement, start: 5, end: 6, flags: 33 });
    const layout = await newObj("android/text/StaticLayout", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFZ)V", text, paint, 1000, null, 1, 0, 1);
    expect(sizedWith).toBe(48);
    expect(await vcall(layout, "getHeight", "()I")).toBe(bigFm.bottom - bigFm.top);
    expect(await vcall(layout, "getLineBaseline", "(I)I", 0)).toBe(-bigFm.top);
    const width = measureText(paint, "Now ") + measureText(big, "$") + 30 + measureText(big, "2") + measureText(paint, " each");
    expect(await vcall(layout, "getLineWidth", "(I)F", 0)).toBeCloseTo(width, 3);
    expect(await vcall(rt.link("android/text/Layout").ctor, "getDesiredWidth", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F", text, paint)).toBeCloseTo(width, 3);
    expect(fm.bottom - fm.top).toBeLessThan(bigFm.bottom - bigFm.top);
  });

  test("style spans preserve existing italics for drawing and measurement", async () => {
    const typeface = rt.link("android/graphics/Typeface").ctor;
    const italic = await vcall(typeface, "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "serif", 2);
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

describe("reached-text-api", () => {
  rt.linkNatives();

  function heuristic(name: string): unknown {
    return Object.getOwnPropertyDescriptor(
      rt.link("android/text/TextDirectionHeuristics").ctor,
      mangleStaticField(name),
    )?.value;
  }

  test("TextPaint exposes and copies custom underline state", async () => {
    const source = await newObj("android/text/TextPaint");
    const target = await newObj("android/text/TextPaint");
    expect(source).toBeInstanceOf(JTextPaint);
    expect(target).toBeInstanceOf(JTextPaint);
    if (!(source instanceof JTextPaint) || !(target instanceof JTextPaint)) return;
    expect(source.underlineColor).toBe(0);
    expect(source.underlineThickness).toBe(0);
    const color = 0xff123456 | 0;
    source.underlineColor = color;
    source.underlineThickness = 2.5;
    await vcall(target, "set", "(Landroid/text/TextPaint;)V", source);
    expect(target.underlineColor).toBe(color);
    expect(target.underlineThickness).toBe(2.5);
  });

  test("text direction heuristics inspect the requested range", async () => {
    const firstLtr = heuristic("FIRSTSTRONG_LTR");
    const firstRtl = heuristic("FIRSTSTRONG_RTL");
    const anyRtl = heuristic("ANYRTL_LTR");
    expect(await vcall(firstLtr, "isRtl", "(Ljava/lang/CharSequence;II)Z", "  אב", 0, 4)).toBe(1);
    expect(await vcall(firstLtr, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc אב", 0, 6)).toBe(0);
    expect(await vcall(firstRtl, "isRtl", "(Ljava/lang/CharSequence;II)Z", "123", 0, 3)).toBe(1);
    expect(await vcall(anyRtl, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc אב", 0, 6)).toBe(1);
    expect(await vcall(anyRtl, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc אב", 0, 3)).toBe(0);
    await expect(vcallAsync(firstLtr, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc", 2, 2)).rejects.toBeDefined();
  });
});

describe("spannable-valueof", () => {
  class Watcher extends JObj { removed: unknown[] = []; }
  rt.register({ name: "test/SpanWatcher", ctor: Watcher, ifaces: ["android/text/SpanWatcher"], methods: {
    "onSpanRemoved(Landroid/text/Spannable;Ljava/lang/Object;II)V": async function (this: Watcher, text: JSpanned, span: unknown) {
      await Promise.resolve();
      expect(text.spans.some(s => s.span === span)).toBe(false);
      this.removed.push(span);
    },
  } });

  rt.linkNatives();
  test("clearSpans preserves characters and notifies remaining watchers after removal", async () => {
    const builder = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", "abc");
    const watcher = rt.make("test/SpanWatcher") as Watcher, span = new JObj();
    await vcall(builder, "setSpan", "(Ljava/lang/Object;III)V", watcher, 0, 3, 33);
    await vcall(builder, "setSpan", "(Ljava/lang/Object;III)V", span, 3, 3, 34);
    await vcall(builder, "clearSpans", "()V");
    expect(watcher.removed).toEqual([span]);
    expect(await vcall(builder, "getSpanStart", "(Ljava/lang/Object;)I", watcher)).toBe(-1);
    expect(await vcall(builder, "toString", "()Ljava/lang/String;")).toBe("abc");
  });
  test("SpannableString.valueOf keeps string identity and copies mutable builders with spans", async () => {
    const builder = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", "abc");
    const span = new JObj();
    await vcall(builder, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 2, 33);
    const value = await vcall(rt.link("android/text/SpannableString").ctor, "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannableString;", builder);
    expect(value).not.toBe(builder);
    expect(await vcall(rt.link("android/text/SpannableString").ctor, "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannableString;", value)).toBe(value);
    await vcall(builder, "clear", "()V");
    expect(await vcall(value, "toString", "()Ljava/lang/String;")).toBe("abc");
    expect(await vcall(value, "getSpanEnd", "(Ljava/lang/Object;)I", span)).toBe(2);
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
  rt.linkNatives();

  test("StringBuilder appends a CharSequence range through charAt", async () => {
    const builder = await newObj("java/lang/StringBuilder", "()V");
    const sequence = await newObj("test/RangeSequence", "()V");
    await vcall(builder, "append", "(Ljava/lang/CharSequence;II)Ljava/lang/StringBuilder;", sequence, 1, 5);
    expect(await vcall(builder, "toString", "()Ljava/lang/String;")).toBe("bcab");
  });

  test("appending styled text retains span identity and offsets without coloring the following text", async () => {
    const word = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "Games");
    const color = await newObj("android/text/style/ForegroundColorSpan", "(I)V", -1);
    await vcall(word, "setSpan", "(Ljava/lang/Object;III)V", color, 0, 5, 33);
    const line = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", "Play ");
    await vcall(line, "append", "(Ljava/lang/CharSequence;)Landroid/text/SpannableStringBuilder;", word);
    await vcall(line, "append", "(Ljava/lang/CharSequence;)Landroid/text/SpannableStringBuilder;", " together");
    expect(await vcall(line, "toString", "()Ljava/lang/String;")).toBe("Play Games together");
    expect(await vcall(line, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, 19, rt.classFor("android/text/style/ForegroundColorSpan"))).toEqual(Object.assign([color], {$t:"Landroid/text/style/ForegroundColorSpan;"}));
    expect(await vcall(line, "getSpanStart", "(Ljava/lang/Object;)I", color)).toBe(5);
    expect(await vcall(line, "getSpanEnd", "(Ljava/lang/Object;)I", color)).toBe(10);
    expect(await vcall(word, "getSpanStart", "(Ljava/lang/Object;)I", color)).toBe(0);
  });
});

describe("style-wrap", () => {
  rt.linkNatives();
  test("style wrappers remain distinct while forwarding draw and measure state", async () => {
    const wrap = (style: unknown) => vcall(rt.link("android/text/style/CharacterStyle").ctor, "wrap", "(Landroid/text/style/CharacterStyle;)Landroid/text/style/CharacterStyle;", style);
    const style = await newObj("android/text/style/AbsoluteSizeSpan", "(I)V", 23);
    const first = await wrap(style), second = await wrap(first);
    expect(second).not.toBe(first);
    expect(rt.iof(second, "android/text/style/MetricAffectingSpan")).toBe(1);
    expect(await vcall(second, "getUnderlying", "()Landroid/text/style/CharacterStyle;")).toBe(style);
    expect(await vcall(second, "getUnderlying", "()Landroid/text/style/MetricAffectingSpan;")).toBe(style);
    const paint = rt.make("android/text/TextPaint") as JTextPaint;
    await vcall(second, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(paint.textSize).toBe(23);
    const color = await newObj("android/text/style/ForegroundColorSpan", "(I)V", -65536);
    const colorWrapper = await wrap(color);
    expect(rt.iof(colorWrapper, "android/text/style/MetricAffectingSpan")).toBe(0);
    await vcall(colorWrapper, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    expect(paint.color).toBe(-65536);
  });
});

describe("styled-null", () => {
  rt.linkNatives();
  test("explicit style arrays mask null font values", async () => {
    const S = 0x7f0f0000, A = 0x7f010001;
    const res = await fakeStyles(["fallback", "custom-family"], {
      [S]: [[A, TV.STRING, 0], [A + 3, TV.REFERENCE, 0]],
      [S + 1]: [[A, TV.REFERENCE, 0], [A + 1, TV.STRING, 1], [A + 2, TV.ATTRIBUTE, A + 3]],
    }), theme = new JTheme();
    theme.res = res; theme.apply(S);
    const { vals } = obtainStyled(res, theme, null, new Int32Array([A, A + 1, A + 2]), 0, S + 1);
    expect(vals[0]).toBeNull();
    expect(vals[2]).toBeNull();
    expect(rvString(res, vals[1])).toBe("custom-family");
  });
});

describe("text-appearance-span", () => {
  test("text appearances combine font style and apply state colors after virtual measurement", async () => {
    rt.linkNatives();
    const valueOf = (c: number) => scall("android/content/res/ColorStateList", "valueOf", "(I)Landroid/content/res/ColorStateList;", c | 0);
    const color = await valueOf(0xff123456), link = await valueOf(0xffabcdef);
    const span = await newObj("android/text/style/TextAppearanceSpan", "(Ljava/lang/String;IILandroid/content/res/ColorStateList;Landroid/content/res/ColorStateList;)V", null, 1, 28, color, link);
    const paint = new JTextPaint(); paint.tf = await scall("android/graphics/Typeface", "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "serif", 2);
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(await vcall(paint.tf, "getStyle", "()I")).toBe(3);
    expect(paint.textSize).toBe(28);
    expect(paint.color).not.toBe(0xff123456 | 0);
    let calls = 0;
    Object.assign(span, { [mangleMethod("updateMeasureState", "(Landroid/text/TextPaint;)V")]: async (p: JTextPaint) => {
      await Promise.resolve(); calls++; p.textSize = 36;
    } });
    await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    expect(calls).toBe(1);
    expect(paint.textSize).toBe(36);
    expect(paint.color).toBe(0xff123456 | 0);
    expect(paint.linkColor).toBe(0xffabcdef | 0);
    expect(await vcall(span, "getTextColor", "()Landroid/content/res/ColorStateList;")).toBe(color);
    expect(rt.iof(span, "android/text/style/MetricAffectingSpan")).toBe(1);
  });


  test("SuperscriptSpan shifts the existing baseline using virtual ascent without resizing text", async () => {
    rt.linkNatives();
    const span = await newObj("android/text/style/SuperscriptSpan", "()V");
    const paint = new JTextPaint(); paint.baselineShift = 3; paint.textSize = 24;
    Object.assign(paint, { [mangleMethod("ascent", "()F")]: async () => { await Promise.resolve(); return -15; } });
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(paint.baselineShift).toBe(-4);
    await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    expect(paint.baselineShift).toBe(-11);
    expect(paint.textSize).toBe(24);
    expect(await vcall(span, "getSpanTypeId", "()I")).toBe(14);
    expect(rt.iof(span, "android/text/style/MetricAffectingSpan")).toBe(1);
  });
});

describe("text-platform", () => {
  rt.linkNatives();

  test("TypefaceSpan retains and applies a supplied typeface", async () => {
    const typeface = await scall("android/graphics/Typeface", "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "monospace", 1);
    const span = await newObj("android/text/style/TypefaceSpan", "(Landroid/graphics/Typeface;)V", typeface);
    expect(await vcall(span, "getTypeface", "()Landroid/graphics/Typeface;")).toBe(typeface);
    expect(await vcall(span, "getFamily", "()Ljava/lang/String;")).toBeNull();

    const paint = new JTextPaint();
    await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    expect(paint.tf).toBe(typeface);
  });


  test("storage stats resolves by class to its named service", async () => {
    const context = await newObj("android/content/Context");
    const cls = rt.classFor("android/app/usage/StorageStatsManager");
    expect(await vcall(context, "getSystemServiceName", "(Ljava/lang/Class;)Ljava/lang/String;", cls)).toBe("storagestats");
    const manager = await vcall(context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "storagestats");
    expect(manager).not.toBeNull();
    expect(await vcall(context, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", cls)).toBe(manager);
  });
});

describe("textview-link-color", () => {
  test("TextView retains link color lists and updates its paint across state changes without layout", async () => {
    rt.linkNatives();
    const view = rt.make("android/widget/TextView");
    if (!(view instanceof JTextView)) throw new Error("Invalid TextView");
    const colors = await newObj("android/content/res/ColorStateList", "([[I[I)V",
      [Int32Array.of(16842919), new Int32Array(0)], Int32Array.of(0xff123456, 0xffabcdef));
    const layouts = perf.layoutRequests;
    await vcall(view, "setLinkTextColor", "(Landroid/content/res/ColorStateList;)V", colors);
    expect(await vcall(view, "getLinkTextColors", "()Landroid/content/res/ColorStateList;")).toBe(colors);
    expect(view.paintT.linkColor).toBe(0xffabcdef | 0);
    view.pressed = true;
    await view.refreshDrawableState();
    expect(view.paintT.linkColor).toBe(0xff123456 | 0);
    await vcall(view, "setLinkTextColor", "(I)V", 0xff112233 | 0);
    expect(view.paintT.linkColor).toBe(0xff112233 | 0);
    await vcall(view, "setLinkTextColor", "(Landroid/content/res/ColorStateList;)V", null);
    expect(await vcall(view, "getLinkTextColors", "()Landroid/content/res/ColorStateList;")).toBeNull();
    expect(view.paintT.linkColor).toBe(0xff112233 | 0);
    expect(perf.layoutRequests).toBe(layouts);
    const span = await newObj("android/text/style/URLSpan", "(Ljava/lang/String;)V", "https://example.com");
    await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", view.paintT);
    expect(view.paintT.color).toBe(view.paintT.linkColor);
    expect(view.paintT.underline).toBe(true);
  });
});

describe("tts-span", () => {
  rt.linkNatives();

  test("TtsSpan builders preserve pronunciation arguments and parcel values", async () => {
    for (const name of ["Text", "Verbatim"]) {
      const builder = await newObj(`android/text/style/TtsSpan$${name}Builder`, "(Ljava/lang/String;)V", "Golden Gate Bridge");
      const span = await vcall(builder, "build", "()Landroid/text/style/TtsSpan;");
      expect(await vcall(span, "getType", "()Ljava/lang/String;")).toBe("android.type." + name.toLowerCase());
      const args = await vcall(span, "getArgs", "()Landroid/os/PersistableBundle;");
      expect(await vcall(args, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "android.arg." + name.toLowerCase())).toBe("Golden Gate Bridge");
      const parcel = await vcall(rt.link("android/os/Parcel").ctor, "obtain", "()Landroid/os/Parcel;");
      await vcall(span, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
      await vcall(parcel, "setDataPosition", "(I)V", 0);
      const copy = await newObj("android/text/style/TtsSpan", "(Landroid/os/Parcel;)V", parcel);
      const copyArgs = await vcall(copy, "getArgs", "()Landroid/os/PersistableBundle;");
      expect(await vcall(copyArgs, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "android.arg." + name.toLowerCase())).toBe("Golden Gate Bridge");
      await vcall(parcel, "recycle", "()V");
    }
  });
});

describe("editable-factory", () => {
  rt.linkNatives();
  test("newEditable copies span records", async () => {
    const source = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "hello");
    const span = new JObj();
    await vcall(source, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 2, 33);
    const factory = await vcall(rt.link("android/text/Editable$Factory").ctor, "getInstance", "()Landroid/text/Editable$Factory;");
    const editable = await vcall(factory, "newEditable", "(Ljava/lang/CharSequence;)Landroid/text/Editable;", source);
    await vcall(editable, "setSpan", "(Ljava/lang/Object;III)V", span, 1, 4, 33);
    expect(await vcall(source, "getSpanEnd", "(Ljava/lang/Object;)I", span)).toBe(2);
  });
});

describe("length-filter", () => {
  rt.linkNatives();
  test("an EditText's filters bound setText and edits through its Editable", async () => {
    const field = new JEditText();
    await vcall(field, "setFilters", "([Landroid/text/InputFilter;)V", [await newObj("android/text/InputFilter$LengthFilter", "(I)V", 4)]);
    await vcall(field, "setText", "(Ljava/lang/CharSequence;)V", "abcdef");
    expect(field.text).toBe("abcd");
    const editable = await vcall(field, "getText", "()Landroid/text/Editable;");
    await vcall(editable, "delete", "(II)Landroid/text/Editable;", 0, 2);
    await vcall(editable, "append", "(Ljava/lang/CharSequence;)Landroid/text/Editable;", "xyz");
    expect(field.text).toBe("cdxy");
  });
});
