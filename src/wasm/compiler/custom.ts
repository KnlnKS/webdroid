// invoke-custom links the DEX site's actual Java bootstrap and invokes its current CallSite target.
import { mid } from "./ids";
import { emitBoxedInvoke, CUSTOM_INVOKE } from "../link/mhandles";
import type { PreparedInstruction as Ins } from "../../jvm/prepared";
import type { MC } from "./method";

export function emitCustom(mc: MC, ins: Ins): void {
  const { code: c, dex } = mc, proto = dex.proto((dex.callSite(ins.b)[2] as { idx: number }).idx);
  emitBoxedInvoke(mc, ins, proto.params.map(t => dex.type(t)), dex.type(proto.ret), 0, () => c.anyNull(), `${mid(mc.m)}#${ins.b}`, CUSTOM_INVOKE);
}
