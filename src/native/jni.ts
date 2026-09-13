// JavaVM + JNIEnv function tables in guest memory, the object-handle tables, and the marshalling
// between guest natives (AAPCS words) and the JVM's value model.

import { mem } from "./mem";
import { defineHost, type HostFn, vaList, retF, retD, retPair, type ArgReader, PTR, stp, ldp, type HostRet, hostTrace } from "./host";
import { Cpu, cpuFor, type CallArg } from "./cpu";
import { rt, JObj, type ClassInfo, type Runtime } from "../jvm/runtime";
import { mangleMethod, mangleStaticField, parseMethodDesc, jarray, PRIM_ARRAYS, type PrimElem, splitSig, u8, primElem } from "../jvm/abi";
import { curThread, JClass, stackTraceText } from "../jvm/natives/jlang";
import { JCtor, JMethod, classCtors, mkMethod, methodAnnotations } from "../jvm/natives/jreflect";
import { JBuffer, directBufferAddress, nativeByteBuffer } from "../jvm/natives/jnio";
const enc = new TextEncoder();

export const jniMissing = new Set<string>();
export const jniTrace = { on: false };
export const javaVM = { addr: 0 };

// ── references: locals live per Cpu in frames; globals in one table. 0 is null.
const GLOBAL_BIT = 0x40000000;
const globals: unknown[] = [null];
const freeGlobals: number[] = [];
const localsOf = new WeakMap<Cpu, { refs: unknown[]; frames: number[] }>();
function locals(cpu: Cpu) {
  let l = localsOf.get(cpu);
  if (!l) localsOf.set(cpu, (l = { refs: [null], frames: [] }));
  return l;
}
let cur: Cpu | null = null;   // the Cpu executing the current JNI function
function toRef(o: unknown, cpu: Cpu | null = cur): number {
  if (o === null || o === undefined) return 0;
  const l = locals(cpu!);
  l.refs.push(o);
  return l.refs.length - 1;
}
function newGlobalRef(o: unknown): number {
  if (o === null || o === undefined) return 0;
  const i = freeGlobals.pop();
  if (i !== undefined) { globals[i] = o; return GLOBAL_BIT | i; }
  globals.push(o);
  return GLOBAL_BIT | (globals.length - 1);
}
export function deref(h: number, cpu: Cpu | null = cur): unknown {
  if (h === 0) return null;
  if (h & GLOBAL_BIT) return globals[h & ~GLOBAL_BIT] ?? null;
  return locals(cpu!).refs[h] ?? null;
}
export function pushFrame(cpu: Cpu): void { const l = locals(cpu); l.frames.push(l.refs.length); }
export function popFrame(cpu: Cpu): void { const l = locals(cpu); const m = l.frames.pop(); if (m !== undefined) l.refs.length = m; }

interface MethodRec { info: ClassInfo; name: string; desc: string; mangled: string; isStatic: boolean; params: string[]; ret: string }
interface FieldRec { prop: string; type: string; isStatic: boolean; owner: any }
const methods: MethodRec[] = [null as unknown as MethodRec];
const methodIds = new WeakMap<ClassInfo, Map<string, number>>();
// A jmethodID/jfieldID is an ArtMethod*/ArtField* on a device, and an image may read the bytes
// it points at (libmetasec sizes ArtMethod as the gap between two ids of one class and scans
// them): each id is therefore a zeroed block in guest memory, mapped back to its record here.
const ID_BLOCK = 64;
const methodIdx = new Map<number, number>(), fieldIdx = new Map<number, number>();
function mintId(table: Map<number, number>, index: number): number {
  const p = mem.calloc(1, ID_BLOCK);
  if (!p) throw new Error("out of memory for JNI ids");
  table.set(p, index);
  return p;
}
const methodOf = (id: number): MethodRec | undefined => methods[methodIdx.get(id >>> 0) ?? 0];
const fieldOf = (id: number): FieldRec | undefined => fields[fieldIdx.get(id >>> 0) ?? 0];
/** a jmethodID is canonical: the same method looked up twice, or reached through a reflected
 *  Method, is the same id (an engine caches ids per proxy method and matches by identity) */
function methodId(info: ClassInfo, name: string, desc: string, isStatic: boolean): number {
  const key = (isStatic ? "static " : "") + name + desc;
  let ids = methodIds.get(info);
  if (!ids) methodIds.set(info, ids = new Map());
  let id = ids.get(key);
  if (id === undefined) {
    const { params, ret } = parseMethodDesc(desc);
    methods.push({ info, name, desc, mangled: mangleMethod(name, desc), isStatic, params, ret });
    ids.set(key, (id = mintId(methodIdx, methods.length - 1)));
  }
  return id;
}
function hasAbstractMethod(info: ClassInfo, name: string, desc: string): boolean {
  const { dex, def } = info;
  if (dex && def?.virtualMethods.some((m) => (m.flags & 0x400) !== 0 && dex.method(m.methodIdx).name === name && dex.methodDesc(m.methodIdx) === desc)) return true;
  return !!info.superInfo && hasAbstractMethod(info.superInfo, name, desc)
    || info.interfaces.some((i) => hasAbstractMethod(i, name, desc));
}
const fields: FieldRec[] = [null as unknown as FieldRec];
const fieldIds = new WeakMap<ClassInfo, Map<string, number>>();

function fieldId(info: ClassInfo, prop: string, type: string, isStatic: boolean): number {
  let ids = fieldIds.get(info);
  if (!ids) fieldIds.set(info, ids = new Map());
  const key = (isStatic ? "static " : "") + prop + type;
  let id = ids.get(key);
  if (id === undefined) {
    fields.push({ prop, type, isStatic, owner: isStatic ? info.ctor : null });
    ids.set(key, id = mintId(fieldIdx, fields.length - 1));
  }
  return id;
}

interface Registered { info: ClassInfo; cls: string; name: string; sig: string; fn: number; isStatic: boolean; critical: boolean; params: string[]; ret: string; label: string }
export const registered: Registered[] = [];

const clsName = (o: unknown): string => {
  if (typeof o === "string") return "java/lang/String";
  if (o instanceof JClass) return "java/lang/Class";
  if (Array.isArray(o)) return "[" + ((o as any).$t ?? "Ljava/lang/Object;");
  const e = primElem(o);
  if (e) return "[" + e;
  return ((o as any)?.constructor?.$i as ClassInfo | undefined)?.name ?? "java/lang/Object";
};
function infoOf(clsRef: number): ClassInfo | null {
  const c = deref(clsRef);
  if (c instanceof JClass) return c.ci ?? (c.arrDesc ? rt.link(c.arrDesc) : null);
  return null;
}
function pend(cpu: Cpu, e: unknown): void {
  cpu.exc = e;
  if (jniTrace.on) { console.warn("[jni] pending", (e as { msg?: string })?.msg, e); console.warn("[jni] ring", hostTrace.ring.slice(-50).join(" | "), new Error().stack); }
}
const throwable = (cls: string, msg: string) => rt.mkThrowable(cls, msg);

// argument readers per Java descriptor
type Reader = { i(): number; l(): bigint; d(): number; p(): number };
function readArgs(params: string[], r: Reader): unknown[] {
  const out: unknown[] = [];
  for (const t of params) {
    switch (t[0]) {
      case "Z": out.push(r.i() ? 1 : 0); break;
      case "B": out.push((r.i() << 24) >> 24); break;
      case "C": out.push(r.i() & 0xffff); break;
      case "S": out.push((r.i() << 16) >> 16); break;
      case "I": out.push(r.i()); break;
      case "J": out.push(r.l()); break;
      case "F": out.push(Math.fround(r.d())); break;   // varargs promote float to double
      case "D": out.push(r.d()); break;
      default: out.push(deref(r.p()));
    }
  }
  return out;
}
function readJvalues(params: string[], p: number): unknown[] {
  const out: unknown[] = [];
  for (const t of params) {
    switch (t[0]) {
      case "Z": out.push(mem.ld8u(p) ? 1 : 0); break;
      case "B": out.push(mem.ld8s(p)); break;
      case "C": out.push(mem.ld16u(p)); break;
      case "S": out.push(mem.ld16s(p)); break;
      case "I": out.push(mem.ld32(p)); break;
      case "J": out.push(mem.ld64(p)); break;
      case "F": out.push(mem.ldf32(p)); break;
      case "D": out.push(mem.ldf64(p)); break;
      default: out.push(deref(mem.ld32(p)));
    }
    p += 8;
  }
  return out;
}
function retWord(ret: string, v: unknown, cpu: Cpu): HostRet {
  switch (ret[0]) {
    case "V": return 0;
    case "Z": return v ? 1 : 0;
    case "J": return v as bigint;
    case "F": return retF(cpu, v as number);
    case "D": return retD(cpu, v as number);
    case "L": case "[": return toRef(v, cpu);
    default: return (v as number) | 0;
  }
}

async function invoke(cpu: Cpu, m: MethodRec, self: unknown, args: unknown[], nonvirtual: boolean): Promise<HostRet> {
  try {
    let fn: any;
    if (m.isStatic) {
      const p = (m.info.owner ?? rt).initClass(m.info); if (p) await p;
      fn = m.info.ctor[m.mangled];
      if (typeof fn !== "function") throw throwable("java/lang/NoSuchMethodError", m.name + m.desc);
      const r = fn.apply(m.info.ctor, args);
      return retWord(m.ret, r instanceof Promise ? await r : r, cpu);
    }
    if (self === null || self === undefined) throw throwable("java/lang/NullPointerException", "JNI call on null " + m.name);
    fn = nonvirtual ? m.info.ctor.prototype[m.mangled] : (self as any)[m.mangled] ?? rt.proxyMethod?.(self, m.name, m.desc);
    if (typeof fn !== "function") throw throwable("java/lang/NoSuchMethodError", m.name + m.desc);
    const r = fn.apply(self, args);
    return retWord(m.ret, r instanceof Promise ? await r : r, cpu);
  } catch (e) {
    pend(cpu, rt.jx(e));
    return m.ret === "J" || m.ret === "D" ? 0n : 0;
  }
}

/** a Java native method whose body is guest code: marshal, run on the caller's Cpu, convert the result */
async function callGuestNative(cpu: Cpu, r: Registered, self: unknown, args: unknown[]): Promise<unknown> {
  const { params, ret } = r;
  await cpu.awaitIdleBase();
  const prevCur = cur, previousRuntime = cpu.nativeRuntime;
  cpu.nativeRuntime = r.info.owner ?? rt;
  cur = cpu;
  if (!r.critical) pushFrame(cpu);
  try {
    const list: CallArg[] = r.critical ? [] : [envFor(cpu), toRef(r.isStatic ? cpu.nativeRuntime.classFor(r.cls) : self)];
    for (let i = 0; i < params.length; i++) {
      const t = params[i], v = args[i];
      switch (t[0]) {
        case "J": list.push(v as bigint); break;
        case "F": list.push({ f: v as number }); break;
        case "D": list.push({ d: v as number }); break;
        case "L": case "[": list.push(toRef(v)); break;
        default: list.push((v as number) | 0);
      }
    }
    if (jniTrace.on) console.log("[jni] →", r.cls, r.name, r.sig);
    let r0: number, r1: number;
    const jt = cpu.jthread;
    jt.inNative++;
    try {
      r0 = await cpu.call(r.fn, list, r.label);
      r1 = cpu.ret1;
    } finally { cur = cpu; if (--jt.inNative === 0) for (const w of jt.nativeIdle.splice(0)) w(); }
    let out: unknown;
    switch (ret[0]) {
      case "V": out = undefined; break;
      case "Z": out = r0 & 0xff ? 1 : 0; break;
      case "B": out = (r0 << 24) >> 24; break;
      case "C": out = r0 & 0xffff; break;
      case "S": out = (r0 << 16) >> 16; break;
      case "I": out = r0; break;
      case "J": out = retPair(r0, r1); break;
      case "F": out = cpu.retF(); break;
      case "D": out = cpu.retD(); break;
      default: out = deref(r0);
    }
    const exc = cpu.exc;
    if (exc) { cpu.exc = null; throw exc; }
    return out;
  } finally { if (!r.critical) popFrame(cpu); cpu.nativeRuntime = previousRuntime; cur = prevCur; }
}

let envTable = 0;
function envFor(cpu: Cpu): number {
  if (!cpu.env) {
    cpu.env = mem.calloc(1, 8);
    if (!cpu.env) cpu.fault("out of memory for JNI environment");
    stp(cpu.env, envTable);
  }
  return cpu.env;
}

const PRIM = ["Object", "Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double", "Void"];
const PRIM_DESC = ["L", "Z", "B", "C", "S", "I", "J", "F", "D", "V"];
const elemSize: Record<string, number> = { Z: 1, B: 1, C: 2, S: 2, I: 4, J: 8, F: 4, D: 8 };
const pinned = new Map<number, { arr: any; type: string }>();
function copyOut(type: string, arr: any, p: number, start: number, len: number): void {
  const bytes = u8(arr, start * elemSize[type], len * elemSize[type]);
  mem.u8.set(bytes, p);
}
function copyIn(type: string, arr: any, p: number, start: number, len: number): void {
  const dst = u8(arr, start * elemSize[type], len * elemSize[type]);
  dst.set(mem.u8.subarray(p, p + len * elemSize[type]));
}
function pin(arr: any, type: string, isCopy: number): number {
  const p = mem.malloc(Math.max(1, arr.length * elemSize[type]));
  copyOut(type, arr, p, 0, arr.length);
  pinned.set(p, { arr, type });
  if (isCopy) mem.st8(isCopy, 1);
  return p;
}

export function jniInit(): void {
  jniTrace.on ||= !!(globalThis as { __wdJniTrace?: boolean }).__wdJniTrace;
  const T: (HostFn | null)[] = new Array(233).fill(null);
  const names: string[] = new Array(233).fill("?");
  const def = (i: number, name: string, fn: HostFn) => { T[i] = fn; names[i] = name; };
  const utf8Len = (s: string) => enc.encode(s).length;

  def(4, "GetVersion", () => 0x00010006);
  def(7, "FromReflectedMethod", (_c, a) => {
    a.p(); const m = deref(a.i());
    if (m instanceof JMethod) return methodId(m.owner, m.name, m.desc, m.isStatic);
    return m instanceof JCtor ? methodId(m.owner, "<init>", m.desc, false) : 0;
  });
  def(9, "ToReflectedMethod", (_c, a) => {
    a.p(); a.p(); const m = methodOf(a.p()); a.i();
    if (!m) return 0;
    if (m.name === "<init>") {
      const c = classCtors(m.info).find((ctor) => ctor.desc === m.desc);
      return c ? toRef(c) : 0;
    }
    return toRef(mkMethod(m.info, m.name, m.desc, m.isStatic, m.isStatic ? m.info.ctor[m.mangled] : m.info.ctor.prototype[m.mangled]));
  });
  def(6, "FindClass", (cpu, a) => {
    a.p(); const name = a.str();
    const n = name.replace(/\./g, "/");
    const owner = cpu.nativeRuntime ?? rt, info = owner.link(n);
    if (info.stub) { pend(cpu, rt.ncdfe(n)); return 0; }
    return toRef(owner.classFor(n), cpu);
  });
  def(10, "GetSuperclass", (_c, a) => { a.p(); const i = infoOf(a.p()); return i?.superInfo ? toRef((i.superInfo.owner ?? rt).classFor(i.superInfo.name)) : 0; });
  def(11, "IsAssignableFrom", (_c, a) => { a.p(); const s = infoOf(a.p()), t = infoOf(a.p()); return s && t && s.assignableTo(t) ? 1 : 0; });
  def(13, "Throw", (cpu, a) => { a.p(); pend(cpu, deref(a.p())); return 0; });
  def(14, "ThrowNew", (cpu, a) => { a.p(); const i = infoOf(a.p()); const msg = a.p(); pend(cpu, throwable(i?.name ?? "java/lang/Error", msg ? mem.cstr(msg) : "")); return 0; });
  def(15, "ExceptionOccurred", (cpu) => toRef(cpu.exc));
  def(16, "ExceptionDescribe", async (cpu) => { if (cpu.exc) console.warn("[jni] exception:", cpu.exc instanceof JObj ? await stackTraceText(cpu.exc as never) : cpu.exc); });
  def(17, "ExceptionClear", (cpu) => { cpu.exc = null; });
  def(18, "FatalError", (cpu, a) => { a.p(); cpu.fault("JNI FatalError: " + a.str()); });
  def(19, "PushLocalFrame", (cpu) => { pushFrame(cpu); return 0; });
  def(20, "PopLocalFrame", (cpu, a) => { a.p(); const o = deref(a.p()); popFrame(cpu); return toRef(o); });
  def(21, "NewGlobalRef", (_c, a) => { a.p(); return newGlobalRef(deref(a.p())); });
  def(22, "DeleteGlobalRef", (_c, a) => { a.p(); const h = a.p(); if (h & GLOBAL_BIT) { globals[h & ~GLOBAL_BIT] = null; freeGlobals.push(h & ~GLOBAL_BIT); } });
  def(23, "DeleteLocalRef", (cpu, a) => { a.p(); const h = a.p(); if (h && !(h & GLOBAL_BIT)) locals(cpu).refs[h] = null; });
  def(24, "IsSameObject", (_c, a) => { a.p(); return deref(a.p()) === deref(a.p()) ? 1 : 0; });
  def(25, "NewLocalRef", (_c, a) => { a.p(); return toRef(deref(a.p())); });
  def(26, "EnsureLocalCapacity", () => 0);
  def(27, "AllocObject", async (cpu, a) => { a.p(); const i = infoOf(a.p()); if (!i) return 0; const p = (i.owner ?? rt).initClass(i); if (p) await p; return toRef(new i.ctor(), cpu); });
  const newObject = (read: (m: MethodRec, a: ArgReader) => unknown[]) => async (cpu: Cpu, a: ArgReader) => {
    a.p(); const i = infoOf(a.p()); const m = methodOf(a.p());
    if (!i || !m) return 0;
    try {
      const p = (i.owner ?? rt).initClass(i); if (p) await p;
      const args = read(m, a);
      if (i.name === "java/lang/String") return toRef(rt.newStr(m.desc, args), cpu);   // a Java string is a JS string, built by the runtime's own constructor table
      const o = new i.ctor();
      const fn = o[m.mangled];
      if (typeof fn !== "function") throw throwable("java/lang/NoSuchMethodError", "<init>" + m.desc);
      const r = fn.apply(o, args);
      if (r instanceof Promise) await r;
      return toRef(o, cpu);
    } catch (e) { pend(cpu, rt.jx(e)); return 0; }
  };
  def(28, "NewObject", newObject((m, a) => readArgs(m.params, a)));
  def(29, "NewObjectV", newObject((m, a) => readArgs(m.params, vaList(a.p()))));
  def(30, "NewObjectA", newObject((m, a) => readJvalues(m.params, a.p())));
  def(31, "GetObjectClass", (_c, a) => { a.p(); const o = deref(a.p()); const info = o instanceof JObj ? (o.constructor as typeof JObj).$i : null; return o === null ? 0 : toRef((info?.owner ?? rt).classFor(clsName(o))); });
  def(32, "IsInstanceOf", (_c, a) => { a.p(); const o = deref(a.p()); const i = infoOf(a.p()); return o === null ? 1 : i ? (i.owner ?? rt).iof(o, i.name) : 0; });
  const getMethodID = (isStatic: boolean) => async (cpu: Cpu, a: ArgReader) => {
    a.p(); const i = infoOf(a.p()); const name = a.str(), sig = a.str();
    if (!i) { pend(cpu, throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    const p = (i.owner ?? rt).initClass(i); if (p) await p;
    const mangled = mangleMethod(name, sig);
    // an interface the framework only marks (its methods live on the implementations) answers for
    // what the app's own bytecode calls on it; the receiver dispatches at call time as always
    const have = isStatic ? typeof i.ctor[mangled] === "function" : typeof i.ctor.prototype?.[mangled] === "function" || (i.name === "java/lang/String" && typeof (String.prototype as any)[mangled] === "function")
      || hasAbstractMethod(i, name, sig)
      || (!i.dex && !isStatic && (rt.methodRefs(i.name).has(name + sig) || !Object.keys(rt.natives.get(i.name)?.methods ?? {}).length));
    if (!have) { pend(cpu, throwable("java/lang/NoSuchMethodError", `${i.name}.${name}${sig}`)); jniMissing.add(`${isStatic ? "static " : ""}${i.name}.${name}${sig}`); return 0; }
    return methodId(i, name, sig, isStatic);
  };
  def(33, "GetMethodID", getMethodID(false));
  def(113, "GetStaticMethodID", getMethodID(true));
  // Call<Type>Method / V / A, Nonvirtual, Static
  for (let k = 0; k < 10; k++) {
    const P = PRIM[k];
    const mk = (base: number, kind: "virtual" | "nonvirtual" | "static") => {
      const readers: ((m: MethodRec, a: ArgReader) => unknown[])[] = [
        (m, a) => readArgs(m.params, a), (m, a) => readArgs(m.params, vaList(a.p())), (m, a) => readJvalues(m.params, a.p()),
      ];
      const suffix = ["", "V", "A"];
      for (let v = 0; v < 3; v++) {
        const read = readers[v];
        def(base + v, `Call${kind === "static" ? "Static" : kind === "nonvirtual" ? "Nonvirtual" : ""}${P}Method${suffix[v]}`, (cpu, a) => {
          a.p();
          const self = kind === "static" ? null : deref(a.p());
          if (kind !== "virtual") a.p(); // jclass
          const m = methodOf(a.p());
          if (!m) { pend(cpu, throwable("java/lang/NoSuchMethodError", "bad methodID")); return 0; }
          const args = read(m, a);
          if (jniTrace.on) console.log("[jni] ←", m.info.name, m.name, m.desc, args.map((v) => typeof v === "string" ? JSON.stringify(v.slice(0, 200)) : Array.isArray(v) ? `[${v.length}]` : String(v)).join(" "));
          return invoke(cpu, m, self, args, kind === "nonvirtual");
        });
      }
    };
    mk(34 + k * 3, "virtual");
    mk(64 + k * 3, "nonvirtual");
    mk(114 + k * 3, "static");
  }
  const getFieldID = (isStatic: boolean) => async (cpu: Cpu, a: ArgReader) => {
    a.p(); const i = infoOf(a.p()); const name = a.str(), sig = a.str();
    if (!i) { pend(cpu, throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    const p = (i.owner ?? rt).initClass(i); if (p) await p;
    if (isStatic) {
      const prop = mangleStaticField(name);
      let owner: ClassInfo | null = i;
      while (owner && !Object.prototype.hasOwnProperty.call(owner.ctor, prop)) owner = owner.superInfo;
      if (!owner) { pend(cpu, throwable("java/lang/NoSuchFieldError", `${i.name}.${name}`)); jniMissing.add(`static field ${i.name}.${name}`); return 0; }
      return fieldId(owner, prop, sig, true);
    }
    let info: ClassInfo | null = i, prop: string | undefined;
    while (info && !(prop = info.fieldTable.get(name))) info = info.superInfo;
    if (!prop) { pend(cpu, throwable("java/lang/NoSuchFieldError", `${i.name}.${name}`)); jniMissing.add(`field ${i.name}.${name}`); return 0; }
    return fieldId(info!, prop, sig, false);
  };
  def(94, "GetFieldID", getFieldID(false));
  def(144, "GetStaticFieldID", getFieldID(true));
  for (let k = 0; k < 9; k++) {
    const P = PRIM[k], D = PRIM_DESC[k];
    const fromJava = (v: unknown, cpu: Cpu): HostRet => retWord(D, v, cpu);
    const toJava = (a: ArgReader): unknown => D === "J" ? a.l() : D === "F" ? a.f() : D === "D" ? a.d() : D === "L" ? deref(a.p()) : D === "Z" ? (a.i() & 255 ? 1 : 0) : a.i();
    def(95 + k, `Get${P}Field`, (cpu, a) => { a.p(); const o = deref(a.p()) as any; const f = fieldOf(a.p()); return o && f ? fromJava(o[f.prop], cpu) : D === "J" ? 0n : 0; });
    def(104 + k, `Set${P}Field`, (_c, a) => { a.p(); const o = deref(a.p()) as any; const f = fieldOf(a.p()); const v = toJava(a); if (o && f) o[f.prop] = v; });
    def(145 + k, `GetStatic${P}Field`, (cpu, a) => { a.p(); a.p(); const f = fieldOf(a.p()); return f ? fromJava(f.owner[f.prop], cpu) : D === "J" ? 0n : 0; });
    def(154 + k, `SetStatic${P}Field`, (_c, a) => { a.p(); a.p(); const f = fieldOf(a.p()); const v = toJava(a); if (f) f.owner[f.prop] = v; });
  }
  // strings
  def(163, "NewString", (_c, a) => { a.p(); const p = a.p(), n = a.i(); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(mem.ld16u(p + i * 2)); return toRef(s); });
  def(164, "GetStringLength", (_c, a) => { a.p(); return (deref(a.p()) as string)?.length ?? 0; });
  def(165, "GetStringChars", (_c, a) => { a.p(); const s = deref(a.p()) as string; const isCopy = a.p(); const p = mem.malloc(s.length * 2 + 2); for (let i = 0; i < s.length; i++) mem.st16(p + i * 2, s.charCodeAt(i)); mem.st16(p + s.length * 2, 0); if (isCopy) mem.st8(isCopy, 1); return p; });
  def(166, "ReleaseStringChars", (_c, a) => { a.p(); a.p(); mem.free(a.p()); });
  def(167, "NewStringUTF", (_c, a) => { a.p(); const p = a.p(); return p ? toRef(mem.cstr(p)) : 0; });
  def(168, "GetStringUTFLength", (_c, a) => { a.p(); return utf8Len((deref(a.p()) as string) ?? ""); });
  def(169, "GetStringUTFChars", (_c, a) => { a.p(); const s = (deref(a.p()) as string) ?? ""; const isCopy = a.p(); const p = mem.strdup(s); if (isCopy) mem.st8(isCopy, 1); return p; });
  def(170, "ReleaseStringUTFChars", (_c, a) => { a.p(); a.p(); mem.free(a.p()); });
  def(220, "GetStringRegion", (_c, a) => { a.p(); const s = deref(a.p()) as string; const st = a.i(), n = a.i(), buf = a.p(); for (let i = 0; i < n; i++) mem.st16(buf + i * 2, s.charCodeAt(st + i)); });
  def(221, "GetStringUTFRegion", (_c, a) => { a.p(); const s = deref(a.p()) as string; const st = a.i(), n = a.i(), buf = a.p(); mem.putCstr(buf, s.slice(st, st + n)); });
  def(224, "GetStringCritical", T[165]!);
  def(225, "ReleaseStringCritical", T[166]!);
  // arrays
  def(171, "GetArrayLength", (_c, a) => { a.p(); const arr = deref(a.p()) as { length: number } | null; return arr ? arr.length : 0; });
  def(172, "NewObjectArray", (_c, a) => { a.p(); const n = a.i(); const i = infoOf(a.p()); const init = deref(a.p()); const arr = jarray(new Array(n).fill(init), i ? (i.name[0] === "[" ? i.name : "L" + i.name + ";") : "Ljava/lang/Object;"); return toRef(arr); });
  def(173, "GetObjectArrayElement", (cpu, a) => { a.p(); const arr = deref(a.p()) as unknown[]; const i = a.i(); if (!arr || i < 0 || i >= arr.length) { pend(cpu, throwable("java/lang/ArrayIndexOutOfBoundsException", String(i))); return 0; } return toRef(arr[i]); });
  def(174, "SetObjectArrayElement", (cpu, a) => { a.p(); const arr = deref(a.p()) as unknown[]; const i = a.i(); const v = deref(a.p()); if (!arr || i < 0 || i >= arr.length) { pend(cpu, throwable("java/lang/ArrayIndexOutOfBoundsException", String(i))); return; } arr[i] = v; });
  for (let k = 1; k <= 8; k++) {
    const P = PRIM[k], D = PRIM_DESC[k];
    def(174 + k, `New${P}Array`, (_c, a) => { a.p(); return toRef(new PRIM_ARRAYS[D as PrimElem](a.i())); });
    def(182 + k, `Get${P}ArrayElements`, (_c, a) => { a.p(); const arr = deref(a.p()) as any; const isCopy = a.p(); return arr ? pin(arr, D, isCopy) : 0; });
    def(190 + k, `Release${P}ArrayElements`, (_c, a) => {
      a.p(); a.p(); const p = a.p(), mode = a.i();
      const pin = pinned.get(p);
      if (!pin) return;
      if (mode !== 2) copyIn(pin.type, pin.arr, p, 0, pin.arr.length);
      if (mode !== 1) { pinned.delete(p); mem.free(p); }
    });
    def(198 + k, `Get${P}ArrayRegion`, (cpu, a) => {
      a.p(); const arr = deref(a.p()) as any; const st = a.i(), n = a.i(), buf = a.p();
      if (!arr || st < 0 || st + n > arr.length) { pend(cpu, throwable("java/lang/ArrayIndexOutOfBoundsException", `${st}+${n}`)); return; }
      copyOut(D, arr, buf, st, n);
    });
    def(206 + k, `Set${P}ArrayRegion`, (cpu, a) => {
      a.p(); const arr = deref(a.p()) as any; const st = a.i(), n = a.i(), buf = a.p();
      if (!arr || st < 0 || st + n > arr.length) { pend(cpu, throwable("java/lang/ArrayIndexOutOfBoundsException", `${st}+${n}`)); return; }
      copyIn(D, arr, buf, st, n);
    });
  }
  def(222, "GetPrimitiveArrayCritical", (_c, a) => { a.p(); const arr = deref(a.p()) as any; const isCopy = a.p(); return arr ? pin(arr, clsName(arr)[1], isCopy) : 0; });
  def(223, "ReleasePrimitiveArrayCritical", T[191]!);
  def(215, "RegisterNatives", (cpu, a) => {
    a.p(); const i = infoOf(a.p()); const tab = a.p(), n = a.i();
    if (!i) return -1;
    for (let k = 0; k < n; k++) {
      // JNINativeMethod is three pointers: 12 bytes on ILP32, 24 on LP64
      const rec = tab + k * PTR * 3;
      const name = mem.cstr(ldp(rec)), sig = mem.cstr(ldp(rec + PTR)), fn = ldp(rec + PTR * 2);
      registerNative(i, name, sig, fn);
    }
    return 0;
  });
  def(216, "UnregisterNatives", () => 0);
  for (const [index, name, enter] of [[217, "MonitorEnter", true], [218, "MonitorExit", false]] satisfies [number, string, boolean][]) {
    def(index, name, (cpu, a) => {
      a.p(); const obj = deref(a.p());
      try {
        if (typeof obj !== "object" && typeof obj !== "string") throw throwable("java/lang/NullPointerException", "JNI monitor reference");
        const pending = enter ? rt.monitors.enter(obj, cpu.jthread) : rt.monitors.exit(obj, cpu.jthread);
        return pending ? pending.then(() => 0, (e) => { pend(cpu, e); return -1; }) : 0;
      } catch (e) { pend(cpu, e); return -1; }
    });
  }
  def(219, "GetJavaVM", (_c, a) => { a.p(); stp(a.p(), javaVM.addr); return 0; });
  def(226, "NewWeakGlobalRef", T[21]!);
  def(227, "DeleteWeakGlobalRef", T[22]!);
  def(228, "ExceptionCheck", (cpu) => (cpu.exc ? 1 : 0));
  def(229, "NewDirectByteBuffer", (_cpu, a) => {
    a.p(); const address = a.p(), cap = a.l();
    return cap < 0n || cap > 0x7fffffffn ? 0 : toRef(nativeByteBuffer(address, Number(cap)));
  });
  def(230, "GetDirectBufferAddress", (cpu, a) => {
    a.p(); const b = deref(a.p());
    try { return b instanceof JBuffer ? directBufferAddress(b) : 0; }
    catch (e) { pend(cpu, e); return 0; }
  });
  def(231, "GetDirectBufferCapacity", (_cpu, a) => {
    a.p(); const b = deref(a.p());
    return b instanceof JBuffer && b.direct ? BigInt(b.cap) : -1n;
  });
  def(232, "GetObjectRefType", (_c, a) => { a.p(); const h = a.p(); return h === 0 ? 0 : h & GLOBAL_BIT ? 2 : 1; });

  envTable = mem.hostAlloc(233 * PTR);
  for (let i = 0; i < 233; i++) {
    const fn = T[i];
    const name = fn ? names[i] : `JNI#${i}`;
    const wrapped: HostFn = fn
      ? (cpu, a) => { cur = cpu; return fn(cpu, a); }
      : (cpu) => { if (!jniMissing.has(name)) { jniMissing.add(name); console.warn("[jni missing]", name); } void cpu; return 0; };
    stp(envTable + i * PTR, defineHost("JNI:" + name, wrapped));
  }
  const vmTable = mem.hostAlloc(8 * PTR);
  const vmFns: [number, string, HostFn][] = [
    [3, "DestroyJavaVM", () => 0],
    [4, "AttachCurrentThread", (cpu, a) => { a.p(); stp(a.p(), envFor(cpu)); return 0; }],
    [5, "DetachCurrentThread", () => 0],
    [6, "GetEnv", (cpu, a) => { a.p(); stp(a.p(), envFor(cpu)); return 0; }],
    [7, "AttachCurrentThreadAsDaemon", (cpu, a) => { a.p(); stp(a.p(), envFor(cpu)); return 0; }],
  ];
  for (const [i, name, fn] of vmFns) stp(vmTable + i * PTR, defineHost("JavaVM:" + name, (cpu, a) => { cur = cpu; return fn(cpu, a); }));
  javaVM.addr = mem.hostAlloc(8);
  stp(javaVM.addr, vmTable);
}

function registerNative(info: ClassInfo, name: string, sig: string, fn: number): void {
  // static or instance is not in the JNINativeMethod record: the dex knows
  let isStatic = false;
  const def = info.def, dex = info.dex;
  if (def && dex) {
    for (const m of def.directMethods) { const mr = dex.method(m.methodIdx); if (mr.name === name && dex.methodDesc(m.methodIdx) === sig) { isStatic = (m.flags & 0x8) !== 0; break; } }
  }
  const { params, ret } = parseMethodDesc(sig);
  const critical = isStatic && methodAnnotations(info, name, sig).some(a => a.type === "dalvik/annotation/optimization/CriticalNative");
  const rec: Registered = { info, cls: info.name, name, sig, fn, isStatic, critical, params, ret, label: info.name.split("/").pop() + "." + name };
  registered.push(rec);
  (info.owner ?? rt).registerJni(info.name, name + sig, function (this: unknown, ...args: unknown[]) {
    return callGuestNative(cpuFor(curThread), rec, this, args);
  } as (...a: never[]) => unknown);
  // the compiled stub memoised a miss before JNI_OnLoad ran: re-point it (see compiler emitNativeStub)
  const mangled = mangleMethod(name, sig);
  const target = isStatic ? info.ctor : info.ctor.prototype;
  if (target && Object.prototype.hasOwnProperty.call(target, mangled)) {
    target[mangled] = function (this: unknown, ...args: unknown[]) { return callGuestNative(cpuFor(curThread), rec, this, args); };
  }
}

/** natives with no RegisterNatives entry resolve by the JNI short-name export `Java_pkg_Cls_method` */
export function resolveByExport(lookup: (sym: string) => number | undefined): void {
  rt.jniResolver = function (this: Runtime, cls: string, sig: string) {
    const [name, desc] = splitSig(sig);
    const mangle = (s: string) => s.replace(/_/g, "_1").replace(/;/g, "_2").replace(/\[/g, "_3").replace(/\//g, "_").replace(/[^A-Za-z0-9_]/g, (c) => "_0" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    const short = "Java_" + mangle(cls) + "_" + mangle(name);
    const fn = lookup(short) ?? lookup(short + "__" + mangle(desc.slice(1, desc.indexOf(")"))));
    if (fn === undefined) return null;
    const info = this.link(cls);
    registerNative(info, name, desc, fn);
    return (info.owner ?? this).jni.get(cls + "|" + sig) ?? null;
  };
}
