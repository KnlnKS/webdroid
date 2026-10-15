// The String constructors that turn bytes into chars, for either representation of String: the compact form StringLatin1 builds, the
// deprecated hibyte forms, and the charset forms. ASCII (any byte below 0x80, the same chars in UTF-8, US-ASCII and ISO-8859-1) is
// widened here; anything else, and every argument the constructors reject, is the production implementation (natives.ts).
import { Code, OP } from "../compiler/code";
import { T, ref } from "../compiler/wasmbin";
import { kindOf } from "../compiler/program";
import { parseMethodDesc } from "../../jvm/abi";
import type { Compiler } from "../compiler/j2w";
import type { StructStrings } from "./strings";

const CHARSET = "java/nio/charset/Charset";

/** the factory for constructor `desc` when it decodes bytes, or undefined for another constructor; `host` is the production factory (or undefined) */
export function bytesFactory(cx: Compiler, t: StructStrings, desc: string, host: number | undefined): number | undefined {
  const { params } = parseMethodDesc(desc), chars = cx.tData.i16, bytes = cx.tData.i8;
  const hibyte = desc === "([BI)V" || desc === "([BIII)V", compact = desc === "([BB)V";
  const isCharset = desc.endsWith("Charset;)V"), named = isCharset || desc.startsWith("([B") && desc.endsWith("String;)V");
  const ranged = desc === "([BII)V" || desc === "([BIII)V" || desc.startsWith("([BIIL");
  if (!hibyte && !compact && !named && desc !== "([B)V" && desc !== "([BII)V") return undefined;
  if (!compact && host === undefined) return undefined;
  const offAt = desc === "([BIII)V" ? 2 : 1, countAt = offAt + 1, csAt = ranged ? 3 : 1;
  const c = new Code(params.length);
  const d = c.newLocal(ref(bytes)), from = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32), acc = c.newLocal(T.i32), b = c.newLocal(T.i32), out = c.newLocal(ref(chars)), name = c.newLocal(T.anyref);
  const done = () => { c.lget(out).call(t.mk()); return cx.mb.addFunc(cx.sig(params.map(kindOf), "L"), c.finish(), `String.<init>${desc}`); };
  const viaHost = () => { params.forEach((_, k) => c.lget(k)); c.call(host!).ret(); };
  const npe = () => { c.lget(0).refIsNull().if_(); if (compact) cx.callThrower(c, "npe"); else viaHost(); c.end(); };
  const outOfRange = () => c.lget(offAt).i32(0).raw(OP.i32_lt_s).lget(countAt).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(offAt).lget(n).lget(countAt).raw(OP.i32_sub).raw(OP.i32_gt_s).raw(OP.i32_or);
  npe();
  c.lget(0).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).lset(d);
  c.lget(d).arrayLen().lset(n);
  if (named) {
    c.lget(csAt).refIsNull().if_(); viaHost(); c.end();
    if (isCharset) {
      const charset = cx.structFor(CHARSET), field = cx.fieldIndex(CHARSET, { owner: CHARSET, name: "name", desc: "Ljava/lang/String;" });
      c.lget(csAt).refCast(charset).structGet(charset, field).lset(name);
    } else c.lget(csAt).lset(name);
    c.lget(name).refIsNull().if_(); viaHost(); c.end();
    // the canonical names of the three charsets whose ASCII is the chars themselves
    const is = (text: string) => { c.lget(name); t.literal(c, text); c.call(t.equals()); };
    is("UTF-8"); is("US-ASCII"); c.raw(OP.i32_or); is("ISO-8859-1"); c.raw(OP.i32_or).raw(OP.i32_eqz).if_(); viaHost(); c.end();
  }
  if (compact) {
    // coder 0 holds a char per byte, coder 1 two, low byte first
    c.lget(1).if_().lget(n).i32(1).raw(OP.i32_shr_s).lset(n).end();
    c.lget(n).call(t.newCharsKnown()).lset(out);
    const byte = (index: () => void) => { c.lget(d); index(); c.arrayGetU(bytes); };
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1).lget(out).lget(i);
    c.lget(1).if_(T.i32);
    byte(() => c.lget(i).i32(1).raw(OP.i32_shl)); byte(() => c.lget(i).i32(1).raw(OP.i32_shl).i32(1).raw(OP.i32_add)); c.i32(8).raw(OP.i32_shl).raw(OP.i32_or);
    c.else_(); byte(() => c.lget(i)); c.end();
    c.arraySet(chars).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
    return done();
  }
  if (ranged) {
    outOfRange().if_(); viaHost(); c.end();
    c.lget(offAt).lset(from).lget(countAt).lset(n);
  }
  c.lget(n).call(t.newCharsKnown()).lset(out);
  // a hibyte constructor puts its byte (as a char) under the high byte; the others reject what is not ASCII after the loop
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
    .lget(d).lget(from).lget(i).raw(OP.i32_add).arrayGetU(bytes).lset(b);
  if (hibyte) c.lget(out).lget(i).lget(1).i32(0xff).raw(OP.i32_and).i32(8).raw(OP.i32_shl).lget(b).raw(OP.i32_or).arraySet(chars);
  else c.lget(out).lget(i).lget(b).arraySet(chars).lget(acc).lget(b).raw(OP.i32_or).lset(acc);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  if (!hibyte) { c.lget(acc).i32(0x80).raw(OP.i32_and).if_(); viaHost(); c.end(); }
  return done();
}
