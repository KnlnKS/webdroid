// What ART throws at a use site whose class or member does not resolve (ClassLinker::ResolveType, ResolveField, ResolveMethodWithChecks and
// common_throws.cc): NoClassDefFoundError, NoSuchFieldError, NoSuchMethodError and IncompatibleClassChangeError, with ART's messages. These are
// not gaps: the program asks for something the loaded classes lack, and the error is what it gets.
import type { DexFile } from "../../jvm/dex.ts";
import type { PreparedInstruction } from "../../jvm/prepared.ts";
import type { LinkEnv } from "./j2w.ts";
import { stringSite } from "./strings.ts";
import { PRIMS, descToName, dotName } from "../../jvm/abi.ts";
import { ACC, descOf, javaName, sameRuntimePackage, selectDefault, type DispatchTarget, type FieldInfo, type JClass, type MethodInfo, type Program } from "./program.ts";
import type { Thrower } from "./exc.ts";
import { Invoke, invokeKind } from "../../jvm/opcodes.ts";

export interface LinkFailure {
  thrower: Extract<Thrower, "ncdfr" | "nsme" | "nsfer" | "icce">;
  message: string;
  /** the class whose later loading would resolve the site */
  absent?: string;
}

const dotted = (n: string) => dotName(javaName(n));
/** a descriptor as ART's PrettyDescriptor prints it */
export const prettyType = (d: string): string => (d[0] === "[" ? prettyType(d.slice(1)) + "[]" : d[0] === "L" ? dotted(d.slice(1, -1)) : PRIMS[d]?.name ?? "void");
/** ART appends where the referring class was declared */
const declared = (prog: Program, cls: string, extra?: DexFile) => ` (declaration of '${dotted(cls)}' appears in ${prog.get(cls)?.dex?.name ?? extra?.name ?? "?"})`;
const fail = (thrower: LinkFailure["thrower"], message: string, absent?: string): LinkFailure => ({ thrower, message, absent });

/** the class a type descriptor names, through arrays; undefined for a primitive */
export const classOfType = (d: string): string | undefined => { const e = d.replace(/^\[+/, ""); return e[0] === "L" ? descToName(e) : undefined; };

const UNRESOLVED = "Failed resolution of: ";
/** a type that does not resolve: its class (or an array's element class) is not loaded */
export function typeFailure(prog: Program, desc: string): LinkFailure | undefined {
  const cls = classOfType(desc);
  return cls !== undefined && !prog.get(cls) ? fail("ncdfr", UNRESOLVED + desc, cls) : undefined;
}
/** the class a NoClassDefFoundError's message from here names */
export const unresolvedClass = (message: string): string | undefined => message.startsWith(UNRESOLVED) ? classOfType(message.slice(UNRESOLVED.length)) : undefined;

/** by Invoke, the kind ART names in its messages */
const INVOKE_TYPE = ["virtual", "super", "direct", "static", "interface"];
const invokeType = (m: MethodInfo, prog: Program) => (m.isStatic ? "static" : m.isCtor || m.flags & ACC.PRIVATE ? "direct" : prog.get(m.cls)?.isInterface ? "interface" : "virtual");
const prettyMethod = (m: MethodInfo) => `${prettyType(m.ret)} ${dotted(m.cls)}.${m.name}(${m.params.map(prettyType).join(", ")})`;

export function symbolicMethod(c: JClass, name: string, desc: string): MethodInfo | undefined {
  // the file's own spelling differs only where a loader qualifies a type, in the query or the class's dex
  return c.method(name + desc) ?? c.method(name + javaName(desc), true);
}

/** DEX member resolution compares descriptors, not the referring loader's already-resolved types. */
export const resolveSymbolicMethod = (prog: Program, cls: string, name: string, desc: string): MethodInfo | undefined =>
  prog.resolveBy(cls, (c) => symbolicMethod(c, name, desc));

/** Package-private slots retain their declaring runtime package even when binary prototypes match. */
export const dispatchMethodKey = (key: string): string => key.slice(key.indexOf("\0") + 1);
export const dispatchSlotKey = (m: MethodInfo): string => (m.flags & (ACC.PUBLIC | ACC.PROTECTED) ? "" : m.cls + "\0") + javaName(m.key);
/** Reflection's access rule for a member of `decl` with `flags` used by class `caller`: the class must be public or in the caller's package, then the member public,
 *  the caller's own, in the caller's package, or protected and inherited */
export function canAccess(prog: Program, caller: string, decl: JClass, flags: number): boolean {
  const samePackage = sameRuntimePackage(prog, caller, decl.name);
  if (!(decl.flags & ACC.PUBLIC) && !samePackage) return false;
  if (flags & ACC.PUBLIC || caller === decl.name) return true;
  if (flags & ACC.PRIVATE) return false;
  return samePackage || !!(flags & ACC.PROTECTED) && prog.isSubclass(caller, decl.name);
}
export const overridesMethod = (prog: Program, cls: string, m: MethodInfo): boolean => !(m.flags & ACC.PRIVATE) && (!!(m.flags & (ACC.PUBLIC | ACC.PROTECTED)) || sameRuntimePackage(prog, cls, m.cls));

/** Select an override of this declaration, rather than a same-named inaccessible member. */
export function symbolicOverride(prog: Program, cls: string, declared: MethodInfo, includeAbstract = false): MethodInfo | undefined {
  let method = declared, reached = false;
  for (const owner of [...prog.chain(cls)].reverse()) {
    if (owner === declared.cls) { reached = true; continue; }
    if (!reached) continue;
    const candidate = symbolicMethod(prog.require(owner), declared.name, javaName(declared.desc));
    if (candidate && !(candidate.flags & (ACC.STATIC | ACC.PRIVATE)) && overridesMethod(prog, owner, method)) method = candidate;
  }
  return !includeAbstract && method.flags & ACC.ABSTRACT ? undefined : method;
}

/** DEX name/prototype equality selects true overrides; initialization checks their Class identities. */
export function symbolicImplFor(prog: Program, cls: string, slot: string, includeAbstract = false): MethodInfo | undefined {
  const target = symbolicDispatchFor(prog, cls, slot, includeAbstract);
  return target && failed(target) ? includeAbstract ? target.candidates[0] : undefined : target;
}

/** Executable selection differs from declaration metadata when defaults conflict. */
export function symbolicDispatchFor(prog: Program, cls: string, slot: string, includeAbstract = false): DispatchTarget {
  const key = dispatchMethodKey(slot), at = key.indexOf("("), name = key.slice(0, at), desc = key.slice(at), split = slot.indexOf("\0");
  if (split >= 0) {
    const declared = symbolicMethod(prog.require(slot.slice(0, split)), name, desc);
    return declared ? symbolicOverride(prog, cls, declared, includeAbstract) : undefined;
  }
  if (prog.loaderOf(cls) === prog.boot && !includeAbstract) return prog.dispatchFor(cls, name, desc);
  for (const owner of [...prog.chain(cls)].reverse()) {
    const m = symbolicMethod(prog.require(owner), name, desc);
    if (m && !(m.flags & (ACC.STATIC | ACC.PRIVATE)) && m.flags & (ACC.PUBLIC | ACC.PROTECTED)) return symbolicOverride(prog, cls, m, includeAbstract);
  }
  const maximal = prog.maximalInterfaceMethods(prog.chain(cls).flatMap(owner => prog.require(owner).ifaces), c => symbolicMethod(c, name, desc));
  return selectDefault(maximal, includeAbstract);
}

/** ART Class::FindVirtualMethodForInterfaceSuper visits subinterfaces before their ancestors. */
function interfaceSuper(prog: Program, cls: string, name: string, desc: string): MethodInfo | LinkFailure | undefined {
  const own = symbolicMethod(prog.require(cls), name, desc);
  if (own) return own;
  const maximal = prog.maximalInterfaceMethods(prog.require(cls).ifaces, c => symbolicMethod(c, name, desc));
  const target = selectDefault(maximal, true);
  return target && failed(target) ? { ...target, message: `Conflicting default methods for ${dotted(cls)}.${name}${javaName(desc)}` } : target;
}

/** the method an invoke names, or why it does not resolve. `referrer` is the class of the calling method. */
export function resolveInvoke(prog: Program, kind: Invoke, declaredCls: string, name: string, desc: string, referrer: string): MethodInfo | LinkFailure {
  const cls = declaredCls[0] === "[" ? "java/lang/Object" : declaredCls, c = prog.get(cls), at = () => declared(prog, referrer);
  if (!c) return fail("ncdfr", UNRESOLVED + descOf(declaredCls), declaredCls);
  if (kind === Invoke.Interface && !c.isInterface) return fail("icce", `Found class ${dotted(cls)}, but interface was expected${at()}`);
  if (kind === Invoke.Virtual && c.isInterface) return fail("icce", `Found interface ${dotted(cls)}, but class was expected${at()}`);
  const expected = INVOKE_TYPE[kind];
  const owner = kind === Invoke.Super && !c.isInterface ? prog.get(referrer)?.sup ?? cls : cls;
  const m = kind === Invoke.Super && c.isInterface ? interfaceSuper(prog, cls, name, desc) : resolveSymbolicMethod(prog, owner, name, desc);
  if (!m) return fail("nsme", `No ${expected} method ${name}${desc} in class ${descOf(cls)} or its super classes${declared(prog, cls)}`);
  if (failed(m)) return m;
  if (m.isStatic !== (kind === Invoke.Static)) {
    const found = invokeType(m, prog);
    return fail("icce", `The method '${prettyMethod(m)}' was expected to be of type ${expected} but instead was found to be of type ${found}${at()}`);
  }
  return m;
}

/** what an invoke names: the method's name and descriptor, the class whose methods it searches (an array's are Object's) and the resolved target, except an array's clone, which copies it */
export interface InvokeSite { name: string; desc: string; decl: string; target: MethodInfo | LinkFailure | "clone" }
/** the site that invoke `kind` of method reference `ref` makes in `m` */
export function invokeSite(prog: Program, m: MethodInfo, ref: number, kind: Invoke): InvokeSite {
  const types = prog.typesOf(m.dex), mr = m.dex.method(ref), desc = types.methodDesc(ref), declared = types.typeName(mr.cls);
  const decl = declared[0] === "[" ? "java/lang/Object" : declared;
  if (declared !== decl && mr.name + desc === "clone()Ljava/lang/Object;") return { name: mr.name, desc, decl, target: "clone" };
  const resolve = () => resolveInvoke(prog, kind, declared, mr.name, desc, m.cls);
  // invoke-super's target depends on the caller
  return { name: mr.name, desc, decl, target: kind === Invoke.Super ? resolve() : resolved(prog.refsOf(m.dex).invokes, 8 * ref + kind, resolve) };
}
/** whether a virtual call of `t` through class `decl` runs `t` whatever the receiver: ART links no subclass of a final class and no override of a final method */
export function finalDispatch(prog: Program, decl: string, t: MethodInfo): boolean {
  const d = prog.get(decl);
  return !!d && !d.isInterface && (!!(d.flags & ACC.FINAL) || !!(t.flags & ACC.FINAL) && prog.isSubclass(decl, t.cls));
}
/** how an invoke reaches the method it resolves to (`m`): a fixed one; a dispatch from it; String's constructor, which makes the string */
export type Binding = { k: "fixed" | "virtual"; m: MethodInfo } | { k: "string" };
/** how invoke `ins` (not invoke-polymorphic or invoke-custom) of `m` at `site` binds, as the compiler compiles it and the planner plans it; null when it calls
 *  no method (an array's clone, a site that does not link). A static, direct or super call is fixed, and a virtual call that dispatches finally and reaches no
 *  host spec's native; only a build knows every spec (a split bundle registers some late), so a World without one fixes no virtual call */
export function bindInvoke(w: Pick<LinkEnv, "prog" | "hosts">, m: MethodInfo, ins: PreparedInstruction, site: InvokeSite): Binding | null {
  const { decl, target } = site, kind = invokeKind(ins.op);
  if (target === "clone" || failed(target)) return null;
  if (stringSite(m.dex, ins) === "init") return { k: "string" };
  const fixed = kind !== Invoke.Virtual && kind !== Invoke.Interface || finalDispatch(w.prog, decl, target) && !w.hosts.mayReach(decl, target);
  return { k: fixed ? "fixed" : "virtual", m: target };
}
/** a resolution of a reference of a dex: what succeeded is the same for every caller while the Program's classes hold (Program.refsOf), a failure names its caller */
function resolved<T extends object>(memo: Map<number, T>, key: number, resolve: () => T | LinkFailure): T | LinkFailure {
  let r: T | LinkFailure | undefined = memo.get(key);
  if (r === undefined) { r = resolve(); if (!failed(r)) memo.set(key, r); }
  return r;
}

/** the field an iget/iput/sget/sput names, or why it does not resolve */
export function resolveFieldRef(prog: Program, dex: DexFile, idx: number, isStatic: boolean, referrer: string): { decl: string; f: FieldInfo } | LinkFailure {
  return resolved(prog.refsOf(dex).fields, 2 * idx + +isStatic, () => fieldRef(prog, dex, idx, isStatic, referrer));
}
function fieldRef(prog: Program, dex: DexFile, idx: number, isStatic: boolean, referrer: string): { decl: string; f: FieldInfo } | LinkFailure {
  const fr = dex.field(idx), types = prog.typesOf(dex), decl = types.typeName(fr.cls), type = dex.rawType(fr.type);
  if (!prog.get(decl)) return fail("ncdfr", UNRESOLVED + types.type(fr.cls), decl);
  const raw = javaName(type), f = prog.resolveFieldBy(decl, (x) => x.name === fr.name && javaName(x.desc) === raw);
  if (!f) return fail("nsfer", `No ${isStatic ? "static " : "instance "}field ${fr.name} of type ${type} in class ${descOf(decl)} or its superclasses${declared(prog, decl)}`);
  if (f.isStatic !== isStatic) {
    return fail("icce", `Expected '${prettyType(f.desc)} ${dotted(f.owner)}.${f.name}' to be a ${isStatic ? "static" : "instance"} field rather than a ${isStatic ? "instance" : "static"} field${declared(prog, referrer)}`);
  }
  return { decl, f };
}
export const failed = (x: object): x is LinkFailure => "thrower" in x;
