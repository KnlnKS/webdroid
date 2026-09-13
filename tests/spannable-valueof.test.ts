import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JSpanned } from "../src/android/text";

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
