// How host code enters Java on the Wasm tier: the Entry that src/jvm/natives/jentry.ts selects with `useEntry`, over one World. A Java object
// is a facade (bridge.ts) to host code, one per object; a Java exception that leaves a call is thrown as the facade of the throwable, which
// stands where the JS tier's JThrowable does. Nothing here suspends yet: a call that would wait for another thread is Track C's.
import { rt, JObj } from "../../jvm/runtime";
import { mangleField } from "../../jvm/abi";
import { JThrowable } from "../../jvm/natives/jthrowable";
import type { Entry } from "../../jvm/natives/jentry";
import type { JavaClass } from "../../jvm/tier";
import type { FieldInfo } from "../compiler/program";
import type { World } from "../link/world";
import { fromBits, refOf, toBits } from "./bridge";
import { count } from "./stats";

const OBJECT = "Ljava/lang/Object;", ARRAY_SUPERS = new Set(["java/lang/Object", "java/lang/Cloneable", "java/io/Serializable"]);

export function wasmEntry(w: World): Entry {
  const { bridge, prog } = w;
  const missing = (what: string): Error => rt.unimplemented(what);
  /** `f` as a call into Java: an exception that leaves it reaches the host as its throwable's facade */
  const enter = <T>(f: () => T): T => {
    count("wasmEntries");
    try { return f(); } catch (e) {
      const java = w.throwable(w.boundary(e));
      throw java ? bridge.toHost(java) : e;
    }
  };
  const scoped = <T>(f: () => T): T => { const mark = bridge.begin(); try { return f(); } finally { bridge.end(mark); } };
  const receiver = (obj: unknown, what: string): object => {
    if (obj === null || obj === undefined) throw new TypeError(`Cannot read properties of ${obj} (reading '${what}')`);
    if (obj instanceof JObj && !refOf(obj) && !w.hosts.specOfHost(obj)) throw missing(`${what} on a host object of class ${(obj.constructor as { $i?: { name: string } }).$i?.name}`);
    return bridge.toJava(obj, OBJECT) as object;
  };
  const alloc = (cls: string) => w.hostFn("e:new:" + cls, [], "L", (cx, c) => { cx.emitEnsure(c, cls); cx.emitNew(c, cls); })() as object;
  const init = (cls: string) => enter(() => w.hostFn("e:init:" + cls, [], "V", (cx, c) => { cx.emitEnsure(c, cls); })());

  /** the static field `name` (of type `desc`, when given) that `cls` declares or inherits */
  const staticOf = (cls: string, name: string, desc?: string): FieldInfo | undefined => {
    const seen = new Set<string>();
    const visit = (n: string): FieldInfo | undefined => {
      const c = prog.get(n);
      if (!c || seen.has(n)) return undefined;
      seen.add(n);
      return c.fields.find((f) => f.isStatic && f.name === name && (desc === undefined || f.desc === desc)) ?? c.ifaces.map(visit).find(Boolean) ?? (c.sup ? visit(c.sup) : undefined);
    };
    return visit(cls);
  };
  const classes = new Map<string, JavaClass>();
  function linkClass(name: string): JavaClass {
    let cls = classes.get(name);
    if (cls) return cls;
    if (!prog.get(name)) throw missing(`class ${name}`);
    const method = (mname: string, desc: string, isStatic: boolean) => {
      const m = prog.resolve(name, mname, desc);
      if (!m || m.isStatic !== isStatic) throw missing(`${isStatic ? "static " : ""}${name}.${mname}${desc}`);
      return m;
    };
    cls = {
      name,
      new: () => scoped(() => enter(() => bridge.toHost(alloc(name)) as object)),
      static: (field, desc) => {
        const f = staticOf(name, field, desc);
        if (!f) return undefined;
        const read = w.hostFn(`e:sget:${f.owner}.${f.name}:${f.desc}`, [], f.kind, (cx, c) => { c.gget(cx.staticGlobal(f.owner, f.name, f.desc)); });
        return scoped(() => f.kind === "L" ? bridge.toHost(read(), f.desc) : fromBits(read(), f.desc));
      },
      setStatic: (field, value, desc) => {
        const f = staticOf(name, field, desc);
        if (!f) return false;
        const write = w.hostFn(`e:sset:${f.owner}.${f.name}:${f.desc}`, [f.kind], "V", (cx, c) => { c.lget(0).gset(cx.staticGlobal(f.owner, f.name, f.desc)); });
        scoped(() => write(f.kind === "L" ? bridge.toJava(value, f.desc) : toBits(value, f.desc)));
        return true;
      },
      has: (mname, desc) => { const m = prog.resolve(name, mname, desc); return !!m && !m.isStatic; },
      call: (mname, desc) => { const m = method(mname, desc, true); return (...args) => enter(() => bridge.invoke(m, null, args)); },
      special: (mname, desc) => { const m = method(mname, desc, false); return (self, ...args) => enter(() => bridge.invoke(m, receiver(self, mname), args)); },
    };
    classes.set(name, cls);
    return cls;
  }
  /** a Java object's class: of a Java object the facade's, of an object the host made (a throwable a native raised) its own */
  const classNameOf = (o: unknown): string | undefined => {
    const java = refOf(o) ?? (typeof o === "object" && o !== null ? w.hosts.shellOf(o) : undefined);
    return java ? w.classNameOf(java) : o instanceof JObj ? w.hosts.specOfHost(o)?.name ?? (o.constructor as { $i?: { name: string } }).$i?.name : undefined;
  };

  return {
    vcall(obj, name, desc, ...args) {
      const recv = receiver(obj, name), cls = w.classNameOf(recv), m = prog.implFor(cls, name, desc);
      if (!m) throw missing(`vcall ${cls}.${name}${desc}`);
      return enter(() => bridge.invoke(m, recv, args));
    },
    scall(cls, name, desc, ...args) {
      const m = prog.resolve(cls, name, desc);
      if (!m?.isStatic) throw missing(`scall ${cls}.${name}${desc}`);
      return enter(() => bridge.invoke(m, null, args));
    },
    newObj(cls, desc = "()V", ...args) {
      const ctor = prog.get(cls)?.byKey.get("<init>" + desc);
      if (!ctor) throw missing(`newObj ${cls}.<init>${desc}`);
      return enter(() => {
        const o = alloc(cls);
        bridge.invoke(ctor, o, args);
        return bridge.toHost(o);
      });
    },
    staticField<T>(cls: string, field: string) { init(cls); return linkClass(cls).static(field) as T; },
    linkInit(cls) { const c = linkClass(cls); init(cls); return c; },
    linkClass,
    initClass(cls) { linkClass(cls); init(cls); return null; },
    iof(o, cls) {
      const name = classNameOf(o);
      if (name === undefined) return false;
      return name[0] === "[" ? name === cls || ARRAY_SUPERS.has(cls) : prog.isSubclass(name, cls);
    },
    classNameOf,
    callOn: (_thread, call) => call(),
    after: (r, f) => r instanceof Promise ? r.then(f) : f(r),
  };
}

/** how the Wasm tier names the instance field `name` of `cls` (declared or inherited, the most derived first) for getDeclared and setDeclared */
export const fieldNamesOf = (w: World) => (cls: string, name: string): string | undefined => {
  const f = w.prog.layout(cls).reverse().find((x) => x.name === name);
  return f && mangleField(f.owner, f.name);
};

const hostClasses = new Map<string, typeof JObj>();
const hostClass = (cls: string, base: typeof JObj): typeof JObj => {
  const key = (base === JThrowable ? "throwable " : "") + cls;
  let ctor = hostClasses.get(key);
  if (!ctor) hostClasses.set(key, ctor = Object.assign(class extends base {}, { $i: { name: cls } as never }));
  return ctor;
};
/** the throwable a TS native raises by class name, made without Java code: it carries the name that natives.ts turns into the Java throwable */
export function hostThrowable(cls: string, msg: string | null): JThrowable {
  const e = new (hostClass(cls, JThrowable) as typeof JThrowable)();
  e.msg = msg;
  return e;
}
/** an instance of the Java class `cls` made by the host, as `rt.make` makes one for a native that fills in a result (a Struct*) or an exception (UnixException)
 *  by field name; the Bridge copies it into Java */
export const hostObject = (w: World, cls: string): JObj => new (hostClass(cls, w.prog.isSubclass(cls, "java/lang/Throwable") ? JThrowable : JObj))();
