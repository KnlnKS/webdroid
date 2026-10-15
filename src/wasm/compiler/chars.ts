// The java.lang.Character natives, as java_lang_Character.cpp answers them with ICU4C: the ASCII range of the predicates text loops call inline,
// every other code point (and every property without an ASCII shortcut) by ICU4J's UCharacter, which reads the ICU property data through its own
// loaders. jicu.ts answers the natives this does not.
import { OP, type Code } from "./code";
import { T } from "./wasmbin";
import type { Compiler, Intrinsic } from "./j2w";
import { mid } from "./ids";
import { f64bits } from "./consts";

export const charIntrinsics = new Map<string, Intrinsic>();
const UCHARACTER = "android/icu/lang/UCharacter";
{
  type Emit = (cx: Compiler, c: Code) => void;
  /** `UCharacter.name`(desc) over the native's own parameters */
  const icu = (name: string, desc: string, ...extra: number[]): Intrinsic => (cx, m, c) => {
    const target = cx.prog.resolve(UCHARACTER, name, desc);
    if (!target) { cx.gap(c, `${mid(m)}: ${UCHARACTER} is not loaded`); return; }
    m.params.forEach((_, i) => c.lget(i)); extra.forEach((v) => c.i32(v));
    cx.callMethod(c, target);
  };
  const ascii = (key: string, ret: T.i32, body: Emit, name: string, desc: string) => charIntrinsics.set(`java/lang/Character.${key}`, (cx, m, c) => {
    c.lget(0).i32(128).raw(OP.i32_lt_u).if_(ret); body(cx, c); c.else_(); icu(name, desc)(cx, m, c); c.end();
  });
  // c - base <u n
  const within = (c: Code, base: number, n: number) => c.lget(0).i32(base).raw(OP.i32_sub).i32(n).raw(OP.i32_lt_u);
  const digit: Emit = (cx, c) => { within(c, 48, 10); };
  const upper: Emit = (cx, c) => { within(c, 65, 26); };
  const lower: Emit = (cx, c) => { within(c, 97, 26); };
  const letter: Emit = (cx, c) => { c.lget(0).i32(32).raw(OP.i32_or).i32(97).raw(OP.i32_sub).i32(26).raw(OP.i32_lt_u); };
  ascii("isDigitImpl(I)Z", T.i32, digit, "isDigit", "(I)Z");
  ascii("isUpperCaseImpl(I)Z", T.i32, upper, "isUpperCase", "(I)Z");
  ascii("isLowerCaseImpl(I)Z", T.i32, lower, "isLowerCase", "(I)Z");
  ascii("isLetterImpl(I)Z", T.i32, letter, "isLetter", "(I)Z");
  ascii("isLetterOrDigitImpl(I)Z", T.i32, (cx, c) => { letter(cx, c); digit(cx, c); c.raw(OP.i32_or); }, "isLetterOrDigit", "(I)Z");
  // UCharacter.digit(ch, radix): the decimal digit or the Latin letter's 10 + index when below a radix of 2 to 36, else -1
  ascii("digitImpl(II)I", T.i32, (cx, c) => {
    const v = c.newLocal(T.i32);
    digit(cx, c); c.if_(T.i32).lget(0).i32(48).raw(OP.i32_sub).else_();
    letter(cx, c); c.if_(T.i32).lget(0).i32(32).raw(OP.i32_or).i32(87).raw(OP.i32_sub).else_().i32(-1).end().end().lset(v);
    c.lget(1).i32(2).raw(OP.i32_ge_s).lget(1).i32(36).raw(OP.i32_le_s).raw(OP.i32_and).lget(v).lget(1).raw(OP.i32_lt_s).raw(OP.i32_and)
      .if_(T.i32).lget(v).else_().i32(-1).end();
  }, "digit", "(II)I");
  // simple case mappings: the title case of an ASCII letter is its upper case
  ascii("toLowerCaseImpl(I)I", T.i32, (cx, c) => { upper(cx, c); c.if_(T.i32).lget(0).i32(32).raw(OP.i32_add).else_().lget(0).end(); }, "toLowerCase", "(I)I");
  for (const [k, name] of [["toUpperCaseImpl(I)I", "toUpperCase"], ["toTitleCaseImpl(I)I", "toTitleCase"]]) ascii(k, T.i32, (cx, c) => { lower(cx, c); c.if_(T.i32).lget(0).i32(-32).raw(OP.i32_add).else_().lget(0).end(); }, name, "(I)I");
  // Java's white space: the controls 9 to 13 and 28 to 31, and the space; its space separators in ASCII: the space
  ascii("isWhitespaceImpl(I)Z", T.i32, (cx, c) => { within(c, 9, 5); within(c, 28, 4); c.raw(OP.i32_or).lget(0).i32(32).raw(OP.i32_eq).raw(OP.i32_or); }, "isWhitespace", "(I)Z");
  ascii("isSpaceCharImpl(I)Z", T.i32, (cx, c) => { c.lget(0).i32(32).raw(OP.i32_eq); }, "isSpaceChar", "(I)Z");
  // properties always asked of UCharacter
  for (const [key, name, desc] of [["isTitleCaseImpl(I)Z", "isTitleCase", "(I)Z"], ["isDefinedImpl(I)Z", "isDefined", "(I)Z"], ["isIdentifierIgnorableImpl(I)Z", "isIdentifierIgnorable", "(I)Z"],
    ["isMirroredImpl(I)Z", "isMirrored", "(I)Z"], ["isUnicodeIdentifierStartImpl(I)Z", "isUnicodeIdentifierStart", "(I)Z"], ["isUnicodeIdentifierPartImpl(I)Z", "isUnicodeIdentifierPart", "(I)Z"],
    ["getTypeImpl(I)I", "getType", "(I)I"], ["getDirectionalityImpl(I)B", "getDirection", "(I)I"], ["getNameImpl(I)Ljava/lang/String;", "getName", "(I)Ljava/lang/String;"],
    ["codePointOfImpl(Ljava/lang/String;)I", "getCharFromName", "(Ljava/lang/String;)I"]]) charIntrinsics.set(`java/lang/Character.${key}`, icu(name, desc));
  // UProperty.ALPHABETIC and IDEOGRAPHIC
  charIntrinsics.set("java/lang/Character.isAlphabeticImpl(I)Z", icu("hasBinaryProperty", "(II)Z", 0));
  charIntrinsics.set("java/lang/Character.isIdeographicImpl(I)Z", icu("hasBinaryProperty", "(II)Z", 17));
  // U_NO_NUMERIC_VALUE is -1; a value that is negative or not an integer is -2
  charIntrinsics.set("java/lang/Character.getNumericValueImpl(I)I", (cx, m, c) => {
    const target = cx.prog.resolve(UCHARACTER, "getUnicodeNumericValue", "(I)D"), v = c.newLocal(T.f64);
    if (!target) { cx.gap(c, `${mid(m)}: ${UCHARACTER} is not loaded`); return; }
    c.lget(0); cx.callMethod(c, target); c.raw(OP.f64_reinterpret_i64).lset(v);
    c.lget(v).f64const(f64bits(-123456789)).raw(OP.f64_eq).if_(T.i32).i32(-1).else_()
      .lget(v).f64const(f64bits(0)).raw(OP.f64_lt).lget(v).f64const(f64bits(0.5)).raw(OP.f64_add).raw(0x9c).lget(v).raw(OP.f64_ne).raw(OP.i32_or).if_(T.i32).i32(-2).else_().lget(v).raw(0xaa).end().end();
  });
}
