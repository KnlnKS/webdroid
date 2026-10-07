// What ART throws at a use site whose class or member does not resolve (ClassLinker::ResolveType, ResolveField, ResolveMethodWithChecks and
// common_throws.cc): NoClassDefFoundError, NoSuchFieldError, NoSuchMethodError and IncompatibleClassChangeError, with ART's messages. These are
// not gaps: the program asks for something the loaded classes lack, and the error is what it gets.
import type { DexFile } from "../../jvm/dex";
import { descToName } from "../../jvm/abi";
import { ACC, declaredMethod, declaredMethods, javaName, sameRuntimePackage, type FieldInfo, type JClass, type MethodInfo, type Program } from "./program";
import type { Thrower } from "../link/exc";

export interface LinkFailure {
  thrower: Extract<Thrower, "ncdfr" | "nsme" | "nsfer" | "icce">;
  message: string;
  /** the class whose later loading would resolve the site */
  absent?: string;
}

const dotted = (n: string) => javaName(n).replace(/\//g, ".");
const PRIMS: Record<string, string> = { Z: "boolean", B: "byte", C: "char", S: "short", I: "int", J: "long", F: "float", D: "double", V: "void" };
/** a descriptor as ART's PrettyDescriptor prints it */
export const prettyType = (d: string): string => (d[0] === "[" ? prettyType(d.slice(1)) + "[]" : d[0] === "L" ? dotted(d.slice(1, -1)) : PRIMS[d]);
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

const invokeType = (m: MethodInfo, prog: Program) => (m.isStatic ? "static" : m.isCtor || m.flags & ACC.PRIVATE ? "direct" : prog.get(m.cls)?.isInterface ? "interface" : "virtual");
const prettyMethod = (m: MethodInfo) => `${prettyType(m.ret)} ${dotted(m.cls)}.${m.name}(${m.params.map(prettyType).join(", ")})`;

export function symbolicMethod(c: JClass, name: string, desc: string): MethodInfo | undefined {
  const exact = declaredMethod(c, name + desc);
  if (exact) return exact;
  const raw = name + javaName(desc), key = declaredMethods(c).find(([key]) => javaName(key) === raw)?.[0];
  return key === undefined ? undefined : declaredMethod(c, key);
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
export const overridesMethod = (prog: Program, cls: string, m: MethodInfo): boolean => !(m.flags & ACC.PRIVATE) && (!!(m.flags & (ACC.PUBLIC | ACC.PROTECTED)) || sameRuntimePackage(prog, cls, m.cls));

/** Select an override of this declaration, rather than a same-named inaccessible member. */
export function symbolicOverride(prog: Program, cls: string, declared: MethodInfo, includeAbstract = false): MethodInfo | undefined {
  let method = declared, reached = false;
  for (const owner of prog.chain(cls).reverse()) {
    if (owner === declared.cls) { reached = true; continue; }
    if (!reached) continue;
    const candidate = symbolicMethod(prog.require(owner), declared.name, javaName(declared.desc));
    if (candidate && !(candidate.flags & (ACC.STATIC | ACC.PRIVATE)) && overridesMethod(prog, owner, method)) method = candidate;
  }
  return !includeAbstract && method.flags & ACC.ABSTRACT ? undefined : method;
}

/** DEX name/prototype equality selects true overrides; initialization checks their Class identities. */
export function symbolicImplFor(prog: Program, cls: string, slot: string, includeAbstract = false): MethodInfo | undefined {
  const key = dispatchMethodKey(slot), at = key.indexOf("("), name = key.slice(0, at), desc = key.slice(at), split = slot.indexOf("\0");
  if (split >= 0) {
    const declared = symbolicMethod(prog.require(slot.slice(0, split)), name, desc);
    return declared ? symbolicOverride(prog, cls, declared, includeAbstract) : undefined;
  }
  if (prog.loaderOf(cls) === prog.boot) return includeAbstract ? prog.resolve(cls, name, desc) : prog.implFor(cls, name, desc);
  for (const owner of prog.chain(cls).reverse()) {
    const m = symbolicMethod(prog.require(owner), name, desc);
    if (m && !(m.flags & (ACC.STATIC | ACC.PRIVATE)) && m.flags & (ACC.PUBLIC | ACC.PROTECTED)) return symbolicOverride(prog, cls, m, includeAbstract);
  }
  const seen = new Set<string>(), found: MethodInfo[] = [];
  const visit = (owner: string) => {
    if (seen.has(owner)) return;
    seen.add(owner);
    const c = prog.get(owner);
    if (!c) return;
    const m = symbolicMethod(c, name, desc);
    if (m && !(m.flags & (ACC.STATIC | ACC.PRIVATE))) { if (includeAbstract || !(m.flags & ACC.ABSTRACT)) found.push(m); return; }
    c.ifaces.forEach(visit);
  };
  for (const owner of prog.chain(cls)) prog.require(owner).ifaces.forEach(visit);
  return found.find(m => found.every(other => other === m || !prog.isSubclass(other.cls, m.cls)));
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

/** the method an invoke names, or why it does not resolve. `referrer` is the class of the calling method, `kind` the opcode without /range. */
export function resolveInvoke(prog: Program, kind: string, declaredCls: string, name: string, desc: string, referrer: string): MethodInfo | LinkFailure {
  const cls = declaredCls[0] === "[" ? "java/lang/Object" : declaredCls, c = prog.get(cls), at = declared(prog, referrer);
  if (!c) return fail("ncdfr", UNRESOLVED + descriptor(declaredCls), declaredCls);
  if (kind === "invoke-interface" && !c.isInterface) return fail("icce", `Found class ${dotted(cls)}, but interface was expected${at}`);
  if (kind === "invoke-virtual" && c.isInterface) return fail("icce", `Found interface ${dotted(cls)}, but class was expected${at}`);
  const expected = kind.slice(7);
  const owner = kind === "invoke-super" && !c.isInterface ? prog.get(referrer)?.sup ?? cls : cls;
  const m = resolveSymbolicMethod(prog, owner, name, desc);
  if (!m) return fail("nsme", `No ${expected} method ${name}${desc} in class ${descriptor(cls)} or its super classes${declared(prog, cls)}`);
  if (m.isStatic !== (kind === "invoke-static")) {
    const found = invokeType(m, prog);
    return fail("icce", `The method '${prettyMethod(m)}' was expected to be of type ${expected} but instead was found to be of type ${found}${at}`);
  }
  return m;
}

/** the field an iget/iput/sget/sput names, or why it does not resolve */
export function resolveFieldRef(prog: Program, dex: DexFile, idx: number, isStatic: boolean, referrer: string): { decl: string; f: FieldInfo } | LinkFailure {
  const fr = dex.field(idx), decl = descToName(dex.type(fr.cls)), type = dex.rawType(fr.type);
  if (!prog.get(decl)) return fail("ncdfr", UNRESOLVED + dex.type(fr.cls), decl);
  const f = resolveSymbolicField(prog, decl, fr.name, type);
  if (!f) return fail("nsfer", `No ${isStatic ? "static " : "instance "}field ${fr.name} of type ${type} in class ${descriptor(decl)} or its superclasses${declared(prog, decl)}`);
  if (f.isStatic !== isStatic) {
    return fail("icce", `Expected '${prettyType(f.desc)} ${dotted(f.owner)}.${f.name}' to be a ${isStatic ? "static" : "instance"} field rather than a ${isStatic ? "instance" : "static"} field${declared(prog, referrer)}`);
  }
  return { decl, f };
}
export const failed = (x: object): x is LinkFailure => "thrower" in x;
