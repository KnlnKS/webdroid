import { decodeInstructions, type PreparedInstruction as Ins } from "../../../src/jvm/prepared";
import { descToName } from "../../../src/jvm/abi";
import { ACC, Program, type MethodInfo, mkey } from "./program";

export interface Reach {
  methods: Map<string, MethodInfo>;           // "cls.name+desc" -> method
  instantiated: Set<string>;
  referenced: Set<string>;                     // classes needing ids (casts, catches, instance-of, instantiated)
  initClasses: Set<string>;                    // classes whose static init must be ensured
  ifaceSelectors: Map<string, { name: string; desc: string }>;
  virtualSites: Map<string, Set<string>>;      // sel key -> declaring classes
  unresolved: Set<string>;                     // natives/abstract with no intrinsic
  arrayTypes: Set<string>;                     // array descriptors used ("[I", "[Ljava/lang/Object;"...)
  staticFields: Set<string>;
  classLiterals: Set<string>;                  // const-class operands
}
export const mid = (m: MethodInfo) => m.cls + "." + m.key;

export type Implied = (m: MethodInfo, r: Reach, prog: Program) => [string, string, string][];
/** `implied` names methods that a reached method calls from generated code rather than from its bytecode (a constructor also instantiates its class) */
export function reach(prog: Program, roots: MethodInfo[], seeds: { instantiate: string[]; methods: [string, string, string][] }, isIntrinsic: (m: MethodInfo) => boolean, implied: Implied = () => []): Reach {
  const r: Reach = { methods: new Map(), instantiated: new Set(), referenced: new Set(), initClasses: new Set(), ifaceSelectors: new Map(),
    virtualSites: new Map(), unresolved: new Set(), arrayTypes: new Set(), staticFields: new Set(), classLiterals: new Set() };
  const queue: MethodInfo[] = [];
  const addMethod = (m: MethodInfo | undefined) => { if (m && !r.methods.has(mid(m))) { r.methods.set(mid(m), m); queue.push(m); } };
  const ref = (cls: string) => {
    if (cls[0] === "[") { r.arrayTypes.add(cls); r.referenced.add(cls); return; }
    r.referenced.add(cls); const c = prog.get(cls); if (c?.sup) ref(c.sup); c?.ifaces.forEach(ref);
  };
  const requireInit = (cls: string) => {
    if (cls[0] === "[" || r.initClasses.has(cls)) return;
    const c = prog.get(cls); if (!c) return;
    r.initClasses.add(cls);
    const ci = c.byKey.get("<clinit>()V"); if (ci) addMethod(ci);
    if (c.sup) requireInit(c.sup);
    if (!c.isInterface) for (const i of prog.defaultIfaces(cls)) requireInit(i);
  };
  const resolveSites = (cls: string) => {
    for (const [key, decls] of r.virtualSites) for (const d of decls) {
      if (!prog.isSubclass(cls, d)) continue;
      const i = key.indexOf("("); const impl = prog.implFor(cls, key.slice(0, i), key.slice(i)); addMethod(impl);
    }
  };
  const instantiate = (cls: string, init = true) => {
    if (r.instantiated.has(cls)) return;
    r.instantiated.add(cls); ref(cls); if (init) requireInit(cls); resolveSites(cls);
  };
  const virtualSite = (decl: string, name: string, desc: string, iface: boolean) => {
    const key = mkey(name, desc);
    if (iface) r.ifaceSelectors.set(key, { name, desc });
    let s = r.virtualSites.get(key); if (!s) r.virtualSites.set(key, s = new Set());
    if (s.has(decl)) return; s.add(decl);
    // declared method itself must exist for abstract/native checks
    for (const c of r.instantiated) if (prog.isSubclass(c, decl)) addMethod(prog.implFor(c, name, desc));
  };
  for (const c of seeds.instantiate) instantiate(c, false);   // the runtime creates these without running their static initializers
  for (const [c, n, d] of seeds.methods) addMethod(prog.resolve(c, n, d));
  for (const m of roots) addMethod(m);
  const drain = () => { while (queue.length) {
    const m = queue.pop()!;
    if (!m.codeOff) {
      if (!isIntrinsic(m) && !(m.flags & ACC.ABSTRACT)) r.unresolved.add(mid(m));
      continue;
    }
    if (isIntrinsic(m)) continue;
    const code = m.dex.code(m.codeOff);
    const dex = m.dex;
    for (const ins of decodeInstructions(code.insns)) scan(ins);
    for (const t of code.tries) for (const [ty] of t.handlers) ref(descToName(dex.type(ty)));
    function scan(ins: Ins) {
      const n = ins.name;
      if (n === "new-instance") instantiate(descToName(dex.type(ins.b)));
      else if (n === "new-array") { ref(dex.type(ins.c)); }
      else if (n === "filled-new-array" || n === "filled-new-array/range") ref(dex.type(ins.b));
      else if (n === "check-cast") ref(descToName(dex.type(ins.b)));
      else if (n === "instance-of") ref(descToName(dex.type(ins.c)));
      else if (n === "const-class") { const cn = descToName(dex.type(ins.b)); r.classLiterals.add(cn); ref(cn); }
      else if (n.startsWith("sget") || n.startsWith("sput")) {
        const fr = dex.field(ins.b); const decl = descToName(dex.type(fr.cls));
        const f = prog.resolveField(decl, fr.name, dex.type(fr.type));
        const owner = f?.owner ?? decl; requireInit(owner); r.staticFields.add(owner + "." + fr.name);
      } else if (n.startsWith("invoke-")) {
        if (n.startsWith("invoke-polymorphic") && descToName(dex.type(dex.method(ins.b).cls)) === "java/lang/invoke/VarHandle") { ref("java/lang/invoke/FieldVarHandle"); ref("java/lang/invoke/ArrayElementVarHandle"); return; }
        if (n.startsWith("invoke-polymorphic") || n.startsWith("invoke-custom")) { r.unresolved.add(`${mid(m)}: ${n}`); return; }
        const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), decl = descToName(dex.type(mr.cls));
        const kind = n.replace("/range", "");
        if (decl[0] === "[") { r.arrayTypes.add(decl); return; }
        if (kind === "invoke-static") { const t = prog.resolve(decl, mr.name, desc); if (t) { requireInit(t.cls); addMethod(t); } else r.unresolved.add(`missing static ${decl}.${mr.name}${desc}`); }
        else if (kind === "invoke-direct") addMethod(prog.resolve(decl, mr.name, desc));
        else if (kind === "invoke-super") addMethod(prog.superTarget(m.cls, decl, mr.name, desc));
        else {
          const declC = prog.get(decl);
          virtualSite(decl, mr.name, desc, !!declC?.isInterface);
          // Object methods called on interface receivers
          if (declC?.isInterface) virtualSite("java/lang/Object", mr.name, desc, false);
        }
      }
    }
  }
  };
  drain();
  for (let size = 0; size !== r.methods.size;) {
    size = r.methods.size;
    for (const m of [...r.methods.values()]) for (const [c, n, d] of implied(m, r, prog)) { if (n === "<init>") instantiate(c); addMethod(prog.resolve(c, n, d)); }
    drain();
  }
  return r;
}
