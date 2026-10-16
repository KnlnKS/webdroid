// JavaVM + JNIEnv function tables in guest memory, the reference tables, and the marshalling between guest natives (AAPCS words) and the JVM's value
// model. What a class, an object, a field, a method or an array is belongs to the Wasm tier (jnivm.ts, wasm/host/jni.ts): a reference here is the
// Wasm reference itself.

import { mem } from "./mem.ts";
import { defineHost, type HostFn, vaList, retF, retD, retPair, type ArgReader, PTR, stp, ldp, type HostRet, hostTrace } from "./host.ts";
import { type Cpu, cpuFor, type CallArg } from "./cpu.ts";
import { rt, type Gen } from "../jvm/runtime.ts";
import { parseMethodDesc, splitSig, decodeModifiedUtf8, encodeModifiedUtf8, charsToString } from "../jvm/abi.ts";
import { after, curThread } from "../jvm/natives/jentry.ts";
import { isExternal, isLive, guestAddress } from "../jvm/natives/jmemory.ts";
import { vm, type JniClass, type JniField } from "./jnivm.ts";

export const jniMissing = new Set<string>();
export const jniTrace = { on: false };
export const javaVM = { addr: 0 };

// ── references: locals live per Cpu in frames; globals and weak globals in a table each. 0 is null.
/** `n` UTF-16 units of `s` from `from` into guest memory at `p`, in one store */
function putUnits(p: number, s: string, from: number, n: number): void {
  if (n <= 0) return;
  const units = new Uint16Array(n);
  for (let i = 0; i < n; i++) units[i] = s.charCodeAt(from + i);
  mem.write(p, new Uint8Array(units.buffer));
}
/** a failed call's result: zero of the return type's width */
const zero = (ret: string) => (ret === "J" || ret === "D" ? 0n : 0);
const GLOBAL_BIT = 0x40000000, WEAK_BIT = 0x20000000;
const globals: unknown[] = [null];
const freeGlobals: number[] = [];
/** a weak global holds its object through a WeakRef; a value that is not an object (a JS string) cannot be held weakly and is held as it is */
const weaks: (WeakRef<object> | unknown)[] = [null];
const freeWeaks: number[] = [];
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
function add(table: unknown[], free: number[], o: unknown, bit: number): number {
  const i = free.pop();
  if (i !== undefined) { table[i] = o; return bit | i; }
  table.push(o);
  return bit | (table.length - 1);
}
const newGlobalRef = (o: unknown): number => (o === null || o === undefined ? 0 : add(globals, freeGlobals, o, GLOBAL_BIT));
const newWeakRef = (o: unknown): number => (o === null || o === undefined ? 0 : add(weaks, freeWeaks, typeof o === "object" ? new WeakRef(o) : o, WEAK_BIT));
/** the Java object a reference stands for, as the tier holds it; null for 0, a deleted reference and a collected weak one */
function object(h: number, cpu: Cpu | null = cur): unknown {
  if (h === 0) return null;
  if (h & GLOBAL_BIT) return globals[h & ~GLOBAL_BIT] ?? null;
  if (h & WEAK_BIT) { const w = weaks[h & ~WEAK_BIT]; return (w instanceof WeakRef ? w.deref() : w) ?? null; }
  return locals(cpu!).refs[h] ?? null;
}
/** the object behind a reference as the host natives (libandroid, bitmap) read it */
export const deref = (h: number, cpu: Cpu | null = cur): unknown => vm.host(object(h, cpu));
export function pushFrame(cpu: Cpu): void { const l = locals(cpu); l.frames.push(l.refs.length); }
export function popFrame(cpu: Cpu): void { const l = locals(cpu); const m = l.frames.pop(); if (m !== undefined) l.refs.length = m; }

interface MethodRec { cls: JniClass; name: string; desc: string; isStatic: boolean; params: string[]; ret: string }
const methods: MethodRec[] = [null as unknown as MethodRec];
const methodIds = new WeakMap<JniClass, Map<string, number>>();
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
const fieldOf = (id: number): JniField | undefined => fields[fieldIdx.get(id >>> 0) ?? 0];
/** a jmethodID is canonical: the same method looked up twice, or reached through a reflected
 *  Method, is the same id (an engine caches ids per proxy method and matches by identity) */
function methodId(cls: JniClass, name: string, desc: string, isStatic: boolean): number {
  const key = (isStatic ? "static " : "") + name + desc;
  let ids = methodIds.get(cls);
  if (!ids) methodIds.set(cls, ids = new Map());
  let id = ids.get(key);
  if (id === undefined) {
    const { params, ret } = parseMethodDesc(desc);
    methods.push({ cls, name, desc, isStatic, params, ret });
    ids.set(key, (id = mintId(methodIdx, methods.length - 1)));
  }
  return id;
}
const fields: JniField[] = [null as unknown as JniField];
const fieldIds = new WeakMap<JniClass, Map<string, number>>();

function fieldId(f: JniField): number {
  let ids = fieldIds.get(f.cls);
  if (!ids) fieldIds.set(f.cls, ids = new Map());
  let id = ids.get(f.key);
  if (id === undefined) {
    fields.push(f);
    ids.set(f.key, id = mintId(fieldIdx, fields.length - 1));
  }
  return id;
}

interface Registered { c: JniClass; cls: string; name: string; sig: string; fn: number; isStatic: boolean; critical: boolean; params: string[]; ret: string; label: string }
export const registered: Registered[] = [];

const classOf = (clsRef: number): JniClass | null => {
  const c = object(clsRef);
  return c === null ? null : vm.classOf(c);
};
function pend(cpu: Cpu, e: unknown): void {
  cpu.exc = e;
  if (jniTrace.on) { console.warn("[jni] pending", (e as { msg?: string })?.msg, e); console.warn("[jni] ring", hostTrace.ring.slice(-50).join(" | "), new Error().stack); }
}
/** the exception a failed call leaves pending */
const failed = (cpu: Cpu, e: unknown): void => pend(cpu, vm.caught(e));

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
      default: out.push(object(r.p()));
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
      default: out.push(object(mem.ld32(p)));
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

/** ART hands out array elements in place, so native code reads a pinned pointer after Java
 *  filled the array (InputStream.read into it) and passes arrays it wrote through one: a pinned
 *  array that crosses a call is synced both ways around it. */
function syncPinned(args: unknown[], toJava: boolean): void {
  for (const arr of args) {
    const at = pinsOf.get(arr);
    if (at) for (const p of at) (toJava ? vm.fromGuest : vm.toGuest)(arr, pinned.get(p)!.type, 0, vm.length(arr), p);
  }
}

function invoke(cpu: Cpu, m: MethodRec, self: unknown, args: unknown[], nonvirtual: boolean): HostRet | Promise<HostRet> {
  const synced = pinned.size > 0;
  if (synced) syncPinned(args, true);
  let pending = false;
  try {
    const p = m.isStatic ? vm.init(m.cls) : null;
    const r = after(p, () => vm.invoke(m.cls, m.name, m.desc, m.isStatic, self, args, nonvirtual));
    if (r instanceof Promise) {
      pending = true;
      return r.then(value => retWord(m.ret, value, cpu)).catch(e => {
        failed(cpu, e);
        return zero(m.ret);
      }).finally(() => { if (synced) syncPinned(args, false); });
    }
    return retWord(m.ret, r, cpu);
  } catch (e) {
    failed(cpu, e);
    return zero(m.ret);
  } finally {
    if (synced && !pending) syncPinned(args, false);
  }
}

/** a Java native method whose body is guest code: marshal, run on the caller's Cpu, convert the
 *  result; driven, so it continues as the calling thread and chain */
function* callGuestNative(cpu: Cpu, r: Registered, self: unknown, args: unknown[]): Gen<unknown> {
  const { params, ret } = r;
  yield cpu.idleBase();
  const prevCur = cur, previousClass = cpu.nativeClass;
  cpu.nativeClass = r.c;
  cur = cpu;
  if (!r.critical) pushFrame(cpu);
  try {
    const list: CallArg[] = r.critical ? [] : [envFor(cpu), toRef(r.isStatic ? vm.mirror(r.c) : self)];
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
    try {
      r0 = yield cpu.callSync(r.fn, list, r.label);
      r1 = cpu.ret1;
    } finally { cur = cpu; }
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
      default: out = object(r0);
    }
    const exc = cpu.exc;
    if (exc) { cpu.exc = null; throw vm.raise(exc); }
    return out;
  } finally { if (!r.critical) popFrame(cpu); cpu.nativeClass = previousClass; cur = prevCur; }
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
/** the native copies of arrays that Get<Prim>ArrayElements and GetPrimitiveArrayCritical gave out, until released: by pointer, and by array for the call boundaries that sync them */
const pinned = new Map<number, { arr: unknown; type: string }>();
const pinsOf = new Map<unknown, number[]>();
/** the number of arrays native code holds a copy of */
export const pinnedCount = (): number => pinned.size;
function unpin(p: number, arr: unknown): void {
  pinned.delete(p);
  const at = pinsOf.get(arr)!;
  if (at.length > 1) at.splice(at.indexOf(p), 1); else pinsOf.delete(arr);
}
function pin(arr: unknown, type: string, isCopy: number): number {
  const n = vm.length(arr), p = mem.malloc(Math.max(1, n * elemSize[type]));
  vm.toGuest(arr, type, 0, n, p);
  pinned.set(p, { arr, type });
  const at = pinsOf.get(arr);
  if (at) at.push(p); else pinsOf.set(arr, [p]);
  if (isCopy) mem.st8(isCopy, 1);
  return p;
}

/** writes the bytes and a NUL at p, or at a fresh allocation */
function putUtf8(bytes: Uint8Array, p = mem.malloc(bytes.length + 1)): number {
  mem.u8.set(bytes, p); mem.u8[p + bytes.length] = 0;
  return p;
}
const text = (ref: number): string => { const s = object(ref); return s === null ? "" : vm.chars(s); };

export function jniInit(): void {
  jniTrace.on ||= !!(globalThis as { __wdJniTrace?: boolean }).__wdJniTrace;
  const T: (HostFn | null)[] = new Array(233).fill(null);
  const names: string[] = new Array(233).fill("?");
  const def = (i: number, name: string, fn: HostFn) => { T[i] = fn; names[i] = name; };

  def(4, "GetVersion", () => 0x00010006);
  def(7, "FromReflectedMethod", (cpu, a) => {
    a.p(); const o = object(a.i());
    try { const m = vm.unreflectMethod(o); return m ? methodId(m.cls, m.name, m.desc, m.isStatic) : 0; } catch (e) { failed(cpu, e); return 0; }
  });
  def(8, "FromReflectedField", (cpu, a) => {
    a.p(); const o = object(a.p());
    try { const f = vm.unreflectField(o); return f ? fieldId(f) : 0; } catch (e) { failed(cpu, e); return 0; }
  });
  def(9, "ToReflectedMethod", (cpu, a) => {
    a.p(); a.p(); const m = methodOf(a.p()); a.i();
    try { return m ? toRef(vm.reflect(m.cls, m.name, m.desc, m.isStatic)) : 0; } catch (e) { failed(cpu, e); return 0; }
  });
  def(6, "FindClass", (cpu, a) => {
    a.p(); const n = a.str().replace(/\./g, "/");
    const found = (c: JniClass | null): number => {
      if (!c) { pend(cpu, vm.noClass(n)); return 0; }
      return toRef(vm.mirror(c), cpu);
    };
    const rejected = (e: unknown): number => { failed(cpu, e); return 0; };
    try {
      const result = vm.resolve(n, cpu.nativeClass);
      return result instanceof Promise ? result.then(found).catch(rejected) : found(result);
    } catch (e) { return rejected(e); }
  });
  def(10, "GetSuperclass", (_c, a) => { a.p(); const c = classOf(a.p()); return c ? toRef(vm.superClass(c)) : 0; });
  def(11, "IsAssignableFrom", (_c, a) => { a.p(); const s = classOf(a.p()), t = classOf(a.p()); return s && t && vm.assignable(s, t) ? 1 : 0; });
  def(13, "Throw", (cpu, a) => { a.p(); pend(cpu, object(a.p())); return 0; });
  def(14, "ThrowNew", (cpu, a) => { a.p(); const c = classOf(a.p()); const msg = a.p(); pend(cpu, vm.throwable(c?.name ?? "java/lang/Error", msg ? mem.cstr(msg) : "")); return 0; });
  def(15, "ExceptionOccurred", (cpu) => toRef(cpu.exc));
  def(16, "ExceptionDescribe", async (cpu) => { if (cpu.exc) console.warn("[jni] exception:", await vm.describe(cpu.exc)); });
  def(17, "ExceptionClear", (cpu) => { cpu.exc = null; });
  def(18, "FatalError", (cpu, a) => { a.p(); cpu.fault("JNI FatalError: " + a.str()); });
  def(19, "PushLocalFrame", (cpu) => { pushFrame(cpu); return 0; });
  def(20, "PopLocalFrame", (cpu, a) => { a.p(); const o = object(a.p()); popFrame(cpu); return toRef(o); });
  def(21, "NewGlobalRef", (_c, a) => { a.p(); return newGlobalRef(object(a.p())); });
  def(22, "DeleteGlobalRef", (_c, a) => { a.p(); const h = a.p(); if (h & GLOBAL_BIT) { globals[h & ~GLOBAL_BIT] = null; freeGlobals.push(h & ~GLOBAL_BIT); } });
  def(23, "DeleteLocalRef", (cpu, a) => { a.p(); const h = a.p(); if (h && !(h & (GLOBAL_BIT | WEAK_BIT))) locals(cpu).refs[h] = null; });
  def(24, "IsSameObject", (_c, a) => { a.p(); return object(a.p()) === object(a.p()) ? 1 : 0; });
  def(25, "NewLocalRef", (_c, a) => { a.p(); return toRef(object(a.p())); });
  def(26, "EnsureLocalCapacity", () => 0);
  def(27, "AllocObject", async (cpu, a) => { a.p(); const c = classOf(a.p()); return c ? after(vm.init(c), () => toRef(vm.allocate(c), cpu)) : 0; });
  const newObject = (read: (m: MethodRec, a: ArgReader) => unknown[]) => async (cpu: Cpu, a: ArgReader) => {
    a.p(); const c = classOf(a.p()); const m = methodOf(a.p());
    if (!c || !m) return 0;
    const args = read(m, a);
    return rt.drive(function* (): Gen<number> {
      try {
        yield vm.init(c);
        return toRef(yield vm.construct(c, m.desc, args), cpu);
      } catch (e) { failed(cpu, e); return 0; }
    }());
  };
  def(28, "NewObject", newObject((m, a) => readArgs(m.params, a)));
  def(29, "NewObjectV", newObject((m, a) => readArgs(m.params, vaList(a.p()))));
  def(30, "NewObjectA", newObject((m, a) => readJvalues(m.params, a.p())));
  def(31, "GetObjectClass", (_c, a) => { a.p(); const o = object(a.p()); return o === null ? 0 : toRef(vm.objectClass(o)); });
  def(32, "IsInstanceOf", (_c, a) => { a.p(); const o = object(a.p()); const c = classOf(a.p()); return o === null ? 1 : c ? +vm.isInstance(o, c) : 0; });
  const getMethodID = (isStatic: boolean) => async (cpu: Cpu, a: ArgReader) => {
    a.p(); const c = classOf(a.p()); const name = a.str(), sig = a.str();
    if (!c) { pend(cpu, vm.throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    const p = vm.init(c); if (p) await p;
    if (!vm.hasMethod(c, name, sig, isStatic)) { pend(cpu, vm.throwable("java/lang/NoSuchMethodError", `${c.name}.${name}${sig}`)); jniMissing.add(`${isStatic ? "static " : ""}${c.name}.${name}${sig}`); return 0; }
    return methodId(c, name, sig, isStatic);
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
          const self = kind === "static" ? null : object(a.p());
          if (kind !== "virtual") a.p(); // jclass
          const m = methodOf(a.p());
          if (!m) { pend(cpu, vm.throwable("java/lang/NoSuchMethodError", "bad methodID")); return 0; }
          const args = read(m, a);
          if (jniTrace.on) console.log("[jni] ←", m.cls.name, m.name, m.desc, args.map((v) => typeof v === "string" ? JSON.stringify(v.slice(0, 200)) : Array.isArray(v) ? `[${v.length}]` : v !== null && typeof v === "object" ? "<reference>" : String(v)).join(" "));
          return invoke(cpu, m, self, args, kind === "nonvirtual");
        });
      }
    };
    mk(34 + k * 3, "virtual");
    mk(64 + k * 3, "nonvirtual");
    mk(114 + k * 3, "static");
  }
  const getFieldID = (isStatic: boolean) => async (cpu: Cpu, a: ArgReader) => {
    a.p(); const c = classOf(a.p()); const name = a.str(), sig = a.str();
    if (!c) { pend(cpu, vm.throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    const p = vm.init(c); if (p) await p;
    const f = vm.field(c, name, sig, isStatic);
    if (!f) { pend(cpu, vm.throwable("java/lang/NoSuchFieldError", `${c.name}.${name}`)); jniMissing.add(`${isStatic ? "static field" : "field"} ${c.name}.${name}`); return 0; }
    return fieldId(f);
  };
  def(94, "GetFieldID", getFieldID(false));
  def(144, "GetStaticFieldID", getFieldID(true));
  for (let k = 0; k < 9; k++) {
    const P = PRIM[k], D = PRIM_DESC[k];
    const fromJava = (v: unknown, cpu: Cpu): HostRet => retWord(D, v, cpu);
    const toJava = (a: ArgReader): unknown => D === "J" ? a.l() : D === "F" ? a.f() : D === "D" ? a.d() : D === "L" ? object(a.p()) : D === "Z" ? (a.i() & 255 ? 1 : 0) : a.i();
    def(95 + k, `Get${P}Field`, (cpu, a) => { a.p(); const o = object(a.p()); const f = fieldOf(a.p()); return o !== null && f ? fromJava(vm.get(f, o), cpu) : zero(D); });
    def(104 + k, `Set${P}Field`, (_c, a) => { a.p(); const o = object(a.p()); const f = fieldOf(a.p()); const v = toJava(a); if (o !== null && f) vm.set(f, o, v); });
    def(145 + k, `GetStatic${P}Field`, (cpu, a) => { a.p(); a.p(); const f = fieldOf(a.p()); return f ? fromJava(vm.get(f, null), cpu) : zero(D); });
    def(154 + k, `SetStatic${P}Field`, (_c, a) => { a.p(); a.p(); const f = fieldOf(a.p()); const v = toJava(a); if (f) vm.set(f, null, v); });
  }
  // strings
  def(163, "NewString", (_c, a) => { a.p(); const p = a.p(), n = Math.max(0, a.i()), b = mem.bytes(p, 2 * n); return toRef(vm.string(charsToString(p & 1 ? new Uint16Array(b.slice().buffer) : new Uint16Array(b.buffer, b.byteOffset, n), 0, n))); });
  def(164, "GetStringLength", (_c, a) => { a.p(); return text(a.p()).length; });
  def(165, "GetStringChars", (_c, a) => { a.p(); const s = text(a.p()); const isCopy = a.p(); const p = mem.malloc(s.length * 2 + 2); putUnits(p, s, 0, s.length); mem.st16(p + s.length * 2, 0); if (isCopy) mem.st8(isCopy, 1); return p; });
  def(166, "ReleaseStringChars", (_c, a) => { a.p(); a.p(); mem.free(a.p()); });
  def(167, "NewStringUTF", (_c, a) => {
    a.p(); const p = a.p();
    if (!p) return 0;
    mem.ld8u(p); // faults on a bad pointer as reading it would
    const end = mem.u8.indexOf(0, p);
    return toRef(vm.string(decodeModifiedUtf8(mem.u8, p, end < 0 ? mem.u8.length : end)));
  });
  def(168, "GetStringUTFLength", (_c, a) => { a.p(); return encodeModifiedUtf8(text(a.p())).length; });
  def(169, "GetStringUTFChars", (_c, a) => { a.p(); const s = text(a.p()); const isCopy = a.p(); const p = putUtf8(encodeModifiedUtf8(s)); if (isCopy) mem.st8(isCopy, 1); return p; });
  def(170, "ReleaseStringUTFChars", (_c, a) => { a.p(); a.p(); mem.free(a.p()); });
  def(220, "GetStringRegion", (_c, a) => { a.p(); const s = text(a.p()); const st = a.i(), n = a.i(); putUnits(a.p(), s, st, n); });
  def(221, "GetStringUTFRegion", (_c, a) => { a.p(); const s = text(a.p()); const st = a.i(), n = a.i(), buf = a.p(); putUtf8(encodeModifiedUtf8(s.slice(st, st + n)), buf); });
  def(224, "GetStringCritical", T[165]!);
  def(225, "ReleaseStringCritical", T[166]!);
  // arrays
  def(171, "GetArrayLength", (_c, a) => { a.p(); const arr = object(a.p()); return arr === null ? 0 : vm.length(arr); });
  def(172, "NewObjectArray", (_c, a) => { a.p(); const n = a.i(); const c = classOf(a.p()); const init = object(a.p()); return toRef(vm.newObjectArray(n, c, init)); });
  def(173, "GetObjectArrayElement", (cpu, a) => { a.p(); const arr = object(a.p()); const i = a.i(); if (arr === null || i < 0 || i >= vm.length(arr)) { pend(cpu, vm.throwable("java/lang/ArrayIndexOutOfBoundsException", String(i))); return 0; } return toRef(vm.element(arr, i)); });
  def(174, "SetObjectArrayElement", (cpu, a) => { a.p(); const arr = object(a.p()); const i = a.i(); const v = object(a.p()); if (arr === null || i < 0 || i >= vm.length(arr)) { pend(cpu, vm.throwable("java/lang/ArrayIndexOutOfBoundsException", String(i))); return; } vm.setElement(arr, i, v); });
  for (let k = 1; k <= 8; k++) {
    const P = PRIM[k], D = PRIM_DESC[k];
    def(174 + k, `New${P}Array`, (_c, a) => { a.p(); return toRef(vm.newPrimitiveArray(D, a.i())); });
    def(182 + k, `Get${P}ArrayElements`, (_c, a) => { a.p(); const arr = object(a.p()); const isCopy = a.p(); return arr !== null ? pin(arr, D, isCopy) : 0; });
    def(190 + k, `Release${P}ArrayElements`, (_c, a) => {
      a.p(); a.p(); const p = a.p(), mode = a.i();
      const held = pinned.get(p);
      if (!held) return;
      if (mode !== 2) vm.fromGuest(held.arr, held.type, 0, vm.length(held.arr), p);
      if (mode !== 1) { unpin(p, held.arr); mem.free(p); }
    });
    for (const [slot, kind, copy] of [[198, "Get", vm.toGuest], [206, "Set", vm.fromGuest]] as const) def(slot + k, `${kind}${P}ArrayRegion`, (cpu, a) => {
      a.p(); const arr = object(a.p()); const st = a.i(), n = a.i(), buf = a.p();
      if (arr === null || st < 0 || st + n > vm.length(arr)) { pend(cpu, vm.throwable("java/lang/ArrayIndexOutOfBoundsException", `${st}+${n}`)); return; }
      copy(arr, D, st, n, buf);
    });
  }
  def(222, "GetPrimitiveArrayCritical", (_c, a) => { a.p(); const arr = object(a.p()); const isCopy = a.p(); return arr !== null ? pin(arr, vm.elementType(arr), isCopy) : 0; });
  def(223, "ReleasePrimitiveArrayCritical", T[191]!);
  def(215, "RegisterNatives", (_cpu, a) => {
    a.p(); const c = classOf(a.p()); const tab = a.p(), n = a.i();
    if (!c) return -1;
    for (let k = 0; k < n; k++) {
      // JNINativeMethod is three pointers: 12 bytes on ILP32, 24 on LP64
      const rec = tab + k * PTR * 3;
      const name = mem.cstr(ldp(rec)), sig = mem.cstr(ldp(rec + PTR)), fn = ldp(rec + PTR * 2);
      registerNative(c, name, sig, fn);
    }
    return 0;
  });
  def(216, "UnregisterNatives", () => 0);
  for (const [index, name, enter] of [[217, "MonitorEnter", true], [218, "MonitorExit", false]] satisfies [number, string, boolean][]) {
    def(index, name, (cpu, a) => {
      a.p(); const obj = object(a.p());
      try {
        if (typeof obj !== "object" && typeof obj !== "string") throw vm.throwable("java/lang/NullPointerException", "JNI monitor reference");
        const pending = vm.monitor(obj, enter);
        return pending ? pending.then(() => 0, (e) => { failed(cpu, e); return -1; }) : 0;
      } catch (e) { failed(cpu, e); return -1; }
    });
  }
  def(219, "GetJavaVM", (_c, a) => { a.p(); stp(a.p(), javaVM.addr); return 0; });
  def(226, "NewWeakGlobalRef", (_c, a) => { a.p(); return newWeakRef(object(a.p())); });
  def(227, "DeleteWeakGlobalRef", (_c, a) => { a.p(); const h = a.p(); if (h & WEAK_BIT) { weaks[h & ~WEAK_BIT] = null; freeWeaks.push(h & ~WEAK_BIT); } });
  def(228, "ExceptionCheck", (cpu) => (cpu.exc ? 1 : 0));
  def(229, "NewDirectByteBuffer", (cpu, a) => {
    a.p(); const address = a.p(), cap = a.l();
    if (cap < 0n || cap > 0x7fffffffn) return 0;
    try {
      const b = vm.newBuffer(mem.va(address), Number(cap));
      return b instanceof Promise ? b.then(toRef, (e) => { failed(cpu, e); return 0; }) : toRef(b);
    } catch (e) { failed(cpu, e); return 0; }
  });
  def(230, "GetDirectBufferAddress", (cpu, a) => {
    a.p(); const address = vm.bufferAddress(object(a.p()));
    if (address === null) return 0;
    try {
      const native = isExternal(address) ? guestAddress(address) : address <= 0xffffffffn ? Number(address) : address;
      return native instanceof Promise ? native.catch((e) => { failed(cpu, e); return 0; }) : native;
    } catch (e) { failed(cpu, e); return 0; }
  });
  def(231, "GetDirectBufferCapacity", (_cpu, a) => {
    a.p(); const b = object(a.p()), address = vm.bufferAddress(b);
    return address && !isLive(address) ? BigInt(vm.bufferCapacity(b)) : -1n;
  });
  def(232, "GetObjectRefType", (_c, a) => { a.p(); const h = a.p(); return h === 0 ? 0 : h & GLOBAL_BIT ? 2 : h & WEAK_BIT ? 3 : 1; });

  envTable = mem.hostAlloc(233 * PTR);
  for (let i = 0; i < 233; i++) {
    const fn = T[i];
    const name = fn ? names[i] : `JNI#${i}`;
    const wrapped: HostFn = fn
      ? (cpu, a) => { cur = cpu; return fn(cpu, a); }
      : () => { if (!jniMissing.has(name)) { jniMissing.add(name); console.warn("[jni missing]", name); } return 0; };
    stp(envTable + i * PTR, defineHost("JNI:" + name, wrapped));
  }
  const vmTable = mem.hostAlloc(8 * PTR);
  const attach: HostFn = (cpu, a) => { a.p(); stp(a.p(), envFor(cpu)); return 0; };
  const vmFns: [number, string, HostFn][] = [
    [3, "DestroyJavaVM", () => 0],
    [4, "AttachCurrentThread", attach],
    [5, "DetachCurrentThread", () => 0],
    [6, "GetEnv", attach],
    [7, "AttachCurrentThreadAsDaemon", attach],
  ];
  for (const [i, name, fn] of vmFns) stp(vmTable + i * PTR, defineHost("JavaVM:" + name, (cpu, a) => { cur = cpu; return fn(cpu, a); }));
  javaVM.addr = mem.hostAlloc(8);
  stp(javaVM.addr, vmTable);
}

function registerNative(c: JniClass, name: string, sig: string, fn: number): void {
  const { isStatic, critical } = vm.nativeKind(c, name, sig), { params, ret } = parseMethodDesc(sig);
  const rec: Registered = { c, cls: c.name, name, sig, fn, isStatic, critical, params, ret, label: c.name.split("/").pop() + "." + name };
  registered.push(rec);
  vm.bind(c, name, sig, isStatic, native(rec), params.length);
}
/** the host function a native method with guest code runs: its arguments and result are the Wasm tier's Java values, unconverted */
const native = (rec: Registered): ((...a: never[]) => unknown) =>
  Object.assign(function (this: unknown, ...args: unknown[]) { return rt.drive(callGuestNative(cpuFor(curThread), rec, this, args)); }, { javaValues: true }) as never;

/** natives with no RegisterNatives entry resolve by the JNI short-name export `Java_pkg_Cls_method` */
export function resolveByExport(lookup: (sym: string) => number | undefined): void {
  rt.jniResolver = (cls: string, sig: string) => {
    const [name, desc] = splitSig(sig);
    const mangle = (s: string) => s.replace(/_/g, "_1").replace(/;/g, "_2").replace(/\[/g, "_3").replace(/\//g, "_").replace(/[^A-Za-z0-9_]/g, (c) => "_0" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    const short = "Java_" + mangle(vm.binaryName(cls)) + "_" + mangle(name);
    const fn = lookup(short) ?? lookup(short + "__" + mangle(vm.binaryName(desc.slice(1, desc.indexOf(")")))));
    if (fn === undefined) return null;
    const c = vm.find(cls);
    if (!c) return null;
    registerNative(c, name, desc, fn);
    return rt.jni.get(cls + "|" + sig) ?? null;
  };
}
