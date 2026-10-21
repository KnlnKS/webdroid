// java.lang.String as a struct over an i16 array: the chars, the cached hash code and, once the host has asked
// for it, the JS string. A String is then an Object like any other (it carries its vtable), so a virtual call needs no test for it,
// and character access is an array access instead of a call of a wasm:js-string builtin. A native sees the JS string, made and
// cached on first use; a JS string a native answers is copied into an array once.
import { Code, OP } from "./code.ts";
import { HT, T, ref, refNull, type VT } from "./wasmbin.ts";
import { kindOf } from "./program.ts";
import { parseMethodDesc } from "../../jvm/abi.ts";
import type { Compiler } from "./j2w.ts";
import { bytesFactory } from "./strfactory.ts";
import type { DexFile } from "../../jvm/dex.ts";
import type { PreparedInstruction } from "../../jvm/prepared.ts";

export const STRING = "java/lang/String";
/** field indices of the struct after the Object header (0, 1) */
const CHARS = 2, HASH = 3, JS = 4;

/** how `ins` makes a String, which has no constructor: its allocation (new-instance), which holds null until the constructor call (invoke-direct
 *  String.<init>), which the String's factory takes the place of. No loader defines a String of its own, so the dex's name is the class */
export function stringSite(dex: DexFile, ins: PreparedInstruction): "alloc" | "init" | undefined {
  if (ins.op === 0x22) return dex.type(ins.b) === "Ljava/lang/String;" ? "alloc" : undefined;
  if (ins.op !== 0x70 && ins.op !== 0x76) return undefined;
  const m = dex.method(ins.b);
  return m.name === "<init>" && dex.type(m.cls) === "Ljava/lang/String;" ? "init" : undefined;
}

export class StructStrings {
  private cx: Compiler;
  private b = {} as { length: number; fromCharCodeArray: number; intoCharCodeArray: number };
  constructor(cx: Compiler) { this.cx = cx; }

  /** A constant is made on first use and kept in a global of the module that uses it: the interned String of the JS string the engine imports as a constant.
   *  The test is inline, as a call of a function per constant costs the engine a compile and its baseline code a call. */
  literal(c: Code, s: string): void {
    const cx = this.cx, g = cx.memo("lit:" + s, () => cx.mb.defineGlobal(T.anyref, true, [0xd0, 0x6e]));
    c.block(T.anyref).ggetDefined(g).brOnNonNull(0);
    if (s.isWellFormed()) c.gget(cx.stringConst(s));
    else {
      // a name in an import section is UTF-8, which cannot hold a lone surrogate: the UTF-16 units come from a data segment
      const units = cx.memo("litdata:" + s, () => cx.mb.addDataPassive(Uint8Array.from({ length: 2 * s.length }, (_, i) => (s.charCodeAt(i >> 1) >> (8 * (i & 1))) & 255)));
      c.i32(0).i32(s.length).arrayNewData(cx.tData.i16, units).i32(0).i32(s.length).call(this.b.fromCharCodeArray);
    }
    c.call(this.fn("lit", [T.externref], [T.anyref], (b) => { b.lget(0).call(this.fromJs()).call(this.intern()); })).gsetDefined(g).ggetDefined(g).end();
  }
  /** intern(s) -> the String the host holds for these chars (this one if it has none) */
  intern(): number {
    return this.fn("intern", [T.anyref], [T.anyref], (c) => {
      c.lget(0).call(this.toJs()).lget(0).externConvertAny().call(this.cx.imp.intern).anyConvertExtern();
    });
  }
  /** turns the String on the stack into the JS string a native takes (null stays null), and a JS string a native answers into a String */
  toHost(c: Code): void { c.call(this.toJs()); }
  fromHost(c: Code): void { c.call(this.fromJs()); }

  /** imports the string builtins; before any function of the module is defined */
  importBuiltins(): void {
    const { mb, tData } = this.cx, E = T.externref, I = T.i32, A = refNull(tData.i16);
    this.b.length = mb.importFunc("wasm:js-string", "length", { params: [E], results: [I] });
    this.b.fromCharCodeArray = mb.importFunc("wasm:js-string", "fromCharCodeArray", { params: [A, I, I], results: [ref(HT.extern)] });
    this.b.intoCharCodeArray = mb.importFunc("wasm:js-string", "intoCharCodeArray", { params: [E, A, I], results: [I] });
  }

  // ---------- functions of the module
  /** a function of this module, defined on first use under `key` */
  private fn(key: string, params: VT[], results: VT[], body: (c: Code) => void): number { return this.cx.defineFn("s:" + key, params, results, body, true); }
  private get st(): number { return this.cx.tStr; }
  private get chars(): number { return this.cx.tData.i16; }
  /** pushes the char array of the String in local `l` */
  charsOf(c: Code, l: number): Code { return c.lget(l).refCast(this.st).structGet(this.st, CHARS); }
  lenOf(c: Code, l: number): Code { return this.charsOf(c, l).arrayLen(); }
  npe(c: Code, l: number): void { c.lget(l).refIsNull().if_(); this.cx.callThrower(c, "npe"); c.end(); }

  /** newChars(n) -> (ref $chars): a zeroed array of n chars, through the allocation budget */
  newChars(): number {
    return this.fn("newChars", [T.i32], [ref(this.chars)], (c) => { c.lget(0).i32(1).call(this.cx.helper("newLen")).arrayNewDefault(this.chars); });
  }
  /** newCharsKnown(n) -> (ref $chars): as newChars for a length that is no larger than an array that exists, so it only counts the allocation */
  newCharsKnown(): number {
    return this.fn("newCharsKnown", [T.i32], [ref(this.chars)], (c) => {
      const g = this.cx.global("rt", "alloc", T.i32, true);
      c.gget(g).lget(0).i32(1).raw(OP.i32_shl).raw(OP.i32_add).gset(g).gget(g).i32(0).raw(OP.i32_ge_s).if_().call(this.cx.helper("allocSlow")).end();
      c.lget(0).arrayNewDefault(this.chars);
    });
  }
  /** mk(chars) -> String */
  mk(): number {
    return this.fn("mk", [ref(this.chars)], [ref(this.st)], (c) => {
      this.cx.w.allocated.add(STRING);
      c.gget(this.cx.vtGlobal(STRING)).refAsNonNull().i64(0n).lget(0).i32(0).refNull(HT.extern).structNew(this.st);
    });
  }
  /** sub(s, from, n) -> String: the chars [from, from + n), the String itself when that is all of them */
  sub(): number {
    return this.fn("sub", [T.anyref, T.i32, T.i32], [T.anyref], (c) => {
      const out = c.newLocal(ref(this.chars));
      c.lget(1).raw(OP.i32_eqz).lget(2); this.lenOf(c, 0); c.raw(OP.i32_eq, OP.i32_and).if_().lget(0).ret().end();
      c.lget(2).call(this.newCharsKnown()).lset(out);
      c.lget(out).i32(0); this.charsOf(c, 0); c.lget(1).lget(2).arrayCopy(this.chars, this.chars);
      c.lget(out).call(this.mk());
    });
  }
  /** toJs(s) -> externref: the JS string of the String, made once */
  private toJs(): number {
    return this.fn("toJs", [T.anyref], [T.externref], (c) => {
      const s = c.newLocal(ref(this.st)), js = c.newLocal(T.externref);
      c.lget(0).refIsNull().if_().refNull(HT.extern).ret().end();
      c.lget(0).refCast(this.st).lset(s);
      c.lget(s).structGet(this.st, JS).ltee(js).refIsNull().raw(OP.i32_eqz).if_().lget(js).ret().end();
      c.lget(s).structGet(this.st, CHARS).i32(0).lget(s).structGet(this.st, CHARS).arrayLen().call(this.b.fromCharCodeArray).lset(js);
      c.lget(s).lget(js).structSet(this.st, JS).lget(js);
    });
  }
  /** fromJs(e) -> String: the chars of a JS string, which the String keeps as its own JS string */
  fromJs(): number {
    return this.fn("fromJs", [T.externref], [T.anyref], (c) => {
      const chars = c.newLocal(ref(this.chars)), s = c.newLocal(ref(this.st));
      c.lget(0).refIsNull().if_().anyNull().ret().end();
      c.lget(0).call(this.b.length).call(this.newChars()).lset(chars);
      c.lget(0).lget(chars).i32(0).call(this.b.intoCharCodeArray).drop();
      c.lget(chars).call(this.mk()).lset(s).lget(s).lget(0).structSet(this.st, JS).lget(s);
    });
  }
  /** hash(s) -> int: s[0]*31^(n-1) + ... in 32-bit arithmetic, kept in the String */
  hash(): number {
    return this.fn("hash", [T.anyref], [T.i32], (c) => {
      const h = c.newLocal(T.i32), i = c.newLocal(T.i32), n = c.newLocal(T.i32), a = c.newLocal(ref(this.chars));
      c.lget(0).refCast(this.st).structGet(this.st, HASH).ltee(h).if_().lget(h).ret().end();
      this.charsOf(c, 0).lset(a).lget(a).arrayLen().lset(n);
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
        .lget(h).i32(31).raw(OP.i32_mul).lget(a).lget(i).arrayGetU(this.chars).raw(OP.i32_add).lset(h)
        .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
      c.lget(0).refCast(this.st).lget(h).structSet(this.st, HASH).lget(h);
    });
  }
  /** equals(a, b) -> boolean: the same String, or one of the same chars */
  equals(): number {
    return this.fn("equals", [T.anyref, T.anyref], [T.i32], (c) => {
      const x = c.newLocal(ref(this.st)), y = c.newLocal(ref(this.st)), a = c.newLocal(ref(this.chars)), b = c.newLocal(ref(this.chars)), i = c.newLocal(T.i32), n = c.newLocal(T.i32);
      c.lget(1).refTest(this.st).raw(OP.i32_eqz).if_().i32(0).ret().end();
      c.lget(0).refCast(this.st).lset(x).lget(1).refCast(this.st).lset(y);
      c.lget(x).lget(y).refEq().if_().i32(1).ret().end();
      c.lget(x).structGet(this.st, CHARS).lset(a).lget(y).structGet(this.st, CHARS).lset(b);
      c.lget(a).arrayLen().ltee(n).lget(b).arrayLen().raw(OP.i32_ne).if_().i32(0).ret().end();
      // both hashes known and different
      c.lget(x).structGet(this.st, HASH).lget(y).structGet(this.st, HASH).raw(OP.i32_ne)
        .lget(x).structGet(this.st, HASH).i32(0).raw(OP.i32_ne).raw(OP.i32_and).lget(y).structGet(this.st, HASH).i32(0).raw(OP.i32_ne).raw(OP.i32_and).if_().i32(0).ret().end();
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
        .lget(a).lget(i).arrayGetU(this.chars).lget(b).lget(i).arrayGetU(this.chars).raw(OP.i32_ne).if_().i32(0).ret().end()
        .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().i32(1);
    });
  }
  /** compare(a, b) -> int: the first differing unit's difference, else the length difference */
  compare(): number {
    return this.fn("compare", [T.anyref, T.anyref], [T.i32], (c) => {
      const a = c.newLocal(ref(this.chars)), b = c.newLocal(ref(this.chars)), na = c.newLocal(T.i32), nb = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32), d = c.newLocal(T.i32);
      this.charsOf(c, 0).lset(a); this.charsOf(c, 1).lset(b);
      c.lget(a).arrayLen().lset(na).lget(b).arrayLen().lset(nb);
      c.lget(na).lget(nb).raw(OP.i32_lt_s).if_(T.i32).lget(na).else_().lget(nb).end().lset(n);
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
        .lget(a).lget(i).arrayGetU(this.chars).lget(b).lget(i).arrayGetU(this.chars).raw(OP.i32_sub).ltee(d).if_().lget(d).ret().end()
        .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().lget(na).lget(nb).raw(OP.i32_sub);
    });
  }

  // ---------- constructors
  private factories = new Map<string, number | undefined>();
  /** the function making a String the way constructor `desc` does (its parameters in, the String out), or undefined */
  factory(desc: string): number | undefined {
    if (!this.factories.has(desc)) this.factories.set(desc, this.makeFactory(desc));
    return this.factories.get(desc);
  }
  private makeFactory(desc: string): number | undefined {
    const cx = this.cx, { params } = parseMethodDesc(desc), chars = this.chars, ctor = cx.prog.get(STRING)?.byKey.get("<init>" + desc);
    const host = () => ctor && cx.natives.factory(cx, ctor);
    const decoder = bytesFactory(cx, this, desc, desc === "([BB)V" ? undefined : host());
    if (decoder !== undefined) return decoder;
    const make = (name: string, body: (c: Code) => void) => {
      const c = new Code(params.length);
      body(c);
      return cx.mb.addFunc(cx.sig(params.map(kindOf), "L"), c.finish(), name);
    };
    const data = (c: Code, l: number, kind: "i8" | "i16") => c.lget(l).refCast(cx.tArr[kind]).structGet(cx.tArr[kind], 2);
    /** the String of n chars of the char[] in local `src` from `from` */
    const copy = (c: Code, src: number, from: () => void, n: () => void) => {
      const out = c.newLocal(ref(chars));
      n(); c.call(this.newCharsKnown()).lset(out);
      c.lget(out).i32(0); data(c, src, "i16"); from(); n(); c.arrayCopy(chars, chars);
      c.lget(out).call(this.mk());
    };
    const outOfRange = (c: Code, off: number, count: number, len: number) =>
      c.lget(off).i32(0).raw(OP.i32_lt_s).lget(count).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(off).lget(len).lget(count).raw(OP.i32_sub).raw(OP.i32_gt_s).raw(OP.i32_or);
    switch (desc) {
      case "()V": return make("String.<init>()V", (c) => { c.i32(0).call(this.newChars()).call(this.mk()); });
      // a new object with the chars of the old one
      case "(Ljava/lang/String;)V": return make("String.<init>(String)V", (c) => {
        this.npe(c, 0);
        c.gget(cx.vtGlobal(STRING)).refAsNonNull().i64(0n).lget(0).refCast(cx.tStr).structGet(cx.tStr, CHARS).lget(0).refCast(cx.tStr).structGet(cx.tStr, HASH).refNull(HT.extern).structNew(cx.tStr);
      });
      case "([C)V": return make("String.<init>([C)V", (c) => {
        this.npe(c, 0);
        copy(c, 0, () => c.i32(0), () => data(c, 0, "i16").arrayLen());
      });
      case "([CII)V": return make("String.<init>([CII)V", (c) => {
        this.npe(c, 0);
        const len = c.newLocal(T.i32);
        data(c, 0, "i16").arrayLen().lset(len);
        outOfRange(c, 1, 2, len).if_().lget(1).lget(2).lget(len); cx.callThrower(c, "sioobe"); c.end();
        copy(c, 0, () => c.lget(1), () => c.lget(2));
      });
      // the hidden constructor libcore's case mapping uses: a range of a char[] it filled itself, so the range needs no check
      case "(II[C)V": return make("String.<init>(II[C)V", (c) => { copy(c, 2, () => c.lget(0), () => c.lget(1)); });
      // the builders are final classes: their toString is the String the constructor makes
      case "(Ljava/lang/StringBuffer;)V": case "(Ljava/lang/StringBuilder;)V": {
        const to = cx.prog.resolve(desc.slice(2, -3), "toString", "()Ljava/lang/String;");
        return to ? make("String.<init>" + desc, (c) => { this.npe(c, 0); c.lget(0); cx.callMethod(c, to); }) : host();
      }
      default: return host();
    }
  }
}
