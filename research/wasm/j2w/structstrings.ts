// java.lang.String as a struct over an i16 array (plan 3.4 and gate G5): the chars, the cached hash code and, once the host has asked
// for it, the JS string. A String is then an Object like any other (it carries its vtable), so a virtual call needs no test for it,
// and character access is an array access instead of a call of a wasm:js-string builtin. A native sees the JS string, made and
// cached on first use; a JS string a native answers is copied into an array once.
import { Code, OP } from "./code";
import { T, ref, refNull, type VT } from "./wasmbin";
import { kindOf } from "./program";
import { H } from "./consts";
import { parseMethodDesc } from "../../../src/jvm/abi";
import type { Compiler, Intrinsic } from "./j2w";
import { HT, type StringRepr } from "./strings";

const STRING = "java/lang/String";
/** the imported table (after the function table) holding the String constants, shared by all modules */
const STR_TABLE = 1;
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
  /** the constants are String objects the host put in the shared table (World.stringId) */
  literal(c: Code, s: string): void { c.i32(this.cx.w.stringId(s)).tableGet(STR_TABLE).anyConvertExtern(); }
  toHost(c: Code): void { c.call(this.toJs()); }
  fromHost(c: Code): void { c.call(this.fromJs()); }

  importBuiltins(): void {
    const { mb, tData } = this.cx, E = T.externref, I = T.i32, A = refNull(tData.i16);
    this.b.length = mb.importFunc("wasm:js-string", "length", mb.addFuncType([E], [I]));
    this.b.fromCharCodeArray = mb.importFunc("wasm:js-string", "fromCharCodeArray", mb.addFuncType([A, I, I], [ref(HT.extern)]));
    this.b.intoCharCodeArray = mb.importFunc("wasm:js-string", "intoCharCodeArray", mb.addFuncType([E, A, I], [I]));
  }

  // ---------- functions of the module
  /** a function of this module, defined on first use under `key` */
  private fn(key: string, params: VT[], results: VT[], body: (c: Code) => void): number {
    return this.cx.memo("s:" + key, () => {
      const mb = this.cx.mb, f = mb.reserveFunc(mb.addFuncType(params, results), "$s:" + key), c = new Code(params.length);
      body(c);
      mb.setBody(f, c.finish());
      return f;
    });
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
  /** mk(chars) -> String */
  mk(): number {
    return this.fn("mk", [ref(this.chars)], [ref(this.st)], (c) => {
      this.cx.w.allocated.add(STRING);
      c.gget(this.cx.vtGlobal(STRING)).refAsNonNull().i32(0).lget(0).i32(0).refNull(HT.extern).structNew(this.st);
    });
  }
  /** sub(s, from, n) -> String: the chars [from, from + n), the String itself when that is all of them */
  sub(): number {
    return this.fn("sub", [T.anyref, T.i32, T.i32], [T.anyref], (c) => {
      const out = c.newLocal(ref(this.chars));
      c.lget(1).raw(OP.i32_eqz).lget(2); this.lenOf(c, 0); c.raw(OP.i32_eq, OP.i32_and).if_().lget(0).ret().end();
      c.lget(2).call(this.newChars()).lset(out);
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
  private fromJs(): number {
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
    const make = (name: string, body: (c: Code) => void) => {
      const c = new Code(params.length);
      body(c);
      return cx.mb.addFunc(cx.sig(params.map(kindOf), "L"), c.finish(), name);
    };
    const data = (c: Code, l: number, kind: "i8" | "i16") => c.lget(l).refCast(cx.tArr[kind]).structGet(cx.tArr[kind], 2);
    /** the String of n chars of the char[] in local `src` from `from` */
    const copy = (c: Code, src: number, from: () => void, n: () => void) => {
      const out = c.newLocal(ref(chars));
      n(); c.call(this.newChars()).lset(out);
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
        c.gget(cx.vtGlobal(STRING)).refAsNonNull().i32(0).lget(0).refCast(cx.tStr).structGet(cx.tStr, CHARS).lget(0).refCast(cx.tStr).structGet(cx.tStr, HASH).refNull(HT.extern).structNew(cx.tStr);
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
      // the compact form StringLatin1 and StringUTF16 build: coder 0 holds a char per byte, coder 1 two, low byte first
      case "([BB)V": return make("String.<init>([BB)V", (c) => {
        this.npe(c, 0);
        const bytes = cx.tData.i8, d = c.newLocal(ref(bytes)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), out = c.newLocal(ref(chars));
        data(c, 0, "i8").lset(d);
        c.lget(d).arrayLen().lset(n);
        c.lget(1).if_().lget(n).i32(1).raw(OP.i32_shr_s).lset(n).end();
        c.lget(n).call(this.newChars()).lset(out);
        const byte = (index: () => void) => { c.lget(d); index(); c.arrayGetU(bytes); };
        c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1).lget(out).lget(i);
        c.lget(1).if_(T.i32);
        byte(() => c.lget(i).i32(1).raw(OP.i32_shl)); byte(() => c.lget(i).i32(1).raw(OP.i32_shl).i32(1).raw(OP.i32_add)); c.i32(8).raw(OP.i32_shl).raw(OP.i32_or);
        c.else_(); byte(() => c.lget(i)); c.end();
        c.arraySet(chars).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
        c.lget(out).call(this.mk());
      });
      // bytes of the default charset (UTF-8): ASCII is the chars themselves, anything else is the host's decoder
      case "([B)V": case "([BII)V": {
        const h = host();
        if (h === undefined) return undefined;
        return make(`String.<init>${desc}`, (c) => {
          const d = c.newLocal(ref(cx.tData.i8)), from = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32), acc = c.newLocal(T.i32), b = c.newLocal(T.i32), out = c.newLocal(ref(chars));
          const viaHost = () => { params.forEach((_, k) => c.lget(k)); c.call(h).ret(); };
          c.lget(0).refIsNull().if_(); viaHost(); c.end();
          data(c, 0, "i8").lset(d);
          c.lget(d).arrayLen().lset(n);
          if (desc === "([BII)V") {
            outOfRange(c, 1, 2, n).if_(); viaHost(); c.end();
            c.lget(1).lset(from).lget(2).lset(n);
          }
          c.lget(n).call(this.newChars()).lset(out);
          c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
            .lget(d).lget(from).lget(i).raw(OP.i32_add).arrayGetU(cx.tData.i8).lset(b)
            .lget(out).lget(i).lget(b).arraySet(chars).lget(acc).lget(b).raw(OP.i32_or).lset(acc)
            .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
          c.lget(acc).i32(0x80).raw(OP.i32_and).if_(); viaHost(); c.end();
          c.lget(out).call(this.mk());
        });
      }
      default: return host();
    }
  }
}

/** String methods that read the representation, as Wasm over the char array; where Java's behaviour is an exception they call the
 *  production native (natives.ts), which raises it */
export const structIntrinsics = new Map<string, Intrinsic>();
{
  const def = (key: string, f: Intrinsic) => structIntrinsics.set(`${STRING}.${key}`, f);
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
    s.lenOf(c, 0).call(s.newChars()).lset(a);
    c.lget(a).i32(0); s.charsOf(c, 0).i32(0); s.lenOf(c, 0); c.arrayCopy(cx.tData.i16, cx.tData.i16);
    c.gget(cx.vtGlobal("[C")).refAsNonNull().i32(0).lget(a).structNew(t);
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
