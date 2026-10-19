import { descToName } from "../../jvm/abi.ts";
import { ACC, declaredMethods, javaName, type MethodInfo } from "../compiler/program.ts";
import { symbolicMethod, canAccess } from "../compiler/linkage.ts";
import { rt } from "../compiler/rtfns.ts";
import { T } from "../compiler/wasmbin.ts";
import { causedThrowable, resolveType } from "./resolution.ts";
import { type Strand } from "./sched.ts";
import type { World } from "./world.ts";
import { emitSave } from "../compiler/hostcalls.ts";

type Declaration = { cls: string; key: string; flags: number };
type Pair = [Declaration, Declaration];
const virtual = (key: string, flags: number) => !(flags & (ACC.STATIC | ACC.PRIVATE | ACC.CONSTRUCTOR)) && key[0] !== "<";

function virtualMethods(w: World, cls: string, caller: string): Map<string, Declaration> {
  const methods = new Map<string, Declaration>();
  for (const name of [...w.prog.chain(cls)].reverse()) {
    const c = w.prog.require(name);
    for (const [key, flags] of declaredMethods(c)) {
      if (virtual(key, flags) && canAccess(w.prog, caller, c, flags)) methods.set(javaName(key), { cls: name, key, flags });
    }
  }
  return methods;
}

function defaultMethod(w: World, cls: string, key: string): Declaration | undefined {
  const seen = new Set<string>(), found: Declaration[] = [];
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const c = w.prog.get(name);
    if (!c) return;
    const entry = declaredMethods(c).find(([candidate, flags]) => virtual(candidate, flags) && javaName(candidate) === key);
    if (entry) {
      if (!(entry[1] & ACC.ABSTRACT)) found.push({ cls: name, key: entry[0], flags: entry[1] });
      return;
    }
    c.ifaces.forEach(visit);
  };
  for (const name of w.prog.chain(cls)) w.prog.require(name).ifaces.forEach(visit);
  return found.find(m => found.every(other => other === m || !w.prog.isSubclass(other.cls, m.cls)));
}

/** ART ValidateSuperClassDescriptors checks changed dispatch entries, not unused prototypes. */
function constraints(w: World, cls: string): Pair[] {
  const c = w.prog.get(cls);
  if (!c || c.isInterface) return [];
  const loader = w.prog.loaderOf(cls);
  if (loader === w.prog.boot) return [];
  // A static namespace delegates to the boot loader first, so it resolves every type a boot class names as that class does.
  const other = (name: string) => { const l = w.prog.loaderOf(name); return l !== loader && !(l === w.prog.boot && w.prog.linksStatically(loader)); };
  const interfaces = new Set<string>();
  const visit = (name: string) => {
    if (interfaces.has(name)) return;
    interfaces.add(name); w.prog.get(name)?.ifaces.forEach(visit);
  };
  for (const name of w.prog.chain(cls)) w.prog.require(name).ifaces.forEach(visit);
  const differentSuper = !!c.sup && other(c.sup);
  const differentIfaces = [...interfaces].filter(other);
  if (!differentSuper && !differentIfaces.length) return [];
  const methods = virtualMethods(w, cls, cls), pairs: Pair[] = [];
  const changed = (a: Declaration, b: Declaration) => a.cls !== b.cls || a.key !== b.key;
  if (differentSuper) for (const [key, base] of [...virtualMethods(w, c.sup!, cls)].reverse()) {
    const method = methods.get(key);
    if (method && changed(method, base)) pairs.push([method, base]);
  }
  for (const name of differentIfaces) {
    const iface = w.prog.require(name);
    for (const [key, flags] of declaredMethods(iface)) {
      if (!virtual(key, flags)) continue;
      const base = { cls: name, key, flags }, method = methods.get(javaName(key)) ?? defaultMethod(w, cls, javaName(key));
      if (method && changed(method, base)) pairs.push([method, base]);
    }
  }
  return pairs;
}

export const hasSignatureConstraints = (w: World, cls: string): boolean => constraints(w, cls).length > 0;

type Validation = { thread: Strand["thread"]; wait: Promise<void> } | { ready: true } | { failed: true };
const validations = new WeakMap<World, Map<string, Validation>>();

function signature(m: MethodInfo): string[] {
  if (!m.dex || m.methodIdx < 0) return [m.ret, ...m.params];
  const p = m.dex.proto(m.dex.method(m.methodIdx).proto);
  return [p.ret, ...p.params].map(type => m.dex.rawType(type));
}

export function validateSignatures(w: World, cls: string, owner: Strand): void | Promise<void> {
  let states = validations.get(w);
  if (!states) validations.set(w, states = new Map());
  const prior = states.get(cls);
  if (prior) {
    if ("ready" in prior) return;
    const erroneous = (): never => { throw w.exception(w.makeThrowable("java/lang/NoClassDefFoundError", `Could not initialize class ${javaName(cls)}`)); };
    if ("failed" in prior) return erroneous();
    if (prior.thread !== owner.thread) return prior.wait.catch(error => {
      if (w.throwable(error)) return erroneous();
      throw error;
    });
  }
  const pairs = constraints(w, cls);
  const linkage = (message: string, error?: unknown): never => {
    const cause = error === undefined ? undefined : w.throwable(error);
    if (error !== undefined && !cause) throw error;
    throw w.exception(cause ? causedThrowable(w, "java/lang/LinkageError", message, cause) : w.makeThrowable("java/lang/LinkageError", message));
  };
  const type = (m: MethodInfo, descriptor: string): string | Promise<string> => {
    if (descriptor[0] !== "L" && descriptor[0] !== "[") return descriptor;
    // Generated methods already carry the exact Class identities supplied by their creator.
    if (!m.dex || m.methodIdx < 0) return descToName(descriptor);
    return resolveType(w, w.prog.loaderOf(m.cls), descToName(descriptor), owner);
  };
  const nextPair = (at: number): void | Promise<void> => {
    if (at === pairs.length) return;
    const [targetDecl, baseDecl] = pairs[at];
    const hydrate = (d: Declaration): MethodInfo => {
      const at = d.key.indexOf("(");
      return symbolicMethod(w.prog.require(d.cls), d.key.slice(0, at), d.key.slice(at))!;
    };
    const target = hydrate(targetDecl), base = hydrate(baseDecl);
    const a = signature(target), b = signature(base);
    const message = `Class ${javaName(cls)} method ${javaName(target.key)} signature against ${javaName(base.cls)}`;
    const nextType = (index: number): void | Promise<void> => {
      if (index === a.length) return nextPair(at + 1);
      const resolved = (m: MethodInfo, descriptor: string): string | Promise<string> => {
        const failed = (error: unknown): never => linkage(`${message}: failed to resolve signature type`, error);
        try { const value = type(m, descriptor); return value instanceof Promise ? value.catch(failed) : value; }
        catch (error) { return failed(error); }
      };
      const other = (key: string): void | Promise<void> => {
        const compare = (otherKey: string) => {
          if (key !== otherKey) linkage(`${message} resolves differently: ${key} vs ${otherKey}`);
          return nextType(index + 1);
        };
        const value = resolved(base, b[index]);
        return value instanceof Promise ? value.then(compare) : compare(value);
      };
      const value = resolved(target, a[index]);
      return value instanceof Promise ? value.then(other) : other(value);
    };
    return nextType(0);
  };
  const ready = () => { states!.set(cls, { ready: true }); };
  const failed = (error: unknown): never => {
    if (w.throwable(error)) states!.set(cls, { failed: true }); else states!.delete(cls);
    throw error;
  };
  try {
    const value = nextPair(0);
    if (value instanceof Promise) {
      const wait = value.then(ready, failed);
      if (!prior) states.set(cls, { thread: owner.thread, wait });
      return wait;
    }
    ready();
  } catch (error) { return failed(error); }
}

rt("validateSignatures", ["I"], "V", (cx, c) => {
  const restore = emitSave(cx, c), error = c.newLocal(T.anyref);
  c.block().block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
  c.call(cx.imp.catchSync).if_(); c.lget(0).call(cx.imp.initSignatures);
  c.else_(); c.lget(0).call(cx.imp.initSignaturesWait); c.end();
  restore(); c.br(2);
  c.end().unreachable().end().lset(error); restore(); c.lget(error).throw_(cx.tag);
  c.end();
});
