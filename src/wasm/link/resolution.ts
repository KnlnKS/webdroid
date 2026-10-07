import { javaName, type Loader } from "../compiler/program";
import { idOfClass } from "./classes";
import { objectOfLoader } from "./loaders";
import type { Strand } from "./sched";
import type { World } from "./world";

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
  if (loaded) return loaded;
  const object = objectOfLoader(w, loader);
  if (!object) {
    // The boot namespace and the host's startup namespace have no Java loader peer yet.
    const key = w.prog.lookup(loader, name);
    if (!key) throw w.exception(w.makeThrowable("java/lang/NoClassDefFoundError", name));
    w.initiateClass(loader, name, key);
    return key;
  }
  const method = w.prog.implFor(w.classNameOf(object), "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;");
  if (!method) throw w.exception(w.makeThrowable("java/lang/AbstractMethodError", "ClassLoader.loadClass"));
  // Java owns loader locking, recursive delegation and denial. Do not deduplicate pending calls in JS.
  const call = w.callFn(`resolve:load:${method.cls}`, ["L", "L"], "L", (cx, c, arg) => {
    arg(0); arg(1); cx.callMethod(c, method);
  });
  const accept = (mirror: unknown): string => {
    if (!mirror) throw w.exception(w.makeThrowable("java/lang/NullPointerException", `ClassLoader.loadClass returned null for ${name.replace(/\//g, ".")}`));
    const id = w.hostFn("resolve:classId", ["L"], "I", (cx, c) => { c.lget(0); idOfClass(cx, c); })(mirror) as number;
    const key = w.nameOf(id);
    const winner = w.prog.initiatedBy(loader, name);
    if (winner) return winner;
    if (javaName(key) !== name) throw w.exception(w.makeThrowable("java/lang/NoClassDefFoundError", `${name} (wrong name: ${javaName(key)})`));
    w.initiateClass(loader, name, key);
    return key;
  };
  const failed = (error: unknown): string => {
    const winner = w.prog.initiatedBy(loader, name);
    if (winner) return winner;
    throw error;
  };
  const strand = w.sched.strand(owner.thread, owner);
  let result: unknown;
  try {
    result = call(strand, object, w.javaString(name.replace(/\//g, ".")));
  } catch (error) { strand.end(); return failed(error); }
  if (result instanceof Promise) return result.then(accept, failed).finally(() => strand.end());
  try { return accept(result); } finally { strand.end(); }
}
