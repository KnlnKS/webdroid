// How host code enters Java on the Wasm tier: the Entry that src/jvm/natives/jentry.ts selects with `useEntry`, over one World. A Java object
// is a facade (bridge.ts) to host code, one per object; a Java exception that leaves a call is thrown as the facade of the throwable, which
// stands where a native's JThrowable does. A call from host code that no Java frame is under (an event, a Suspending native after its first wait) runs on a new
// strand of the thread that owns the turn, so it may wait; the result is the value at once if it did not, else a Promise. A native that a
// Java frame called is on that frame's stack, which cannot suspend, and calls Java on it.
import { rt, JObj } from "../../jvm/runtime.ts";
import { JThread, curThread, mainThread, resumeAs, setCurThread, threadContended, threadExit, type Entry } from "../../jvm/natives/jentry.ts";
import { Strand as HostStrand } from "../../jvm/suspend.ts";
import { processExited, never } from "../../process-exit.ts";
import { mangleField } from "../../jvm/abi.ts";
import { JThrowable } from "../../jvm/natives/jthrowable.ts";
import type { JavaClass } from "../../jvm/tier.ts";
import { kindOf, type FieldInfo, type Kind, type MethodInfo } from "../compiler/program.ts";
import type { World } from "../link/world.ts";
import { waitsEnded } from "../link/module.ts";
import type { Strand, ThreadRec } from "../link/sched.ts";
import type { Compiler } from "../compiler/j2w.ts";
import { OP, type Code } from "../compiler/code.ts";
import { fromBits, refOf, toBits, type Bridge } from "./bridge.ts";
import { failed } from "../compiler/linkage.ts";
import { UInfo } from "../compiler/info.ts";
import { box } from "../link/mhandles.ts";
import { count } from "./stats.ts";
import { note, Ev } from "../../timeline.ts";
import { procTasks, processTid } from "../../shell/procfs.ts";
import { cpus, nameThread } from "../../native/cpu.ts";

const OBJECT = "Ljava/lang/Object;";
/** the classes and interfaces every array class is a subtype of */
export const ARRAY_SUPERS = new Set(["java/lang/Object", "java/lang/Cloneable", "java/io/Serializable"]);

/** `f` as a call into Java made by whatever is running (a native, a JNI callback of a native's guest code), on a new strand of its thread: the result, or a Promise of it when it waited */
const nested = new WeakMap<World, { onStrand<T>(f: (s: Strand) => T): T; thread(): ThreadRec }>();
export const onNestedStrand = <T>(w: World, f: (s: Strand) => T): T => nested.get(w)!.onStrand(f);
/** the Java thread whatever is running enters Java as */
export const runningThread = (w: World): ThreadRec => nested.get(w)!.thread();

const entries = new WeakMap<World, Entry>();
/** the entry seam over `w`: one per World, since it keeps the World's host threads and its scheduler's thread hook */
export function wasmEntry(w: World): Entry {
  let entry = entries.get(w);
  if (!entry) entries.set(w, entry = makeEntry(w));
  return entry;
}
function makeEntry(w: World): Entry {
  const { bridge, prog, sched } = w;
  const missing = (what: string): Error => rt.unimplemented(what);
  const jthreads = new WeakMap<ThreadRec, JThread>(), recs = new WeakMap<JThread, ThreadRec>();
  const hostStrands = new WeakMap<Strand, HostStrand>(), javaStrands = new WeakMap<HostStrand, Strand>();
  const jthreadOf = (rec: ThreadRec): JThread => {
    if (rec === sched.mainRec) return mainThread;
    let t = jthreads.get(rec);
    if (!t) { t = new JThread(); jthreads.set(rec, t); recs.set(t, rec); }
    return t;
  };
  /** the Java thread a host thread (a binder thread, a native thread that attached, the JThread of a test) runs Java as: its own, made the first time it enters */
  const recOf = (t: JThread): ThreadRec => {
    if (t === mainThread) return sched.mainRec;
    let rec = recs.get(t);
    if (!rec) { rec = sched.hostThread(); recs.set(t, rec); jthreads.set(rec, t); }
    return rec;
  };
  // what the host had as its current thread when it last entered Java from the top level, which it has again when no strand runs
  let hostCurrent = curThread;
  const hostStrandOf = (s: Strand): HostStrand => {
    let host = hostStrands.get(s);
    if (!host) { host = new HostStrand(jthreadOf(s.thread)); hostStrands.set(s, host); javaStrands.set(host, s); }
    return host;
  };
  sched.onThreadEnd = (rec) => threadExit.hook?.(jthreadOf(rec));
  threadContended.hook = (t) => { const rec = t === mainThread ? sched.mainRec : recs.get(t); return !!rec && sched.contended(rec); };
  let threadName: FieldInfo | undefined;
  sched.onNamed = (rec) => {
    threadName ??= prog.require("java/lang/Thread").fields.find((f) => !f.isStatic && f.name === "name");
    const name = threadName && bridge.toHost((bridge as Bridge).read(threadName, rec.obj));
    if (typeof name === "string") nameThread(jthreadOf(rec), name);
  };
  // /proc/self/task: the main thread, the Java threads Thread.start made and the native threads, by their native names
  const tidOf = (t: JThread) => processTid(t, t === mainThread);
  const tasks = (): JThread[] => [mainThread, ...[...sched.started].map(jthreadOf), ...[...cpus].filter((c) => !c.finished).map((c) => c.jthread)];
  const taskOf = (tid: number) => tasks().find((t) => tidOf(t) === tid);
  procTasks.tids = () => [...new Set(tasks().map(tidOf))].sort((a, b) => a - b);
  procTasks.name = (tid) => taskOf(tid)?.jname ?? null;
  procTasks.rename = (tid, name) => { const t = taskOf(tid); if (t) nameThread(t, name); return !!t; };
  let noted = -1;
  sched.onThread = (rec, idle) => {
    const s = sched.current(), now = idle ? 0 : rec === sched.mainRec ? 1 : 2 + s.id;
    if (now !== noted) { noted = now; note(Ev.Thread, now); }
    if (idle) setCurThread(hostCurrent); else resumeAs(hostStrandOf(s));
  };
  /** the strand whose native is entering Java: the one running on this stack, or the one a Suspending native runs for after its first wait */
  const nativeOf = (): Strand | null => {
    // the globals name the strand until a later reaction idles them, after its stack ends: they are its turn only while rt.cur is its own
    const s = sched.current(), running = s.root ? sched.running?.root ? null : sched.running : hostStrands.get(s) === rt.cur ? s : null;
    if (running) return running;
    const captured = javaStrands.get(rt.cur);
    return captured && !captured.root && sched.strands[captured.id] === captured ? captured : null;
  };
  /** the thread whose turn callOn is running; else the thread of the native that enters Java, else the main thread */
  let entering: ThreadRec | null = null, enteringParent: Strand | null = null;
  const threadNow = (): ThreadRec => entering ?? nativeOf()?.thread ?? recOf(curThread);
  // A thread switch cannot inherit a different thread's native monitor ancestry.
  const parentOf = (rec: ThreadRec): Strand | null => {
    const parent = entering ? enteringParent : nativeOf();
    return parent?.thread === rec ? parent : null;
  };
  // A generator native resumes as the host strand it started on: the parent's, so what it enters Java with after a wait still holds the parent's locks.
  const asThread = <T>(rec: ThreadRec, f: () => T, parent = parentOf(rec)): T => {
    const was = entering, wasParent = enteringParent, prev = rt.cur;
    entering = rec; enteringParent = parent; resumeAs(parent ? hostStrandOf(parent) : jthreadOf(rec).root);
    try { return f(); } finally { entering = was; enteringParent = wasParent; resumeAs(prev); }
  };
  /** `f` on a new strand of the turn's thread, holding what the strand of the native that enters Java holds; the strand ends with the call */
  const onStrand = <T>(f: (s: Strand) => T): T => {
    if (sched.current().root && !sched.running) hostCurrent = curThread;
    const thread = threadNow(), s = sched.strand(thread, parentOf(thread));
    // A JNI guest slice can own a host strand while the Wasm globals are idle.
    const caller = rt.cur;
    let r: T;
    try { r = f(s); } catch (e) { s.end(); throw e; }
    finally { resumeAs(caller); }
    if (r instanceof Promise) void r.then(() => s.end(), () => s.end()); else s.end();
    return r;
  };
  nested.set(w, { onStrand, thread: threadNow });
  /** `f` as a call into Java: an exception that leaves it reaches the host as its throwable's facade */
  const enter = <T>(f: () => T): T => {
    count("wasmEntries");
    const fail = (e: unknown) => { const java = w.throwable(w.boundary(e)); return java ? bridge.toHost(java) : e; };
    try {
      const r = f();
      return r instanceof Promise ? r.catch((e) => { throw fail(e); }) as T : r;
    } catch (e) { throw fail(e); }
  };
  const chain = <A, B>(r: A | Promise<A>, f: (v: A) => B | Promise<B>): B | Promise<B> => {
    if (!(r instanceof Promise)) return f(r);
    const rec = threadNow(), parent = parentOf(rec);
    return r.then(v => asThread(rec, () => f(v), parent));
  };
  /** Java method `m` with host arguments */
  const invoke = (m: MethodInfo, recv: object | null, args: unknown[]): unknown => onStrand((s) => bridge.invokeOn(s, m, recv, args));
  /** a call made of `body` */
  const call = (key: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, ...args: unknown[]): unknown =>
    onStrand((s) => w.callFn(key, params, ret, body)(s, ...args));
  const scoped = <T>(f: () => T): T => { const mark = bridge.begin(); try { return f(); } finally { bridge.end(mark); } };
  /** a JThread (what host code holds of a thread) is the Java Thread of its strands: the main thread's is made by its first Thread.currentThread() */
  const threadObject = (t: JThread): object => {
    const rec = recOf(t);
    if (!rec.obj) asThread(rec, () => enter(() => invoke(prog.resolve("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;")!, null, [])));
    return rec.obj!;
  };
  const receiver = (obj: unknown, what: string): object => {
    if (obj instanceof JThread) return threadObject(obj);
    if (obj === null || obj === undefined) throw new TypeError(`Cannot read properties of ${obj} (reading '${what}')`);
    if (obj instanceof JObj && !(obj instanceof JThrowable) && !refOf(obj) && !w.hosts.specOfHost(obj)) throw missing(`${what} on a host object of class ${(obj.constructor as { $i?: { name: string } }).$i?.name}`);
    return bridge.toJava(obj, OBJECT) as object;
  };
  // asked as compiled code asks, so that an app build holds the allocator
  const alloc = (cls: string) => onStrand((s) => w.invoker([], "L", true)(s, w.host.info(UInfo.AllocInstance, w.idOf(cls), 0), -1)) as object | Promise<object>;
  const init = (cls: string) => w.needsInit(cls) ? enter(() => onStrand((s) => w.invoker([], "V", true)(s, w.ensureSlot(cls), -1))) as void | Promise<void> : undefined;

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
      new: () => scoped(() => enter(() => {
        const allocate = w.hostFn("e:alloc:" + name, [], "L", (cx, c) => cx.emitNew(c, name));
        return bridge.toHost(allocate()) as object;
      })),
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
      setStatics: (entries, desc) => {
        const fs = entries.map(([field, value]) => [staticOf(name, field, desc), value] as const).filter((e): e is readonly [FieldInfo, unknown] => !!e[0]);
        if (!fs.length) return;
        // one module for all of them: the function takes the index of the field and its value (a chain of tests is smaller for the engine to compile than a jump table of nested blocks)
        const kind = fs[0][0].kind, write = w.hostFn(`e:ssets:${name}:${desc}:${fs.map(([f]) => f.name).join()}`, ["I", kind], "V", (cx, c) => {
          fs.forEach(([f], i) => { c.lget(0).i32(i).raw(OP.i32_eq).if_().lget(1).gset(cx.staticGlobal(f.owner, f.name, f.desc)).ret().end(); });
        });
        scoped(() => fs.forEach(([f, value], i) => write(i, kind === "L" ? bridge.toJava(value, f.desc) : toBits(value, f.desc))));
      },
      has: (mname, desc) => { const m = prog.resolve(name, mname, desc); return !!m && !m.isStatic; },
      call: (mname, desc) => { const m = method(mname, desc, true); return (...args) => enter(() => invoke(m, null, args)); },
      special: (mname, desc) => { const m = method(mname, desc, false); return (self, ...args) => enter(() => invoke(m, receiver(self, mname), args)); },
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
      // an array's methods are Object's
      const recv = receiver(obj, name), cls = w.classNameOf(recv), m = prog.dispatchFor(cls[0] === "[" ? "java/lang/Object" : cls, name, desc);
      if (m && failed(m)) return enter(() => call("e:conflict:" + cls + "." + name + desc, [], "V", (cx, c) => cx.linkError(c, m)));
      if (!m) throw missing(`vcall ${cls}.${name}${desc}`);
      return enter(() => invoke(m, recv, args));
    },
    scall(cls, name, desc, ...args) {
      const m = prog.resolve(cls, name, desc);
      if (!m?.isStatic) throw missing(`scall ${cls}.${name}${desc}`);
      return enter(() => invoke(m, null, args));
    },
    newObj(cls, desc = "()V", ...args) {
      // a class of natives takes the constructors of its superclass
      const c = prog.get(cls), ctor = c?.byKey.get("<init>" + desc) ?? (c && !c.dex ? prog.resolve(cls, "<init>", desc) : undefined);
      if (!ctor) throw missing(`newObj ${cls}.<init>${desc}`);
      return enter(() => chain(alloc(cls), (o) => chain(invoke(ctor, o, args), () => scoped(() => bridge.toHost(o)))));
    },
    staticField<T>(cls: string, field: string) { return chain(init(cls), () => linkClass(cls).static(field) as T); },
    linkInit(cls) { const c = linkClass(cls); return chain(init(cls), () => c); },
    linkClass,
    initClass(cls) { linkClass(cls); const r = init(cls); return r instanceof Promise ? r.then(() => {}) : null; },
    iof(o, cls) {
      const name = classNameOf(o);
      if (name === undefined) return false;
      return name[0] === "[" ? name === cls || ARRAY_SUPERS.has(cls) : prog.isSubclass(name, cls);
    },
    classNameOf,
    callOn: (thread, run) => processExited() || waitsEnded() ? never() as never : asThread(recOf(thread), run),
    after: chain,
  };
}

/** how the Wasm tier names the instance field `name` of `cls` (declared or inherited, the most derived first) for getDeclared and setDeclared */
export const fieldNamesOf = (w: World) => (cls: string, name: string): string | undefined => {
  const f = [...w.prog.layout(cls)].reverse().find((x) => x.name === name);
  return f && mangleField(f.owner, f.name);
};

const hostClasses = new Map<string, typeof JObj>();
const hostClass = (cls: string, base: typeof JObj): typeof JObj => {
  const key = (base === JThrowable ? "throwable " : "") + cls;
  let ctor = hostClasses.get(key);
  // named for the Java class, which is what the browser's console shows of one of its objects
  if (!ctor) hostClasses.set(key, ctor = Object.defineProperty(Object.assign(class extends base {}, { $i: { name: cls } as never }), "name", { value: cls }));
  return ctor;
};
/** the throwable a TS native raises by class name, made without Java code: it carries the name that natives.ts turns into the Java throwable */
export function hostThrowable(cls: string, msg: string | null): JThrowable {
  const e = new (hostClass(cls, JThrowable) as typeof JThrowable)();
  e.msg = msg;
  return e;
}
/** the Class object of `cls`, a Java reference */
export const classRef = (w: World, cls: string): object => w.hostFn("j:class:" + cls, [], "L", (cx, c) => { cx.constClass(c, cls); })() as object;
/** the box `valueOf` of primitive type `desc` makes of the host value `v`, a Java reference: a host function, so a first call's link cannot suspend it */
export const boxRef = (w: World, desc: string, v: number | bigint): object => w.hostFn("j:box:" + desc, [kindOf(desc)], "L", (cx, c) => { c.lget(0); box(cx, c, desc); })(toBits(v, desc)) as object;
/** an instance of the Java class `cls` made by the host, as `rt.make` makes one for a native that fills in a result (a Struct*) or an exception (UnixException)
 *  by field name; the Bridge copies it into Java */
export const hostObject = (w: World, cls: string): JObj => new (hostClass(cls, w.prog.isSubclass(cls, "java/lang/Throwable") ? JThrowable : JObj))();
