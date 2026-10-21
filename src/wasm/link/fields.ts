// java.lang.reflect.Field's get and set natives (art/runtime/native/java_lang_reflect_Field.cc). A field is named by the id in its artFieldIndex
// (class id << 12 | index in the class's fields, classes.ts mkField); the host hands out a generated accessor slot per field and operation
// (unsafe.ts), for static fields as well, so the natives only choose the accessor by the field's type letter. Primitive reads and writes widen
// as the language does (a getLong of an int field, a setInt of a long field is not allowed), and a receiver, access or final check precedes them.
import { OP } from "../compiler/code.ts";
import { T } from "../compiler/wasmbin.ts";
import { ACC, kindOf } from "../compiler/program.ts";
import { fieldId } from "./classes.ts";
import { rt } from "../compiler/rtfns.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import { Info, UInfo } from "../compiler/info.ts";
import { BOX, WIDEN } from "../compiler/primitives.ts";
import { PRIMS } from "../../jvm/abi.ts";

const FIELD = "java/lang/reflect/Field", ACCESSIBLE = "java/lang/reflect/AccessibleObject";
const LETTERS = Object.keys(PRIMS);
const code = (l: string) => l.charCodeAt(0);

/** locals for the field id on the stack (or already in local `given`), its class id, index, flags and, unless `flagsOnly`, type letter */
function describe(cx: Compiler, c: Code, given?: number, flagsOnly = false) {
  const id = given ?? c.newLocal(T.i32), cid = c.newLocal(T.i32), idx = c.newLocal(T.i32), flags = c.newLocal(T.i32), letter = flagsOnly ? -1 : c.newLocal(T.i32);
  if (given === undefined) c.lset(id);
  c.lget(id).i32(12).raw(OP.i32_shr_u).lset(cid).lget(id).i32(0xfff).raw(OP.i32_and).lset(idx);
  cx.info(c, Info.FieldFlags, () => c.lget(cid), () => c.lget(idx)); c.lset(flags);
  if (!flagsOnly) { cx.info(c, Info.FieldDesc, () => c.lget(cid), () => c.lget(idx)); c.lset(letter); }
  return { id, cid, idx, flags, letter };
}
/** the locals of the field `f` names: its id, class id, index and flags */
function decode(cx: Compiler, c: Code, f: number) { c.lget(f); fieldId(cx, c); return describe(cx, c, undefined, true); }
/** the accessor slot (get or put) of field `id` held as kind index `k` (0 int-like, 1 long-like, 2 reference) */
function accessor(cx: Compiler, c: Code, id: number, flags: number, put: boolean, k: number): number {
  const slot = c.newLocal(T.i32);
  c.lget(flags).i32(ACC.STATIC).raw(OP.i32_and).if_(T.i32).i32(put ? UInfo.StaticPut : UInfo.StaticGet).else_().i32(put ? UInfo.FieldPut : UInfo.FieldGet).end();
  c.lget(id).i32(k).call(cx.imp.info).lset(slot);
  return slot;
}

// fprep(field, obj, write) -> field id: the checks every Field native makes first. A static field's class is initialized; an instance field needs a
// receiver of its class; a member the caller could not reach without setAccessible is IllegalAccessException (the caller's class is the
// frame that called the native, which only an engine that names Wasm frames can say); a final field is written only through setAccessible,
// and then only an instance one
rt("fprep", ["L", "L", "I"], "I", (cx, c) => {
  const { id, cid, flags } = decode(cx, c, 0), ao = cx.structFor(ACCESSIBLE), caller = c.newLocal(T.i32), override = c.newLocal(T.i32);
  c.lget(flags).i32(ACC.STATIC).raw(OP.i32_and).if_();
  cx.info(c, Info.EnsureSlot, () => c.lget(cid)); c.callIndirect(cx.sig([], "V"));
  c.else_();
  c.lget(1); cx.nullCheck(c);
  c.lget(cid); cx.callRt(c, "classOf"); c.lget(1); cx.callNamed(c, "java/lang/Class", "isInstance", "(Ljava/lang/Object;)Z");
  c.raw(OP.i32_eqz).if_().lget(cid).lget(1); cx.vtId(c); cx.callThrower(c, "recv"); c.end();
  c.end();
  c.lget(0).refCast(ao).structGet(ao, cx.fieldIndex(ACCESSIBLE, { owner: ACCESSIBLE, name: "override", desc: "Z" })).lset(override);
  // ART's VerifyAccess passes a public member before it looks for the caller
  c.lget(override).lget(flags).i32(ACC.PUBLIC).raw(OP.i32_and).raw(OP.i32_or).raw(OP.i32_eqz).if_();
  c.i32(0).call(cx.imp.stackClass).lset(caller);
  c.lget(caller).if_();                                       // 0: no frame to judge by
  cx.info(c, Info.CanAccess, () => c.lget(caller), () => c.lget(id)); c.raw(OP.i32_eqz).if_().lget(caller).lget(cid); cx.callThrower(c, "iacc"); c.end();
  c.end().end();
  const set = (flag: number) => c.lget(flags).i32(flag).raw(OP.i32_and).i32(0).raw(OP.i32_ne);
  c.lget(2); set(ACC.FINAL); c.raw(OP.i32_and).lget(override).raw(OP.i32_eqz); set(ACC.STATIC); c.raw(OP.i32_or, OP.i32_and)
    .if_().lget(cid); cx.callThrower(c, "fin"); c.end();
  c.lget(id);
});

// fgetp(field, obj, want) -> bits: the field read as the primitive type letter `want`, widened, as an i64 (float and double as their bits)
rt("fgetp", ["L", "L", "I"], "J", (cx, c) => {
  c.lget(0).lget(1).i32(0); cx.callRt(c, "fprep");
  const { id, cid, flags, letter } = describe(cx, c);
  for (const l of LETTERS) {
    c.lget(letter).i32(code(l)).raw(OP.i32_eq).if_();
    const k = kindOf(l), slot = accessor(cx, c, id, flags, false, k === "J" ? 1 : 0), raw = c.newLocal(cx.vtOf(k));
    c.lget(1).lget(slot).callIndirect(cx.sig(["L"], k)).lset(raw);
    // the value as a signed integer (i64) or a double, whichever the letter is
    const asInt = () => { c.lget(raw); if (k === "I" && l !== "F") c.raw(OP.i64_extend_i32_s); else if (l === "F") c.raw(OP.i64_extend_i32_u); };
    const asDouble = () => { c.lget(raw); if (l === "F") c.raw(OP.f32_reinterpret_i32, OP.f64_promote_f32); else c.raw(OP.f64_reinterpret_i64); };
    for (const w of WIDEN[l]) {
      c.lget(2).i32(code(w)).raw(OP.i32_eq).if_();
      if (w === "F") { if (l === "F") asInt(); else { asInt(); c.raw(OP.f32_convert_i64_s, OP.i32_reinterpret_f32, OP.i64_extend_i32_u); } }
      else if (w === "D") { if (l === "F" || l === "D") asDouble(); else { asInt(); c.raw(OP.f64_convert_i64_s); } c.raw(OP.i64_reinterpret_f64); }
      else asInt();
      c.ret().end();
    }
    c.lget(cid).lget(cid); cx.callThrower(c, "ftm"); c.end();
  }
  c.lget(cid).lget(cid); cx.callThrower(c, "ftm"); c.i64(0n);
});

// fbox(letter, bits) -> the wrapper object of a primitive: valueOf of its class
rt("fbox", ["I", "J"], "L", (cx, c) => {
  for (const l of LETTERS) {
    const cls = PRIMS[l].box, vo = cx.prog.resolve(cls, "valueOf", `(${l})L${cls};`);
    c.lget(0).i32(code(l)).raw(OP.i32_eq).if_();
    if (!vo) cx.gap(c, `${cls}.valueOf`); else { cx.emitEnsure(c, cls); c.lget(1); if (kindOf(l) === "I") c.raw(OP.i32_wrap_i64); cx.callMethod(c, vo); c.ret(); }
    c.end();
  }
  c.anyNull();
});

// fget(field, obj) -> Object: a reference field as it is, a primitive boxed
rt("fget", ["L", "L"], "L", (cx, c) => {
  c.lget(0).lget(1).i32(0); cx.callRt(c, "fprep");
  const { id, flags, letter } = describe(cx, c);
  // a letter that is not a primitive's is a reference
  c.lget(letter).i32(code("L")).raw(OP.i32_eq).lget(letter).i32(code("[")).raw(OP.i32_eq).raw(OP.i32_or).if_();
  const ref = accessor(cx, c, id, flags, false, 2);
  c.lget(1).lget(ref).callIndirect(cx.sig(["L"], "L")).ret().end();
  c.lget(letter).lget(0).lget(1).lget(letter); cx.callRt(c, "fgetp"); cx.callRt(c, "fbox");
});

// fstore(field id, obj, bits, letter): assigns a primitive of type `letter` (as fgetp's bits) to the field, converted to the field's type
rt("fstore", ["I", "L", "J", "I"], "V", (cx, c) => {
  const { cid, flags, letter } = describe(cx, c, 0);
  for (const target of LETTERS) {
    c.lget(letter).i32(code(target)).raw(OP.i32_eq).if_();
    const k = kindOf(target), slot = accessor(cx, c, 0, flags, true, k === "J" ? 1 : 0);
    for (const v of LETTERS.filter((x) => WIDEN[x].includes(target))) {
      c.lget(3).i32(code(v)).raw(OP.i32_eq).if_();
      c.lget(1);
      const bits = () => c.lget(2);
      if (target === "F") { if (v === "F") bits().raw(OP.i32_wrap_i64); else bits().raw(OP.f32_convert_i64_s, OP.i32_reinterpret_f32); }
      else if (target === "D") {
        if (v === "F") bits().raw(OP.i32_wrap_i64, OP.f32_reinterpret_i32, OP.f64_promote_f32, OP.i64_reinterpret_f64);
        else if (v === "D") bits(); else bits().raw(OP.f64_convert_i64_s, OP.i64_reinterpret_f64);
      } else if (target === "J") bits(); else bits().raw(OP.i32_wrap_i64);
      c.lget(slot).callIndirect(cx.sig(["L", k], "V")).ret().end();
    }
    c.lget(cid).lget(cid); cx.callThrower(c, "ftm"); c.end();
  }
});

// fset(field, obj, value): a reference field takes any instance of its type, a primitive field the wrapper of a type that widens to it
rt("fset", ["L", "L", "L"], "V", (cx, c) => {
  c.lget(0).lget(1).i32(1); cx.callRt(c, "fprep");
  const { id, cid, idx, flags, letter } = describe(cx, c), ty = c.newLocal(T.i32);
  cx.info(c, Info.FieldType, () => c.lget(cid), () => c.lget(idx)); c.lset(ty);
  c.lget(letter).i32(code("L")).raw(OP.i32_eq).lget(letter).i32(code("[")).raw(OP.i32_eq).raw(OP.i32_or).if_();
  // a reference: null, or an instance of the field's type
  c.lget(2).refIsNull().raw(OP.i32_eqz).if_();
  c.lget(ty); cx.callRt(c, "classOf"); c.lget(2); cx.callNamed(c, "java/lang/Class", "isInstance", "(Ljava/lang/Object;)Z");
  c.raw(OP.i32_eqz).if_().lget(ty).lget(2).refAsNonNull(); cx.vtId(c); cx.callThrower(c, "ftm"); c.end().end();
  const ref = accessor(cx, c, id, flags, true, 2);
  c.lget(1).lget(2).lget(ref).callIndirect(cx.sig(["L", "L"], "V")).ret().end();
  // a primitive: the wrapper's class says which type it holds
  c.lget(2).refIsNull().if_().lget(ty).lget(cid); cx.callThrower(c, "ftm"); c.end();
  for (const l of LETTERS) {
    const [cls, name, desc] = BOX[l], m = cx.prog.resolve(cls, name, desc);
    c.lget(2).i32(cx.idOf(cls)).i32(cx.prog.chain(cls).length - 1).call(cx.helper("iof")).if_();
    if (!m) cx.gap(c, `${cls}.${name}`); else {
      c.lget(id).lget(1).lget(2); cx.callMethod(c, m);
      if (l === "F") c.raw(OP.i64_extend_i32_u); else if (kindOf(l) === "I") c.raw(OP.i64_extend_i32_s);
      c.i32(code(l)); cx.callRt(c, "fstore"); c.ret();
    }
    c.end();
  }
  c.lget(ty).lget(2).refAsNonNull(); cx.vtId(c); cx.callThrower(c, "ftm");
});

export const fieldIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => fieldIntrinsics.set(`${FIELD}.${key}`, (cx, m, c) => f(cx, c));
def("get(Ljava/lang/Object;)Ljava/lang/Object;", (cx, c) => { c.lget(0).lget(1); cx.callRt(c, "fget"); });
def("set(Ljava/lang/Object;Ljava/lang/Object;)V", (cx, c) => { c.lget(0).lget(1).lget(2); cx.callRt(c, "fset"); });
for (const [l, { title: name }] of Object.entries(PRIMS)) {
  const k = kindOf(l);
  def(`get${name}(Ljava/lang/Object;)${l}`, (cx, c) => { c.lget(0).lget(1).i32(code(l)); cx.callRt(c, "fgetp"); if (k === "I") c.raw(OP.i32_wrap_i64); });
  // the value in local 2, as the bits fstore takes: sign-extended for int-like, zero-extended for float
  def(`set${name}(Ljava/lang/Object;${l})V`, (cx, c) => {
    c.lget(0).lget(1).i32(1); cx.callRt(c, "fprep");
    c.lget(1).lget(2);
    if (l === "F") c.raw(OP.i64_extend_i32_u); else if (k === "I") c.raw(OP.i64_extend_i32_s);
    c.i32(code(l)); cx.callRt(c, "fstore");
  });
}
