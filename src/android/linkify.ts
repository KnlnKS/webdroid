import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { csText } from "./text";
import type { JTextView } from "./textview";

type Link = { start: number; end: number; url: string };

function matches(text: string, mask: number): Link[] {
  const links: Link[] = [];
  const collect = (pattern: RegExp, url: (value: string) => string, valid: (value: string, start: number) => boolean = () => true) => {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/[.,;:!?]+$/, "");
      const start = match.index;
      if (value && valid(value, start)) links.push({ start, end: start + value.length, url: url(value) });
    }
  };
  if (mask & 1) collect(/\b(?:https?:\/\/|ftp:\/\/|rtsp:\/\/|www\.)[^\s<>"']+|\b[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+\b/gi,
    value => /^(?:https?|ftp|rtsp):\/\//i.test(value) ? value : `http://${value}`,
    (value, start) => text[start - 1] !== "@" && !/^\d+(?:\.\d+)+$/.test(value));
  if (mask & 2) collect(/\b[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z]{2,}\b/gi, value => `mailto:${value}`);
  if (mask & 4) collect(/(?:\+?\d[\d .()-]{5,}\d)/g,
    value => `tel:${value.replace(/[^\d+]/g, "")}`,
    value => value.replace(/\D/g, "").length >= 5);
  links.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const accepted: Link[] = [];
  for (const link of links) {
    const prior = accepted.at(-1);
    if (prior && link.start < prior.end) {
      if (link.end - link.start > prior.end - prior.start) accepted[accepted.length - 1] = link;
    } else accepted.push(link);
  }
  return accepted;
}

async function applyLinks(spannable: unknown, links: Link[]): Promise<number> {
  for (const link of links) {
    const span = await newObj("android/text/style/URLSpan", "(Ljava/lang/String;)V", link.url);
    await vcall(spannable, "setSpan", "(Ljava/lang/Object;III)V", span, link.start, link.end, 33);
  }
  return links.length ? 1 : 0;
}

async function addMaskLinks(spannable: unknown, mask: number): Promise<number> {
  if (!spannable) return rt.npe();
  if (!mask) return 0;
  const text = await csText(spannable);
  const oldSpans: unknown = await vcall(spannable, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, text.length, rt.classFor("android/text/style/URLSpan"));
  if (!Array.isArray(oldSpans)) throw rt.mkThrowable("java/lang/IllegalStateException", "Spannable.getSpans did not return an array");
  for (const span of oldSpans) await vcall(spannable, "removeSpan", "(Ljava/lang/Object;)V", span);
  return applyLinks(spannable, matches(text, mask));
}

async function addPatternLinks(spannable: unknown, pattern: unknown, defaultScheme: string | null,
  schemes: string[] | null, matchFilter: unknown, transformFilter: unknown): Promise<number> {
  if (!spannable || !pattern) return rt.npe();
  const matcher = await vcall(pattern, "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", spannable);
  const prefixes = [defaultScheme ?? "", ...(schemes ?? [])].map(s => (s ?? "").toLowerCase());
  let added = 0;
  while (await vcall(matcher, "find", "()Z")) {
    const start = await vcall(matcher, "start", "()I");
    const end = await vcall(matcher, "end", "()I");
    if (matchFilter && !await vcall(matchFilter, "acceptMatch", "(Ljava/lang/CharSequence;II)Z", spannable, start, end)) continue;
    const group = await vcall(matcher, "group", "()Ljava/lang/String;") as string;
    let url = transformFilter ? await vcall(transformFilter, "transformUrl", "(Ljava/util/regex/Matcher;Ljava/lang/String;)Ljava/lang/String;", matcher, group) as string : group;
    if (!prefixes.some(prefix => prefix && url.toLowerCase().startsWith(prefix))) url = prefixes[0] + url;
    added += await applyLinks(spannable, [{ start, end, url }]);
  }
  return added ? 1 : 0;
}

async function addTextViewLinks(view: JTextView, add: (spannable: unknown) => Promise<number>): Promise<number> {
  if (!view) return rt.npe();
  const source = await vcall(view, "getText", "()Ljava/lang/CharSequence;");
  const spannable = await vcall(rt.link("android/text/SpannableString").ctor, "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannableString;", source);
  const added = await add(spannable);
  if (added) {
    await vcall(view, "setText", "(Ljava/lang/CharSequence;)V", spannable);
    if (await vcall(view, "getLinksClickable", "()Z")) {
      const method = await vcall(rt.link("android/text/method/LinkMovementMethod").ctor, "getInstance", "()Landroid/text/method/MovementMethod;");
      await vcall(view, "setMovementMethod", "(Landroid/text/method/MovementMethod;)V", method);
    }
  }
  return added;
}

rt.markers("android/text/util/Linkify$MatchFilter", "android/text/util/Linkify$TransformFilter");
class UrlMatchFilter extends JObj {}
class PhoneMatchFilter extends JObj {}
class PhoneTransformFilter extends JObj {}
rt.register({ name: "webdroid/UrlMatchFilter", ctor: UrlMatchFilter, ifaces: ["android/text/util/Linkify$MatchFilter"], methods: {
  "acceptMatch(Ljava/lang/CharSequence;II)Z": driven(function* (text: unknown, start: number): Gen { return (yield csText(text))[start - 1] === "@" ? 0 : 1; }),
} });
rt.register({ name: "webdroid/PhoneMatchFilter", ctor: PhoneMatchFilter, ifaces: ["android/text/util/Linkify$MatchFilter"], methods: {
  "acceptMatch(Ljava/lang/CharSequence;II)Z": driven(function* (text: unknown, start: number, end: number): Gen { return (yield csText(text)).slice(start, end).replace(/\D/g, "").length >= 5 ? 1 : 0; }),
} });
rt.register({ name: "webdroid/PhoneTransformFilter", ctor: PhoneTransformFilter, ifaces: ["android/text/util/Linkify$TransformFilter"], methods: {
  "transformUrl(Ljava/util/regex/Matcher;Ljava/lang/String;)Ljava/lang/String;": (_matcher: unknown, url: string) => url.replace(/[^\d+]/g, ""),
} });

rt.register({
  name: "android/text/util/Linkify", ctor: class extends JObj {},
  statics: { WEB_URLS: 1, EMAIL_ADDRESSES: 2, PHONE_NUMBERS: 4, MAP_ADDRESSES: 8, ALL: 15,
    sUrlMatchFilter: new UrlMatchFilter(), sPhoneNumberMatchFilter: new PhoneMatchFilter(), sPhoneNumberTransformFilter: new PhoneTransformFilter() },
  methods: {
    "<init>()V": function () {},
    "static addLinks(Landroid/text/Spannable;I)Z": addMaskLinks,
    "static addLinks(Landroid/widget/TextView;I)Z": (view: JTextView, mask: number) => addTextViewLinks(view, text => addMaskLinks(text, mask)),
    "static addLinks(Landroid/text/Spannable;Ljava/util/regex/Pattern;Ljava/lang/String;)Z":
      (text: unknown, pattern: unknown, scheme: string | null) => addPatternLinks(text, pattern, scheme, null, null, null),
    "static addLinks(Landroid/text/Spannable;Ljava/util/regex/Pattern;Ljava/lang/String;Landroid/text/util/Linkify$MatchFilter;Landroid/text/util/Linkify$TransformFilter;)Z":
      (text: unknown, pattern: unknown, scheme: string | null, match: unknown, transform: unknown) => addPatternLinks(text, pattern, scheme, null, match, transform),
    "static addLinks(Landroid/text/Spannable;Ljava/util/regex/Pattern;Ljava/lang/String;[Ljava/lang/String;Landroid/text/util/Linkify$MatchFilter;Landroid/text/util/Linkify$TransformFilter;)Z": addPatternLinks,
    "static addLinks(Landroid/widget/TextView;Ljava/util/regex/Pattern;Ljava/lang/String;)V":
      (view: JTextView, pattern: unknown, scheme: string | null) => addTextViewLinks(view, text => addPatternLinks(text, pattern, scheme, null, null, null)),
    "static addLinks(Landroid/widget/TextView;Ljava/util/regex/Pattern;Ljava/lang/String;Landroid/text/util/Linkify$MatchFilter;Landroid/text/util/Linkify$TransformFilter;)V":
      (view: JTextView, pattern: unknown, scheme: string | null, match: unknown, transform: unknown) => addTextViewLinks(view, text => addPatternLinks(text, pattern, scheme, null, match, transform)),
    "static addLinks(Landroid/widget/TextView;Ljava/util/regex/Pattern;Ljava/lang/String;[Ljava/lang/String;Landroid/text/util/Linkify$MatchFilter;Landroid/text/util/Linkify$TransformFilter;)V":
      (view: JTextView, pattern: unknown, scheme: string | null, schemes: string[] | null, match: unknown, transform: unknown) => addTextViewLinks(view, text => addPatternLinks(text, pattern, scheme, schemes, match, transform)),
  },
});
