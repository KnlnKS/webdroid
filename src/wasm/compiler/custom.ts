// invoke-custom links the DEX site's actual Java bootstrap and invokes its current CallSite target.
import { T } from "./wasmbin";
import { isWide, descToName } from "../../jvm/abi";
import { kindOf } from "./program";
import { mid } from "./ids";
import { box, unbox, emitInvokeImport, CUSTOM_INVOKE } from "../link/mhandles";
import { BOX } from "./fields";
import type { PreparedInstruction as Ins } from "../../jvm/prepared";
import type { MC } from "./method";

export function emitCustom(mc: MC, ins: Ins): void {
  const { cx, code: c, dex } = mc, proto = dex.proto((dex.callSite(ins.b)[2] as { idx: number }).idx);
  const params = proto.params.map(t => dex.type(t)), ret = dex.type(proto.ret), args = c.newLocal(T.anyref);
  cx.emitNewArray(c, "[Ljava/lang/Object;", () => c.i32(params.length)); c.lset(args);
  for (let i = 0, ri = 0; i < params.length; ri += isWide(params[i++]) ? 2 : 1) {
    const p = params[i];
    c.lget(args).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).i32(i);
    mc.get(kindOf(p), ins.regs[ri]); if (BOX[p]) box(cx, c, p); c.arraySet(cx.tData.ref);
  }
  emitInvokeImport(cx, c, () => c.anyNull(), () => c.lget(args), `${mid(mc.m)}#${ins.b}`, CUSTOM_INVOKE);
  if (ret === "V") c.drop();
  else if (BOX[ret]) { unbox(cx, c, ret); mc.finishResult(ins, kindOf(ret)); }
  else { if (ret !== "Ljava/lang/Object;") c.call(cx.castFn(ret[0] === "L" ? descToName(ret) : ret)); mc.finishResult(ins, "L"); }
}
