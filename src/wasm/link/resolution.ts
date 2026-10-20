import { javaName, type Loader } from "../compiler/program.ts";
import { idOfClass } from "./classes.ts";

import { definingLoader, nativeClassLookup, objectOfLoader } from "./loaders.ts";
import type { Strand } from "./sched.ts";
import type { World } from "./world.ts";
import { PerWorld } from "./perworld.ts";
import type { MethodInfo } from "../compiler/program.ts";
import type { PreparedInstruction } from "../../jvm/prepared.ts";
import { Pool, referenceIndex, referenceOf } from "../../jvm/opcodes.ts";
import { descToName } from "../../jvm/abi.ts";
import { handleMemberOwner, handleSignatureTypes, handleThunk, methodTypeSignatureTypes, type SignatureType } from "./mhandles.ts";
import { THROWERS } from "../compiler/exc.ts";
import { resolveHandleMember } from "../compiler/handles.ts";
import { caught, chain, each } from "./maybe.ts";

export function resolveSignatureTypes(w: World, types: SignatureType[], owner: Strand): void | Promise<void> {
  return each(types, ({ descriptor, owner: cls }) => descriptor[0] === "L" || descriptor[0] === "[" ? resolveType(w, w.prog.loaderOf(cls), descToName(descriptor), owner) : undefined);
}

export function resolveHandleReference(w: World, method: MethodInfo, index: number, owner: Strand): void | Promise<void> {
  const ready = resolveType(w, w.prog.loaderOf(method.cls), handleMemberOwner(method, index), owner);
  const signature = () => {
    const member = resolveHandleMember(w.prog, method, index);
    if ("thrower" in member || "errorClass" in member) {
      w.raise("thrower" in member ? THROWERS[member.thrower].cls : member.errorClass, member.message);
    }
    return resolveSignatureTypes(w, handleSignatureTypes(method, index, "field" in member ? member.field : undefined), owner);
  };
  return chain(ready, signature);
}

/** a throwable of `cls` with `message` whose cause is the Java throwable `cause` */
export function causedThrowable(w: World, cls: string, message: string, cause: object): object {
  const throwable = w.helpers.makeThrowable(cls, message);
  w.helpers.hostFn("throwable:cause", ["L", "L"], "V", (cx, c) => {
    const t = "java/lang/Throwable", st = cx.structFor(t);
    c.lget(0).refCast(st).lget(1).structSet(st, cx.fieldIndex(t, { owner: t, name: "cause", desc: "Ljava/lang/Throwable;" }));
  })(throwable, cause);
  return throwable;
}

export function resolveType(w: World, loader: Loader, name: string, owner: Strand): string | Promise<string> {
  const symbolic = name[0] === "[" ? name : `L${name};`, component = symbolic.replace(/^\[+/, "");
  const message = `Failed resolution of: ${symbolic}`;
  if (!objectOfLoader(w, loader) && component[0] === "L" && !w.prog.lookup(loader, descToName(component))) {
    w.raise("java/lang/NoClassDefFoundError", message);
  }
  const fail = (error: unknown): never => {
    const cause = w.throwable(error);
    if (!cause || !w.prog.isSubclass(w.classNameOf(cause), "java/lang/ClassNotFoundException")) throw error;
    throw w.exception(causedThrowable(w, "java/lang/NoClassDefFoundError", message, cause));
  };
  try { return caught(resolveClass(w, loader, name, owner), fail); }
  catch (error) { return fail(error); }
}

export function instructionClass(method: MethodInfo, ins: PreparedInstruction): string | undefined {
  const dex = method.dex, pool = referenceOf(ins.op), at = referenceIndex(ins);
  const index = pool === Pool.Type ? at : pool === Pool.Field ? dex.field(at).cls : pool === Pool.Method ? dex.method(at).cls : undefined;
  if (index === undefined) return;
  const descriptor = dex.rawType(index);
  if (descriptor[0] !== "L" && descriptor[0] !== "[") return;
  return descToName(descriptor);
}

export function initiatedInstruction(w: World, method: MethodInfo, ins: PreparedInstruction): { name: string; key: string } | undefined {
  // An initiated MH/VH owner does not establish resolution of the separate call-site prototype.
  if (ins.name.startsWith("invoke-polymorphic")) return;
  const symbolic = instructionClass(method, ins);
  return symbolic ? initiatedType(w, method.cls, symbolic) : undefined;
}

export function initiatedType(w: World, referrer: string, symbolic: string): { name: string; key: string } | undefined {
  const component = symbolic.replace(/^\[+/, ""), name = symbolic[0] === "[" && component[0] === "L" ? component.slice(1, -1) : symbolic;
  const key = w.prog.initiatedBy(w.prog.loaderOf(referrer), name);
  return key && definitionReady(w, key) ? { name, key } : undefined;
}

/** Resolve only references used by this executed instruction. */
export function resolveInstruction(w: World, method: MethodInfo, ins: PreparedInstruction, owner: Strand): void | Promise<void> {
  if (ins.name === "const-method-type") return resolveSignatureTypes(w, methodTypeSignatureTypes(method, ins.b), owner);
  if (ins.name === "const-method-handle") return resolveHandleReference(w, method, ins.b, owner);
  if (ins.name.startsWith("invoke-polymorphic")) return resolveSignatureTypes(w, methodTypeSignatureTypes(method, ins.c), owner);
  const name = instructionClass(method, ins);
  if (!name) return;
  const key = resolveType(w, w.prog.loaderOf(method.cls), name, owner);
  if (key instanceof Promise) return key.then(() => {});
}

/** ART FindCatchBlock preserves the original exception and skips unresolved catch types. */
export function resolveCatch(w: World, method: MethodInfo, pc: number, throwable: object, owner: Strand): number | Promise<number> {
  const range = method.dex.code(method.codeOff).tries.find(t => pc >= t.start && pc < t.end);
  if (!range) return -1;
  const loader = w.prog.loaderOf(method.cls), thrown = w.classNameOf(throwable);
  const next = (at: number): number | Promise<number> => {
    if (at === range.handlers.length) return range.catchAllAddr;
    const [type, target] = range.handlers[at];
    const matched = (key: string) => w.prog.isSubclass(thrown, key) ? target : next(at + 1);
    const failed = (error: unknown): number | Promise<number> => {
      if (!w.throwable(error)) throw error;
      return next(at + 1);
    };
    try { return chain(resolveType(w, loader, method.dex.rawTypeName(type), owner), matched, failed); }
    catch (error) { return failed(error); }
  };
  return next(0);
}

/** Class.forName wraps lookup errors before its caller performs initialization. */
export function resolveForName(w: World, name: string, object: object | null, owner: Strand): number | Promise<object> {
  const element = name.replace(/^\[+/, ""), binary = name[0] === "[" && element[0] === "L" && element.endsWith(";") ? element.slice(1, -1) : name;
  const valid = name[0] === "[" && /^[ZBCSIJFD]$/.test(element)
    || (!/[\/;\[\u0000]/.test(binary) && binary.split(".").every(part => part.length > 0) && (name[0] !== "[" || element === `L${binary};`));
  if (!valid) w.raise("java/lang/ClassNotFoundException", `Invalid name: ${name}`);
  const wrap = (error: unknown): never | Promise<never> => {
    const cause = w.throwable(error);
    if (!cause) throw error;
    const cls = "java/lang/ClassNotFoundException", ctor = w.prog.resolve(cls, "<init>", "(Ljava/lang/String;Ljava/lang/Throwable;)V");
    if (!ctor) w.raise("java/lang/UnsatisfiedLinkError", "ClassNotFoundException(String, Throwable)");
    const value = handleThunk(w, "resolve:forName:failure", ["L", "L"], "L", (cx, c, arg) => cx.construct(c, ctor, () => { arg(0); arg(1); }), owner)(w.javaString(name), cause);
    return chain(value, (value): never => { throw w.exception(value as object); });
  };
  try {
    const key = resolveClass(w, definingLoader(w, object), name.replace(/\./g, "/"), owner);
    return key instanceof Promise ? key.catch(wrap).then(key => resolvedMirror(w, key, owner)) : w.idOf(key);
  } catch (error) {
    return wrap(error);
  }
}

type Definition = { owner: Strand["thread"]; state: "resolving" | "ready" | "failed"; wait: Promise<string>; error?: unknown };
const definitions = new PerWorld(() => new Map<string, Definition>());

export function definitionReady(w: World, key: string): boolean {
  const cls = w.prog.get(key), loader = w.prog.loaderOf(key);
  return !cls?.dex || !cls.def || w.prog.linksStatically(loader) || !objectOfLoader(w, loader)
    || definitions.peek(w)?.get(key)?.state === "ready";
}

/** Resolve only declaration hierarchy before a definition publishes layout or its mirror. */
export function prepareDefinition(w: World, key: string, owner: Strand): string | Promise<string> {
  const cls = w.prog.get(key), loader = w.prog.loaderOf(key);
  if (!cls?.dex || !cls.def || w.prog.linksStatically(loader) || !objectOfLoader(w, loader)) return key;
  const states = definitions.get(w);
  const prior = states.get(key);
  if (prior) {
    if (prior.state === "ready") return key;
    if (prior.state === "failed") throw prior.error;
    if (prior.owner === owner.thread) w.raise("java/lang/ClassCircularityError", javaName(key));
    return prior.wait;
  }
  let complete!: (key: string) => void, reject!: (error: unknown) => void;
  const wait = new Promise<string>((yes, no) => { complete = yes; reject = no; });
  wait.catch(() => {});
  const state: Definition = { owner: owner.thread, state: "resolving", wait };
  states.set(key, state);
  const { superIdx, interfaces } = cls.def, dex = cls.dex;
  const names = [...superIdx === 0xffffffff ? [] : [superIdx], ...interfaces].map(i => dex.rawTypeName(i));
  const finish = () => { state.state = "ready"; complete(key); return key; };
  const fail = (error: unknown): never => { state.state = "failed"; state.error = error; reject(error); throw error; };
  try { return caught(chain(each(names, (name) => resolveType(w, loader, name, owner)), finish), fail); }
  catch (error) { return fail(error); }
}

export function resolvedMirror(w: World, key: string, owner: Strand): object | Promise<object> {
  return handleThunk(w, "resolve:mirror", ["I"], "L", (cx, c, arg) => { arg(0); cx.callRt(c, "classOf"); }, owner)(w.idOf(key)) as object | Promise<object>;
}

/** Resolve one executed symbolic request without linking its class module. */
export function resolveClass(w: World, loader: Loader, name: string, owner: Strand): string | Promise<string> {
  const missing = (): never => w.raise("java/lang/ClassNotFoundException", name.replace(/\//g, "."));
  if (name.startsWith("[")) {
    const component = name.replace(/^\[+/, "");
    if (/^[ZBCSIJFD]$/.test(component)) return name;
    if (!component.startsWith("L") || !component.endsWith(";")) return missing();
    const found = resolveClass(w, loader, component.slice(1, -1), owner);
    const array = (key: string) => name.slice(0, name.length - component.length) + `L${key};`;
    return chain(found, array);
  }
  const loaded = w.prog.initiatedBy(loader, name);
  if (loaded) return prepareDefinition(w, loaded, owner);
  const object = objectOfLoader(w, loader);
  if (!object) {
    // The boot namespace and the host's startup namespace have no Java loader peer yet.
    const key = w.prog.lookup(loader, name);
    if (!key) w.raise("java/lang/NoClassDefFoundError", name);
    w.namespaces.initiateClass(loader, name, key);
    return key;
  }
  const native = nativeClassLookup(w, loader, name);
  if (native) {
    w.namespaces.initiateClass(loader, name, native);
    return prepareDefinition(w, native, owner);
  }
  const method = w.prog.implFor(w.classNameOf(object), "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;");
  if (!method) w.raise("java/lang/AbstractMethodError", "ClassLoader.loadClass");
  // Java owns custom delegation and denial. Do not deduplicate pending calls in JS.
  const body: Parameters<World["helpers"]["callFn"]>[3] = (cx, c, arg) => {
    arg(0); arg(1); cx.callMethod(c, method);
  };
  const accept = (mirror: unknown): string | Promise<string> => {
    if (!mirror) w.raise("java/lang/NullPointerException", `ClassLoader.loadClass returned null for ${name.replace(/\//g, ".")}`);
    const id = w.helpers.hostFn("resolve:classId", ["L"], "I", (cx, c) => { c.lget(0); idOfClass(cx, c); })(mirror) as number;
    const key = w.nameOf(id);
    const winner = w.prog.initiatedBy(loader, name);
    if (winner) return prepareDefinition(w, winner, owner);
    if (javaName(key) !== name) w.raise("java/lang/NoClassDefFoundError", `${name} (wrong name: ${javaName(key)})`);
    w.namespaces.initiateClass(loader, name, key);
    return prepareDefinition(w, key, owner);
  };
  const failed = (error: unknown): string | Promise<string> => {
    const winner = w.prog.initiatedBy(loader, name);
    if (winner) return prepareDefinition(w, winner, owner);
    throw error;
  };
  let result: unknown;
  try {
    const string = w.javaString(name.replace(/\//g, "."));
    result = handleThunk(w, `resolve:load:${method.cls}`, ["L", "L"], "L", body, owner)(object, string);
  } catch (error) { return failed(error); }
  return chain(result, accept, failed);
}
