import { OP, type Code } from "../compiler/code.ts";
import { T, refNull } from "../compiler/wasmbin.ts";
import { MATH_IMPORTS, type Compiler, type Intrinsic } from "../compiler/j2w.ts";
import { emitRefCopy, classIntrinsics } from "./classes.ts";

import { unsafeIntrinsics } from "./unsafe.ts";
import { reflectIntrinsics } from "./reflect.ts";
import { H, ELEM_KINDS, elemKindOf } from "../compiler/consts.ts";
import { PRIMS } from "../../jvm/abi.ts";
import { stringIntrinsics } from "./strings.ts";
import { charIntrinsics } from "./chars.ts";
import { threadIntrinsics } from "./sched.ts";
import { refIntrinsics } from "./refs.ts";
import { memoryIntrinsics } from "./memory.ts";
import { fieldIntrinsics } from "./fields.ts";
import { memberIntrinsics } from "./members.ts";
import { inetIntrinsics } from "./inet.ts";
import { proxyIntrinsics } from "./proxy.ts";
import { annotationIntrinsics } from "./annotations.ts";
import { handleIntrinsics } from "./mhandles.ts";
import { loaderIntrinsics } from "./loaders.ts";

export const intrinsics = new Map<string, Intrinsic>([...stringIntrinsics, ...charIntrinsics]);
export const externs: string[] = [];             // statics of classes the program may lack (d8 also emits Double.isNaN calls)
const def = (key: string, f: Intrinsic, extern = false) => { intrinsics.set(key, f); if (extern) externs.push(key); };

def("java/lang/Object.hashCode()I", (cx, m, c) => { c.lget(0).call(cx.helper("hash")); });
def("java/lang/System.identityHashCode(Ljava/lang/Object;)I", (cx, m, c) => { c.lget(0).refIsNull().if_(T.i32).i32(0).else_().lget(0).call(cx.helper("hash")).end(); });
// the stack state is an Object the host keys the captured stack by; nativeGetStackTrace(state) turns it into StackTraceElements
def("java/lang/Throwable.nativeFillInStackTrace()Ljava/lang/Object;", (cx, m, c) => {
  const state = c.newLocal(refNull(cx.tObj));
  cx.emitNew(c, "java/lang/Object"); c.lset(state).lget(state).externConvertAny().call(cx.imp.capture).lget(state);
});
/** leaves the StackTraceElement[] of the frames the host recorded for the stack state in local `state` (null: none) */
function emitFrames(cx: Compiler, c: Code, state: number): void {
  const STE = "java/lang/StackTraceElement", ctor = cx.prog.resolve(STE, "<init>", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)V");
  const n = c.newLocal(T.i32), i = c.newLocal(T.i32), arr = c.newLocal(T.anyref), frames = c.newLocal(T.externref);
  if (!ctor) { cx.gap(c, "StackTraceElement.<init>"); return; }
  // the frames stay this code's own while the constructor runs Java
  c.lget(state).externConvertAny().call(cx.imp.stFrames).ltee(frames).call(cx.imp.len).lset(n);
  cx.emitNewArray(c, "[L" + STE + ";", () => c.lget(n)); c.lset(arr);
  const text = (which: number) => { c.lget(frames).lget(i).i32(which).call(cx.imp.stString); cx.str.fromHost(c); };
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(arr).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(i);
  cx.construct(c, ctor, () => { text(0); text(1); text(2); c.lget(frames).lget(i).call(cx.imp.stLine); });
  c.arraySet(cx.tData.ref);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().lget(arr);
}
// Throwable.nativeGetStackTrace(state): the frames the host recorded for the state, as StackTraceElement(class, method, file, line)
def("java/lang/Throwable.nativeGetStackTrace(Ljava/lang/Object;)[Ljava/lang/StackTraceElement;", (cx, m, c) => { emitFrames(cx, c, 0); });
// VMStack.getThreadStackTrace(thread): the running thread's frames, taken as a new Throwable takes them; another thread's stack is not on this one (an empty trace)
def("dalvik/system/VMStack.getThreadStackTrace(Ljava/lang/Thread;)[Ljava/lang/StackTraceElement;", (cx, m, c) => {
  const THR = "java/lang/Throwable", ctor = cx.prog.resolve(THR, "<init>", "()V"), trace = cx.prog.resolve(THR, "getStackTrace", "()[Ljava/lang/StackTraceElement;");
  if (!ctor || !trace) { cx.gap(c, "Throwable.getStackTrace"); return; }
  c.lget(0); cx.callRt(c, "curThread"); c.call(cx.helper("acmp")).if_(T.anyref);
  cx.construct(c, ctor); cx.callMethod(c, trace);
  c.else_(); cx.emitNewArray(c, "[Ljava/lang/StackTraceElement;", () => c.i32(0)); c.end();
});
def("java/lang/Float.floatToRawIntBits(F)I", (cx, m, c) => { c.lget(0); });
def("java/lang/Float.intBitsToFloat(I)F", (cx, m, c) => { c.lget(0); });
def("java/lang/Double.doubleToRawLongBits(D)J", (cx, m, c) => { c.lget(0); });
def("java/lang/Double.longBitsToDouble(J)D", (cx, m, c) => { c.lget(0); });
def("java/lang/Float.isNaN(F)Z", (cx, m, c) => { c.lget(0).raw(OP.f32_reinterpret_i32).lget(0).raw(OP.f32_reinterpret_i32, OP.f32_ne); }, true);
def("java/lang/Double.isNaN(D)Z", (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64).lget(0).raw(OP.f64_reinterpret_i64, OP.f64_ne); }, true);
// System.setIn, setOut and setErr store the stream in the static final field, which the Wasm class holds as a global
for (const [name, desc] of [["in", "Ljava/io/InputStream;"], ["out", "Ljava/io/PrintStream;"], ["err", "Ljava/io/PrintStream;"]])
  def(`java/lang/System.set${name[0].toUpperCase()}${name.slice(1)}0(${desc})V`, (cx, m, c) => { c.lget(0).gset(cx.staticGlobal("java/lang/System", name, desc)); });
/** a double function that is one Wasm instruction: f64.sqrt/floor/ceil/nearest round as Java does */
const f64Op = (op: number): Intrinsic => (cx, m, c) => { c.lget(0).raw(OP.f64_reinterpret_i64, op, OP.i64_reinterpret_f64); };
for (const [name, op] of [["sqrt", 0x9f], ["floor", 0x9c], ["ceil", 0x9b]] as const) def(`java/lang/StrictMath.${name}(D)D`, f64Op(op));
for (const [f, { params }] of Object.entries(MATH_IMPORTS)) def(`java/lang/Math.${f}(${"D".repeat(params.length)})D`, (cx, m, c) => {
  params.forEach((_, i) => c.lget(i).raw(OP.f64_reinterpret_i64));
  c.call(cx.imp[f as keyof typeof MATH_IMPORTS]).raw(OP.i64_reinterpret_f64);
});
def("java/lang/Math.sqrt(D)D", f64Op(0x9f));

// System.arraycopy(Object src, int sp, Object dst, int dp, int n): an element kind's arrays copy as one array.copy; a pair of arrays of
// different classes (int[] to float[], or not both arrays) is an ArrayStoreException, a bad range the production AIOOBE message
def("java/lang/System.arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V", (cx, m, c) => {
  c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  c.lget(2).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  for (const k of ELEM_KINDS) {
    const t = cx.tArr[k], d = cx.tData[k];
    c.lget(0).refTest(t).if_();
    c.lget(2).refTest(t).raw(OP.i32_eqz).if_(); cx.callThrower(c, "ase"); c.end();
    if (k !== "ref") {
      const id = (l: number) => c.lget(l).refCast(cx.tObj).structGet(cx.tObj, 0).i32(H.ID).arrayGet(cx.tVT);
      id(0); id(2); c.raw(OP.i32_ne).if_(); cx.callThrower(c, "ase"); c.end();
    }
    const s = c.newLocal(refNull(d)), dd = c.newLocal(refNull(d));
    c.lget(0).refCast(t).structGet(t, 2).lset(s);
    c.lget(2).refCast(t).structGet(t, 2).lset(dd);
    // bounds: sp<0 || dp<0 || n<0 || sp+n > len(src) || dp+n > len(dst)
    c.lget(1).i32(0).raw(OP.i32_lt_s).lget(3).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(4).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or)
      .lget(1).lget(4).raw(OP.i32_add).lget(s).refAsNonNull().arrayLen().raw(OP.i32_gt_u).raw(OP.i32_or)
      .lget(3).lget(4).raw(OP.i32_add).lget(dd).refAsNonNull().arrayLen().raw(OP.i32_gt_u).raw(OP.i32_or)
      .if_().lget(s).refAsNonNull().arrayLen().lget(1).lget(dd).refAsNonNull().arrayLen().lget(3).lget(4); cx.callThrower(c, "copy"); c.end();
    if (k === "ref") emitRefCopy(cx, c);
    c.lget(dd).refAsNonNull().lget(3).lget(s).refAsNonNull().lget(1).lget(4).arrayCopy(d, d).ret().end();
  }
  cx.callThrower(c, "ase");
});
// the Unchecked forms are called once the range is known good
for (const [d, { title }] of Object.entries(PRIMS)) {
  def(`java/lang/System.arraycopy${title}Unchecked([${d}I[${d}II)V`, (cx, m, c) => {
    const k = elemKindOf("[" + d), t = cx.tArr[k], a = cx.tData[k];
    c.lget(2).refCast(t).structGet(t, 2).lget(3).lget(0).refCast(t).structGet(t, 2).lget(1).lget(4).arrayCopy(a, a);
  });
}
for (const [name, op] of [["floor", 0x9c], ["ceil", 0x9b], ["rint", 0x9e]] as const) def(`java/lang/Math.${name}(D)D`, f64Op(op));

for (const family of [classIntrinsics, unsafeIntrinsics, reflectIntrinsics, threadIntrinsics, refIntrinsics, memoryIntrinsics, fieldIntrinsics, memberIntrinsics,
  inetIntrinsics, proxyIntrinsics, annotationIntrinsics, loaderIntrinsics, handleIntrinsics]) for (const [key, f] of family) intrinsics.set(key, f);
