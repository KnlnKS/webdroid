import { expect, test } from "bun:test";
import "../src/natives";
import { fillFontMetrics, mkTypeface, setFamilyMetrics } from "../src/android/graphics";
import { JTextView } from "../src/android/textview";

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
