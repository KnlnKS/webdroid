// ART mirror/var_handle.cc: view accesses use backing bytes, native byte order and alignment; ByteBuffer checks read-only before bounds.
import { Code, OP } from "../compiler/code.ts";
import { emitMemoryScalar, memoryScalarMethod, guestRange } from "./memory.ts";
import { T } from "../compiler/wasmbin.ts";
import { kindOf } from "../compiler/program.ts";
import { emitVarHandleOperation } from "../compiler/poly.ts";
import { varHandleValues } from "../../jvm/abi.ts";
import { handleThunk } from "./mhandles.ts";
import type { World } from "./world.ts";
import type { Strand } from "./sched.ts";
import { box, unbox } from "../compiler/primitives.ts";

export function invokeVarHandleView(w: World, handle: object, args: object, storage: string, mode: string, params: string[], ret: string, parent: Strand): object | null | Promise<object | null> {
  const BB = "java/nio/ByteBuffer", array = storage === "java/lang/invoke/ByteArrayViewVarHandle";
  const element = varHandleValues(mode) ? params[2] : ret, K = kindOf(element), width = element === "S" || element === "C" ? 2 : element === "J" || element === "D" ? 8 : 4;
  const nativeOrder = w.fieldReader<number>(storage, "nativeByteOrder", "Z")(handle);
  return handleThunk(w, `vh:view:${array ? "array" : "buffer"}:${mode}:${element}:${nativeOrder}`, ["L"], "L", (cx, c, arg) => {
    const value = (index: number) => { arg(0); c.refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).i32(index).arrayGet(cx.tData.ref); };
    const field = (local: number, owner: string, name: string, desc: string) => {
      const st = cx.structFor(owner);
      c.lget(local).refCast(st).structGet(st, cx.fieldIndex(owner, cx.prog.resolveField(owner, name, desc)!));
    };
    const receiver = c.newLocal(T.anyref), bytes = c.newLocal(T.anyref), index = c.newLocal(T.i32), offset = c.newLocal(T.i32), length = c.newLocal(T.i32), address = c.newLocal(T.i64);
    value(1); c.ltee(receiver).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
    value(2); unbox(cx, c, "I"); c.lset(index);
    if (array) { c.lget(receiver).ltee(bytes).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).refAsNonNull().arrayLen(); c.lset(length); }
    else {
      if (!/^get(Volatile|Acquire|Opaque)?$/.test(mode)) { field(receiver, BB, "isReadOnly", "Z"); c.if_(); cx.throwNew(c, "java/nio/ReadOnlyBufferException"); c.end(); }
      field(receiver, "java/nio/Buffer", "limit", "I"); c.lset(length);
      field(receiver, "java/nio/Buffer", "address", "J"); c.lset(address);
      field(receiver, BB, "hb", "[B"); c.lset(bytes);
      c.lget(address).raw(OP.i64_eqz).if_(); field(receiver, BB, "offset", "I"); c.lset(offset); c.end();
    }
    c.lget(length).i32(width).raw(OP.i32_sub).lget(index).raw(OP.i32_lt_s).lget(index).i32(0).raw(OP.i32_lt_s, OP.i32_or).if_(); cx.throwNew(c, "java/lang/IndexOutOfBoundsException"); c.end();
    c.lget(index).lget(offset).raw(OP.i32_add).lset(index);
    if (mode !== "get" && mode !== "set") {
      c.lget(address).lget(index).raw(OP.i64_extend_i32_u, OP.i64_add).i64(BigInt(width - 1)).raw(OP.i64_and, OP.i64_eqz, OP.i32_eqz).if_(); cx.throwNew(c, "java/lang/IllegalStateException"); c.end();
    }
    const byteIndex = (i: number) => c.lget(index).i32(i).raw(OP.i32_add);
    const memoryAddress = (i: number) => { c.lget(address); byteIndex(i); c.raw(OP.i64_extend_i32_u, OP.i64_add); };
    const data = () => c.lget(bytes).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2);
    // Mutable external HostBytes reads/writes are synchronous; immutable Region reads may fault before returning a whole-width value.
    // Inline native bindings and guest operations so no lazy link can split a read-modify-write operation.
    const memoryCall = (put: boolean, size = 1) => {
      const bits = size * 8 as 8 | 16 | 32 | 64, m = memoryScalarMethod(cx, !put, bits), name = m.name;
      const fn = cx.memo(`vh:view:${name}`, () => {
        const body = new Code(m.params.length);
        const fn = cx.mb.reserveFunc(cx.methodSig(m), "$vh_" + name);
        emitMemoryScalar(cx, body, m, !put, bits, true);
        cx.mb.setBody(fn, body.finish()); return fn;
      });
      c.call(fn);
    };
    const readByte = (i: number) => {
      c.lget(address).raw(OP.i64_eqz).if_(T.i32); data(); byteIndex(i); c.arrayGetU(cx.tData.i8);
      c.else_(); memoryAddress(i); memoryCall(false); c.i32(255).raw(OP.i32_and); c.end();
    };
    const inline = () => {
      c.lget(address).raw(OP.i64_eqz);
      guestRange(c, () => memoryAddress(0), width); c.raw(OP.i32_or);
    };
    const reverse = () => {
      const value = c.newLocal(cx.vtOf(K)), result = c.newLocal(cx.vtOf(K)); c.lset(value);
      for (let i = 0; i < width; i++) {
        c.lget(value);
        if (K === "J") c.i64(BigInt(i * 8)).raw(OP.i64_shr_u).i64(255n).raw(OP.i64_and).i64(BigInt((width - 1 - i) * 8)).raw(OP.i64_shl).lget(result).raw(OP.i64_or);
        else c.i32(i * 8).raw(OP.i32_shr_u).i32(255).raw(OP.i32_and).i32((width - 1 - i) * 8).raw(OP.i32_shl).lget(result).raw(OP.i32_or);
        c.lset(result);
      }
      c.lget(result);
    };
    const values = params.slice(2).map((p, i) => { const local = c.newLocal(cx.vtOf(kindOf(p))); value(i + 3); unbox(cx, c, p); c.lset(local); return local; });
    emitVarHandleOperation(cx, c, mode, element, {
      load: () => {
        inline(); c.if_(cx.vtOf(K));
        for (let i = 0; i < width; i++) {
          readByte(i); if (K === "J") c.raw(OP.i64_extend_i32_u);
          const shift = 8 * (nativeOrder ? i : width - 1 - i);
          if (shift) { if (K === "J") c.i64(BigInt(shift)).raw(OP.i64_shl); else c.i32(shift).raw(OP.i32_shl); }
          if (i) c.raw(K === "J" ? OP.i64_or : OP.i32_or);
        }
        c.else_(); memoryAddress(0); memoryCall(false, width);
        if (!nativeOrder) reverse(); c.end();
        if (element === "S") c.raw(OP.i32_extend16_s); else if (element === "C") c.i32(0xffff).raw(OP.i32_and);
      },
      store: v => {
        inline(); c.if_();
        for (let i = 0; i < width; i++) {
          const byte = () => { const shift = 8 * (nativeOrder ? i : width - 1 - i); c.lget(v); if (K === "J") c.i64(BigInt(shift)).raw(OP.i64_shr_u, OP.i32_wrap_i64); else c.i32(shift).raw(OP.i32_shr_u); };
          c.lget(address).raw(OP.i64_eqz).if_(); data(); byteIndex(i); byte(); c.arraySet(cx.tData.i8);
          c.else_(); memoryAddress(i); byte(); memoryCall(true); c.end();
        }
        c.else_(); memoryAddress(0); c.lget(v); if (!nativeOrder) reverse(); memoryCall(true, width); c.end();
      },
    }, values);
    if (ret === "V") c.anyNull(); else box(cx, c, ret);
  }, parent, cx => {
    for (const size of [1, width]) for (const put of [false, true]) {
      cx.natives.declare(cx, [memoryScalarMethod(cx, !put, size * 8 as 8 | 16 | 32 | 64)]);
    }
  })(args) as object | null | Promise<object | null>;
}
