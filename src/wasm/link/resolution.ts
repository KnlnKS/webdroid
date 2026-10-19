import { javaName, type Loader } from "../compiler/program.ts";
import { idOfClass } from "./classes.ts";

import { definingLoader, nativeClassLookup, objectOfLoader } from "./loaders.ts";
import type { Strand } from "./sched.ts";
import type { World } from "./world.ts";
import type { MethodInfo } from "../compiler/program.ts";
import type { PreparedInstruction } from "../../jvm/prepared.ts";
import { descToName } from "../../jvm/abi.ts";
import { handleMemberOwner, handleSignatureTypes, handleThunk, methodTypeSignatureTypes, resolveHandleMember, type SignatureType } from "./mhandles.ts";
import { THROWERS } from "../compiler/exc.ts";

export function resolveSignatureTypes(w: World, types: SignatureType[], owner: Strand): void | Promise<void> {
  const next = (at: number): void | Promise<void> => {
    for (; at < types.length; at++) {
      const { descriptor, owner: cls } = types[at];
      if (descriptor[0] !== "L" && descriptor[0] !== "[") continue;
      const ready = resolveType(w, w.prog.loaderOf(cls), descToName(descriptor), owner);
      if (ready instanceof Promise) return ready.then(() => next(at + 1));
    }
  };
  return next(0);
}

export function resolveHandleReference(w: World, method: MethodInfo, index: number, owner: Strand): void | Promise<void> {
  const ready = resolveType(w, w.prog.loaderOf(method.cls), handleMemberOwner(method, index), owner);
  const signature = () => {
    const member = resolveHandleMember(w, method, index);
    if ("thrower" in member || "errorClass" in member) {
      throw w.exception(w.makeThrowable("thrower" in member ? THROWERS[member.thrower].cls : member.errorClass, member.message));
    }
    return resolveSignatureTypes(w, handleSignatureTypes(method, index, "field" in member ? member.field : undefined), owner);
  };
  return ready instanceof Promise ? ready.then(signature) : signature();
}

/** a throwable of `cls` with `message` whose cause is the Java throwable `cause` */
export function causedThrowable(w: World, cls: string, message: string, cause: object): object {
  const throwable = w.makeThrowable(cls, message);
  w.hostFn("throwable:cause", ["L", "L"], "V", (cx, c) => {
    const t = "java/lang/Throwable", st = cx.structFor(t);
    c.lget(0).refCast(st).lget(1).structSet(st, cx.fieldIndex(t, { owner: t, name: "cause", desc: "Ljava/lang/Throwable;" }));
  })(throwable, cause);
  return throwable;
}

export function resolveType(w: World, loader: Loader, name: string, owner: Strand): string | Promise<string> {
  const symbolic = name[0] === "[" ? name : `L${name};`, component = symbolic.replace(/^\[+/, "");
  const message = `Failed resolution of: ${symbolic}`;
  if (!objectOfLoader(w, loader) && component[0] === "L" && !w.prog.lookup(loader, descToName(component))) {
    throw w.exception(w.makeThrowable("java/lang/NoClassDefFoundError", message));
  }
  const fail = (error: unknown): never => {
    const cause = w.throwable(error);
    if (!cause || !w.prog.isSubclass(w.classNameOf(cause), "java/lang/ClassNotFoundException")) throw error;
    throw w.exception(causedThrowable(w, "java/lang/NoClassDefFoundError", message, cause));
  };
  try { const key = resolveClass(w, loader, name, owner); return key instanceof Promise ? key.catch(fail) : key; }
  catch (error) { return fail(error); }
}

export function instructionClass(method: MethodInfo, ins: PreparedInstruction): string | undefined {
  const dex = method.dex, n = ins.name;
  const index = /^(const-class|check-cast|new-instance|filled-new-array)/.test(n) ? ins.b
    : n === "instance-of" || n === "new-array" ? ins.c
    : /^(iget|iput)/.test(n) ? dex.field(ins.c).cls
    : /^(sget|sput)/.test(n) ? dex.field(ins.b).cls
    : /^invoke-(virtual|interface|static|direct|super|polymorphic)/.test(n) ? dex.method(ins.b).cls : undefined;
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
    try {
      const key = resolveType(w, loader, method.dex.rawTypeName(type), owner);
      return key instanceof Promise ? key.then(matched, failed) : matched(key);
    } catch (error) { return failed(error); }
  };
  return next(0);
}

/** Class.forName wraps lookup errors before its caller performs initialization. */
export function resolveForName(w: World, name: string, object: object | null, owner: Strand): number | Promise<object> {
  const element = name.replace(/^\[+/, ""), binary = name[0] === "[" && element[0] === "L" && element.endsWith(";") ? element.slice(1, -1) : name;
  const valid = name[0] === "[" && /^[ZBCSIJFD]$/.test(element)
    || (!/[\/;\[\u0000]/.test(binary) && binary.split(".").every(part => part.length > 0) && (name[0] !== "[" || element === `L${binary};`));
  if (!valid) throw w.exception(w.makeThrowable("java/lang/ClassNotFoundException", `Invalid name: ${name}`));
  const wrap = (error: unknown): never | Promise<never> => {
    const cause = w.throwable(error);
    if (!cause) throw error;
    const cls = "java/lang/ClassNotFoundException", ctor = w.prog.resolve(cls, "<init>", "(Ljava/lang/String;Ljava/lang/Throwable;)V");
    if (!ctor) throw w.exception(w.makeThrowable("java/lang/UnsatisfiedLinkError", "ClassNotFoundException(String, Throwable)"));
    const value = handleThunk(w, "resolve:forName:failure", ["L", "L"], "L", (cx, c, arg) => cx.construct(c, ctor, () => { arg(0); arg(1); }), owner)(w.javaString(name), cause);
    const fail = (value: unknown): never => { throw w.exception(value as object); };
    return value instanceof Promise ? value.then(fail) : fail(value);
  };
  try {
    const key = w.resolveClass(definingLoader(w, object), name.replace(/\./g, "/"), owner);
    return key instanceof Promise ? key.catch(wrap).then(key => resolvedMirror(w, key, owner)) : w.idOf(key);
  } catch (error) {
    return wrap(error);
  }
}

type Definition = { owner: Strand["thread"]; state: "resolving" | "ready" | "failed"; wait: Promise<string>; error?: unknown };
const definitions = new WeakMap<World, Map<string, Definition>>();

export function definitionReady(w: World, key: string): boolean {
  const cls = w.prog.get(key), loader = w.prog.loaderOf(key);
  return !cls?.dex || !cls.def || w.prog.linksStatically(loader) || !objectOfLoader(w, loader)
    || definitions.get(w)?.get(key)?.state === "ready";
}

/** Resolve only declaration hierarchy before a definition publishes layout or its mirror. */
export function prepareDefinition(w: World, key: string, owner: Strand): string | Promise<string> {
  const cls = w.prog.get(key), loader = w.prog.loaderOf(key);
  if (!cls?.dex || !cls.def || w.prog.linksStatically(loader) || !objectOfLoader(w, loader)) return key;
  let states = definitions.get(w);
  if (!states) definitions.set(w, states = new Map());
  const prior = states.get(key);
  if (prior) {
    if (prior.state === "ready") return key;
    if (prior.state === "failed") throw prior.error;
    if (prior.owner === owner.thread) throw w.exception(w.makeThrowable("java/lang/ClassCircularityError", javaName(key)));
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
  const next = (at: number): string | Promise<string> => {
    if (at === names.length) return finish();
    const result = resolveType(w, loader, names[at], owner);
    return result instanceof Promise ? result.then(() => next(at + 1)) : next(at + 1);
  };
  try { const result = next(0); return result instanceof Promise ? result.catch(fail) : result; }
  catch (error) { return fail(error); }
}

export function resolvedMirror(w: World, key: string, owner: Strand): object | Promise<object> {
  return handleThunk(w, "resolve:mirror", ["I"], "L", (cx, c, arg) => { arg(0); cx.callRt(c, "classOf"); }, owner)(w.idOf(key)) as object | Promise<object>;
}

/** Resolve one executed symbolic request without linking its class module. */
export function resolveClass(w: World, loader: Loader, name: string, owner: Strand): string | Promise<string> {
  const missing = (): never => { throw w.exception(w.makeThrowable("java/lang/ClassNotFoundException", name.replace(/\//g, "."))); };
  if (name.startsWith("[")) {
    const component = name.replace(/^\[+/, "");
    if (/^[ZBCSIJFD]$/.test(component)) return name;
    if (!component.startsWith("L") || !component.endsWith(";")) return missing();
    const found = resolveClass(w, loader, component.slice(1, -1), owner);
    const array = (key: string) => name.slice(0, name.length - component.length) + `L${key};`;
    return found instanceof Promise ? found.then(array) : array(found);
  }
  const loaded = w.prog.initiatedBy(loader, name);
  if (loaded) return prepareDefinition(w, loaded, owner);
  const object = objectOfLoader(w, loader);
  if (!object) {
    // The boot namespace and the host's startup namespace have no Java loader peer yet.
    const key = w.prog.lookup(loader, name);
    if (!key) throw w.exception(w.makeThrowable("java/lang/NoClassDefFoundError", name));
    w.initiateClass(loader, name, key);
    return key;
  }
  const native = nativeClassLookup(w, loader, name);
  if (native) {
    w.initiateClass(loader, name, native);
    return prepareDefinition(w, native, owner);
  }
  const method = w.prog.implFor(w.classNameOf(object), "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;");
  if (!method) throw w.exception(w.makeThrowable("java/lang/AbstractMethodError", "ClassLoader.loadClass"));
  // Java owns custom delegation and denial. Do not deduplicate pending calls in JS.
  const body: Parameters<World["callFn"]>[3] = (cx, c, arg) => {
    arg(0); arg(1); cx.callMethod(c, method);
  };
  const accept = (mirror: unknown): string | Promise<string> => {
    if (!mirror) throw w.exception(w.makeThrowable("java/lang/NullPointerException", `ClassLoader.loadClass returned null for ${name.replace(/\//g, ".")}`));
    const id = w.hostFn("resolve:classId", ["L"], "I", (cx, c) => { c.lget(0); idOfClass(cx, c); })(mirror) as number;
    const key = w.nameOf(id);
    const winner = w.prog.initiatedBy(loader, name);
    if (winner) return prepareDefinition(w, winner, owner);
    if (javaName(key) !== name) throw w.exception(w.makeThrowable("java/lang/NoClassDefFoundError", `${name} (wrong name: ${javaName(key)})`));
    w.initiateClass(loader, name, key);
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
  return result instanceof Promise ? result.then(accept, failed) : accept(result);
}
