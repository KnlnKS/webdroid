// The ASCII range of the java.lang.Character natives, which the production runtime answers the same way before it asks ICU4J's
// UCharacter (jicu.ts characterNatives). Other code points need UCharacter's property data and stay a recorded gap.
import { OP } from "./code";
import { T } from "./wasmbin";
import type { Compiler, Intrinsic } from "./j2w";
import { mid } from "./reach";

export const charIntrinsics = new Map<string, Intrinsic>();
{
  type Emit = (cx: Compiler, c: import("./code").Code) => void;
  const ascii = (key: string, ret: T.i32, body: Emit) => charIntrinsics.set(`java/lang/Character.${key}`, (cx, m, c) => {
    c.lget(0).i32(128).raw(OP.i32_lt_u).if_(ret); body(cx, c); c.else_(); cx.gap(c, `${mid(m)}: code point beyond ASCII`); c.end();
  });
  // c - base <u n
  const within = (c: import("./code").Code, base: number, n: number) => c.lget(0).i32(base).raw(OP.i32_sub).i32(n).raw(OP.i32_lt_u);
  const digit: Emit = (cx, c) => { within(c, 48, 10); };
  const upper: Emit = (cx, c) => { within(c, 65, 26); };
  const lower: Emit = (cx, c) => { within(c, 97, 26); };
  const letter: Emit = (cx, c) => { c.lget(0).i32(32).raw(OP.i32_or).i32(97).raw(OP.i32_sub).i32(26).raw(OP.i32_lt_u); };
  ascii("isDigitImpl(I)Z", T.i32, digit);
  ascii("isUpperCaseImpl(I)Z", T.i32, upper);
  ascii("isLowerCaseImpl(I)Z", T.i32, lower);
  ascii("isLetterImpl(I)Z", T.i32, letter);
  ascii("isLetterOrDigitImpl(I)Z", T.i32, (cx, c) => { letter(cx, c); digit(cx, c); c.raw(OP.i32_or); });
  // UCharacter.digit(ch, radix): the decimal digit or the Latin letter's 10 + index when below a radix of 2 to 36, else -1
  ascii("digitImpl(II)I", T.i32, (cx, c) => {
    const v = c.newLocal(T.i32);
    digit(cx, c); c.if_(T.i32).lget(0).i32(48).raw(OP.i32_sub).else_();
    letter(cx, c); c.if_(T.i32).lget(0).i32(32).raw(OP.i32_or).i32(87).raw(OP.i32_sub).else_().i32(-1).end().end().lset(v);
    c.lget(1).i32(2).raw(OP.i32_ge_s).lget(1).i32(36).raw(OP.i32_le_s).raw(OP.i32_and).lget(v).lget(1).raw(OP.i32_lt_s).raw(OP.i32_and)
      .if_(T.i32).lget(v).else_().i32(-1).end();
  });
  // simple case mappings: the title case of an ASCII letter is its upper case
  ascii("toLowerCaseImpl(I)I", T.i32, (cx, c) => { upper(cx, c); c.if_(T.i32).lget(0).i32(32).raw(OP.i32_add).else_().lget(0).end(); });
  for (const k of ["toUpperCaseImpl(I)I", "toTitleCaseImpl(I)I"]) ascii(k, T.i32, (cx, c) => { lower(cx, c); c.if_(T.i32).lget(0).i32(-32).raw(OP.i32_add).else_().lget(0).end(); });
  // Java's white space: the controls 9 to 13 and 28 to 31, and the space; its space separators in ASCII: the space
  ascii("isWhitespaceImpl(I)Z", T.i32, (cx, c) => { within(c, 9, 5); within(c, 28, 4); c.raw(OP.i32_or).lget(0).i32(32).raw(OP.i32_eq).raw(OP.i32_or); });
  ascii("isSpaceCharImpl(I)Z", T.i32, (cx, c) => { c.lget(0).i32(32).raw(OP.i32_eq); });
}
