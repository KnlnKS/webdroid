import { Code, OP } from "./code";
import { T, refNull } from "./wasmbin";
import type { Compiler, Intrinsic } from "./j2w";
import type { ElemKind } from "./consts";

export const intrinsics = new Map<string, Intrinsic>();
export const externs: string[] = [];             // statics of classes the program may lack (d8 also emits Double.isNaN calls)
const def = (key: string, f: Intrinsic, extern = false) => { intrinsics.set(key, f); if (extern) externs.push(key); };

def("java/lang/Object.hashCode()I", (cx, m, c) => { c.lget(0).call(cx.helpers.hash); });
def("java/lang/System.identityHashCode(Ljava/lang/Object;)I", (cx, m, c) => { c.lget(0).refIsNull().if_(T.i32).i32(0).else_().lget(0).call(cx.helpers.hash).end(); });
def("java/lang/Throwable.nativeFillInStackTrace()Ljava/lang/Object;", (cx, m, c) => { c.refNull(cx.tObj); });
def("java/lang/Float.floatToRawIntBits(F)I", (cx, m, c) => { c.lget(0); });
def("java/lang/Float.intBitsToFloat(I)F", (cx, m, c) => { c.lget(0); });
def("java/lang/Double.doubleToRawLongBits(D)J", (cx, m, c) => { c.lget(0); });
def("java/lang/Double.longBitsToDouble(J)D", (cx, m, c) => { c.lget(0); });
def("java/lang/Float.isNaN(F)Z", (cx, m, c) => { c.lget(0).raw(OP.f32_reinterpret_i32).lget(0).raw(OP.f32_reinterpret_i32, OP.f32_ne); }, true);
def("java/lang/Double.isNaN(D)Z", (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64).lget(0).raw(OP.f64_reinterpret_i64, OP.f64_ne); }, true);
def("java/lang/StrictMath.sqrt(D)D", (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64, 0x9f, OP.i64_reinterpret_f64); });
def("java/lang/StrictMath.floor(D)D", (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64, 0x9c, OP.i64_reinterpret_f64); });
def("java/lang/StrictMath.ceil(D)D", (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64, 0x9b, OP.i64_reinterpret_f64); });
def("java/lang/Math.sqrt(D)D", (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64, 0x9f, OP.i64_reinterpret_f64); });

// System.arraycopy(Object src, int sp, Object dst, int dp, int n)
def("java/lang/System.arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V", (cx, m, c) => {
  const kinds: ElemKind[] = ["i32", "ref", "i8", "i16", "i64"];
  c.lget(0).refIsNull().if_().call(cx.helpers.npe).end();
  c.lget(2).refIsNull().if_().call(cx.helpers.npe).end();
  const sd = c.newLocal(refNull(cx.tObj)); void sd;
  for (const k of kinds) {
    const t = cx.tArr[k], d = cx.tData[k];
    c.lget(0).refTest(t).if_();
    const s = c.newLocal(refNull(d)), dd = c.newLocal(refNull(d));
    c.lget(0).refCast(t).structGet(t, 2).lset(s);
    c.lget(2).refCast(t).structGet(t, 2).lset(dd);
    // bounds: sp<0 || dp<0 || n<0 || sp+n > len(src) || dp+n > len(dst)
    c.lget(1).i32(0).raw(OP.i32_lt_s).lget(3).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(4).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or)
      .lget(1).lget(4).raw(OP.i32_add).lget(s).refAsNonNull().arrayLen().raw(OP.i32_gt_u).raw(OP.i32_or)
      .lget(3).lget(4).raw(OP.i32_add).lget(dd).refAsNonNull().arrayLen().raw(OP.i32_gt_u).raw(OP.i32_or)
      .if_().call(cx.helpers.aioobe).end();
    if (k === "ref") cx.cm.emitRefCopy(c);
    c.lget(dd).refAsNonNull().lget(3).lget(s).refAsNonNull().lget(1).lget(4).arrayCopy(d, d).ret().end();
  }
  c.call(cx.helpers.cce);
});
