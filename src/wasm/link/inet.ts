// Linux.android_getaddrinfo (libcore/io/Linux.java): the production native builds its InetAddress[] through InetAddress.getByAddress, which its runtime
// can only run asynchronously. The resolution is the production one (the hosts file, numeric forms, the relay's answer), which answers synchronously for
// everything but a name the relay must look up, for which the strand waits (Block.Net); the objects are made here, by the same call, in the Wasm program. A stack that cannot wait
// (a plain entry) has a gap for such a name.
import { OP } from "../compiler/code.ts";
import { T } from "../compiler/wasmbin.ts";
import type { Intrinsic } from "../compiler/j2w.ts";
import { Block, emitBlock } from "./sched.ts";

const STRUCT = "android/system/StructAddrinfo", INET = "java/net/InetAddress", GAI = "android/system/GaiException";
/** the answer of op 0 for a lookup that cannot finish synchronously */
export const ASYNC = -0x80000000;
export const NetOp = { Resolve: 0, Byte: 1 } as const;

export const inetIntrinsics = new Map<string, Intrinsic>();
inetIntrinsics.set("libcore/io/Linux.android_getaddrinfo(Ljava/lang/String;Landroid/system/StructAddrinfo;I)[Ljava/net/InetAddress;", (cx, m, c) => {
  const n = c.newLocal(T.i32), i = c.newLocal(T.i32), j = c.newLocal(T.i32), len = c.newLocal(T.i32), arr = c.newLocal(T.anyref), bytes = c.newLocal(T.anyref);
  const hints = cx.structFor(STRUCT), field = (name: string) => cx.fieldIndex(STRUCT, cx.prog.resolveField(STRUCT, name, "I")!);
  const byte = (a: () => void, b: () => void) => { c.i32(NetOp.Byte).lget(1).externConvertAny(); a(); b(); c.call(cx.imp.net); };
  for (const l of [1, 2]) { c.lget(l).refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); }
  const resolve = () => { c.i32(NetOp.Resolve).lget(1).externConvertAny().lget(2).refCast(hints).structGet(hints, field("ai_family")).lget(2).refCast(hints).structGet(hints, field("ai_flags")).call(cx.imp.net).lset(n); };
  resolve();
  // a name the relay must look up: the strand waits for the answer and asks again
  c.lget(n).i32(ASYNC).raw(OP.i32_eq).if_();
  emitBlock(cx, c, Block.Net); c.drop();
  resolve();
  c.lget(n).i32(ASYNC).raw(OP.i32_eq).if_(); cx.gap(c, "android_getaddrinfo: the relay's answer did not come (a stack that cannot wait)"); c.end();
  c.end();
  c.lget(n).i32(0).raw(OP.i32_lt_s).if_();
  const ctor = cx.prog.resolve(GAI, "<init>", "(Ljava/lang/String;I)V")!;
  cx.construct(c, ctor, () => { cx.str.literal(c, "android_getaddrinfo"); c.i32(0).lget(n).raw(OP.i32_sub); });
  c.throw_(cx.tag).end();
  cx.emitNewArray(c, `[L${INET};`, () => c.lget(n)); c.lset(arr);
  const getByAddress = cx.prog.resolve(INET, "getByAddress", "(Ljava/lang/String;[BI)Ljava/net/InetAddress;")!;
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  byte(() => c.lget(i), () => c.i32(-1)); c.lset(len);
  cx.emitNewArray(c, "[B", () => c.lget(len)); c.lset(bytes);
  c.i32(0).lset(j).block().loop().lget(j).lget(len).raw(OP.i32_ge_s).brIf(1);
  c.lget(bytes).refCast(cx.tArr.i8).structGet(cx.tArr.i8, 2).lget(j); byte(() => c.lget(i), () => c.lget(j)); c.arraySet(cx.tData.i8);
  c.lget(j).i32(1).raw(OP.i32_add).lset(j).br(0).end().end();
  c.lget(arr).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(i);
  cx.emitEnsure(c, INET); c.anyNull().lget(bytes).i32(0); cx.callMethod(c, getByAddress);
  c.arraySet(cx.tData.ref).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  c.lget(arr);
});
