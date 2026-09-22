import { measureText } from "./graphics";
import type { JTextPaint } from "./text";

export interface TLine { start: number; end: number; text: string; width: number; ellipsis?: { start: number; count: number }; }
type Constraints = {
  width: number; firstWidth?: number; firstCount?: number; maxLines?: number; balanced?: boolean;
  measure?: (start: number, end: number) => number;
  boundary?: (start: number, end: number) => number;
};

/** Paragraph offsets and replacement boundaries are shared by both breaking strategies. */
export function breakLines(text: string, paint: JTextPaint, constraints: Constraints): TLine[] {
  const { width, firstWidth = width, firstCount = 0, maxLines = Number.MAX_SAFE_INTEGER, balanced = false } = constraints;
  const measure = constraints.measure ?? ((start, end) => measureText(paint, text.slice(start, end)));
  const boundary = constraints.boundary ?? ((_start, end) => end);
  const out: TLine[] = [];
  let start = 0;
  for (const paragraph of text.split("\n")) {
    if (out.length >= maxLines) break;
    const end = start + paragraph.length, lines: TLine[] = [];
    let at = start;
    do {
      const available = out.length + lines.length < firstCount ? firstWidth : width;
      let cut = end;
      if (at < end && measure(at, end) > available) {
        let lo = at + 1, hi = end;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (measure(at, mid) <= available) lo = mid; else hi = mid - 1;
        }
        const space = text.lastIndexOf(" ", Math.min(lo, end - 2));
        cut = space > at ? space : lo;
      }
      cut = Math.min(end, boundary(at, cut));
      lines.push({ start: at, end: cut, text: text.slice(at, cut), width: cut > at ? measure(at, cut) : 0 });
      at = cut;
      if (at < end && text[at] === " ") at++;
    } while (at < end && (balanced || out.length + lines.length < maxLines));
    const result = balanced && lines.length > 1
      ? balanceParagraph(text, start, end, lines, width, paint.textSize, measure, boundary) : lines;
    for (const line of result) { if (out.length >= maxLines) break; out.push(line); }
    // A paragraph's last line owns its newline, but its visible text excludes it.
    if (end < text.length && out.at(-1)?.end === end) out[out.length - 1].end++;
    start = end + 1;
  }
  if (!out.length) out.push({ start: 0, end: 0, text: "", width: 0 });
  return out;
}

function balanceParagraph(text: string, start: number, end: number, greedy: TLine[], width: number, textSize: number,
  measure: (start: number, end: number) => number, boundary: (start: number, end: number) => number): TLine[] {
  const words = new Set([...text.slice(start, end).matchAll(/ +/g)].map(m => start + m.index + m[0].length));
  const ends = [...new Set([start, ...words, ...greedy.map(l => l.end), end])]
    .filter(at => at === start || boundary(start, at) === at).sort((a, b) => a - b);
  const scores = new Float64Array(ends.length).fill(Infinity), previous = new Int32Array(ends.length);
  scores[0] = 0;
  for (let i = 1; i < ends.length; i++) {
    let visible = ends[i];
    while (visible > start && text[visible - 1] === " " && boundary(start, visible - 1) === visible - 1) visible--;
    for (let j = i - 1; j >= 0; j--) {
      const advance = measure(ends[j], Math.max(ends[j], visible));
      if (advance > width && j < i - 1) break;
      // Minikin penalizes emergency word breaks and balances squared unused width.
      const penalty = ends[i] === end || words.has(ends[i]) ? 0 : 1e10;
      const score = scores[j] + (advance > width ? 1e12 : (width - advance) ** 2) + textSize * width + penalty;
      if (score <= scores[i]) { scores[i] = score; previous[i] = j; }
    }
  }
  const lines: TLine[] = [];
  for (let i = ends.length - 1; i > 0; i = previous[i]) {
    const begin = ends[previous[i]], finish = ends[i];
    let visible = finish;
    while (visible > begin && text[visible - 1] === " " && boundary(begin, visible - 1) === visible - 1) visible--;
    lines.push({ start: begin, end: finish, text: text.slice(begin, visible), width: measure(begin, visible) });
  }
  return lines.reverse();
}
