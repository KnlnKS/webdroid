// java.lang.String as a JS string held in a reference slot (plan 3.4). Every reference slot is an `anyref`: Java objects are
// struct subtypes of $Obj, a String is the JS string reached through any.convert_extern. `StringRepr` is the whole surface the
// rest of the compiler uses, so the struct-over-i16-array alternative (gate G5) replaces this class and nothing else.
import { Code, OP } from "./code";
import { T, ref, refNull, type VT } from "./wasmbin";
import { kindOf } from "./program";
import { parseMethodDesc } from "../../../src/jvm/abi";
import type { Compiler, Intrinsic } from "./j2w";

/** abstract heap types as ref.test/ref.cast immediates */
export const HT = { extern: -17, any: -18, eq: -19 } as const;
const STRING = "java/lang/String";
/** the table (after the function table) holding the string constants, filled by the host */
const STR_TABLE = 1;

export interface StringRepr {
  /** array classes the intrinsics allocate */
  arrays: string[];
  importBuiltins(): void;
  declare(add: (name: string, params: VT[], results: VT[]) => void): void;
  emit(): void;
  finish(): void;
  /** pushes the String constant `s` */
  literal(c: Code, s: string): void;
  /** the host-side values of the constant table */
  pool: string[];
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
  arrays = ["[C", "[B"];
  private consts = new Map<string, number>();
  b = {} as Record<Builtin, number>;
  constructor(private cx: Compiler) {}

  get pool(): string[] { return [...this.consts.keys()]; }
  isString(cls: string): boolean { return cls === STRING; }
  vtab(c: Code, decl: string): void {
    if (this.cx.prog.isSubclass(STRING, decl)) c.call(this.cx.helpers.vtab); else c.refCast(this.cx.tObj).structGet(this.cx.tObj, 0);
  }
  noFields(decl: string, field: string): void {
    if (decl === STRING) throw new Error(`String.${field}: a field of the representation`);
  }
  private factories = new Map<string, number | undefined>();
  factory(desc: string): number | undefined {
    if (!this.factories.has(desc)) this.factories.set(desc, this.makeFactory(desc));
    return this.factories.get(desc);
  }
  private makeFactory(desc: string): number | undefined {
    const { cx, b } = this, { params } = parseMethodDesc(desc), npe = (c: Code) => c.lget(0).refIsNull().if_().call(cx.helpers.npe).end();
    const c = new Code(params.length), fromChars = (data: number, from: () => void, to: () => void) => { c.lget(data); from(); to(); c.call(b.fromCharCodeArray).anyOfExtern(); };
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
          .if_().lget(1).lget(2).lget(len).call(cx.natives.helper.charsBounds).end();
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
        c.lget(out).refAsNonNull().i32(0).lget(n).call(b.fromCharCodeArray).anyOfExtern(); break;
      }
      default: return undefined;
    }
    return cx.mb.addFunc(cx.sig(params.map(kindOf), "L"), c.finish(), `String.<init>${desc}`);
  }

  importBuiltins(): void {
    const { mb, tData } = this.cx, E = T.externref, S = ref(HT.extern), I = T.i32, A = refNull(tData.i16);
    const sigs: Record<Builtin, [VT[], VT[]]> = {
      length: [[E], [I]], charCodeAt: [[E, I], [I]], concat: [[E, E], [S]], substring: [[E, I, I], [S]], equals: [[E, E], [I]], test: [[E], [I]],
      fromCharCodeArray: [[A, I, I], [S]], intoCharCodeArray: [[E, A, I], [I]],
    };
    for (const n of BUILTINS) this.b[n] = mb.importFunc("wasm:js-string", n, mb.addFuncType(sigs[n][0], sigs[n][1]));
  }

  literal(c: Code, s: string): void {
    let i = this.consts.get(s); if (i === undefined) this.consts.set(s, i = this.consts.size);
    c.i32(i).tableGet(STR_TABLE);
  }
  finish(): void {
    const { mb } = this.cx;
    if (mb.addTable(T.anyref, this.consts.size) !== STR_TABLE) throw new Error("string table must follow the function table");
    mb.export("strs", "table", STR_TABLE);
  }

  declare(add: (name: string, params: VT[], results: VT[]) => void): void {
    add("vtab", [T.anyref], [ref(this.cx.tVT)]);
    add("acmp", [T.anyref, T.anyref], [T.i32]);
    add("shash", [T.anyref], [T.i32]);
    add("scmp", [T.anyref, T.anyref], [T.i32]);
  }

  emit(): void {
    const { cx, b } = this, h = cx.helpers, mb = cx.mb;
    // the vtable of an object: a struct carries it, anything else is a String
    {
      const c = new Code(1);
      c.lget(0).refTest(cx.tObj).if_(ref(cx.tVT)).lget(0).refCast(cx.tObj).structGet(cx.tObj, 0).else_().gget(cx.vtGlobal.get(STRING)!).refAsNonNull().end();
      mb.setBody(h.vtab, c.finish());
    }
    // reference equality: identity for structs, value for strings (as the JS tier compares)
    {
      const c = new Code(2);
      c.lget(0).refTest(HT.eq, true).if_(T.i32)
        .lget(1).refTest(HT.eq, true).if_(T.i32).lget(0).refCast(HT.eq, true).lget(1).refCast(HT.eq, true).refEq().else_().i32(0).end()
        .else_()
        .lget(1).refTest(HT.eq, true).if_(T.i32).i32(0).else_().lget(0).externOfAny().lget(1).externOfAny().call(b.equals).end()
        .end();
      mb.setBody(h.acmp, c.finish());
    }
    // String.hashCode: s[0]*31^(n-1) + ... in 32-bit arithmetic
    {
      const c = new Code(1), e = c.newLocal(T.externref), n = c.newLocal(T.i32), i = c.newLocal(T.i32), hv = c.newLocal(T.i32);
      c.lget(0).externOfAny().lset(e).lget(e).call(b.length).lset(n);
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
        .lget(hv).i32(31).raw(OP.i32_mul).lget(e).lget(i).call(b.charCodeAt).raw(OP.i32_add).lset(hv)
        .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().lget(hv);
      mb.setBody(h.shash, c.finish());
    }
    // String.compareTo: the first differing UTF-16 unit's difference, else the length difference
    {
      const c = new Code(2), x = c.newLocal(T.externref), y = c.newLocal(T.externref), nx = c.newLocal(T.i32), ny = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32), d = c.newLocal(T.i32);
      c.lget(0).externOfAny().lset(x).lget(1).externOfAny().lset(y).lget(x).call(b.length).lset(nx).lget(y).call(b.length).lset(ny);
      c.lget(nx).lget(ny).raw(OP.i32_lt_s).if_(T.i32).lget(nx).else_().lget(ny).end().lset(n);
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
        .lget(x).lget(i).call(b.charCodeAt).lget(y).lget(i).call(b.charCodeAt).raw(OP.i32_sub).ltee(d).if_().lget(d).ret().end()
        .lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().lget(nx).lget(ny).raw(OP.i32_sub);
      mb.setBody(h.scmp, c.finish());
    }
  }
}

/** a String constructor is never called: each call site makes the String with `factory` */
export const stringCtor: Intrinsic = (cx, m, c) => { c.unreachable(); };

/** String methods that read the representation, as Wasm over the js-string builtins; where Java's behaviour is an exception they
 *  call the production native (natives.ts), which raises it */
export const stringIntrinsics = new Map<string, Intrinsic>();
{
  const def = (key: string, f: Intrinsic) => stringIntrinsics.set(`${STRING}.${key}`, f);
  const B = (cx: Compiler) => (cx.str as JsStrings).b;
  const nonNull = (cx: Compiler, c: Code, l: number) => c.lget(l).refIsNull().if_().call(cx.helpers.npe).end();
  const lenOf = (cx: Compiler, c: Code, l: number) => c.lget(l).externOfAny().call(B(cx).length);

  def("length()I", (cx, m, c) => { lenOf(cx, c, 0); });
  def("isEmpty()Z", (cx, m, c) => { lenOf(cx, c, 0).raw(OP.i32_eqz); });
  def("hashCode()I", (cx, m, c) => { c.lget(0).call(cx.helpers.shash); });
  def("toString()Ljava/lang/String;", (cx, m, c) => { c.lget(0); });
  def("intern()Ljava/lang/String;", (cx, m, c) => { c.lget(0); });
  def("charAt(I)C", (cx, m, c) => {
    c.lget(1); lenOf(cx, c, 0); c.raw(OP.i32_lt_u).if_(T.i32).lget(0).externOfAny().lget(1).call(B(cx).charCodeAt).else_(); cx.natives.call(cx, c, m); c.end();
  });
  def("equals(Ljava/lang/Object;)Z", (cx, m, c) => {
    c.lget(1).externOfAny().call(B(cx).test).if_(T.i32).lget(0).externOfAny().lget(1).externOfAny().call(B(cx).equals).else_().i32(0).end();
  });
  const compare = (check: boolean): Intrinsic => (cx, m, c) => {
    nonNull(cx, c, 1);
    if (check) c.lget(1).externOfAny().call(B(cx).test).raw(OP.i32_eqz).if_().call(cx.helpers.cce).end();
    c.lget(0).lget(1).call(cx.helpers.scmp);
  };
  def("compareTo(Ljava/lang/String;)I", compare(false));
  def("compareTo(Ljava/lang/Object;)I", compare(true));
  def("concat(Ljava/lang/String;)Ljava/lang/String;", (cx, m, c) => {
    nonNull(cx, c, 1); c.lget(0).externOfAny().lget(1).externOfAny().call(B(cx).concat).anyOfExtern();
  });
  // substring: in range here, otherwise the production native raises its StringIndexOutOfBoundsException
  const sub = (to: (cx: Compiler, c: Code) => void): Intrinsic => (cx, m, c) => {
    c.lget(1).i32(0).raw(OP.i32_ge_s); to(cx, c); lenOf(cx, c, 0).raw(OP.i32_le_s).raw(OP.i32_and);
    c.lget(1); to(cx, c); c.raw(OP.i32_le_s).raw(OP.i32_and);
    c.if_(T.anyref).lget(0).externOfAny().lget(1); to(cx, c); c.call(B(cx).substring).anyOfExtern().else_(); cx.natives.call(cx, c, m); c.end();
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
      .if_().call(cx.helpers.aioobe).end();
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1)
      .lget(0).externOfAny().lget(i).call(B(cx).charCodeAt).lset(ch);
    const at = (k: number) => { c.lget(d).refAsNonNull().lget(2).lget(i).i32(width === 1 ? 0 : 1).raw(OP.i32_shl).raw(OP.i32_add); if (k) c.i32(k).raw(OP.i32_add); };
    at(0); c.lget(ch).arraySet(cx.tData.i8);
    if (width === 2) { at(1); c.lget(ch).i32(8).raw(OP.i32_shr_u).arraySet(cx.tData.i8); }
    c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  };
  def("fillBytesLatin1([BI)V", fill(1));
  def("fillBytesUTF16([BI)V", fill(2));
  def("getCharsNoCheck(II[CI)V", (cx, m, c) => {
    nonNull(cx, c, 3);
    c.lget(0).externOfAny().lget(1).lget(2).call(B(cx).substring).lget(3).refCast(cx.tArr.i16).structGet(cx.tArr.i16, 2).lget(4).call(B(cx).intoCharCodeArray).drop();
  });
  def("toCharArray()[C", (cx, m, c) => {
    const t = cx.tArr.i16, d = cx.tData.i16, n = c.newLocal(T.i32), a = c.newLocal(refNull(d));
    lenOf(cx, c, 0).lset(n).lget(n).arrayNewDefault(d).lset(a);
    c.lget(0).externOfAny().lget(a).i32(0).call(B(cx).intoCharCodeArray).drop();
    c.gget(cx.vtGlobal.get("[C")!).refAsNonNull().i32(0).lget(a).refAsNonNull().structNew(t);
  });
}
