// ART mirror/var_handle.cc: view accesses use backing bytes, native byte order and alignment; ByteBuffer checks read-only before bounds.
import { Code, OP } from "../compiler/code";
import { emitMemoryScalar } from "./memory";
import { T } from "../compiler/wasmbin";
import { kindOf } from "../compiler/program";
import { emitVarHandleOperation } from "../compiler/poly";
import { varHandleValues } from "../../jvm/abi";
import { box, unbox, handleThunk } from "./mhandles";
import type { World } from "./world";
import type { Strand } from "./sched";

export function invokeVarHandleView(w: World, handle: object, args: object, storage: string, mode: string, params: string[], ret: string, parent: Strand): object | null | Promise<object | null> {
  const BB = "java/nio/ByteBuffer", array = storage === "java/lang/invoke/ByteArrayViewVarHandle";
  const element = varHandleValues(mode)! ? params[2] : ret, K = kindOf(element), width = element === "S" || element === "C" ? 2 : element === "J" || element === "D" ? 8 : 4;
  const nativeOrder = w.fieldReader<number>(storage, "nativeByteOrder", "Z")(handle);
  return handleThunk(w, `vh:view:${array ? "array" : "buffer"}:${mode}:${element}:${nativeOrder}`, ["L"], "L", (cx, c, arg) => {
    const value = (index: number) => { arg(0); c.refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).i32(index).arrayGet(cx.tData.ref); };
    const field = (local: number, owner: string, name: string, desc: string) => {
      const f = cx.prog.resolveField(owner, name, desc)!;
      c.lget(local).refCast(cx.structFor(owner)).structGet(cx.structFor(owner), cx.fieldIndex(owner, f));
    };
    const failure = (cls: string) => {
      const local = c.newLocal(T.anyref); cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.ltee(local);
      cx.callMethod(c, cx.prog.resolve(cls, "<init>", "()V")!); c.lget(local).throw_(cx.tag);
    };
    const receiver = c.newLocal(T.anyref), bytes = c.newLocal(T.anyref), index = c.newLocal(T.i32), offset = c.newLocal(T.i32), length = c.newLocal(T.i32), address = c.newLocal(T.i64);
    value(1); c.ltee(receiver).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
    value(2); unbox(cx, c, "I"); c.lset(index);
    if (array) { c.lget(receiver).ltee(bytes).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).refAsNonNull().arrayLen(); c.lset(length); }
    else {
      if (!/^get(Volatile|Acquire|Opaque)?$/.test(mode)) { field(receiver, BB, "isReadOnly", "Z"); c.if_(); failure("java/nio/ReadOnlyBufferException"); c.end(); }
      field(receiver, "java/nio/Buffer", "limit", "I"); c.lset(length);
      field(receiver, "java/nio/Buffer", "address", "J"); c.lset(address);
      field(receiver, BB, "hb", "[B"); c.lset(bytes);
      c.lget(address).raw(OP.i64_eqz).if_(); field(receiver, BB, "offset", "I"); c.lset(offset); c.end();
    }
    c.lget(length).i32(width).raw(OP.i32_sub).lget(index).raw(OP.i32_lt_s).lget(index).i32(0).raw(OP.i32_lt_s, OP.i32_or).if_(); failure("java/lang/IndexOutOfBoundsException"); c.end();
    c.lget(index).lget(offset).raw(OP.i32_add).lset(index);
    if (mode !== "get" && mode !== "set") {
      c.lget(address).lget(index).raw(OP.i64_extend_i32_u, OP.i64_add).i64(BigInt(width - 1)).raw(OP.i64_and, OP.i64_eqz, OP.i32_eqz).if_(); failure("java/lang/IllegalStateException"); c.end();
    }
    // External regions may page in asynchronously. Reject the entire range before touching memory.
    c.lget(address).raw(OP.i64_eqz, OP.i32_eqz).if_();
    c.lget(address).lget(index).raw(OP.i64_extend_i32_u, OP.i64_add).i64(0x10000n).raw(OP.i64_sub)
      .i64(0x1_0000_0000n - 0x10000n - BigInt(width)).raw(OP.i64_gt_u).if_();
    cx.gap(c, "VarHandle view: external memory range has no synchronous atomic primitive"); c.end().end();
    const byteIndex = (i: number) => c.lget(index).i32(i).raw(OP.i32_add);
    const memoryAddress = (i: number) => { c.lget(address); byteIndex(i); c.raw(OP.i64_extend_i32_u, OP.i64_add); };
    const data = () => c.lget(bytes).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2);
    // Inline the owning memory intrinsics so a lazy-link wait cannot split a read-modify-write operation.
    const memoryCall = (put: boolean) => {
      const name = put ? "pokeByte" : "peekByte", desc = put ? "(JB)V" : "(J)B";
      const fn = cx.memo(`vh:view:${name}`, () => {
        const m = cx.prog.resolve("libcore/io/Memory", name, desc)!, body = new Code(m.params.length);
        const fn = cx.mb.reserveFunc(cx.methodSig(m), "$vh_" + name);
        emitMemoryScalar(cx, body, m, !put, 8, true);
        cx.mb.setBody(fn, body.finish()); return fn;
      });
      c.call(fn);
    };
    const readByte = (i: number) => {
      c.lget(address).raw(OP.i64_eqz).if_(T.i32); data(); byteIndex(i); c.arrayGetU(cx.tData.i8);
      c.else_(); memoryAddress(i); memoryCall(false); c.i32(255).raw(OP.i32_and); c.end();
    };
    const values = params.slice(2).map((p, i) => { const local = c.newLocal(cx.vtOf(kindOf(p))); value(i + 3); unbox(cx, c, p); c.lset(local); return local; });
    emitVarHandleOperation(cx, c, mode, element, {
      load: () => {
        for (let i = 0; i < width; i++) {
          readByte(i); if (K === "J") c.raw(OP.i64_extend_i32_u);
          const shift = 8 * (nativeOrder ? i : width - 1 - i);
          if (shift) { if (K === "J") c.i64(BigInt(shift)).raw(OP.i64_shl); else c.i32(shift).raw(OP.i32_shl); }
          if (i) c.raw(K === "J" ? OP.i64_or : OP.i32_or);
        }
        if (element === "S") c.raw(OP.i32_extend16_s);
      },
      store: v => {
        for (let i = 0; i < width; i++) {
          const byte = () => { const shift = 8 * (nativeOrder ? i : width - 1 - i); c.lget(v); if (K === "J") c.i64(BigInt(shift)).raw(OP.i64_shr_u, OP.i32_wrap_i64); else c.i32(shift).raw(OP.i32_shr_u); };
          c.lget(address).raw(OP.i64_eqz).if_(); data(); byteIndex(i); byte(); c.arraySet(cx.tData.i8);
          c.else_(); memoryAddress(i); byte(); memoryCall(true); c.end();
        }
      },
    }, values);
    if (ret === "V") c.anyNull(); else box(cx, c, ret);
  }, parent)(args) as object | null | Promise<object | null>;
}
