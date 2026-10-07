import { javaName, type Kind, type Loader } from "../compiler/program";
import { idOfClass } from "./classes";
import { definingLoader, objectOfLoader } from "./loaders";
import { T } from "../compiler/wasmbin";
import type { Strand } from "./sched";
import type { World } from "./world";

function callJava(w: World, owner: Strand, name: string, params: Kind[], ret: Kind | "V", body: Parameters<World["callFn"]>[3], ...args: unknown[]): unknown {
  if (w.inSynchronousJava() || owner.root) {
    const call = w.hostFn(name + ":sync", params, ret, (cx, c) => body(cx, c, i => { c.lget(i); }));
    return w.synchronous(() => call(...args));
  }
  const call = w.callFn(name, params, ret, body), strand = w.sched.strand(owner.thread, owner);
  try {
    const value = call(strand, ...args);
    if (value instanceof Promise) return value.finally(() => strand.end());
    strand.end(); return value;
  } catch (error) { strand.end(); throw error; }
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
    const value = callJava(w, owner, "resolve:forName:failure", ["L", "L"], "L", (cx, c, arg) => {
      const value = c.newLocal(T.anyref);
      cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.ltee(value); arg(0); arg(1); cx.callMethod(c, ctor); c.lget(value);
    }, w.javaString(name), cause);
    const fail = (value: unknown): never => { throw w.exception(value as object); };
    return value instanceof Promise ? value.then(fail) : fail(value);
  };
  const mirror = (key: string): object | Promise<object> => {
    return callJava(w, owner, "resolve:forName:mirror", ["I"], "L", (cx, c, arg) => { arg(0); cx.callRt(c, "classOf"); }, w.idOf(key)) as object | Promise<object>;
  };
  try {
    const key = w.resolveClass(definingLoader(w, object), name.replace(/\./g, "/"), owner);
    return key instanceof Promise ? key.catch(wrap).then(mirror) : w.idOf(key);
  } catch (error) {
    return wrap(error);
  }
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
  const body: Parameters<World["callFn"]>[3] = (cx, c, arg) => {
    arg(0); arg(1); cx.callMethod(c, method);
  };
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
  let result: unknown;
  try {
    const string = w.javaString(name.replace(/\//g, "."));
    result = callJava(w, owner, `resolve:load:${method.cls}`, ["L", "L"], "L", body, object, string);
  } catch (error) { return failed(error); }
  return result instanceof Promise ? result.then(accept, failed) : accept(result);
}
