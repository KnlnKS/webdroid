import { Code, OP } from "./code";
import { T, refNull } from "./wasmbin";
import type { Compiler, Intrinsic } from "./j2w";
import { H, type ElemKind } from "./consts";
import { stringIntrinsics } from "./strings";
import { charIntrinsics } from "./chars";

export const intrinsics = new Map<string, Intrinsic>([...stringIntrinsics, ...charIntrinsics]);
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

// System.arraycopy(Object src, int sp, Object dst, int dp, int n): an element kind's arrays copy as one array.copy; a pair of arrays of
// different classes (int[] to float[], or not both arrays) is an ArrayStoreException, a bad range the production AIOOBE message
const arraycopy: Intrinsic = (cx, m, c) => {
  const kinds: ElemKind[] = ["i32", "ref", "i8", "i16", "i64"], { copyBounds, arrayStore } = cx.natives.helper;
  c.lget(0).refIsNull().if_().call(cx.helpers.npe).end();
  c.lget(2).refIsNull().if_().call(cx.helpers.npe).end();
  for (const k of kinds) {
    const t = cx.tArr[k], d = cx.tData[k];
    c.lget(0).refTest(t).if_();
    c.lget(2).refTest(t).raw(OP.i32_eqz).if_().call(arrayStore).end();
    if (k !== "ref") {
      const id = (l: number) => c.lget(l).refCast(cx.tObj).structGet(cx.tObj, 0).i32(H.ID).arrayGet(cx.tVT);
      id(0); id(2); c.raw(OP.i32_ne).if_().call(arrayStore).end();
    }
    const s = c.newLocal(refNull(d)), dd = c.newLocal(refNull(d));
    c.lget(0).refCast(t).structGet(t, 2).lset(s);
    c.lget(2).refCast(t).structGet(t, 2).lset(dd);
    // bounds: sp<0 || dp<0 || n<0 || sp+n > len(src) || dp+n > len(dst)
    c.lget(1).i32(0).raw(OP.i32_lt_s).lget(3).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(4).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or)
      .lget(1).lget(4).raw(OP.i32_add).lget(s).refAsNonNull().arrayLen().raw(OP.i32_gt_u).raw(OP.i32_or)
      .lget(3).lget(4).raw(OP.i32_add).lget(dd).refAsNonNull().arrayLen().raw(OP.i32_gt_u).raw(OP.i32_or)
      .if_().lget(s).refAsNonNull().arrayLen().lget(1).lget(dd).refAsNonNull().arrayLen().lget(3).lget(4).call(copyBounds).end();
    c.lget(dd).refAsNonNull().lget(3).lget(s).refAsNonNull().lget(1).lget(4).arrayCopy(d, d).ret().end();
  }
  c.call(arrayStore);
};
def("java/lang/System.arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V", arraycopy);
// the Unchecked forms are called once the range is known good
for (const [d, k] of [["Z", "i8"], ["B", "i8"], ["C", "i16"], ["S", "i16"], ["I", "i32"], ["F", "i32"], ["J", "i64"], ["D", "i64"]] as const) {
  def(`java/lang/System.arraycopy${{ Z: "Boolean", B: "Byte", C: "Char", S: "Short", I: "Int", F: "Float", J: "Long", D: "Double" }[d]}Unchecked([${d}I[${d}II)V`, (cx, m, c) => {
    const t = cx.tArr[k], a = cx.tData[k];
    c.lget(2).refCast(t).structGet(t, 2).lget(3).lget(0).refCast(t).structGet(t, 2).lget(1).lget(4).arrayCopy(a, a);
  });
}
// Math natives with a Wasm instruction: Math.floor/ceil/rint are f64.floor/ceil/nearest, which round as Java does
for (const [name, op] of [["floor", 0x9c], ["ceil", 0x9b], ["rint", 0x9e]] as const) def(`java/lang/Math.${name}(D)D`, (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64, op, OP.i64_reinterpret_f64); });
