// What ART throws at a use site whose class or member does not resolve (ClassLinker::ResolveType, ResolveField, ResolveMethodWithChecks and
// common_throws.cc): NoClassDefFoundError, NoSuchFieldError, NoSuchMethodError and IncompatibleClassChangeError, with ART's messages. These are
// not gaps: the program asks for something the loaded classes lack, and the error is what it gets.
import type { DexFile } from "../../jvm/dex.ts";
import { PRIMS, descToName, dotName } from "../../jvm/abi.ts";
import { ACC, declaredMethod, javaName, sameRuntimePackage, selectDefault, type DispatchTarget, type FieldInfo, type JClass, type MethodInfo, type Program } from "./program.ts";
import type { Thrower } from "./exc.ts";
import { Invoke } from "../../jvm/opcodes.ts";

export interface LinkFailure {
  thrower: Extract<Thrower, "ncdfr" | "nsme" | "nsfer" | "icce">;
  message: string;
  /** the class whose later loading would resolve the site */
  absent?: string;
}

const dotted = (n: string) => dotName(javaName(n));
/** a descriptor as ART's PrettyDescriptor prints it */
export const prettyType = (d: string): string => (d[0] === "[" ? prettyType(d.slice(1)) + "[]" : d[0] === "L" ? dotted(d.slice(1, -1)) : PRIMS[d]?.name ?? "void");
const descriptor = (cls: string) => (cls[0] === "[" ? cls : `L${cls};`);
/** ART appends where the referring class was declared */
const declared = (prog: Program, cls: string, extra?: DexFile) => ` (declaration of '${dotted(cls)}' appears in ${prog.get(cls)?.dex?.name ?? extra?.name ?? "?"})`;
const fail = (thrower: LinkFailure["thrower"], message: string, absent?: string): LinkFailure => ({ thrower, message, absent });

/** the class a type descriptor names, through arrays; undefined for a primitive */
const classOfType = (d: string): string | undefined => { const e = d.replace(/^\[+/, ""); return e[0] === "L" ? descToName(e) : undefined; };

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
  const m = declaredMethod(c, name + desc);
  // the file's own spelling differs only where a loader qualifies a type, in the query or the class's dex
  return m || c.dex && !c.dex.resolveType && !desc.includes("@") ? m : declaredMethod(c, name + javaName(desc), true);
}

/** DEX member resolution compares descriptors, not the referring loader's already-resolved types. */
export function resolveSymbolicMethod(prog: Program, cls: string, name: string, desc: string): MethodInfo | undefined {
  if (prog.loaderOf(cls) === prog.boot) return prog.resolve(cls, name, desc);
  for (const key of prog.chain(cls)) {
    const m = symbolicMethod(prog.require(key), name, desc);
    if (m) return m;
  }
  const seen = new Set<string>();
  const visit = (key: string): MethodInfo | undefined => {
    if (seen.has(key)) return;
    seen.add(key);
    const c = prog.get(key);
    if (!c) return;
    const m = symbolicMethod(c, name, desc);
    if (m && !m.isStatic) return m;
    for (const iface of c.ifaces) { const found = visit(iface); if (found) return found; }
  };
  for (const key of prog.chain(cls)) for (const iface of prog.require(key).ifaces) {
    const found = visit(iface); if (found) return found;
  }
}

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

function resolveSymbolicField(prog: Program, cls: string, name: string, desc: string): FieldInfo | undefined {
  const seen = new Set<string>(), raw = javaName(desc);
  const visit = (key: string): FieldInfo | undefined => {
    if (seen.has(key)) return;
    seen.add(key);
    const c = prog.get(key);
    if (!c) return;
    const field = c.fields.find(f => f.name === name && javaName(f.desc) === raw);
    if (field) return field;
    for (const iface of c.ifaces) { const found = visit(iface); if (found) return found; }
    return c.sup ? visit(c.sup) : undefined;
  };
  return visit(cls);
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
  if (!c) return fail("ncdfr", UNRESOLVED + descriptor(declaredCls), declaredCls);
  if (kind === Invoke.Interface && !c.isInterface) return fail("icce", `Found class ${dotted(cls)}, but interface was expected${at()}`);
  if (kind === Invoke.Virtual && c.isInterface) return fail("icce", `Found interface ${dotted(cls)}, but class was expected${at()}`);
  const expected = INVOKE_TYPE[kind];
  const owner = kind === Invoke.Super && !c.isInterface ? prog.get(referrer)?.sup ?? cls : cls;
  const m = kind === Invoke.Super && c.isInterface ? interfaceSuper(prog, cls, name, desc) : resolveSymbolicMethod(prog, owner, name, desc);
  if (!m) return fail("nsme", `No ${expected} method ${name}${desc} in class ${descriptor(cls)} or its super classes${declared(prog, cls)}`);
  if (failed(m)) return m;
  if (m.isStatic !== (kind === Invoke.Static)) {
    const found = invokeType(m, prog);
    return fail("icce", `The method '${prettyMethod(m)}' was expected to be of type ${expected} but instead was found to be of type ${found}${at()}`);
  }
  return m;
}

/** the field an iget/iput/sget/sput names, or why it does not resolve */
export function resolveFieldRef(prog: Program, dex: DexFile, idx: number, isStatic: boolean, referrer: string): { decl: string; f: FieldInfo } | LinkFailure {
  const fr = dex.field(idx), decl = dex.typeName(fr.cls), type = dex.rawType(fr.type);
  if (!prog.get(decl)) return fail("ncdfr", UNRESOLVED + dex.type(fr.cls), decl);
  const f = resolveSymbolicField(prog, decl, fr.name, type);
  if (!f) return fail("nsfer", `No ${isStatic ? "static " : "instance "}field ${fr.name} of type ${type} in class ${descriptor(decl)} or its superclasses${declared(prog, decl)}`);
  if (f.isStatic !== isStatic) {
    return fail("icce", `Expected '${prettyType(f.desc)} ${dotted(f.owner)}.${f.name}' to be a ${isStatic ? "static" : "instance"} field rather than a ${isStatic ? "instance" : "static"} field${declared(prog, referrer)}`);
  }
  return { decl, f };
}
export const failed = (x: object): x is LinkFailure => "thrower" in x;
