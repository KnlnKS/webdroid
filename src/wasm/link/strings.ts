// java.lang.String as a struct over an i16 array: the chars, the cached hash code and, once the host has asked
// for it, the JS string. A String is then an Object like any other (it carries its vtable), so a virtual call needs no test for it,
// and character access is an array access instead of a call of a wasm:js-string builtin. A native sees the JS string, made and
// cached on first use; a JS string a native answers is copied into an array once.
import { Code, OP } from "../compiler/code";
import { HT, T, ref, refNull, type VT } from "../compiler/wasmbin";
import { kindOf } from "../compiler/program";
import { H } from "../compiler/consts";
import { parseMethodDesc } from "../../jvm/abi";
import type { Compiler, Intrinsic } from "../compiler/j2w";
import { bytesFactory } from "./strfactory";
import { rt } from "../compiler/rtfns";

export interface StringRepr {
  /** imports the string builtins; before any function of the module is defined */
  importBuiltins(): void;
  /** pushes the String constant `s` */
  literal(c: Code, s: string): void;
  isString(cls: string): boolean;
  /** leaves the vtable of the receiver on the stack (anyref in) of a call declared on `decl` */
  vtab(c: Code, decl: string): void;
  /** the representation has no instance fields: reading or writing one of String's is not translated */
  noFields(decl: string, field: string): void;
  /** the function making a String the way constructor `desc` does (its parameters in, the String out), or undefined */
  factory(desc: string): number | undefined;
  /** turns the String on the stack into the JS string a native takes (null stays null), and a JS string a native answers into a String */
  toHost(c: Code): void;
  fromHost(c: Code): void;
  /** a module-local helper over references (vtab, acmp, shash), see Compiler.helper */
  helper(name: string, t: (p: VT[], r: VT[]) => number): [number, () => number[]] | undefined;
}

/** a String constructor is never called: each call site makes the String with `factory` */
export const stringCtor: Intrinsic = (cx, m, c) => { c.unreachable(); };

const STRING = "java/lang/String";
/** field indices of the struct after the Object header (0, 1) */
const CHARS = 2, HASH = 3, JS = 4;

export class StructStrings implements StringRepr {
  private b = {} as { length: number; fromCharCodeArray: number; intoCharCodeArray: number };
  constructor(private cx: Compiler) {}

  isString(cls: string): boolean { return cls === STRING; }
  noFields(decl: string, field: string): void {
    if (decl === STRING) throw new Error(`String.${field}: a field of the representation`);
  }
  vtab(c: Code, _decl: string): void { c.refCast(this.cx.tObj).structGet(this.cx.tObj, 0); }
  /** a constant is made on first use and kept in a global of the module that uses it: the interned String of the JS string the engine imports as a constant */
  literal(c: Code, s: string): void {
    const cx = this.cx;
    c.call(cx.memo("lit:" + s, () => {
      const f = cx.mb.reserveFunc(cx.mb.addFuncType([], [T.anyref]), "$lit"), js = s.isWellFormed() ? cx.stringConst(s) : -1, fromJs = this.fromJs(), intern = this.intern();
      // a defined global's index follows every imported global, so the global, and the body that names it, wait for the module's last import
      cx.atFinish(() => {
        const g = cx.mb.addGlobal(T.anyref, true, [0xd0, 0x6e]), b = new Code(0);
        b.gget(g).refIsNull().if_();
        if (js >= 0) b.gget(js);
        else {
          // a name in an import section is UTF-8, which cannot hold a lone surrogate: the UTF-16 units come from a data segment
          const units = Uint8Array.from({ length: 2 * s.length }, (_, i) => (s.charCodeAt(i >> 1) >> (8 * (i & 1))) & 255);
          b.i32(0).i32(s.length).arrayNewData(cx.tData.i16, cx.mb.addDataPassive(units)).i32(0).i32(s.length).call(this.b.fromCharCodeArray);
        }
        b.call(fromJs).call(intern).gset(g).end().gget(g);
        cx.mb.setBody(f, b.finish());
      });
      return f;
    }));
  }
  /** intern(s) -> the String the host holds for these chars (this one if it has none) */
  intern(): number {
    return this.fn("intern", [T.anyref], [T.anyref], (c) => {
      c.lget(0).call(this.toJs()).lget(0).externConvertAny().call(this.cx.imp.intern).anyConvertExtern();
    });
  }
  toHost(c: Code): void { c.call(this.toJs()); }
  fromHost(c: Code): void { c.call(this.fromJs()); }

  importBuiltins(): void {
    const { mb, tData } = this.cx, E = T.externref, I = T.i32, A = refNull(tData.i16);
    this.b.length = mb.importFunc("wasm:js-string", "length", { params: [E], results: [I] });
    this.b.fromCharCodeArray = mb.importFunc("wasm:js-string", "fromCharCodeArray", { params: [A, I, I], results: [ref(HT.extern)] });
    this.b.intoCharCodeArray = mb.importFunc("wasm:js-string", "intoCharCodeArray", { params: [E, A, I], results: [I] });
  }

  // ---------- functions of the module
  /** a function of this module, defined on first use under `key` */
  private fn(key: string, params: VT[], results: VT[], body: (c: Code) => void): number {
    const mb = this.cx.mb;
    return this.cx.memo("s:" + key, () => {
      const f = mb.reserveFunc(mb.addFuncType(params, results), "$s:" + key), c = new Code(params.length);
      body(c);
      mb.setBody(f, c.finish());
      return f;
    }, () => mb.addFuncType(params, results));
  }
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
  newKnown(): number { return this.newCharsKnown(); }
  finish(c: Code, out: number): void { c.lget(out).call(this.mk()); }
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

  helper(name: string, t: (p: VT[], r: VT[]) => number): [number, () => number[]] | undefined {
    const A = T.anyref;
    switch (name) {
      case "vtab": return [t([A], [ref(this.cx.tVT)]), () => new Code(1).lget(0).refCast(this.cx.tObj).structGet(this.cx.tObj, 0).finish()];
      // every non-null reference is an Object: identity
      case "acmp": return [t([A, A], [T.i32]), () => new Code(2).lget(0).refCast(HT.eq, true).lget(1).refCast(HT.eq, true).refEq().finish()];
      case "shash": return [t([A], [T.i32]), () => new Code(1).lget(0).call(this.hash()).finish()];
    }
    return undefined;
  }

  // ---------- constructors
  private factories = new Map<string, number | undefined>();
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

/** String methods that read the representation, as Wasm over the char array; where Java's behaviour is an exception they call the
 *  production native (natives.ts), which raises it */
export const stringIntrinsics = new Map<string, Intrinsic>();
{
  const def = (key: string, f: Intrinsic) => stringIntrinsics.set(`${STRING}.${key}`, f);
  const S = (cx: Compiler) => cx.str as StructStrings;

  def("length()I", (cx, m, c) => { S(cx).lenOf(c, 0); });
  def("isEmpty()Z", (cx, m, c) => { S(cx).lenOf(c, 0).raw(OP.i32_eqz); });
  def("hashCode()I", (cx, m, c) => { c.lget(0).call(S(cx).hash()); });
  def("toString()Ljava/lang/String;", (cx, m, c) => { c.lget(0); });
  def("intern()Ljava/lang/String;", (cx, m, c) => { c.lget(0); cx.str.toHost(c); c.lget(0).externConvertAny().call(cx.imp.intern).anyConvertExtern(); });
  def("charAt(I)C", (cx, m, c) => {
    c.lget(1); S(cx).lenOf(c, 0); c.raw(OP.i32_lt_u).if_(T.i32); S(cx).charsOf(c, 0).lget(1).arrayGetU(cx.tData.i16); c.else_(); cx.natives.call(cx, c, m); c.end();
  });
  def("equals(Ljava/lang/Object;)Z", (cx, m, c) => { c.lget(0).lget(1).call(S(cx).equals()); });
  const compare = (check: boolean): Intrinsic => (cx, m, c) => {
    S(cx).npe(c, 1);
    if (check) {
      c.lget(1).refTest(cx.tStr).raw(OP.i32_eqz).if_()
        .lget(1).call(cx.helper("vtab")).i32(H.ID).arrayGet(cx.tVT).i32(cx.idOf(STRING)); cx.callThrower(c, "cce"); c.end();
    }
    c.lget(0).lget(1).call(S(cx).compare());
  };
  def("compareTo(Ljava/lang/String;)I", compare(false));
  def("compareTo(Ljava/lang/Object;)I", compare(true));
  def("concat(Ljava/lang/String;)Ljava/lang/String;", (cx, m, c) => {
    const s = S(cx), out = c.newLocal(ref(cx.tData.i16)), n = c.newLocal(T.i32);
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
    const s = S(cx);
    c.lget(1).i32(0).raw(OP.i32_ge_s); to(cx, c); s.lenOf(c, 0).raw(OP.i32_le_s).raw(OP.i32_and);
    c.lget(1); to(cx, c); c.raw(OP.i32_le_s).raw(OP.i32_and);
    c.if_(T.anyref).lget(0).lget(1); to(cx, c); c.lget(1).raw(OP.i32_sub).call(s.sub()).else_(); cx.natives.call(cx, c, m); c.end();
  };
  const end = (cx: Compiler, c: Code) => { c.lget(2); };
  def("substring(II)Ljava/lang/String;", sub(end));
  def("fastSubstring(II)Ljava/lang/String;", sub(end));
  def("substring(I)Ljava/lang/String;", sub((cx, c) => { S(cx).lenOf(c, 0); }));
  // the compact-string internals libcore's builders use: each char to a byte (coder 0) or two, low byte first (coder 1), from byte index `at`
  const fill = (width: 1 | 2): Intrinsic => (cx, m, c) => {
    const s = S(cx), d = c.newLocal(ref(cx.tData.i8)), a = c.newLocal(ref(cx.tData.i16)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), ch = c.newLocal(T.i32);
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
    const s = S(cx);
    s.npe(c, 3);
    c.lget(3).refCast(cx.tArr.i16).structGet(cx.tArr.i16, 2).lget(4); s.charsOf(c, 0).lget(1).lget(2).lget(1).raw(OP.i32_sub).arrayCopy(cx.tData.i16, cx.tData.i16);
  });
  def("toCharArray()[C", (cx, m, c) => {
    const s = S(cx), t = cx.tArr.i16, a = c.newLocal(ref(cx.tData.i16));
    s.lenOf(c, 0).call(s.newCharsKnown()).lset(a);
    c.lget(a).i32(0); s.charsOf(c, 0).i32(0); s.lenOf(c, 0); c.arrayCopy(cx.tData.i16, cx.tData.i16);
    c.gget(cx.vtGlobal("[C")).refAsNonNull().i64(0n).lget(a).structNew(t);
  });
  // 1 when some char does not fit a byte
  def("coder()B", (cx, m, c) => {
    const s = S(cx), a = c.newLocal(ref(cx.tData.i16)), i = c.newLocal(T.i32), n = c.newLocal(T.i32);
    s.charsOf(c, 0).lset(a); c.lget(a).arrayLen().lset(n);
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
      .lget(a).lget(i).arrayGetU(cx.tData.i16).i32(0xff).raw(OP.i32_gt_u).if_().i32(1).ret().end()
      .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().i32(0);
  });
}

// AbstractStringBuilder.putStringAt(index, str): str's chars into value at index, as one pass instead of coder() and getBytes; a char
// that does not fit a byte makes the builder UTF-16 first (inflate), then every char of str is written as two bytes, low byte first
stringIntrinsics.set("java/lang/AbstractStringBuilder.putStringAt(ILjava/lang/String;)V", (cx, m, c) => {
  const s = cx.str as StructStrings, ASB = "java/lang/AbstractStringBuilder", st = cx.structFor(ASB), field = (name: string, desc: string) => cx.fieldIndex(ASB, { owner: ASB, name, desc });
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
    const s = cx.str as StructStrings, W = wide ? T.i64 : T.i32, u = c.newLocal(W), len = c.newLocal(T.i32), i = c.newLocal(T.i32), neg = c.newLocal(T.i32), out = c.newLocal(ref(cx.tData.i16)), t = c.newLocal(W);
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
    const s = cx.str as StructStrings, ci = cx.tData.i16, a = c.newLocal(ref(ci)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), neg = c.newLocal(T.i32), d = c.newLocal(T.i32), acc = c.newLocal(wide ? T.i64 : T.i32);
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
rt("strLit", ["L"], "L", (cx, c) => { const s = cx.str as StructStrings; c.lget(0).externConvertAny().call(s.fromJs()).call(s.intern()); });
