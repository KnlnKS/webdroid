// java.lang.String's methods over the struct representation (compiler/strings.ts): the reads of its chars as Wasm, and the String results of
// Integer and Long.
import { OP } from "../compiler/code.ts";
import { T, ref, refNull } from "../compiler/wasmbin.ts";
import { H } from "../compiler/consts.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import { rt } from "../compiler/rtfns.ts";
import { STRING } from "../compiler/strings.ts";

/** String methods that read the representation, as Wasm over the char array; where Java's behaviour is an exception they call the
 *  production native (natives.ts), which raises it */
export const stringIntrinsics = new Map<string, Intrinsic>();
{
  const def = (key: string, f: Intrinsic) => stringIntrinsics.set(`${STRING}.${key}`, f);

  def("length()I", (cx, m, c) => { cx.str.lenOf(c, 0); });
  def("isEmpty()Z", (cx, m, c) => { cx.str.lenOf(c, 0).raw(OP.i32_eqz); });
  def("hashCode()I", (cx, m, c) => { c.lget(0).call(cx.str.hash()); });
  def("toString()Ljava/lang/String;", (cx, m, c) => { c.lget(0); });
  def("intern()Ljava/lang/String;", (cx, m, c) => { c.lget(0); cx.str.toHost(c); c.lget(0).externConvertAny().call(cx.imp.intern).anyConvertExtern(); });
  def("charAt(I)C", (cx, m, c) => {
    c.lget(1); cx.str.lenOf(c, 0); c.raw(OP.i32_lt_u).if_(T.i32); cx.str.charsOf(c, 0).lget(1).arrayGetU(cx.tData.i16); c.else_(); cx.natives.call(cx, c, m); c.end();
  });
  def("equals(Ljava/lang/Object;)Z", (cx, m, c) => { c.lget(0).lget(1).call(cx.str.equals()); });
  const compare = (check: boolean): Intrinsic => (cx, m, c) => {
    cx.str.npe(c, 1);
    if (check) {
      c.lget(1).refTest(cx.tStr).raw(OP.i32_eqz).if_()
        .lget(1).call(cx.helper("vtab")).i32(H.ID).arrayGet(cx.tVT).i32(cx.idOf(STRING)); cx.callThrower(c, "cce"); c.end();
    }
    c.lget(0).lget(1).call(cx.str.compare());
  };
  def("compareTo(Ljava/lang/String;)I", compare(false));
  def("compareTo(Ljava/lang/Object;)I", compare(true));
  def("concat(Ljava/lang/String;)Ljava/lang/String;", (cx, m, c) => {
    const s = cx.str, out = c.newLocal(ref(cx.tData.i16)), n = c.newLocal(T.i32);
    s.npe(c, 1);
    s.lenOf(c, 1).raw(OP.i32_eqz).if_().lget(0).ret().end();
    s.lenOf(c, 0); s.lenOf(c, 1); c.raw(OP.i32_add).lset(n);
    c.lget(n).call(s.newChars()).lset(out);
    c.lget(out).i32(0); s.charsOf(c, 0).i32(0); s.lenOf(c, 0); c.arrayCopy(cx.tData.i16, cx.tData.i16);
    c.lget(out); s.lenOf(c, 0); s.charsOf(c, 1).i32(0); s.lenOf(c, 1); c.arrayCopy(cx.tData.i16, cx.tData.i16);
    c.lget(out).call(s.mk());
  });
  // substring: in range here, otherwise the production native raises its StringIndexOutOfBoundsException
  const sub = (to: (cx: Compiler, c: Code) => void): Intrinsic => (cx, m, c) => {
    const s = cx.str;
    c.lget(1).i32(0).raw(OP.i32_ge_s); to(cx, c); s.lenOf(c, 0).raw(OP.i32_le_s).raw(OP.i32_and);
    c.lget(1); to(cx, c); c.raw(OP.i32_le_s).raw(OP.i32_and);
    c.if_(T.anyref).lget(0).lget(1); to(cx, c); c.lget(1).raw(OP.i32_sub).call(s.sub()).else_(); cx.natives.call(cx, c, m); c.end();
  };
  const end = (cx: Compiler, c: Code) => { c.lget(2); };
  def("substring(II)Ljava/lang/String;", sub(end));
  def("fastSubstring(II)Ljava/lang/String;", sub(end));
  def("substring(I)Ljava/lang/String;", sub((cx, c) => { cx.str.lenOf(c, 0); }));
  // the compact-string internals libcore's builders use: each char to a byte (coder 0) or two, low byte first (coder 1), from byte index `at`
  const fill = (width: 1 | 2): Intrinsic => (cx, m, c) => {
    const s = cx.str, d = c.newLocal(ref(cx.tData.i8)), a = c.newLocal(ref(cx.tData.i16)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), ch = c.newLocal(T.i32);
    s.npe(c, 1);
    c.lget(1).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).lset(d);
    s.charsOf(c, 0).lset(a); c.lget(a).arrayLen().lset(n);
    c.lget(2).i32(0).raw(OP.i32_lt_s).lget(2).lget(n).i32(width === 1 ? 0 : 1).raw(OP.i32_shl).raw(OP.i32_add).lget(d).arrayLen().raw(OP.i32_gt_s).raw(OP.i32_or)
      .if_().lget(2).lget(d).arrayLen(); cx.callThrower(c, "aioobe"); c.end();
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
      .lget(a).lget(i).arrayGetU(cx.tData.i16).lset(ch);
    const at = (k: number) => { c.lget(d).lget(2).lget(i).i32(width === 1 ? 0 : 1).raw(OP.i32_shl).raw(OP.i32_add); if (k) c.i32(k).raw(OP.i32_add); };
    at(0); c.lget(ch).arraySet(cx.tData.i8);
    if (width === 2) { at(1); c.lget(ch).i32(8).raw(OP.i32_shr_u).arraySet(cx.tData.i8); }
    c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  };
  def("fillBytesLatin1([BI)V", fill(1));
  def("fillBytesUTF16([BI)V", fill(2));
  def("getCharsNoCheck(II[CI)V", (cx, m, c) => {
    const s = cx.str;
    s.npe(c, 3);
    c.lget(3).refCast(cx.tArr.i16).structGet(cx.tArr.i16, 2).lget(4); s.charsOf(c, 0).lget(1).lget(2).lget(1).raw(OP.i32_sub).arrayCopy(cx.tData.i16, cx.tData.i16);
  });
  def("toCharArray()[C", (cx, m, c) => {
    const s = cx.str, t = cx.tArr.i16, a = c.newLocal(ref(cx.tData.i16));
    s.lenOf(c, 0).call(s.newCharsKnown()).lset(a);
    c.lget(a).i32(0); s.charsOf(c, 0).i32(0); s.lenOf(c, 0); c.arrayCopy(cx.tData.i16, cx.tData.i16);
    c.gget(cx.vtGlobal("[C")).refAsNonNull().i64(0n).lget(a).structNew(t);
  });
  // 1 when some char does not fit a byte
  def("coder()B", (cx, m, c) => {
    const s = cx.str, a = c.newLocal(ref(cx.tData.i16)), i = c.newLocal(T.i32), n = c.newLocal(T.i32);
    s.charsOf(c, 0).lset(a); c.lget(a).arrayLen().lset(n);
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
      .lget(a).lget(i).arrayGetU(cx.tData.i16).i32(0xff).raw(OP.i32_gt_u).if_().i32(1).ret().end()
      .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().i32(0);
  });
}

// AbstractStringBuilder.putStringAt(index, str): str's chars into value at index, as one pass instead of coder() and getBytes; a char
// that does not fit a byte makes the builder UTF-16 first (inflate), then every char of str is written as two bytes, low byte first
stringIntrinsics.set("java/lang/AbstractStringBuilder.putStringAt(ILjava/lang/String;)V", (cx, m, c) => {
  const s = cx.str, ASB = "java/lang/AbstractStringBuilder", st = cx.structFor(ASB), field = (name: string, desc: string) => cx.fieldIndex(ASB, { owner: ASB, name, desc });
  const VALUE = field("value", "[B"), CODER = field("coder", "B"), inflate = cx.prog.resolve(ASB, "inflate", "()V");
  if (!inflate) { cx.gap(c, "AbstractStringBuilder.inflate"); return; }
  const a = c.newLocal(ref(cx.tData.i16)), d = c.newLocal(refNull(cx.tData.i8)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), ch = c.newLocal(T.i32);
  const value = () => c.lget(0).refCast(st).structGet(st, VALUE).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).lset(d);
  s.charsOf(c, 2).lset(a); c.lget(a).arrayLen().lset(n);
  c.lget(0).refCast(st).structGet(st, CODER).raw(OP.i32_eqz).if_();
  value();
  c.block().block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
    .lget(a).lget(i).arrayGetU(cx.tData.i16).ltee(ch).i32(0xff).raw(OP.i32_gt_u).brIf(2)
    .lget(d).refAsNonNull().lget(1).lget(i).raw(OP.i32_add).lget(ch).arraySet(cx.tData.i8)
    .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().ret().end();
  c.lget(0); cx.callMethod(c, inflate);
  c.end();
  value();
  c.i32(0).lset(i);
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
    .lget(a).lget(i).arrayGetU(cx.tData.i16).lset(ch)
    .lget(d).refAsNonNull().lget(1).lget(i).raw(OP.i32_add).i32(1).raw(OP.i32_shl).lget(ch).arraySet(cx.tData.i8)
    .lget(d).refAsNonNull().lget(1).lget(i).raw(OP.i32_add).i32(1).raw(OP.i32_shl).i32(1).raw(OP.i32_add).lget(ch).i32(8).raw(OP.i32_shr_u).arraySet(cx.tData.i8)
    .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
});

// Integer.toString(int) and Long.toString(long) in base 10, written into a char array; parseInt(String) and parseLong(String) of an optional
// minus and up to 9 (18) digits, where anything else (a sign, a radix, a number too long to be safe, a bad digit) is the library method with its exceptions
{
  const def = (key: string, f: Intrinsic) => stringIntrinsics.set(key, f);
  const toStr = (wide: boolean): Intrinsic => (cx, m, c) => {
    const s = cx.str, W = wide ? T.i64 : T.i32, u = c.newLocal(W), len = c.newLocal(T.i32), i = c.newLocal(T.i32), neg = c.newLocal(T.i32), out = c.newLocal(ref(cx.tData.i16)), t = c.newLocal(W);
    const k = (n: number) => (wide ? c.i64(BigInt(n)) : c.i32(n));
    const op = (i32op: number, i64op: number) => c.raw(wide ? i64op : i32op);
    const divU = () => op(0x6e, 0x80), remU = () => op(0x70, 0x82);
    // the magnitude as an unsigned number: negating MIN_VALUE wraps to itself, which unsigned division reads right
    c.lget(0); k(0); op(OP.i32_lt_s, OP.i64_lt_s); c.lset(neg);
    c.lget(neg).if_(W); k(0); c.lget(0); op(OP.i32_sub, OP.i64_sub); c.else_().lget(0).end().lset(u);
    c.lget(neg).lset(len).lget(u).lset(t);
    c.block().loop().lget(len).i32(1).raw(OP.i32_add).lset(len).lget(t); k(10); divU(); c.ltee(t); k(0); op(OP.i32_ne, OP.i64_ne).brIf(0).end().end();
    c.lget(len).call(s.newCharsKnown()).lset(out).lget(len).lset(i);
    c.block().loop().lget(i).i32(1).raw(OP.i32_sub).lset(i)
      .lget(out).lget(i).lget(u); k(10); remU(); if (wide) c.raw(OP.i32_wrap_i64); c.i32(48).raw(OP.i32_add).arraySet(cx.tData.i16);
    c.lget(u); k(10); divU(); c.ltee(u); k(0); op(OP.i32_ne, OP.i64_ne).brIf(0).end().end();
    c.lget(neg).if_().lget(out).i32(0).i32(45).arraySet(cx.tData.i16).end();
    c.lget(out).call(s.mk());
  };
  def("java/lang/Integer.toString(I)Ljava/lang/String;", toStr(false));
  def("java/lang/Long.toString(J)Ljava/lang/String;", toStr(true));
  const parse = (wide: boolean): Intrinsic => (cx, m, c) => {
    const s = cx.str, ci = cx.tData.i16, a = c.newLocal(ref(ci)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), neg = c.newLocal(T.i32), d = c.newLocal(T.i32), acc = c.newLocal(wide ? T.i64 : T.i32);
    const owner = wide ? "java/lang/Long" : "java/lang/Integer", slow = cx.prog.resolve(owner, wide ? "parseLong" : "parseInt", `(Ljava/lang/String;I)${wide ? "J" : "I"}`);
    if (!slow) { cx.gap(c, owner + ".parse"); return; }
    const max = wide ? 18 : 9, fallback = () => { c.lget(0).i32(10); cx.callMethod(c, slow); c.ret(); };
    c.lget(0).refIsNull().if_(); fallback(); c.end();
    s.charsOf(c, 0).lset(a); c.lget(a).arrayLen().lset(n);
    c.lget(n).raw(OP.i32_eqz).if_(); fallback(); c.end();
    c.lget(a).i32(0).arrayGetU(ci).i32(45).raw(OP.i32_eq).lset(neg);
    c.lget(neg).lset(i);
    // at least one digit, at most max
    c.lget(n).lget(i).raw(OP.i32_sub).i32(max).raw(OP.i32_gt_s).lget(n).lget(i).raw(OP.i32_eq).raw(OP.i32_or).if_(); fallback(); c.end();
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
      .lget(a).lget(i).arrayGetU(ci).i32(48).raw(OP.i32_sub).ltee(d).i32(9).raw(OP.i32_gt_u).if_(); fallback(); c.end();
    if (wide) c.lget(acc).i64(10n).raw(OP.i64_mul).lget(d).raw(OP.i64_extend_i32_u, OP.i64_add).lset(acc);
    else c.lget(acc).i32(10).raw(OP.i32_mul).lget(d).raw(OP.i32_add).lset(acc);
    c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
    c.lget(neg).if_(wide ? T.i64 : T.i32); if (wide) c.i64(0n).lget(acc).raw(OP.i64_sub); else c.i32(0).lget(acc).raw(OP.i32_sub);
    c.else_().lget(acc).end();
  };
  def("java/lang/Integer.parseInt(Ljava/lang/String;)I", parse(false));
  def("java/lang/Long.parseLong(Ljava/lang/String;)J", parse(true));
}

// strLit(js): the interned String of a JS string, for the class modules, which have no code of their own to make one
rt("strLit", ["L"], "L", (cx, c) => { const s = cx.str; c.lget(0).externConvertAny().call(s.fromJs()).call(s.intern()); });
