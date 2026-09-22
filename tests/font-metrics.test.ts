import { expect, test } from "bun:test";
import "../src/natives";
import { fillFontMetrics, JPaint, mkTypeface, setFamilyMetrics } from "../src/android/graphics";
import { vcall } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";
import { JTextView } from "../src/android/textview";

rt.linkNatives();

test("loaded font metrics preserve fractional ascenders and round padded bounds outward", () => {
  setFamilyMetrics("metrics-probe", { ascent: 966 / 975, descent: 204 / 975, top: 1129 / 975, bottom: 251 / 975 });
  const view = new JTextView();
  view.paintT.tf = mkTypeface("metrics-probe", true, false);
  view.paintT.textSize = 68;
  const metrics = { top: 0, ascent: 0, descent: 0, bottom: 0, leading: 0 };
  fillFontMetrics(view.paintT, metrics, false);
  expect(metrics.ascent).toBeCloseTo(-67.37231, 4);
  fillFontMetrics(view.paintT, metrics, true);
  expect(metrics).toEqual({ top: -79, ascent: -67, descent: 14, bottom: 18, leading: 0 });
  expect(view.textHeight(1)).toBe(97);
  expect(view.textHeight(3)).toBe(259);
  view.includePad = false;
  expect(view.textHeight(3)).toBe(243);
});

test("Paint selects the nearest system face without promoting every bold style to 700", () => {
  const paint = new JPaint(); paint.textSize = 18;
  for (const weight of [500, 600]) {
    paint.tf = mkTypeface("Roboto, sans-serif", weight >= 600, false, weight);
    expect(paint.font()).toBe("500 18px Roboto Medium, Noto Emoji, Noto Emoji Flags, sans-serif");
  }
  paint.tf = mkTypeface("custom-family", true, false, 900);
  expect(paint.font()).toBe("900 18px custom-family, Noto Emoji, Noto Emoji Flags, sans-serif");
  paint.tf = mkTypeface("Roboto, sans-serif", false, false, 400);
  paint.fakeBold = true;
  expect(paint.font()).toBe("700 18px Roboto, Noto Emoji, Noto Emoji Flags, sans-serif");
});

test("system Paint metrics retain Android fractions before integer rounding", async () => {
  const paint = new JPaint(); paint.textSize = 48;
  const metrics = { top: 0, ascent: 0, descent: 0, bottom: 0, leading: 0 };
  expect(fillFontMetrics(paint, metrics, false)).toBe(56.25);
  expect(metrics).toEqual({ top: -50.6953125, ascent: -44.53125, descent: 11.71875, bottom: 13.0078125, leading: 0 });
  expect(await vcall(paint, "getFontSpacing", "()F")).toBe(56.25);
  expect(fillFontMetrics(paint, metrics, true)).toBe(57);
  expect(metrics).toEqual({ top: -51, ascent: -45, descent: 12, bottom: 14, leading: 0 });
});
