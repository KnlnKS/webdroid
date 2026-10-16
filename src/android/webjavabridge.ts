// A JavaScript interface: an object's @JavascriptInterface methods, called on the WebView's bridge
// thread with their arguments and results converted as Chromium's Java bridge converts them.
import { driven, type Gen, type JObj } from "../jvm/runtime.ts";
import { PRIM_DESC, jarray, PRIM_ARRAYS, type PrimElem } from "../jvm/abi.ts";
import { vcall, scall, callOn, type JThread } from "../jvm/natives/jentry.ts";
import type { WebInterfaces } from "../shell/webbridge.ts";

/** page-side proxies of the interfaces, so the page does not keep the Java objects (and so often its WebView) reachable */
export function weakIfaces(of: () => WebInterfaces | null | undefined): WebInterfaces {
  const out: WebInterfaces = Object.create(null);
  for (const [name, methods] of Object.entries(of() ?? {})) {
    const proxy: WebInterfaces[string] = out[name] = Object.create(null);
    for (const m in methods) proxy[m] = Object.assign(async (...args: unknown[]) => of()?.[name]?.[m]?.(...args), { returns: methods[m].returns });
  }
  return out;
}
const toJava = (d: string, x: unknown): unknown =>
  d === "J" ? BigInt(Math.trunc(Number(x)) || 0) : d === "Z" ? (x ? 1 : 0) : d === "F" || d === "D" ? Number(x)
  : d === "C" ? String(x).charCodeAt(0) | 0 : d.length === 1 ? Number(x) | 0 : d[0] === "[" ? toJavaArray(d.slice(1), x) : x;
/** a JavaScript array as Chromium's bridge passes it for an array parameter: primitive and String
 *  elements convert, and any other array type, or a value that is no array, is null */
function toJavaArray(elem: string, x: unknown): unknown {
  if (!Array.isArray(x)) return null;
  if (elem in PRIM_ARRAYS) {
    const out = new PRIM_ARRAYS[elem as PrimElem](x.length) as unknown as unknown[];
    x.forEach((v, i) => { out[i] = toJava(elem, v); });
    return out;
  }
  return elem === "Ljava/lang/String;" ? jarray(x.map((v) => typeof v === "string" ? v : null), elem) : null;
}
const fromJava = (d: string, r: unknown): unknown => d === "J" ? Number(r) : d === "Z" ? !!r : d === "V" ? undefined : r;
export const javaInterface = driven(function* (o: JObj, thread: JThread): Gen<WebInterfaces[string]> {
  const out: WebInterfaces[string] = Object.create(null);
  const annotation = yield scall("java/lang/Class", "forName", "(Ljava/lang/String;)Ljava/lang/Class;", "android.webkit.JavascriptInterface");
  const cls = yield vcall(o, "getClass", "()Ljava/lang/Class;");
  function* descriptor(type: unknown): Gen<string> {
    const name: string = yield vcall(type, "getName", "()Ljava/lang/String;");
    return PRIM_DESC[name] ?? (name[0] === "[" ? name : "L" + name + ";").replace(/\./g, "/");
  }
  for (const method of yield vcall(cls, "getMethods", "()[Ljava/lang/reflect/Method;")) {
    const flags = yield vcall(method, "getModifiers", "()I");
    if (flags & 8 || !(yield vcall(method, "isAnnotationPresent", "(Ljava/lang/Class;)Z", annotation))) continue;
    const name: string = yield vcall(method, "getName", "()Ljava/lang/String;");
    if (name in out) continue;
    const params: string[] = [];
    for (const type of yield vcall(method, "getParameterTypes", "()[Ljava/lang/Class;")) params.push(yield* descriptor(type));
    const ret = yield* descriptor(yield vcall(method, "getReturnType", "()Ljava/lang/Class;")), desc = "(" + params.join("") + ")" + ret;
    out[name] = Object.assign(async (...args: unknown[]) =>
      fromJava(ret, await callOn(thread, () => vcall(o, name, desc, ...params.map((d, i) => toJava(d, args[i]))))), { returns: ret !== "V" });
  }
  return out;
});
