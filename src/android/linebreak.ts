import { measureText } from "./graphics";
import type { JTextPaint } from "./text";

export interface TLine { start: number; end: number; text: string; width: number; ellipsis?: { start: number; count: number }; }
type Constraints = {
  width: number; firstWidth?: number; firstCount?: number; maxLines?: number; balanced?: boolean;
  measure?: (start: number, end: number) => number;
  atomic?: readonly { start: number; end: number }[];
};

class BreakText {
  constructor(readonly text: string, private atomic: NonNullable<Constraints["atomic"]>) {}
  space(at: number): boolean {
    return this.text[at] === " " && !this.atomic.some(span => span.start <= at && span.end > at);
  }
  boundary(start: number, end: number): number {
    const span = this.atomic.find(span => span.start < end && span.end > end);
    if (span) return span.start > start ? span.start : span.end;
    const code = this.text.charCodeAt(end - 1);
    return end > start && code >= 0xd800 && code <= 0xdbff && end < this.text.length
      ? (end - 1 > start ? end - 1 : end + 1) : end;
  }
  trim(start: number, end: number): number {
    while (end > start && this.space(end - 1)) end--;
    return end;
  }
  paragraphEnd(start: number): number {
    let end = this.text.indexOf("\n", start);
    while (end >= 0) {
      const span = this.atomic.find(span => span.start <= end && span.end > end);
      if (!span) return end;
      end = this.text.indexOf("\n", span.end);
    }
    return this.text.length;
  }
}

export function breakLines(text: string, paint: JTextPaint, constraints: Constraints): TLine[] {
  const { width, firstWidth = width, firstCount = 0, maxLines = Number.MAX_SAFE_INTEGER, balanced = false } = constraints;
  const measure = constraints.measure ?? ((start, end) => measureText(paint, text.slice(start, end)));
  const content = new BreakText(text, constraints.atomic ?? []);
  const out: TLine[] = [];
  for (let start = 0; start <= text.length;) {
    if (out.length >= maxLines) break;
    const end = content.paragraphEnd(start), lines: TLine[] = [];
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
        let space = text.lastIndexOf(" ", Math.min(lo, end - 2));
        while (space > at && !content.space(space)) space = text.lastIndexOf(" ", space - 1);
        cut = space > at ? space : lo;
      }
      cut = Math.min(end, content.boundary(at, cut));
      lines.push({ start: at, end: cut, text: text.slice(at, cut), width: cut > at ? measure(at, cut) : 0 });
      at = cut;
      if (at < end && content.space(at)) at++;
    } while (at < end && (balanced || out.length + lines.length < maxLines));
    const result = balanced && lines.length > 1
      ? balanceParagraph(content, start, end, lines, width, paint.textSize, measure) : lines;
    for (const line of result) { if (out.length >= maxLines) break; out.push(line); }
    // A paragraph's last line owns its newline, but its visible text excludes it.
    if (end < text.length && out.at(-1)?.end === end) out[out.length - 1].end++;
    start = end + 1;
  }
  if (!out.length) out.push({ start: 0, end: 0, text: "", width: 0 });
  return out;
}

function balanceParagraph(content: BreakText, start: number, end: number, greedy: TLine[], width: number, textSize: number,
  measure: (start: number, end: number) => number): TLine[] {
  const text = content.text, words = new Set<number>();
  for (let at = start; at < end; at++) {
    if (!content.space(at)) continue;
    while (at < end && content.space(at)) at++;
    words.add(at);
  }
  const ends = [...new Set([start, ...words, ...greedy.map(l => l.end), end])]
    .filter(at => at === start || content.boundary(start, at) === at).sort((a, b) => a - b);
  const scores = new Float64Array(ends.length).fill(Infinity), previous = new Int32Array(ends.length);
  scores[0] = 0;
  for (let i = 1; i < ends.length; i++) {
    const visible = content.trim(start, ends[i]);
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
    const visible = content.trim(begin, finish);
    lines.push({ start: begin, end: finish, text: text.slice(begin, visible), width: measure(begin, visible) });
  }
  return lines.reverse();
}
