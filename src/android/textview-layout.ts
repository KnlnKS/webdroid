import { JSpanned, JSpannable, JStaticLayout, type JLayout, type TLine, measureReplacements, drawLayout } from "./text";
import { beginPaintShadow, cssColor, measureText, tfDefault, tryDrawBitmapText, type JCanvas } from "./graphics";
import { ligatureBoundary } from "./text-shaping";
import { after, callOn, curThread } from "../jvm/natives/jlang";
import { perf } from "../perf";
import type { JTextView } from "./textview";

function uppercase(source: string | JSpanned): string | JSpanned {
  if (typeof source === "string") return source.toUpperCase();
  const result = new JSpannable(), offsets = new Uint32Array(source.text.length + 1);
  let at = 0;
  for (const char of source.text) {
    offsets[at] = result.text.length;
    if (char.length === 2) offsets[at + 1] = result.text.length + 1;
    result.text += char.toUpperCase(); at += char.length;
  }
  offsets[at] = result.text.length;
  result.spans = source.spans.map(s => ({ ...s, start: offsets[s.start], end: offsets[s.end] }));
  return result;
}

type PreparedText = Pick<JLayout, "text" | "replacements"> & { src: string | JSpanned };
/** Cache offered and final widths while sharing span measurements. */
export class TextViewLayouts {
  private source: string | JSpanned | null = null;
  private font = ""; private ls = NaN; private caps = false;
  private prepared: PreparedText | null = null;
  private max = NaN; private single = false; private ell = false;
  private mult = NaN; private extra = NaN; private pad = true;
  private layouts: JLayout[] = [];
  get(tv: JTextView, source: string | JSpanned, width: number): JLayout | Promise<JLayout> {
    width = Math.max(0, width);
    const p = tv.paintT, font = p.font(), thread = curThread;
    const changed = source !== this.source || font !== this.font || p.letterSpacingEm !== this.ls || tv.allCaps !== this.caps;
    if (changed || tv.maxLinesV !== this.max || tv.singleLine !== this.single || tv.ellipsizeEnd !== this.ell ||
        tv.lineSpacingMult !== this.mult || tv.lineSpacingExtra !== this.extra || tv.includePad !== this.pad) {
      this.layouts = []; this.max = tv.maxLinesV; this.single = tv.singleLine; this.ell = tv.ellipsizeEnd;
      this.mult = tv.lineSpacingMult; this.extra = tv.lineSpacingExtra; this.pad = tv.includePad;
    }
    const cached = this.layouts.find(l => l.width === width);
    if (cached) { perf.wrapHits++; return cached; }
    const build = (prepared: PreparedText): JLayout | Promise<JLayout> => {
      const layout = new JStaticLayout();
      layout.src = prepared.src; layout.text = prepared.text; layout.paint = p; layout.width = width;
      layout.replacements = prepared.replacements; layout.spacingMult = this.mult; layout.spacingAdd = this.extra; layout.includePad = this.pad;
      return after(callOn(thread, () => layout.lineUp(() => breakLines(layout, this.single, this.max, this.ell))), () => {
        this.layouts.unshift(layout); this.layouts.length = Math.min(2, this.layouts.length);
        return layout;
      });
    };
    if (!changed && this.prepared) return build(this.prepared);
    this.source = source; this.font = font; this.ls = p.letterSpacingEm; this.caps = tv.allCaps;
    const display = tv.allCaps ? uppercase(source) : source;
    const prepared: PreparedText = { src: display, text: typeof display === "string" ? display : display.text, replacements: [] };
    this.prepared = prepared;
    if (!(prepared.src instanceof JSpanned)) return build(prepared);
    return after(measureReplacements(prepared.src, p), replacements => { prepared.replacements = replacements; return build(prepared); });
  }
}

function breakLines(layout: JLayout, single: boolean, max: number, ellipsis: boolean): TLine[] {
  perf.wraps++;
  const text = layout.text, avail = layout.width, out: TLine[] = [];
  let paragraph = 0, first = 0;
  const indent = () => layout.indent(paragraph, out.length - first);
  const width = (start: number, end: number) => layout.rangeWidth(start, end);
  const fits = (start: number, end: number) => Math.round(width(start, end)) <= avail - indent();
  const push = (start: number, end: number) => out.push({ start, end, text: text.slice(start, end), width: width(start, end), indent: indent() });
  const boundary = (start: number, end: number) => {
    const span = layout.replacements.find(s => s.start < end && s.end > end);
    if (span) return Math.max(start, span.start);
    const code = text.charCodeAt(end - 1);
    const safe = end > start && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
    return layout.paint.tf.family === tfDefault.family ? ligatureBoundary(text, start, safe) : safe;
  };
  const breakWide = (start: number, end: number): number => {
    while (!fits(start, end) && end - start > 1) {
      let lo = start + 1, hi = end;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(start, mid)) lo = mid; else hi = mid - 1; }
      let cut = boundary(start, lo);
      if (cut === start) cut = layout.replacements.find(s => s.start <= start && s.end > start)?.end ?? start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
      push(start, cut); start = cut;
    }
    return start;
  };
  if (avail <= 0) { if (text) push(0, text.length); return out; }
  let start = 0;
  for (const hard of text.split("\n")) {
    const end = start + hard.length;
    paragraph = start; first = out.length;
    if (single || max === 1) { push(start, end); break; }
    if (fits(start, end)) push(start, end);
    else {
      let lineStart = start, lineEnd = start;
      for (const match of hard.matchAll(/\s+|\S+/g)) {
        const wordStart = start + match.index, wordEnd = wordStart + match[0].length;
        if (lineStart === lineEnd || fits(lineStart, wordEnd)) lineStart = breakWide(lineStart, wordEnd);
        else {
          const trimmedEnd = lineStart + text.slice(lineStart, lineEnd).trimEnd().length;
          const rest = breakWide(lineStart, trimmedEnd);
          if (rest < trimmedEnd) push(rest, trimmedEnd);
          lineStart = wordEnd - match[0].trimStart().length;
        }
        lineEnd = wordEnd;
      }
      const trimmedEnd = lineStart + text.slice(lineStart, lineEnd).trimEnd().length;
      const rest = breakWide(lineStart, trimmedEnd);
      if (rest < trimmedEnd) push(rest, trimmedEnd);
    }
    start = end + 1;
  }
  if (out.length > max) out.length = max;
  const last = out.at(-1);
  if (last && ellipsis && (last.end < text.length || last.width > avail - (last.indent ?? 0))) {
    let lo = last.start, hi = last.start + last.text.length;
    const ellWidth = measureText(layout.paint, "…");
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (width(last.start, mid) + ellWidth <= avail - (last.indent ?? 0)) lo = mid; else hi = mid - 1; }
    lo = boundary(last.start, lo);
    last.ellipsis = { start: lo - last.start, count: text.length - lo };
    last.text = text.slice(last.start, lo) + "…"; last.width = width(last.start, lo) + ellWidth;
    last.end = text.length;
  }
  for (let i = 0; i + 1 < out.length; i++) out[i].end = out[i + 1].start;
  return out;
}

export function drawTextViewLayout(layout: JLayout, cv: JCanvas, gravity: number): unknown {
  if (layout.replacements.length || layout.src instanceof JSpanned && layout.src.spans.length) return drawLayout.call(layout, cv, gravity);
  const ctx = cv.ctx, p = layout.paint;
  ctx.font = p.font(); ctx.fillStyle = cssColor(p.color); ctx.textBaseline = "alphabetic";
  ctx.textRendering = "geometricPrecision";
  ctx.textAlign = gravity === 1 ? "center" : gravity === 5 ? "right" : "left";
  const x = gravity === 1 ? layout.width / 2 : gravity === 5 ? layout.width : 0;
  const matrix = ctx.getTransform(), oblique = matrix.b !== 0 || matrix.c !== 0;
  const shadow = beginPaintShadow(ctx, p);
  try {
    for (let i = 0; i < layout.lines.length; i++) {
      const line = layout.lines[i], y = layout.baseline(i);
      cv.recordText(line.text, x, y, p.textSize, gravity === 1 ? 1 : gravity === 5 ? 2 : 0);
      if (!(gravity !== 1 && gravity !== 5 &&
        tryDrawBitmapText(cv, line.text, x + (oblique ? 0.25 : 0), y, p, !oblique))) ctx.fillText(line.text, x, y);
      if (p.strikeThru && line.text) {
        const sx = gravity === 1 ? x - line.width / 2 : gravity === 5 ? x - line.width : x;
        ctx.fillRect(sx, y - p.textSize * 0.3, line.width, Math.max(1, p.textSize / 14));
      }
    }
  } finally { if (shadow) ctx.restore(); }
}
