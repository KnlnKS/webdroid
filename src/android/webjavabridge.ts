// A JavaScript interface: an object's @JavascriptInterface methods, called on the WebView's bridge
// thread with their arguments and results converted as Chromium's Java bridge converts them.
import { JObj, type ClassInfo } from "../jvm/runtime";
import { parseMethodDesc, jarray, PRIM_ARRAYS, type PrimElem } from "../jvm/abi";
import { vcall, callOn, type JThread } from "../jvm/natives/jentry";
import type { WebInterfaces } from "../shell/webbridge";

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
export function javaInterface(o: JObj, thread: JThread): WebInterfaces[string] {
  const out: WebInterfaces[string] = Object.create(null);
  for (let ci = (o.constructor as unknown as { $i?: ClassInfo }).$i ?? null; ci && ci.def && ci.dex; ci = ci.superInfo) {
    const dex = ci.dex, annos = dex.classAnnotations(ci.def).methods;
    for (const m of ci.def.virtualMethods) {
      const name = dex.method(m.methodIdx).name;
      if ((m.flags & 9) !== 1 || name in out || !annos.get(m.methodIdx)?.some((a) => a.type === "android/webkit/JavascriptInterface")) continue;
      const desc = dex.methodDesc(m.methodIdx), { params, ret } = parseMethodDesc(desc);
      out[name] = Object.assign(async (...args: unknown[]) =>
        fromJava(ret, await callOn(thread, () => vcall(o, name, desc, ...params.map((d, i) => toJava(d, args[i]))))), { returns: ret !== "V" });
    }
  }
  return out;
}
