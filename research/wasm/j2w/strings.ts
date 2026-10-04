// java.lang.String as a JS string held in a reference slot (plan 3.4). Every reference slot is an `anyref`: Java objects are
// struct subtypes of $Obj, a String is the JS string reached through any.convert_extern. `StringRepr` is the whole surface the
// rest of the compiler uses, so the struct-over-i16-array alternative (gate G5) replaces this file and nothing else.
import { Code, OP } from "./code";
import { T, ref, refNull, type VT } from "./wasmbin";
import { kindOf } from "./program";
import { H } from "./consts";
import { parseMethodDesc } from "../../../src/jvm/abi";
import type { Compiler, Intrinsic } from "./j2w";

/** abstract heap types as ref.test/ref.cast immediates */
export const HT = { extern: -17, any: -18, eq: -19 } as const;
const STRING = "java/lang/String";
/** the imported table (after the function table) holding the String constants, shared by all modules */
const STR_TABLE = 1;

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
}

const BUILTINS = ["length", "charCodeAt", "concat", "substring", "equals", "test", "fromCharCodeArray", "intoCharCodeArray"] as const;
type Builtin = (typeof BUILTINS)[number];

export class JsStrings implements StringRepr {
  b = {} as Record<Builtin, number>;
  private factories = new Map<string, number | undefined>();
  constructor(private cx: Compiler) {}

  isString(cls: string): boolean { return cls === STRING; }
  literal(c: Code, s: string): void { c.i32(this.cx.w.stringId(s)).tableGet(STR_TABLE).anyConvertExtern(); }
  vtab(c: Code, decl: string): void {
    if (this.cx.prog.isSubclass(STRING, decl)) c.call(this.cx.helper("vtab")); else c.refCast(this.cx.tObj).structGet(this.cx.tObj, 0);
  }
  noFields(decl: string, field: string): void {
    if (decl === STRING) throw new Error(`String.${field}: a field of the representation`);
  }

  importBuiltins(): void {
    const { mb, tData } = this.cx, E = T.externref, S = ref(HT.extern), I = T.i32, A = refNull(tData.i16);
    const sigs: Record<Builtin, [VT[], VT[]]> = {
      length: [[E], [I]], charCodeAt: [[E, I], [I]], concat: [[E, E], [S]], substring: [[E, I, I], [S]], equals: [[E, E], [I]], test: [[E], [I]],
      fromCharCodeArray: [[A, I, I], [S]], intoCharCodeArray: [[E, A, I], [I]],
    };
    for (const n of BUILTINS) this.b[n] = mb.importFunc("wasm:js-string", n, mb.addFuncType(sigs[n][0], sigs[n][1]));
  }

  factory(desc: string): number | undefined {
    if (!this.factories.has(desc)) this.factories.set(desc, this.makeFactory(desc));
    return this.factories.get(desc);
  }
  private makeFactory(desc: string): number | undefined {
    const { cx, b } = this, { params } = parseMethodDesc(desc), npe = (c: Code) => { c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); };
    const c = new Code(params.length), fromChars = (data: number, from: () => void, to: () => void) => { c.lget(data); from(); to(); c.call(b.fromCharCodeArray).anyConvertExtern(); };
    const charData = () => { npe(c); return c.newLocal(refNull(cx.tData.i16)); };
    switch (desc) {
      case "()V": this.literal(c, ""); break;
      case "(Ljava/lang/String;)V": npe(c); c.lget(0); break;
      case "([C)V": {
        const d = charData(); c.lget(0).refCast(cx.tArr.i16).structGet(cx.tArr.i16, 2).lset(d);
        fromChars(d, () => c.i32(0), () => c.lget(d).refAsNonNull().arrayLen()); break;
      }
      case "([CII)V": {
        const d = charData(), len = c.newLocal(T.i32);
        c.lget(0).refCast(cx.tArr.i16).structGet(cx.tArr.i16, 2).lset(d).lget(d).refAsNonNull().arrayLen().lset(len);
        c.lget(1).i32(0).raw(OP.i32_lt_s).lget(2).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(1).lget(len).lget(2).raw(OP.i32_sub).raw(OP.i32_gt_s).raw(OP.i32_or)
          .if_().lget(1).lget(2).lget(len); cx.callThrower(c, "sioobe"); c.end();
        fromChars(d, () => c.lget(1), () => c.lget(1).lget(2).raw(OP.i32_add)); break;
      }
      case "([BB)V": {
        // the compact form StringLatin1 and StringUTF16 build: coder 0 holds a char per byte, coder 1 two, low byte first
        npe(c);
        const bytes = cx.tData.i8, d = c.newLocal(refNull(bytes)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), out = c.newLocal(refNull(cx.tData.i16));
        c.lget(0).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).lset(d).lget(d).refAsNonNull().arrayLen().lset(n);
        c.lget(1).if_().lget(n).i32(1).raw(OP.i32_shr_s).lset(n).end();
        c.lget(n).arrayNewDefault(cx.tData.i16).lset(out);
        const byte = (index: () => void) => { c.lget(d).refAsNonNull(); index(); c.arrayGetU(bytes); };
        c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1).lget(out).refAsNonNull().lget(i);
        c.lget(1).if_(T.i32);
        byte(() => c.lget(i).i32(1).raw(OP.i32_shl)); byte(() => c.lget(i).i32(1).raw(OP.i32_shl).i32(1).raw(OP.i32_add)); c.i32(8).raw(OP.i32_shl).raw(OP.i32_or);
        c.else_(); byte(() => c.lget(i)); c.end();
        c.arraySet(cx.tData.i16).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
        c.lget(out).refAsNonNull().i32(0).lget(n).call(b.fromCharCodeArray).anyConvertExtern(); break;
      }
      default: { const ctor = cx.prog.get(STRING)?.byKey.get("<init>" + desc); return ctor && cx.natives.factory(cx, ctor); }
    }
    return cx.mb.addFunc(cx.sig(params.map(kindOf), "L"), c.finish(), `String.<init>${desc}`);
  }
}

/** a Compiler's module-local helpers over strings: the vtable of any object, reference equality, hashCode and compareTo */
export function stringHelper(cx: Compiler, name: string, t: (p: VT[], r: VT[]) => number): [number, () => number[]] | undefined {
  const { b } = cx.str as JsStrings, A = T.anyref;
  switch (name) {
    // a struct carries its vtable, anything else is a String
    case "vtab": return [t([A], [ref(cx.tVT)]), () => {
      const c = new Code(1);
      c.lget(0).refTest(cx.tObj).if_(ref(cx.tVT)).lget(0).refCast(cx.tObj).structGet(cx.tObj, 0).else_().gget(cx.vtGlobal(STRING)).refAsNonNull().end();
      return c.finish();
    }];
    // identity for structs, value for strings (as the JS tier compares)
    case "acmp": return [t([A, A], [T.i32]), () => {
      const c = new Code(2);
      c.lget(0).refTest(HT.eq, true).if_(T.i32)
        .lget(1).refTest(HT.eq, true).if_(T.i32).lget(0).refCast(HT.eq, true).lget(1).refCast(HT.eq, true).refEq().else_().i32(0).end()
        .else_()
        .lget(1).refTest(HT.eq, true).if_(T.i32).i32(0).else_().lget(0).externConvertAny().lget(1).externConvertAny().call(b.equals).end()
        .end();
      return c.finish();
    }];
    // s[0]*31^(n-1) + ... in 32-bit arithmetic
    case "shash": return [t([A], [T.i32]), () => {
      const c = new Code(1), e = c.newLocal(T.externref), n = c.newLocal(T.i32), i = c.newLocal(T.i32), hv = c.newLocal(T.i32);
      c.lget(0).externConvertAny().lset(e).lget(e).call(b.length).lset(n);
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
        .lget(hv).i32(31).raw(OP.i32_mul).lget(e).lget(i).call(b.charCodeAt).raw(OP.i32_add).lset(hv)
        .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().lget(hv);
      return c.finish();
    }];
    // the first differing UTF-16 unit's difference, else the length difference
    case "scmp": return [t([A, A], [T.i32]), () => {
      const c = new Code(2), x = c.newLocal(T.externref), y = c.newLocal(T.externref), nx = c.newLocal(T.i32), ny = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32), d = c.newLocal(T.i32);
      c.lget(0).externConvertAny().lset(x).lget(1).externConvertAny().lset(y).lget(x).call(b.length).lset(nx).lget(y).call(b.length).lset(ny);
      c.lget(nx).lget(ny).raw(OP.i32_lt_s).if_(T.i32).lget(nx).else_().lget(ny).end().lset(n);
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
        .lget(x).lget(i).call(b.charCodeAt).lget(y).lget(i).call(b.charCodeAt).raw(OP.i32_sub).ltee(d).if_().lget(d).ret().end()
        .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().lget(nx).lget(ny).raw(OP.i32_sub);
      return c.finish();
    }];
  }
  return undefined;
}

/** a String constructor is never called: each call site makes the String with `factory` */
export const stringCtor: Intrinsic = (cx, m, c) => { c.unreachable(); };

/** String methods that read the representation, as Wasm over the js-string builtins; where Java's behaviour is an exception they
 *  call the production native (natives.ts), which raises it */
export const stringIntrinsics = new Map<string, Intrinsic>();
{
  const def = (key: string, f: Intrinsic) => stringIntrinsics.set(`${STRING}.${key}`, f);
  const B = (cx: Compiler) => (cx.str as JsStrings).b;
  const nonNull = (cx: Compiler, c: Code, l: number) => { c.lget(l).refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); };
  const lenOf = (cx: Compiler, c: Code, l: number) => c.lget(l).externConvertAny().call(B(cx).length);

  def("length()I", (cx, m, c) => { lenOf(cx, c, 0); });
  def("isEmpty()Z", (cx, m, c) => { lenOf(cx, c, 0).raw(OP.i32_eqz); });
  def("hashCode()I", (cx, m, c) => { c.lget(0).call(cx.helper("shash")); });
  def("toString()Ljava/lang/String;", (cx, m, c) => { c.lget(0); });
  def("intern()Ljava/lang/String;", (cx, m, c) => { c.lget(0); });
  def("charAt(I)C", (cx, m, c) => {
    c.lget(1); lenOf(cx, c, 0); c.raw(OP.i32_lt_u).if_(T.i32).lget(0).externConvertAny().lget(1).call(B(cx).charCodeAt).else_(); cx.natives.call(cx, c, m); c.end();
  });
  def("equals(Ljava/lang/Object;)Z", (cx, m, c) => {
    c.lget(1).externConvertAny().call(B(cx).test).if_(T.i32).lget(0).externConvertAny().lget(1).externConvertAny().call(B(cx).equals).else_().i32(0).end();
  });
  const compare = (check: boolean): Intrinsic => (cx, m, c) => {
    nonNull(cx, c, 1);
    if (check) {
      c.lget(1).externConvertAny().call(B(cx).test).raw(OP.i32_eqz).if_()
        .lget(1).call(cx.helper("vtab")).i32(H.ID).arrayGet(cx.tVT).i32(cx.idOf(STRING)); cx.callThrower(c, "cce"); c.end();
    }
    c.lget(0).lget(1).call(cx.helper("scmp"));
  };
  def("compareTo(Ljava/lang/String;)I", compare(false));
  def("compareTo(Ljava/lang/Object;)I", compare(true));
  def("concat(Ljava/lang/String;)Ljava/lang/String;", (cx, m, c) => {
    nonNull(cx, c, 1); c.lget(0).externConvertAny().lget(1).externConvertAny().call(B(cx).concat).anyConvertExtern();
  });
  // substring: in range here, otherwise the production native raises its StringIndexOutOfBoundsException
  const sub = (to: (cx: Compiler, c: Code) => void): Intrinsic => (cx, m, c) => {
    c.lget(1).i32(0).raw(OP.i32_ge_s); to(cx, c); lenOf(cx, c, 0).raw(OP.i32_le_s).raw(OP.i32_and);
    c.lget(1); to(cx, c); c.raw(OP.i32_le_s).raw(OP.i32_and);
    c.if_(T.anyref).lget(0).externConvertAny().lget(1); to(cx, c); c.call(B(cx).substring).anyConvertExtern().else_(); cx.natives.call(cx, c, m); c.end();
  };
  const end = (cx: Compiler, c: Code) => { c.lget(2); };
  def("substring(II)Ljava/lang/String;", sub(end));
  def("fastSubstring(II)Ljava/lang/String;", sub(end));
  def("substring(I)Ljava/lang/String;", sub((cx, c) => { lenOf(cx, c, 0); }));
  // the compact-string internals libcore's builders use: each char to a byte (coder 0) or two, low byte first (coder 1), from byte index `at`
  const fill = (width: 1 | 2): Intrinsic => (cx, m, c) => {
    const d = c.newLocal(refNull(cx.tData.i8)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), ch = c.newLocal(T.i32);
    nonNull(cx, c, 1);
    c.lget(1).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).lset(d);
    lenOf(cx, c, 0).lset(n);
    c.lget(2).i32(0).raw(OP.i32_lt_s).lget(2).lget(n).i32(width === 1 ? 0 : 1).raw(OP.i32_shl).raw(OP.i32_add).lget(d).refAsNonNull().arrayLen().raw(OP.i32_gt_s).raw(OP.i32_or)
      .if_().lget(2).lget(d).refAsNonNull().arrayLen(); cx.callThrower(c, "aioobe"); c.end();
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
      .lget(0).externConvertAny().lget(i).call(B(cx).charCodeAt).lset(ch);
    const at = (k: number) => { c.lget(d).refAsNonNull().lget(2).lget(i).i32(width === 1 ? 0 : 1).raw(OP.i32_shl).raw(OP.i32_add); if (k) c.i32(k).raw(OP.i32_add); };
    at(0); c.lget(ch).arraySet(cx.tData.i8);
    if (width === 2) { at(1); c.lget(ch).i32(8).raw(OP.i32_shr_u).arraySet(cx.tData.i8); }
    c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  };
  def("fillBytesLatin1([BI)V", fill(1));
  def("fillBytesUTF16([BI)V", fill(2));
  def("getCharsNoCheck(II[CI)V", (cx, m, c) => {
    nonNull(cx, c, 3);
    c.lget(0).externConvertAny().lget(1).lget(2).call(B(cx).substring).lget(3).refCast(cx.tArr.i16).structGet(cx.tArr.i16, 2).lget(4).call(B(cx).intoCharCodeArray).drop();
  });
  def("toCharArray()[C", (cx, m, c) => {
    const t = cx.tArr.i16, d = cx.tData.i16, n = c.newLocal(T.i32), a = c.newLocal(refNull(d));
    lenOf(cx, c, 0).lset(n).lget(n).arrayNewDefault(d).lset(a);
    c.lget(0).externConvertAny().lget(a).i32(0).call(B(cx).intoCharCodeArray).drop();
    c.gget(cx.vtGlobal("[C")).refAsNonNull().i32(0).lget(a).refAsNonNull().structNew(t);
  });
}
