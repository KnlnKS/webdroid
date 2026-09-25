import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

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
