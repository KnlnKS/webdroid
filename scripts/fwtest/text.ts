import { rt, JObj } from "../../src/jvm/runtime.ts";
import { newObj, vcall, scall } from "../../src/jvm/natives/jentry.ts";
import { mangleStaticField } from "../../src/jvm/abi.ts";
import { exercise, same, statics, classMirror } from "./harness.ts";

// text: expected values printed by the same calls on the reference AVD
await exercise("AndroidCharacter (device values)", async () => {
  const AC = "android/text/AndroidCharacter", chars = (s: string) => Uint16Array.from(s.split(""), (c) => c.charCodeAt(0));
  const widths: number[] = [];
  for (const c of [0x41, 0xa1, 0xff61, 0xff21, 0x3042, 0x20a9, 0x2026, 0xac00, 0x300, 0x1100, 0x4e00]) widths.push(await scall(AC, "getEastAsianWidth", "(C)I", c));
  same("getEastAsianWidth", widths, [4, 1, 2, 3, 5, 2, 1, 5, 1, 5, 5]);
  const mirrors: number[] = [];
  for (const c of "(>«a∈⁅〈»") mirrors.push(await scall(AC, "getMirror", "(C)C", c.charCodeAt(0)));
  same("getMirror", mirrors, [41, 60, 187, 97, 8715, 8262, 12297, 171]);
  const dirs = "aא1 ,٣‮😀א̀ا⁧\n\t", d = new Int8Array(dirs.length);
  await scall(AC, "getDirectionalities", "([C[BI)V", chars(dirs), d, dirs.length);
  same("getDirectionalities", d, [0, 1, 3, 12, 7, 6, 17, 13, 13, 1, 8, 2, -1, 10, 11]);
  const w = "aあ𠀀bｶ", ew = new Int8Array(w.length);
  await scall(AC, "getEastAsianWidths", "([CII[B)V", chars(w), 0, w.length, ew);
  same("getEastAsianWidths", ew, [4, 5, 5, 5, 4, 2]);
  const mc = chars("(a[b]<");
  same("mirror", [await scall(AC, "mirror", "([CII)Z", mc, 1, 4), String.fromCharCode(...mc), await scall(AC, "mirror", "([CII)Z", chars("abc"), 0, 3)], [1, "(a]b[<", 0]);
});
/** a Spanned's spans as the device probe prints them: name[start,end,flags in hex] */
async function spanList(text: unknown, name: (span: any) => Promise<string>): Promise<string> {
  const out: string[] = [];
  for (const span of await vcall(text, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, await vcall(text, "length", "()I"), await classMirror("java/lang/Object")))
    out.push(`${await name(span)}[${await vcall(text, "getSpanStart", "(Ljava/lang/Object;)I", span)},${await vcall(text, "getSpanEnd", "(Ljava/lang/Object;)I", span)},${(await vcall(text, "getSpanFlags", "(Ljava/lang/Object;)I", span)).toString(16)}]`);
  return out.join(" ");
}
await exercise("SpannableStringBuilder, SpannableString, SpannedString, Selection (device values)", async () => {
  const log: string[] = [];
  class Mark extends JObj { n = ""; }
  const text = async (t: unknown) => String(await vcall(t, "toString", "()Ljava/lang/String;")).replaceAll("\n", "|");
  const selection = await statics("android/text/Selection");
  const name = async (span: unknown) => span === selection[mangleStaticField("SELECTION_START")] ? "selStart"
    : span === selection[mangleStaticField("SELECTION_END")] ? "selEnd" : span instanceof Mark ? span.n : String(span);
  const note = (event: string) => async function (this: Mark, t: unknown, ...a: unknown[]) {
    const parts: unknown[] = [];
    for (const x of a) parts.push(typeof x === "number" ? x : await name(x));
    log.push(`${this.n}.${event}(${event === "add" || event === "rm" || event === "chg" ? "" : await text(t) + (a.length ? "," : "")}${parts.join(",")})`);
  };
  rt.register({ name: "fwtest/Mark", ctor: Mark, methods: { "toString()Ljava/lang/String;": function (this: Mark) { return this.n; } } });
  rt.register({ name: "fwtest/Watcher", ctor: class extends Mark {}, sup: "fwtest/Mark", ifaces: ["android/text/TextWatcher", "android/text/SpanWatcher"], methods: {
    "beforeTextChanged(Ljava/lang/CharSequence;III)V": note("before"), "onTextChanged(Ljava/lang/CharSequence;III)V": note("on"),
    "afterTextChanged(Landroid/text/Editable;)V": note("after"), "onSpanAdded(Landroid/text/Spannable;Ljava/lang/Object;II)V": note("add"),
    "onSpanRemoved(Landroid/text/Spannable;Ljava/lang/Object;II)V": note("rm"), "onSpanChanged(Landroid/text/Spannable;Ljava/lang/Object;IIII)V": note("chg"),
  } });
  const mark = (cls: string, n: string) => Object.assign(rt.make(cls) as Mark, { n });
  const events = () => log.splice(0).join(" ");
  const SET = "(Ljava/lang/Object;III)V", E = "Landroid/text/Editable;", b = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", "hello");
  const w1 = mark("fwtest/Watcher", "w1"), w2 = mark("fwtest/Watcher", "w2");
  await vcall(b, "setSpan", SET, w1, 0, 5, 0x12);
  await vcall(b, "setSpan", SET, w2, 0, 5, 0x12 | 100 << 16);
  same("added", events(), "w1.add(w1,0,5) w2.add(w2,0,5) w1.add(w2,0,5)");
  const filters = (...f: unknown[]) => Object.assign(f, { $t: "[Landroid/text/InputFilter;" });
  await vcall(b, "setFilters", "([Landroid/text/InputFilter;)V", filters(await newObj("android/text/InputFilter$LengthFilter", "(I)V", 8), await newObj("android/text/InputFilter$AllCaps", "()V")));
  await vcall(b, "replace", `(IILjava/lang/CharSequence;)${E}`, 5, 5, " world");
  same("filtered", `${await text(b)} | ${events()}`, "hello WO | w2.before(hello,5,0,3) w1.before(hello,5,0,3) w2.on(hello WO,5,0,3) w1.on(hello WO,5,0,3) " +
    "w2.after(hello WO) w1.after(hello WO) w2.chg(w1,0,8,0,8) w1.chg(w1,0,8,0,8) w2.chg(w2,0,8,0,8) w1.chg(w2,0,8,0,8)");
  const [ee, ei, ie, ii, pt, para] = ["ee", "ei", "ie", "ii", "pt", "para"].map((n) => mark("fwtest/Mark", n));
  await vcall(b, "setSpan", SET, ee, 2, 4, 0x21); await vcall(b, "setSpan", SET, ei, 2, 4, 0x22);
  await vcall(b, "setSpan", SET, ie, 2, 4, 0x11); await vcall(b, "setSpan", SET, ii, 2, 4, 0x12 | 5 << 16);
  await vcall(b, "setSpan", SET, pt, 3, 3, 0x22);
  await vcall(b, "setFilters", "([Landroid/text/InputFilter;)V", filters());
  for (const [at, s] of [[2, "<"], [5, ">"], [4, "\n"]] as const) await vcall(b, "insert", `(ILjava/lang/CharSequence;)${E}`, at, s);
  let thrown = "";
  try { await vcall(b, "setSpan", SET, para, 1, 4, 0x33); } catch (e) { thrown = String(await vcall(e, "toString", "()Ljava/lang/String;")); }
  same("paragraph boundary", thrown, "java.lang.RuntimeException: PARAGRAPH span must start at paragraph boundary (1 follows h)");
  await vcall(b, "setSpan", SET, para, 0, 5, 0x33);
  await vcall(b, "delete", `(II)${E}`, 0, 1);
  const spans = (t: unknown) => spanList(t, name);
  same("spans", `${await text(b)} ${await spans(b)}`, "e<l|l>o WO w2[0,10,640012] ii[1,6,50012] w1[0,10,12] ee[2,5,21] ei[2,6,22] ie[1,5,11] pt[4,4,22] para[0,4,33]");
  events();
  const OBJ = await classMirror("java/lang/Object"), MARK = await classMirror("fwtest/Mark"), length: number = await vcall(b, "length", "()I");
  same("nextSpanTransition", [await vcall(b, "nextSpanTransition", "(IILjava/lang/Class;)I", 0, length, OBJ), await vcall(b, "nextSpanTransition", "(IILjava/lang/Class;)I", 2, length, MARK)], [1, 4]);
  const S = "android/text/Selection", sel = async () => [await scall(S, "getSelectionStart", "(Ljava/lang/CharSequence;)I", b), await scall(S, "getSelectionEnd", "(Ljava/lang/CharSequence;)I", b)];
  await scall(S, "setSelection", "(Landroid/text/Spannable;II)V", b, 1, 3);
  const before = await sel();
  await vcall(b, "replace", `(IILjava/lang/CharSequence;)${E}`, 0, 2, "xyz");
  same("selection", [before, await sel()], [1, 3, 1, 4]);
  await scall(S, "selectAll", "(Landroid/text/Spannable;)V", b);
  same("selectAll", await sel(), [0, 11]);
  await scall(S, "removeSelection", "(Landroid/text/Spannable;)V", b);
  same("removeSelection", await sel(), [-1, -1]);
  const ss = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", b);
  same("SpannableString", `${await text(ss)} ${await spans(ss)}`, "xyzl|l>o WO w2[0,11,640012] ii[0,7,50012] w1[0,11,12] ee[3,6,21] ei[3,7,22] ie[0,6,11] pt[5,5,22] para[0,5,33]");
  const sd = await newObj("android/text/SpannedString", "(Ljava/lang/CharSequence;)V", await vcall(b, "subSequence", "(II)Ljava/lang/CharSequence;", 1, 6));
  same("SpannedString", `${await text(sd)} ${await spans(sd)}`, "yzl|l ii[0,5,50012] ee[2,5,21] ei[2,5,22] ie[0,5,11] pt[4,4,22] para[0,4,33]");
  same("valueOf", [await scall("android/text/SpannedString", "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannedString;", sd) === sd,
    await scall("android/text/SpannableString", "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannableString;", ss) === ss], [true, true]);
});

await exercise("Linkify.addLinks (device values)", async () => {
  const L = "android/text/util/Linkify", url = async (span: unknown) => `url:${await vcall(span, "getURL", "()Ljava/lang/String;")}`;
  const links = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "Visit example.com or https://www.android.com/path?q=1, mail user@example.com, not a@b");
  same("web and email", [await scall(L, "addLinks", "(Landroid/text/Spannable;I)Z", links, 3), await spanList(links, url)],
    [1, "url:http://example.com[6,17,21] url:https://www.android.com/path?q=1[21,53,21] url:mailto:user@example.com[60,76,21]"]);
  const tel = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "Call +1 650-253-0000 or 555.");
  same("phone", [await scall(L, "addLinks", "(Landroid/text/Spannable;I)Z", tel, 4), await spanList(tel, url)], [1, "url:tel:+16502530000[5,20,21]"]);
});
