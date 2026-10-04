// invoke-custom: a call site's bootstrap method and constant arguments are in the dex (call_site_item), so a site whose bootstrap this file
// knows is linked at compile time. java.lang.runtime.ObjectMethods.bootstrap (records) is generated from its getter handles: AOSP's own
// implementation is a chain of method-handle combinators, which need ART's emulated stack frames (see link/mhandles.ts).
import { OP } from "./code";
import { T } from "./wasmbin";
import { descToName } from "../../jvm/abi";
import { ACC } from "./program";
import { RInfo, BOX } from "../link/reflect";
import { failed, resolveFieldRef, resolveInvoke } from "./linkage";
import type { EncVal } from "../../jvm/dex";
import type { PreparedInstruction as Ins } from "../../jvm/prepared";
import type { MC } from "./method";

const OBJECT_METHODS = "java/lang/runtime/ObjectMethods.bootstrap";
const SB = "java/lang/StringBuilder", OBJECTS = "java/util/Objects";
/** DEX method handle types a record component's getter can use */
const INSTANCE_GET = 3, INVOKE_INSTANCE = 5, INVOKE_DIRECT = 7, INVOKE_INTERFACE = 8;

/** a record component: how to read it from the record in a local, and its descriptor */
interface Component { desc: string; load(c: import("./code").Code, rec: number): void }

export function emitCustom(mc: MC, ins: Ins): void {
  const dex = mc.dex, cs = dex.callSite(ins.b) as EncVal[];
  const boot = dex.methodHandle((cs[0] as { idx: number }).idx), bm = dex.method(boot.idx), name = `${descToName(dex.type(bm.cls))}.${bm.name}`;
  if (name === OBJECT_METHODS) return objectMethods(mc, ins, cs);
  // ART resolves the bootstrap method first: a class or method it lacks is the error at the site (StringConcatFactory, SwitchBootstraps are not in libcore)
  const target = resolveInvoke(mc.cx.prog, "invoke-static", descToName(dex.type(bm.cls)), bm.name, dex.methodDesc(boot.idx), mc.m.cls);
  if (failed(target)) { mc.consumeResult(ins); return mc.linkFail(target); }
  mc.invokeGap(ins, `invoke-custom ${name}: only ObjectMethods.bootstrap is linked`);
}

function objectMethods(mc: MC, ins: Ins, cs: EncVal[]): void {
  const { cx, code: c, dex } = mc, prog = cx.prog;
  const what = cs[1] as string, extra = cs.slice(3);
  const gap = (why: string) => mc.invokeGap(ins, `invoke-custom ObjectMethods.${what}: ${why}`);
  const record = descToName(dex.type((extra[0] as { idx: number }).idx)), names = extra[1] as string, labels = names ? names.split(";") : [];
  const comps: Component[] = [];
  for (const h of extra.slice(2)) {
    const ref = dex.methodHandle((h as { idx: number }).idx);
    if (ref.type === INSTANCE_GET) {
      const r = resolveFieldRef(prog, dex, ref.idx, false, mc.m.cls);
      if (failed(r)) return gap(r.message);
      const { decl, f } = r, st = cx.structFor(decl), fi = cx.fieldIndex(decl, f);
      comps.push({ desc: f.desc, load: (code, rec) => { code.lget(rec).refCast(st).structGet(st, fi); } });
    } else if (ref.type === INVOKE_INSTANCE || ref.type === INVOKE_DIRECT || ref.type === INVOKE_INTERFACE) {
      const mr = dex.method(ref.idx), desc = dex.methodDesc(ref.idx);
      const kind = ref.type === INVOKE_INTERFACE ? "invoke-interface" : ref.type === INVOKE_DIRECT ? "invoke-direct" : "invoke-virtual";
      const m = resolveInvoke(prog, kind, descToName(dex.type(mr.cls)), mr.name, desc, mc.m.cls);
      if (failed(m)) return gap(m.message);
      if (!desc.startsWith("()") || m.isStatic) return gap(`getter ${mr.name}${desc} is not an instance method without arguments`);
      const owner = prog.get(m.cls)!, direct = ref.type === INVOKE_DIRECT || m.flags & (ACC.PRIVATE | ACC.FINAL) || owner.flags & ACC.FINAL;
      comps.push({ desc: m.ret, load: (code, rec) => {
        code.lget(rec);
        if (direct) { cx.callMethod(code, m); return; }
        // dispatched on the receiver's class by the reflection thunk (reflect.ts), which boxes the result
        code.anyNull(); cx.info(code, RInfo.MethodCall, () => code.i32(cx.idOf(m.cls)), () => code.i32(owner.methods.indexOf(m))); code.callIndirect(cx.sig(["L", "L"], "L"));
        if (BOX[m.ret]) { const [cls, name, d] = BOX[m.ret]; cx.callMethod(code, prog.resolve(cls, name, d)!); }
      } });
    } else return gap(`getter handle of kind ${ref.type}`);
  }
  const rec = c.newLocal(T.anyref), other = c.newLocal(T.anyref);
  const call = (cls: string, n: string, d: string) => cx.callMethod(c, prog.resolve(cls, n, d)!);
  mc.nonNull(ins.regs[0]); c.lset(rec);
  switch (what) {
    case "hashCode": {
      // result = 31 * result + hash(component), each hash as the wrapper class (Objects.hashCode for a reference) gives it
      const h = c.newLocal(T.i32);
      for (const k of comps) {
        c.lget(h).i32(31).raw(OP.i32_mul);
        k.load(c, rec);
        if (BOXES[k.desc]) call(`java/lang/${BOXES[k.desc]}`, "hashCode", `(${k.desc})I`); else call(OBJECTS, "hashCode", "(Ljava/lang/Object;)I");
        c.raw(OP.i32_add).lset(h);
      }
      c.lget(h); mc.finishResult(ins, "I"); return;
    }
    case "equals": {
      // primitives by value (Float.compare equates NaN and orders -0 before 0), references by Objects.equals
      mc.get("L", ins.regs[1]); c.lset(other);
      c.block(T.i32);
      c.lget(other).call(cx.instanceOfFn(record)).raw(OP.i32_eqz).if_().i32(0).br(1).end();
      for (const k of comps) {
        k.load(c, rec); k.load(c, other);
        if (k.desc === "F" || k.desc === "D") { call(k.desc === "F" ? "java/lang/Float" : "java/lang/Double", "compare", `(${k.desc}${k.desc})I`); c.raw(OP.i32_eqz); }
        else if (BOXES[k.desc]) c.raw(k.desc === "J" ? OP.i64_eq : OP.i32_eq);
        else call(OBJECTS, "equals", "(Ljava/lang/Object;Ljava/lang/Object;)Z");
        c.raw(OP.i32_eqz).if_().i32(0).br(1).end();
      }
      c.i32(1).end(); mc.finishResult(ins, "I"); return;
    }
    case "toString": {
      const sb = c.newLocal(T.anyref);
      cx.emitEnsure(c, SB); cx.emitNew(c, SB); c.lset(sb);
      c.lget(sb); call(SB, "<init>", "()V");
      const text = (s: string) => { c.lget(sb); cx.str.literal(c, s); call(SB, "append", "(Ljava/lang/String;)Ljava/lang/StringBuilder;"); c.drop(); };
      text(simpleName(mc, record) + "[");
      comps.forEach((k, i) => {
        text((i ? ", " : "") + labels[i] + "=");
        c.lget(sb); k.load(c, rec);
        call(SB, "append", `(${APPEND[k.desc] ?? "Ljava/lang/Object;"})Ljava/lang/StringBuilder;`); c.drop();
      });
      text("]");
      c.lget(sb); call(SB, "toString", "()Ljava/lang/String;"); mc.finishResult(ins, "L"); return;
    }
  }
  gap(`bootstrap name ${what}`);
}

/** the descriptor StringBuilder.append takes for a component of this type (the sub-int types widen to int) */
const APPEND: Record<string, string> = { Z: "Z", C: "C", B: "I", S: "I", I: "I", J: "J", F: "F", D: "D" };
/** the wrapper class of each primitive type */
const BOXES: Record<string, string> = { Z: "Boolean", B: "Byte", C: "Character", S: "Short", I: "Integer", J: "Long", F: "Float", D: "Double" };

function simpleName(mc: MC, record: string): string {
  const jc = mc.cx.prog.get(record), inner = jc?.def && jc.dex!.classAnnotations(jc.def).cls.find((x) => x.type === "dalvik/annotation/InnerClass");
  if (inner) return (inner.elements.name as string | null) ?? "";
  return record.slice(record.lastIndexOf("/") + 1);
}
