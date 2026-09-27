// android.text.Html: AOSP's HtmlToSpannedConverter with the browser's parser as the tokenizer.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { after, newObj, vcall } from "../jvm/natives/jlang";
import { COLOR_NAMES } from "./graphics";
import { type JSpannable, csText, spannedString } from "./text";

class JHtml extends JObj {}
rt.register({
  name: "android/text/Html", ctor: JHtml,
  methods: {
    "static fromHtml(Ljava/lang/String;)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    "static fromHtml(Ljava/lang/String;I)Landroid/text/Spanned;": (s: string, flags: number) => htmlToSpan(s, flags),
    // the image getter and tag handler are the app's hooks for <img> and unknown tags
    "static fromHtml(Ljava/lang/String;Landroid/text/Html$ImageGetter;Landroid/text/Html$TagHandler;)Landroid/text/Spanned;":
      (s: string, images: unknown, tags: unknown) => htmlToSpan(s, 0, images, tags),
    "static fromHtml(Ljava/lang/String;ILandroid/text/Html$ImageGetter;Landroid/text/Html$TagHandler;)Landroid/text/Spanned;":
      (s: string, flags: number, images: unknown, tags: unknown) => htmlToSpan(s, flags, images, tags),
    "static toHtml(Landroid/text/Spanned;)Ljava/lang/String;": spannedString,
    "static toHtml(Landroid/text/Spanned;I)Ljava/lang/String;": spannedString,
    // AOSP withinStyle: the five markup characters and every non-ASCII code point as entities
    "static escapeHtml(Ljava/lang/CharSequence;)Ljava/lang/String;": (cs: unknown) => after(csText(cs), (text) =>
      text.replace(/[<>&'"]|[^\x00-\x7f]/gu, (c) => c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&#39;" : c === "\"" ? "&quot;" : "&#" + c.codePointAt(0) + ";")),
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
  TT: [["TypefaceSpan", { family: "monospace" }]], SUP: [["SuperscriptSpan"]], SUB: [["SubscriptSpan"]],
  BLOCKQUOTE: [["QuoteSpan"]], LI: [["BulletSpan"]],
  ...Object.fromEntries([1.5, 1.4, 1.3, 1.2, 1.1, 1].map((size, i) => ["H" + (i + 1), [["RelativeSizeSpan", { size }], BOLD]])),
};
/** the tags handleStartTag knows; any other goes to the TagHandler */
const KNOWN_TAGS = new Set([...Object.keys(TAG_SPANS), ...Object.keys(HTML_BLOCKS), "BR", "SPAN", "FONT", "A", "IMG"]);
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
 * its element produced; nothing is trimmed afterwards. An <img> is an ImageSpan over U+FFFC
 * from the ImageGetter (else the system's unknown_image); the TagHandler sees each unknown tag
 * open and close around its content.
 */
const htmlToSpan = driven(function* htmlToSpan(s: string, flags: number = 0, images: unknown = null, tags: unknown = null): Gen<JSpannable> {
  const sp = rt.make("android/text/SpannableStringBuilder") as JSpannable;
  if (typeof DOMParser === "undefined") { sp.text = s.replace(/<[^>]+>/g, ""); return sp; }
  const make = (cls: string, fields: Record<string, unknown> = {}) => Object.assign(rt.make("android/text/style/" + cls), fields);
  const newlines = (min: number) => {
    let n = 0;
    for (let i = sp.text.length - 1; i >= 0 && sp.text[i] === "\n"; i--) n++;
    if (sp.text) sp.text += "\n".repeat(Math.max(0, min - n));
  };
  const image = function* (el: Element): Gen {
    const src = el.getAttribute("src");
    let d = images ? yield vcall(images, "getDrawable", "(Ljava/lang/String;)Landroid/graphics/drawable/Drawable;", src) : null;
    if (!d) {
      const system = yield vcall(rt.link("android/content/res/Resources").ctor, "getSystem", "()Landroid/content/res/Resources;");
      d = yield vcall(system, "getDrawable", "(I)Landroid/graphics/drawable/Drawable;",
        yield vcall(system, "getIdentifier", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "unknown_image", "drawable", "android"));
      yield vcall(d, "setBounds", "(IIII)V", 0, 0, yield vcall(d, "getIntrinsicWidth", "()I"), yield vcall(d, "getIntrinsicHeight", "()I"));
    }
    const start = sp.text.length;
    sp.text += "\uFFFC";
    sp.spans.push({ span: yield newObj("android/text/style/ImageSpan", "(Landroid/graphics/drawable/Drawable;Ljava/lang/String;)V", d, src), start, end: start + 1, flags: 33 });
  };
  const handleTag = (opening: boolean, el: Element) => vcall(tags, "handleTag", "(ZLjava/lang/String;Landroid/text/Editable;Lorg/xml/sax/XMLReader;)V", +opening, el.tagName.toLowerCase(), sp, null);
  const walk = function* (node: Node): Gen {
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
      if (tag === "IMG") { yield* image(el); continue; }
      if (!KNOWN_TAGS.has(tag)) {
        if (tags) yield handleTag(true, el);
        yield* walk(el);
        if (tags) yield handleTag(false, el);
        continue;
      }
      const bit = HTML_BLOCKS[tag], margin = bit ? (flags & bit ? 1 : 2) : 0;
      if (margin) newlines(margin);
      const start = sp.text.length;
      yield* walk(el);
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
  yield* walk(new DOMParser().parseFromString(s, "text/html").body);
  // convert(): a paragraph style's range backs off one blank trailing line and becomes SPAN_PARAGRAPH
  for (const r of sp.spans) {
    if (!rt.iof(r.span, "android/text/style/ParagraphStyle")) continue;
    if (r.end - 2 >= 0 && sp.text[r.end - 1] === "\n" && sp.text[r.end - 2] === "\n") r.end--;
    r.flags = 51;
  }
  sp.spans = sp.spans.filter((r) => r.end > r.start);
  return sp;
});
