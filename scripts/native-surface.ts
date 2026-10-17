import { isPlaceholderMethod, type Runtime } from "../src/jvm/runtime.ts";

export const FRAMEWORK_RE = /^(android|java|javax|dalvik|sun|libcore|com\/android\/internal|org\/xmlpull|org\/json|org\/apache\/http)\//;

export type NativeSupport = "delegate" | "placeholder" | "missing";

function splitMember(key: string): readonly [string, string] {
  const dot = key.indexOf(".");
  return [key.slice(0, dot), key.slice(dot + 1)];
}

export function nativeClassSupport(runtime: Runtime, cls: string): NativeSupport {
  return runtime.natives.has(cls) ? "delegate" : "missing";
}

/** a JNI function, else the spec method of `cls` or of a spec superclass, as the Wasm host binds them (nativesource.ts) */
export function nativeMethodSupport(runtime: Runtime, key: string): NativeSupport {
  const [cls, signature] = splitMember(key);
  let fn: unknown = runtime.jniFn(cls, signature);
  for (let c: string | undefined = cls; !fn && c; c = runtime.natives.get(c)?.sup) {
    const spec = runtime.natives.get(c), impl = spec?.methods?.[signature] ?? spec?.methods?.["static " + signature];
    fn = typeof impl === "string" ? spec!.ctor.prototype[impl] : impl;
  }
  return typeof fn !== "function" ? "missing" : isPlaceholderMethod(fn) ? "placeholder" : "delegate";
}

export function nativeFieldSupport(runtime: Runtime, key: string): NativeSupport {
  const [cls, name] = splitMember(key);
  const spec = runtime.natives.get(cls);
  if (!spec) return "missing";
  const fields = Array.isArray(spec.fields) ? spec.fields : Object.keys(spec.fields ?? {});
  return name in (spec.statics ?? {}) || fields.includes(name) ? "delegate" : "missing";
}

export const rankCalls = (calls: Map<string, number>, keep: (key: string) => boolean): [string, number][] =>
  [...calls].filter(([key]) => keep(key)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
