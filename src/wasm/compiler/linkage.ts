// What ART throws at a use site whose class or member does not resolve (ClassLinker::ResolveType, ResolveField, ResolveMethodWithChecks and
// common_throws.cc): NoClassDefFoundError, NoSuchFieldError, NoSuchMethodError and IncompatibleClassChangeError, with ART's messages. These are
// not gaps: the program asks for something the loaded classes lack, and the error is what it gets.
import type { DexFile } from "../../jvm/dex";
import { descToName } from "../../jvm/abi";
import { ACC, javaName, type FieldInfo, type MethodInfo, type Program } from "./program";
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

/** the method an invoke names, or why it does not resolve. `referrer` is the class of the calling method, `kind` the opcode without /range. */
export function resolveInvoke(prog: Program, kind: string, declaredCls: string, name: string, desc: string, referrer: string): MethodInfo | LinkFailure {
  const cls = declaredCls[0] === "[" ? "java/lang/Object" : declaredCls, c = prog.get(cls), at = declared(prog, referrer);
  if (!c) return fail("ncdfr", UNRESOLVED + descriptor(declaredCls), declaredCls);
  if (kind === "invoke-interface" && !c.isInterface) return fail("icce", `Found class ${dotted(cls)}, but interface was expected${at}`);
  if (kind === "invoke-virtual" && c.isInterface) return fail("icce", `Found interface ${dotted(cls)}, but class was expected${at}`);
  const expected = kind.slice(7);
  const m = kind === "invoke-super" ? prog.superTarget(referrer, cls, name, desc) : prog.resolve(cls, name, desc);
  if (!m) return fail("nsme", `No ${expected} method ${name}${desc} in class ${descriptor(cls)} or its super classes${declared(prog, cls)}`);
  if (m.isStatic !== (kind === "invoke-static")) {
    const found = invokeType(m, prog);
    return fail("icce", `The method '${prettyMethod(m)}' was expected to be of type ${expected} but instead was found to be of type ${found}${at}`);
  }
  return m;
}

/** the field an iget/iput/sget/sput names, or why it does not resolve */
export function resolveFieldRef(prog: Program, dex: DexFile, idx: number, isStatic: boolean, referrer: string): { decl: string; f: FieldInfo } | LinkFailure {
  const fr = dex.field(idx), decl = descToName(dex.type(fr.cls)), type = dex.type(fr.type);
  if (!prog.get(decl)) return fail("ncdfr", UNRESOLVED + dex.type(fr.cls), decl);
  const f = prog.resolveField(decl, fr.name, type);
  if (!f) return fail("nsfer", `No ${isStatic ? "static " : "instance "}field ${fr.name} of type ${type} in class ${descriptor(decl)} or its superclasses${declared(prog, decl)}`);
  if (f.isStatic !== isStatic) {
    return fail("icce", `Expected '${prettyType(f.desc)} ${dotted(f.owner)}.${f.name}' to be a ${isStatic ? "static" : "instance"} field rather than a ${isStatic ? "instance" : "static"} field${declared(prog, referrer)}`);
  }
  return { decl, f };
}
export const failed = (x: object): x is LinkFailure => "thrower" in x;
