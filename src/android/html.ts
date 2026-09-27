// android.text.Html: AOSP's HtmlToSpannedConverter with the browser's parser as the tokenizer.

import { rt, JObj } from "../jvm/runtime";
import { COLOR_NAMES } from "./graphics";
import { type JSpannable, spannedString } from "./text";

class JHtml extends JObj {}
rt.register({
  name: "android/text/Html", ctor: JHtml,
  methods: {
    "static fromHtml(Ljava/lang/String;)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    "static fromHtml(Ljava/lang/String;I)Landroid/text/Spanned;": (s: string, flags: number) => htmlToSpan(s, flags),
    // the image getter and tag handler are the app's hooks for <img> and unknown tags; the
    // converter below calls neither, so they are accepted and ignored
    "static fromHtml(Ljava/lang/String;Landroid/text/Html$ImageGetter;Landroid/text/Html$TagHandler;)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    "static fromHtml(Ljava/lang/String;ILandroid/text/Html$ImageGetter;Landroid/text/Html$TagHandler;)Landroid/text/Spanned;": (s: string, flags: number) => htmlToSpan(s, flags),
    "static toHtml(Landroid/text/Spanned;)Ljava/lang/String;": (sp: unknown) => spannedString(sp),
    "static toHtml(Landroid/text/Spanned;I)Ljava/lang/String;": (sp: unknown) => spannedString(sp),
    // AOSP withinStyle: the five markup characters and every non-ASCII code point as entities
    "static escapeHtml(Ljava/lang/CharSequence;)Ljava/lang/String;": (cs: unknown) =>
      String(cs).replace(/[<>&'"]|[^\x00-\x7f]/gu, (c) => c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&#39;" : c === "\"" ? "&quot;" : "&#" + c.codePointAt(0) + ";"),
  },
});
rt.markers("android/text/Html$ImageGetter", "android/text/Html$TagHandler");

/** block tags and the FROM_HTML_SEPARATOR_LINE_BREAK_* bit each one's margin answers to */
const HTML_BLOCKS: Record<string, number> = { P: 1, H1: 2, H2: 2, H3: 2, H4: 2, H5: 2, H6: 2, LI: 4, UL: 8, DIV: 16, BLOCKQUOTE: 32 };
/** an android.text.style span class and the fields it is made with */
type SpanSpec = readonly [cls: string, fields?: Record<string, unknown>];
const BOLD: SpanSpec = ["StyleSpan", { style: 1 }], ITALIC: SpanSpec = ["StyleSpan", { style: 2 }], STRIKE: SpanSpec = ["StrikethroughSpan"];
/** the spans each tag makes by itself; <a> and <font> read their attributes */
const TAG_SPANS: Record<string, readonly SpanSpec[]> = {
  B: [BOLD], STRONG: [BOLD], I: [ITALIC], EM: [ITALIC], CITE: [ITALIC], DFN: [ITALIC],
  U: [["UnderlineSpan"]], DEL: [STRIKE], S: [STRIKE], STRIKE: [STRIKE],
  BIG: [["RelativeSizeSpan", { size: 1.25 }]], SMALL: [["RelativeSizeSpan", { size: 0.8 }]],
  TT: [["TypefaceSpan", { family: "monospace" }]], SUP: [["SuperscriptSpan"]],
  BLOCKQUOTE: [["QuoteSpan"]], LI: [["BulletSpan"]],
  ...Object.fromEntries([1.5, 1.4, 1.3, 1.2, 1.1, 1].map((size, i) => ["H" + (i + 1), [["RelativeSizeSpan", { size }], BOLD]])),
};
/** Color.getHtmlColor: a colour name, else XmlUtils.convertValueToInt's #hex/0x/decimal; -1 is none */
function htmlColor(value: string | null | undefined): number | null {
  if (!value) return null;
  const named = COLOR_NAMES[value.toLowerCase()];
  if (named !== undefined) return named;
  const m = /^(-?)(#|0x|0X)?([\da-fA-F]+)$/.exec(value);
  const v = m ? (m[1] ? -1 : 1) * parseInt(m[3], m[2] ? 16 : 10) | 0 : -1;
  return v === -1 ? null : (v | 0xff000000) | 0;
}
const cssValue = (el: Element, re: RegExp) => re.exec(el.getAttribute("style") ?? "")?.[1];

/**
 * AOSP HtmlToSpannedConverter into a SpannableStringBuilder. Whitespace collapses as
 * characters() does, block elements separate with their mode's newlines
 * (FROM_HTML_SEPARATOR_LINE_BREAK_* makes one of two), and every span covers exactly the text
 * its element produced; nothing is trimmed afterwards.
 */
function htmlToSpan(s: string, flags = 0): JSpannable {
  const sp = rt.make("android/text/SpannableStringBuilder") as JSpannable;
  if (typeof DOMParser === "undefined") { sp.text = s.replace(/<[^>]+>/g, ""); return sp; }
  const make = (cls: string, fields: Record<string, unknown> = {}) => Object.assign(rt.make("android/text/style/" + cls), fields);
  const newlines = (min: number) => {
    let n = 0;
    for (let i = sp.text.length - 1; i >= 0 && sp.text[i] === "\n"; i--) n++;
    if (sp.text) sp.text += "\n".repeat(Math.max(0, min - n));
  };
  const walk = (node: Node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        let out = "";
        for (const ch of c.nodeValue ?? "") {
          if (ch !== " " && ch !== "\n") { out += ch; continue; }
          const pred = out ? out[out.length - 1] : sp.text ? sp.text[sp.text.length - 1] : "\n";
          if (pred !== " " && pred !== "\n") out += " ";
        }
        sp.text += out;
        continue;
      }
      if (c.nodeType !== 1) continue;
      const el = c as Element, tag = el.tagName;
      if (tag === "BR") { sp.text += "\n"; continue; }
      const bit = HTML_BLOCKS[tag], margin = bit ? (flags & bit ? 1 : 2) : 0;
      if (margin) newlines(margin);
      const start = sp.text.length;
      walk(el);
      const spans = (TAG_SPANS[tag] ?? []).map(([cls, fields]) => make(cls, fields));
      if (tag === "A" && el.hasAttribute("href")) spans.push(make("URLSpan", { url: el.getAttribute("href") }));
      else if (tag === "FONT") {
        const fg = htmlColor(el.getAttribute("color")), face = el.getAttribute("face");
        if (fg !== null) spans.push(make("ForegroundColorSpan", { color: fg }));
        if (face) spans.push(make("TypefaceSpan", { family: face }));
      }
      // startCssStyle: a paragraph's, list item's or span's style attribute, read with AOSP's patterns
      if (tag === "P" || tag === "LI" || tag === "SPAN") {
        const fg = htmlColor(cssValue(el, /(?:\s+|^)color\s*:\s*(\S*)\b/)), bg = htmlColor(cssValue(el, /(?:\s+|^)background(?:-color)?\s*:\s*(\S*)\b/));
        if (fg !== null) spans.push(make("ForegroundColorSpan", { color: fg }));
        if (bg !== null) spans.push(make("BackgroundColorSpan", { color: bg }));
        if (cssValue(el, /(?:\s+|^)text-decoration\s*:\s*(\S*)\b/)?.toLowerCase() === "line-through") spans.push(make("StrikethroughSpan"));
      }
      // a quote or bullet ends after its block's newlines, every other span before them
      const inner = sp.text.length;
      if (margin) newlines(margin);
      for (const span of spans) sp.spans.push({ span, start, end: tag === "BLOCKQUOTE" || tag === "LI" ? sp.text.length : inner, flags: 33 });
    }
  };
  walk(new DOMParser().parseFromString(s, "text/html").body);
  // convert(): a paragraph style's range backs off one blank trailing line and becomes SPAN_PARAGRAPH
  for (const r of sp.spans) {
    if (!rt.iof(r.span, "android/text/style/ParagraphStyle")) continue;
    if (r.end - 2 >= 0 && sp.text[r.end - 1] === "\n" && sp.text[r.end - 2] === "\n") r.end--;
    r.flags = 51;
  }
  sp.spans = sp.spans.filter((r) => r.end > r.start);
  return sp;
}
