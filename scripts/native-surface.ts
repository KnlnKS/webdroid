import type { Runtime } from "../src/jvm/runtime.ts";

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
  let impl = runtime.jniNative(cls, signature) ?? undefined;
  for (let c: string | undefined = cls; !impl && c; c = runtime.natives.get(c)?.sup) impl = runtime.specNative(c, signature, false) ?? runtime.specNative(c, signature, true);
  return !impl ? "missing" : impl.placeholder ? "placeholder" : "delegate";
}

export function nativeFieldSupport(runtime: Runtime, key: string): NativeSupport {
  const [cls, name] = splitMember(key);
  const spec = runtime.natives.get(cls);
  if (!spec) return "missing";
  return name in (spec.statics ?? {}) || name in (spec.fields ?? {}) ? "delegate" : "missing";
}

export const rankCalls = (calls: Map<string, number>, keep: (key: string) => boolean): [string, number][] =>
  [...calls].filter(([key]) => keep(key)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
