import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { isPlaceholderMethod, type Runtime } from "../src/jvm/runtime";

export const FRAMEWORK_RE = /^(android|java|javax|dalvik|sun|libcore|com\/android\/internal|org\/xmlpull|org\/json|org\/apache\/http)\//;

export type NativeSupport = "delegate" | "placeholder" | "missing";

function splitMember(key: string): readonly [string, string] {
  const dot = key.indexOf(".");
  return [key.slice(0, dot), key.slice(dot + 1)];
}

function nativeCtor(runtime: Runtime, cls: string): Record<string, unknown> | null {
  if (!runtime.natives.has(cls)) return null;
  const ctor = runtime.classes.get(cls)?.ctor;
  return typeof ctor === "function" ? ctor : null;
}

export function nativeClassSupport(runtime: Runtime, cls: string): NativeSupport {
  return runtime.natives.has(cls) ? "delegate" : "missing";
}

export function nativeMethodSupport(runtime: Runtime, key: string): NativeSupport {
  const [cls, signature] = splitMember(key);
  const jni = runtime.jniFn(cls, signature);
  if (jni) return isPlaceholderMethod(jni) ? "placeholder" : "delegate";
  const ctor = nativeCtor(runtime, cls);
  const paren = signature.indexOf("(");
  if (!ctor || paren < 0) return "missing";
  const mangled = mangleMethod(signature.slice(0, paren), signature.slice(paren));
  const prototype = Reflect.get(ctor, "prototype");
  if (prototype === null || typeof prototype !== "object") return "missing";
  const value = Reflect.has(prototype, mangled) ? Reflect.get(prototype, mangled) : ctor[mangled];
  if (typeof value !== "function") return "missing";
  return isPlaceholderMethod(value) ? "placeholder" : "delegate";
}

export function nativeFieldSupport(runtime: Runtime, key: string): NativeSupport {
  const [cls, name] = splitMember(key);
  const ctor = nativeCtor(runtime, cls);
  if (!ctor) return "missing";
  const info = runtime.classes.get(cls);
  return mangleStaticField(name) in ctor || !!info?.fieldTable.has(name) ? "delegate" : "missing";
}

export const rankCalls = (calls: Map<string, number>, keep: (key: string) => boolean): [string, number][] =>
  [...calls].filter(([key]) => keep(key)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
