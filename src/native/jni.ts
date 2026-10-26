// JavaVM + JNIEnv function tables in guest memory, the reference tables, and the marshalling between guest natives (AAPCS words) and the JVM's value
// model. What a class, an object, a field, a method or an array is belongs to the Wasm tier (jnivm.ts, wasm/host/jni.ts): a reference here is the
// Wasm reference itself.

import { mem } from "./mem.ts";
import { defineHost, type HostFn, vaList, retF, retD, retPair, type ArgReader, PTR, stp, ldp, type HostRet, hostTrace } from "./host.ts";
import { type Cpu, cpuFor, type CallArg } from "./cpu.ts";
import { rt, javaValues, type Gen } from "../jvm/runtime.ts";
import { PRIMS, parseMethodDesc, splitSig, decodeModifiedUtf8, encodeModifiedUtf8, charsToString } from "../jvm/abi.ts";
import { after, curThread } from "../jvm/natives/jentry.ts";
import { isExternal, guestAddress } from "../jvm/natives/jmemory.ts";
import type { JniClass, JniField } from "./jnivm.ts";
import { java } from "../jvm/javahost.ts";

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
/** a local reference in `cpu`'s frame: each thread's JNI calls name objects through its own table */
function toRef(o: unknown, cpu: Cpu): number {
  if (o === null || o === undefined) return 0;
  const l = locals(cpu);
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
function object(h: number, cpu: Cpu): unknown {
  if (h === 0) return null;
  if (h & GLOBAL_BIT) return globals[h & ~GLOBAL_BIT] ?? null;
  if (h & WEAK_BIT) { const w = weaks[h & ~WEAK_BIT]; return (w instanceof WeakRef ? w.deref() : w) ?? null; }
  return locals(cpu).refs[h] ?? null;
}
/** the object behind a reference as the host natives (libandroid, bitmap) read it */
export const deref = (h: number, cpu: Cpu): unknown => java.jni.host(object(h, cpu));
export function pushFrame(cpu: Cpu): void { const l = locals(cpu); l.frames.push(l.refs.length); }
export function popFrame(cpu: Cpu): void { const l = locals(cpu); const m = l.frames.pop(); if (m !== undefined) l.refs.length = m; }

interface MethodRec { cls: JniClass; name: string; desc: string; isStatic: boolean; args: Codec[]; out: Codec }
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
    methods.push({ cls, name, desc, isStatic, args: params.map(codec), out: codec(ret) });
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

interface Registered { c: JniClass; cls: string; name: string; sig: string; fn: number; isStatic: boolean; critical: boolean; args: Codec[]; out: Codec; label: string }
export const registered: Registered[] = [];

const classOf = (clsRef: number, cpu: Cpu): JniClass | null => {
  const c = object(clsRef, cpu);
  return c === null ? null : java.jni.classOf(c);
};
function pend(cpu: Cpu, e: unknown): void {
  cpu.exc = e;
  if (jniTrace.on) { console.warn("[jni] pending", (e as { msg?: string })?.msg, e); console.warn("[jni] ring", hostTrace.ring.slice(-50).join(" | "), new Error().stack); }
}
/** the exception a failed call leaves pending */
const failed = (cpu: Cpu, e: unknown): void => pend(cpu, java.jni.caught(e));
/** `body`'s answer once `c` is initialized, as ART's EnsureInitialized before an ID or an instance; 0 with any failure pending */
const initialized = (cpu: Cpu, c: JniClass, body: () => Gen<number>): number | Promise<number> => rt.drive(function* (): Gen<number> {
  try { yield java.jni.init(c); return yield* body(); } catch (e) { failed(cpu, e); return 0; }
}());

/** a JNI type's Java values as guest code holds them: read from an argument (a float arrives as a double
 *  among variadic ones) or a jvalue, returned to guest code or passed to it, and read from its result.
 *  A narrow value is extended here, as AAPCS64 leaves the bits above it unspecified. */
interface Codec {
  read(a: ArgReader, cpu: Cpu, variadic: boolean): unknown;
  jvalue(p: number, cpu: Cpu): unknown;
  ret(v: unknown, cpu: Cpu): HostRet;
  pass(v: unknown, cpu: Cpu): CallArg;
  result(r0: number, cpu: Cpu): unknown;
  /** what a failed call answers */
  zero: unknown;
}
const narrow = (norm: (x: number) => number): Codec =>
  ({ read: (a) => norm(a.i()), jvalue: (p) => norm(mem.ld32(p)), ret: (v) => norm(v as number), pass: (v) => norm(v as number), result: norm, zero: 0 });
const REFERENCE: Codec = { read: (a, cpu) => object(a.p(), cpu), jvalue: (p, cpu) => object(mem.ld32(p), cpu), ret: toRef, pass: toRef, result: object, zero: null };
const CODECS: Record<string, Codec> = {
  Z: narrow((x) => (x & 0xff ? 1 : 0)), B: narrow((x) => (x << 24) >> 24), C: narrow((x) => x & 0xffff), S: narrow((x) => (x << 16) >> 16), I: narrow((x) => x | 0),
  J: { read: (a) => a.l(), jvalue: (p) => mem.ld64(p), ret: (v) => v as bigint, pass: (v) => v as bigint, result: (r0, cpu) => retPair(r0, cpu.ret1), zero: 0n },
  F: { read: (a, _c, variadic) => (variadic ? Math.fround(a.d()) : a.f()), jvalue: (p) => mem.ldf32(p), ret: (v, cpu) => retF(cpu, v as number), pass: (v) => ({ f: v as number }), result: (_r, cpu) => cpu.retF(), zero: 0 },
  D: { read: (a) => a.d(), jvalue: (p) => mem.ldf64(p), ret: (v, cpu) => retD(cpu, v as number), pass: (v) => ({ d: v as number }), result: (_r, cpu) => cpu.retD(), zero: 0 },
  V: { ...narrow((x) => x), ret: () => 0, result: () => undefined, zero: undefined },
  L: REFERENCE, "[": REFERENCE,
};
const codec = (desc: string): Codec => CODECS[desc[0]];
/** a call's arguments as guest code passes them: variadic, in a va_list, or in a jvalue array */
const FORMS: Record<string, (m: MethodRec, a: ArgReader, cpu: Cpu) => unknown[]> = {
  "": (m, a, cpu) => m.args.map((c) => c.read(a, cpu, true)),
  V: (m, a, cpu) => { const list = vaList(a.p()); return m.args.map((c) => c.read(list, cpu, true)); },
  A: (m, a, cpu) => { const p = a.p(); return m.args.map((c, i) => c.jvalue(p + 8 * i, cpu)); },
};

/** ART hands out array elements in place, so native code reads a pinned pointer after Java
 *  filled the array (InputStream.read into it) and passes arrays it wrote through one: a pinned
 *  array that crosses a call is synced both ways around it. */
function syncPinned(args: unknown[], toJava: boolean): void {
  for (const arr of args) {
    const at = pinsOf.get(arr);
    if (at) for (const p of at) (toJava ? java.jni.fromGuest : java.jni.toGuest)(arr, pinned.get(p)!.type, 0, java.jni.length(arr), p);
  }
}

function invoke(cpu: Cpu, m: MethodRec, self: unknown, args: unknown[], nonvirtual: boolean): HostRet | Promise<HostRet> {
  const synced = pinned.size > 0;
  if (synced) syncPinned(args, true);
  let pending = false;
  try {
    const p = m.isStatic ? java.jni.init(m.cls) : null;
    const r = after(p, () => java.jni.invoke(m.cls, m.name, m.desc, m.isStatic, self, args, nonvirtual));
    if (r instanceof Promise) {
      pending = true;
      return r.then(value => m.out.ret(value, cpu)).catch(e => {
        failed(cpu, e);
        return m.out.ret(m.out.zero, cpu);
      }).finally(() => { if (synced) syncPinned(args, false); });
    }
    return m.out.ret(r, cpu);
  } catch (e) {
    failed(cpu, e);
    return m.out.ret(m.out.zero, cpu);
  } finally {
    if (synced && !pending) syncPinned(args, false);
  }
}

/** a Java native method whose body is guest code: marshal, run on the caller's Cpu, convert the
 *  result; driven, so it continues as the calling thread and chain */
function* callGuestNative(cpu: Cpu, r: Registered, self: unknown, args: unknown[]): Gen<unknown> {
  yield cpu.idleBase();
  const previousClass = cpu.nativeClass;
  cpu.nativeClass = r.c;
  if (!r.critical) pushFrame(cpu);
  try {
    const list: CallArg[] = r.critical ? [] : [envFor(cpu), toRef(r.isStatic ? java.jni.mirror(r.c) : self, cpu)];
    for (let i = 0; i < r.args.length; i++) list.push(r.args[i].pass(args[i], cpu));
    if (jniTrace.on) console.log("[jni] →", r.cls, r.name, r.sig);
    const r0: number = yield cpu.callSync(r.fn, list, r.label);
    const out = r.out.result(r0, cpu);
    const exc = cpu.exc;
    if (exc) { cpu.exc = null; throw java.jni.raise(exc); }
    return out;
  } finally { if (!r.critical) popFrame(cpu); cpu.nativeClass = previousClass; }
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

/** the types of JNI's per-type functions, in its order: Object, the primitives, Void */
const PRIM = ["Object", ...Object.values(PRIMS).map((p) => p.title), "Void"];
const PRIM_DESC = ["L", ...Object.keys(PRIMS), "V"];
const FIELD_TYPES = PRIM.slice(0, 9), ARRAY_TYPES = PRIM.slice(1, 9);
const calls = (kind: string) => PRIM.flatMap((t) => Object.keys(FORMS).map((form) => `Call${kind}${t}Method${form}`));
/** the JNIEnv function table, in jni.h's order */
const JNI_ORDER = [
  "reserved0", "reserved1", "reserved2", "reserved3", "GetVersion", "DefineClass", "FindClass", "FromReflectedMethod", "FromReflectedField", "ToReflectedMethod",
  "GetSuperclass", "IsAssignableFrom", "ToReflectedField", "Throw", "ThrowNew", "ExceptionOccurred", "ExceptionDescribe", "ExceptionClear", "FatalError",
  "PushLocalFrame", "PopLocalFrame", "NewGlobalRef", "DeleteGlobalRef", "DeleteLocalRef", "IsSameObject", "NewLocalRef", "EnsureLocalCapacity",
  "AllocObject", "NewObject", "NewObjectV", "NewObjectA", "GetObjectClass", "IsInstanceOf",
  "GetMethodID", ...calls(""), ...calls("Nonvirtual"),
  "GetFieldID", ...FIELD_TYPES.map((t) => `Get${t}Field`), ...FIELD_TYPES.map((t) => `Set${t}Field`),
  "GetStaticMethodID", ...calls("Static"),
  "GetStaticFieldID", ...FIELD_TYPES.map((t) => `GetStatic${t}Field`), ...FIELD_TYPES.map((t) => `SetStatic${t}Field`),
  "NewString", "GetStringLength", "GetStringChars", "ReleaseStringChars", "NewStringUTF", "GetStringUTFLength", "GetStringUTFChars", "ReleaseStringUTFChars",
  "GetArrayLength", "NewObjectArray", "GetObjectArrayElement", "SetObjectArrayElement",
  ...["New%Array", "Get%ArrayElements", "Release%ArrayElements", "Get%ArrayRegion", "Set%ArrayRegion"].flatMap((f) => ARRAY_TYPES.map((t) => f.replace("%", t))),
  "RegisterNatives", "UnregisterNatives", "MonitorEnter", "MonitorExit", "GetJavaVM", "GetStringRegion", "GetStringUTFRegion",
  "GetPrimitiveArrayCritical", "ReleasePrimitiveArrayCritical", "GetStringCritical", "ReleaseStringCritical", "NewWeakGlobalRef", "DeleteWeakGlobalRef",
  "ExceptionCheck", "NewDirectByteBuffer", "GetDirectBufferAddress", "GetDirectBufferCapacity", "GetObjectRefType",
];
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
  const n = java.jni.length(arr), p = mem.malloc(Math.max(1, n * PRIMS[type].size));
  java.jni.toGuest(arr, type, 0, n, p);
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
const text = (ref: number, cpu: Cpu): string => { const s = object(ref, cpu); return s === null ? "" : java.jni.chars(s); };

export function jniInit(): void {
  jniTrace.on ||= !!(globalThis as { __wdJniTrace?: boolean }).__wdJniTrace;
  const T: (HostFn | undefined)[] = [];
  const def = (name: string, fn: HostFn) => { const i = JNI_ORDER.indexOf(name); if (i < 0) throw new Error(`JNI has no ${name}`); T[i] = fn; };

  def("GetVersion", () => 0x00010006);
  def("FromReflectedMethod", (cpu, a) => {
    a.p(); const o = object(a.i(), cpu);
    try { const m = java.jni.unreflectMethod(o); return m ? methodId(m.cls, m.name, m.desc, m.isStatic) : 0; } catch (e) { failed(cpu, e); return 0; }
  });
  def("FromReflectedField", (cpu, a) => {
    a.p(); const o = object(a.p(), cpu);
    try { const f = java.jni.unreflectField(o); return f ? fieldId(f) : 0; } catch (e) { failed(cpu, e); return 0; }
  });
  def("ToReflectedMethod", (cpu, a) => {
    a.p(); a.p(); const m = methodOf(a.p()); a.i();
    try { return m ? toRef(java.jni.reflect(m.cls, m.name, m.desc, m.isStatic), cpu) : 0; } catch (e) { failed(cpu, e); return 0; }
  });
  def("FindClass", (cpu, a) => {
    a.p(); const n = a.str().replace(/\./g, "/");
    const found = (c: JniClass | null): number => {
      if (!c) { pend(cpu, java.jni.noClass(n)); return 0; }
      return toRef(java.jni.mirror(c), cpu);
    };
    const rejected = (e: unknown): number => { failed(cpu, e); return 0; };
    try {
      const result = java.jni.resolve(n, cpu.nativeClass);
      return result instanceof Promise ? result.then(found).catch(rejected) : found(result);
    } catch (e) { return rejected(e); }
  });
  def("GetSuperclass", (cpu, a) => { a.p(); const c = classOf(a.p(), cpu); return c ? toRef(java.jni.superClass(c), cpu) : 0; });
  def("IsAssignableFrom", (cpu, a) => { a.p(); const s = classOf(a.p(), cpu), t = classOf(a.p(), cpu); return s && t && java.jni.assignable(s, t) ? 1 : 0; });
  def("Throw", (cpu, a) => { a.p(); pend(cpu, object(a.p(), cpu)); return 0; });
  def("ThrowNew", (cpu, a) => { a.p(); const c = classOf(a.p(), cpu); const msg = a.p(); pend(cpu, java.jni.throwable(c?.name ?? "java/lang/Error", msg ? mem.cstr(msg) : "")); return 0; });
  def("ExceptionOccurred", (cpu) => toRef(cpu.exc, cpu));
  def("ExceptionDescribe", async (cpu) => { if (cpu.exc) console.warn("[jni] exception:", await java.jni.describe(cpu.exc)); });
  def("ExceptionClear", (cpu) => { cpu.exc = null; });
  def("FatalError", (cpu, a) => { a.p(); cpu.fault("JNI FatalError: " + a.str()); });
  def("PushLocalFrame", (cpu) => { pushFrame(cpu); return 0; });
  def("PopLocalFrame", (cpu, a) => { a.p(); const o = object(a.p(), cpu); popFrame(cpu); return toRef(o, cpu); });
  def("NewGlobalRef", (cpu, a) => { a.p(); return newGlobalRef(object(a.p(), cpu)); });
  def("DeleteGlobalRef", (_c, a) => { a.p(); const h = a.p(); if (h & GLOBAL_BIT) { globals[h & ~GLOBAL_BIT] = null; freeGlobals.push(h & ~GLOBAL_BIT); } });
  def("DeleteLocalRef", (cpu, a) => { a.p(); const h = a.p(); if (h && !(h & (GLOBAL_BIT | WEAK_BIT))) locals(cpu).refs[h] = null; });
  def("IsSameObject", (cpu, a) => { a.p(); return object(a.p(), cpu) === object(a.p(), cpu) ? 1 : 0; });
  def("NewLocalRef", (cpu, a) => { a.p(); return toRef(object(a.p(), cpu), cpu); });
  def("EnsureLocalCapacity", () => 0);
  def("AllocObject", (cpu, a) => { a.p(); const c = classOf(a.p(), cpu); return c ? initialized(cpu, c, function* () { return toRef(java.jni.allocate(c), cpu); }) : 0; });
  const newObject = (read: (m: MethodRec, a: ArgReader, cpu: Cpu) => unknown[]) => (cpu: Cpu, a: ArgReader) => {
    a.p(); const c = classOf(a.p(), cpu); const m = methodOf(a.p());
    if (!c || !m) return 0;
    const args = read(m, a, cpu);
    return initialized(cpu, c, function* () { return toRef(yield java.jni.construct(c, m.desc, args), cpu); });
  };
  for (const [form, read] of Object.entries(FORMS)) def(`NewObject${form}`, newObject(read));
  def("GetObjectClass", (cpu, a) => { a.p(); const o = object(a.p(), cpu); return o === null ? 0 : toRef(java.jni.objectClass(o), cpu); });
  def("IsInstanceOf", (cpu, a) => { a.p(); const o = object(a.p(), cpu); const c = classOf(a.p(), cpu); return o === null ? 1 : c ? +java.jni.isInstance(o, c) : 0; });
  const getMethodID = (isStatic: boolean) => (cpu: Cpu, a: ArgReader) => {
    a.p(); const c = classOf(a.p(), cpu); const name = a.str(), sig = a.str();
    if (!c) { pend(cpu, java.jni.throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    return initialized(cpu, c, function* () {
      if (java.jni.hasMethod(c, name, sig, isStatic)) return methodId(c, name, sig, isStatic);
      pend(cpu, java.jni.throwable("java/lang/NoSuchMethodError", `${c.name}.${name}${sig}`)); jniMissing.add(`${isStatic ? "static " : ""}${c.name}.${name}${sig}`); return 0;
    });
  };
  def("GetMethodID", getMethodID(false));
  def("GetStaticMethodID", getMethodID(true));
  for (const kind of ["", "Nonvirtual", "Static"]) for (const P of PRIM) for (const [form, read] of Object.entries(FORMS)) {
    def(`Call${kind}${P}Method${form}`, (cpu, a) => {
      a.p();
      const self = kind === "Static" ? null : object(a.p(), cpu);
      if (kind) a.p(); // jclass
      const m = methodOf(a.p());
      if (!m) { pend(cpu, java.jni.throwable("java/lang/NoSuchMethodError", "bad methodID")); return 0; }
      const args = read(m, a, cpu);
      if (jniTrace.on) console.log("[jni] ←", m.cls.name, m.name, m.desc, args.map((v) => typeof v === "string" ? JSON.stringify(v.slice(0, 200)) : Array.isArray(v) ? `[${v.length}]` : v !== null && typeof v === "object" ? "<reference>" : String(v)).join(" "));
      return invoke(cpu, m, self, args, kind === "Nonvirtual");
    });
  }
  const getFieldID = (isStatic: boolean) => (cpu: Cpu, a: ArgReader) => {
    a.p(); const c = classOf(a.p(), cpu); const name = a.str(), sig = a.str();
    if (!c) { pend(cpu, java.jni.throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    return initialized(cpu, c, function* () {
      const f = java.jni.field(c, name, sig, isStatic);
      if (f) return fieldId(f);
      pend(cpu, java.jni.throwable("java/lang/NoSuchFieldError", `${c.name}.${name}`)); jniMissing.add(`${isStatic ? "static field" : "field"} ${c.name}.${name}`); return 0;
    });
  };
  def("GetFieldID", getFieldID(false));
  def("GetStaticFieldID", getFieldID(true));
  FIELD_TYPES.forEach((P, k) => {
    const c = codec(PRIM_DESC[k]);
    def(`Get${P}Field`, (cpu, a) => { a.p(); const o = object(a.p(), cpu); const f = fieldOf(a.p()); return c.ret(o !== null && f ? java.jni.get(f, o) : c.zero, cpu); });
    def(`Set${P}Field`, (cpu, a) => { a.p(); const o = object(a.p(), cpu); const f = fieldOf(a.p()); const v = c.read(a, cpu, false); if (o !== null && f) java.jni.set(f, o, v); });
    def(`GetStatic${P}Field`, (cpu, a) => { a.p(); a.p(); const f = fieldOf(a.p()); return c.ret(f ? java.jni.get(f, null) : c.zero, cpu); });
    def(`SetStatic${P}Field`, (cpu, a) => { a.p(); a.p(); const f = fieldOf(a.p()); const v = c.read(a, cpu, false); if (f) java.jni.set(f, null, v); });
  });
  // strings
  def("NewString", (cpu, a) => { a.p(); const p = a.p(), n = Math.max(0, a.i()), b = mem.bytes(p, 2 * n); return toRef(java.jni.string(charsToString(p & 1 ? new Uint16Array(b.slice().buffer) : new Uint16Array(b.buffer, b.byteOffset, n), 0, n)), cpu); });
  def("GetStringLength", (cpu, a) => { a.p(); return text(a.p(), cpu).length; });
  const getChars: HostFn = (cpu, a) => { a.p(); const s = text(a.p(), cpu); const isCopy = a.p(); const p = mem.malloc(s.length * 2 + 2); putUnits(p, s, 0, s.length); mem.st16(p + s.length * 2, 0); if (isCopy) mem.st8(isCopy, 1); return p; };
  const releaseChars: HostFn = (_c, a) => { a.p(); a.p(); mem.free(a.p()); };
  def("GetStringChars", getChars); def("GetStringCritical", getChars);
  def("ReleaseStringChars", releaseChars); def("ReleaseStringCritical", releaseChars);
  def("NewStringUTF", (cpu, a) => {
    a.p(); const p = a.p();
    if (!p) return 0;
    mem.ld8u(p); // faults on a bad pointer as reading it would
    const end = mem.u8.indexOf(0, p);
    return toRef(java.jni.string(decodeModifiedUtf8(mem.u8, p, end < 0 ? mem.u8.length : end)), cpu);
  });
  def("GetStringUTFLength", (cpu, a) => { a.p(); return encodeModifiedUtf8(text(a.p(), cpu)).length; });
  def("GetStringUTFChars", (cpu, a) => { a.p(); const s = text(a.p(), cpu); const isCopy = a.p(); const p = putUtf8(encodeModifiedUtf8(s)); if (isCopy) mem.st8(isCopy, 1); return p; });
  def("ReleaseStringUTFChars", (_c, a) => { a.p(); a.p(); mem.free(a.p()); });
  def("GetStringRegion", (cpu, a) => { a.p(); const s = text(a.p(), cpu); const st = a.i(), n = a.i(); putUnits(a.p(), s, st, n); });
  def("GetStringUTFRegion", (cpu, a) => { a.p(); const s = text(a.p(), cpu); const st = a.i(), n = a.i(), buf = a.p(); putUtf8(encodeModifiedUtf8(s.slice(st, st + n)), buf); });
  // arrays
  def("GetArrayLength", (cpu, a) => { a.p(); const arr = object(a.p(), cpu); return arr === null ? 0 : java.jni.length(arr); });
  def("NewObjectArray", (cpu, a) => { a.p(); const n = a.i(); const c = classOf(a.p(), cpu); const init = object(a.p(), cpu); return toRef(java.jni.newObjectArray(n, c, init), cpu); });
  def("GetObjectArrayElement", (cpu, a) => { a.p(); const arr = object(a.p(), cpu); const i = a.i(); if (arr === null || i < 0 || i >= java.jni.length(arr)) { pend(cpu, java.jni.throwable("java/lang/ArrayIndexOutOfBoundsException", String(i))); return 0; } return toRef(java.jni.element(arr, i), cpu); });
  def("SetObjectArrayElement", (cpu, a) => { a.p(); const arr = object(a.p(), cpu); const i = a.i(); const v = object(a.p(), cpu); if (arr === null || i < 0 || i >= java.jni.length(arr)) { pend(cpu, java.jni.throwable("java/lang/ArrayIndexOutOfBoundsException", String(i))); return; } java.jni.setElement(arr, i, v); });
  const releaseElements: HostFn = (_c, a) => {
    a.p(); a.p(); const p = a.p(), mode = a.i();
    const held = pinned.get(p);
    if (!held) return;
    if (mode !== 2) java.jni.fromGuest(held.arr, held.type, 0, java.jni.length(held.arr), p);
    if (mode !== 1) { unpin(p, held.arr); mem.free(p); }
  };
  ARRAY_TYPES.forEach((P, k) => {
    const D = PRIM_DESC[k + 1];
    def(`New${P}Array`, (cpu, a) => { a.p(); return toRef(java.jni.newPrimitiveArray(D, a.i()), cpu); });
    def(`Get${P}ArrayElements`, (cpu, a) => { a.p(); const arr = object(a.p(), cpu); const isCopy = a.p(); return arr !== null ? pin(arr, D, isCopy) : 0; });
    def(`Release${P}ArrayElements`, releaseElements);
    for (const [kind, copy] of [["Get", java.jni.toGuest], ["Set", java.jni.fromGuest]] as const) def(`${kind}${P}ArrayRegion`, (cpu, a) => {
      a.p(); const arr = object(a.p(), cpu); const st = a.i(), n = a.i(), buf = a.p();
      if (arr === null || st < 0 || st + n > java.jni.length(arr)) { pend(cpu, java.jni.throwable("java/lang/ArrayIndexOutOfBoundsException", `${st}+${n}`)); return; }
      copy(arr, D, st, n, buf);
    });
  });
  def("GetPrimitiveArrayCritical", (cpu, a) => { a.p(); const arr = object(a.p(), cpu); const isCopy = a.p(); return arr !== null ? pin(arr, java.jni.elementType(arr), isCopy) : 0; });
  def("ReleasePrimitiveArrayCritical", releaseElements);
  def("RegisterNatives", (cpu, a) => {
    a.p(); const c = classOf(a.p(), cpu); const tab = a.p(), n = a.i();
    if (!c) return -1;
    for (let k = 0; k < n; k++) {
      // JNINativeMethod is three pointers: 12 bytes on ILP32, 24 on LP64
      const rec = tab + k * PTR * 3;
      const name = mem.cstr(ldp(rec)), sig = mem.cstr(ldp(rec + PTR)), fn = ldp(rec + PTR * 2);
      registerNative(c, name, sig, fn);
    }
    return 0;
  });
  def("UnregisterNatives", () => 0);
  for (const [name, enter] of [["MonitorEnter", true], ["MonitorExit", false]] satisfies [string, boolean][]) {
    def(name, (cpu, a) => {
      a.p(); const obj = object(a.p(), cpu);
      try {
        if (typeof obj !== "object" && typeof obj !== "string") throw java.jni.throwable("java/lang/NullPointerException", "JNI monitor reference");
        const pending = java.jni.monitor(obj, enter);
        return pending ? pending.then(() => 0, (e) => { failed(cpu, e); return -1; }) : 0;
      } catch (e) { failed(cpu, e); return -1; }
    });
  }
  def("GetJavaVM", (_c, a) => { a.p(); stp(a.p(), javaVM.addr); return 0; });
  def("NewWeakGlobalRef", (cpu, a) => { a.p(); return newWeakRef(object(a.p(), cpu)); });
  def("DeleteWeakGlobalRef", (_c, a) => { a.p(); const h = a.p(); if (h & WEAK_BIT) { weaks[h & ~WEAK_BIT] = null; freeWeaks.push(h & ~WEAK_BIT); } });
  def("ExceptionCheck", (cpu) => (cpu.exc ? 1 : 0));
  def("NewDirectByteBuffer", (cpu, a) => {
    a.p(); const address = a.p(), cap = a.l();
    if (cap < 0n || cap > 0x7fffffffn) return 0;
    try {
      const b = java.jni.newBuffer(mem.va(address), Number(cap));
      return b instanceof Promise ? b.then((v) => toRef(v, cpu), (e) => { failed(cpu, e); return 0; }) : toRef(b, cpu);
    } catch (e) { failed(cpu, e); return 0; }
  });
  def("GetDirectBufferAddress", (cpu, a) => {
    a.p(); const address = java.jni.bufferAddress(object(a.p(), cpu));
    if (address === null) return 0;
    try {
      const native = isExternal(address) ? guestAddress(address) : address <= 0xffffffffn ? Number(address) : address;
      return native instanceof Promise ? native.catch((e) => { failed(cpu, e); return 0; }) : native;
    } catch (e) { failed(cpu, e); return 0; }
  });
  def("GetDirectBufferCapacity", (cpu, a) => {
    a.p(); const b = object(a.p(), cpu), address = java.jni.bufferAddress(b);
    return address ? BigInt(java.jni.bufferCapacity(b)) : -1n;
  });
  def("GetObjectRefType", (_c, a) => { a.p(); const h = a.p(); return h === 0 ? 0 : h & GLOBAL_BIT ? 2 : h & WEAK_BIT ? 3 : 1; });

  envTable = mem.hostAlloc(JNI_ORDER.length * PTR);
  JNI_ORDER.forEach((name, i) => {
    const missing: HostFn = () => { if (!jniMissing.has(name)) { jniMissing.add(name); console.warn("[jni missing]", name); } return 0; };
    stp(envTable + i * PTR, defineHost("JNI:" + name, T[i] ?? missing));
  });
  const vmTable = mem.hostAlloc(8 * PTR);
  const attach: HostFn = (cpu, a) => { a.p(); stp(a.p(), envFor(cpu)); return 0; };
  const vmFns: [number, string, HostFn][] = [
    [3, "DestroyJavaVM", () => 0],
    [4, "AttachCurrentThread", attach],
    [5, "DetachCurrentThread", () => 0],
    [6, "GetEnv", attach],
    [7, "AttachCurrentThreadAsDaemon", attach],
  ];
  for (const [i, name, fn] of vmFns) stp(vmTable + i * PTR, defineHost("JavaVM:" + name, fn));
  javaVM.addr = mem.hostAlloc(8);
  stp(javaVM.addr, vmTable);
}

function registerNative(c: JniClass, name: string, sig: string, fn: number): void {
  const { isStatic, critical } = java.jni.nativeKind(c, name, sig), { params, ret } = parseMethodDesc(sig);
  const rec: Registered = { c, cls: c.name, name, sig, fn, isStatic, critical, args: params.map(codec), out: codec(ret), label: c.name.split("/").pop() + "." + name };
  registered.push(rec);
  java.jni.bind(c, name, sig, isStatic, native(rec), params.length);
}
/** the host function a native method with guest code runs: its arguments and result are the Wasm tier's Java values, unconverted */
const native = (rec: Registered): ((...a: never[]) => unknown) =>
  javaValues(function (this: unknown, ...args: unknown[]) { return rt.drive(callGuestNative(cpuFor(curThread), rec, this, args)); }) as never;

/** natives with no RegisterNatives entry resolve by the JNI short-name export `Java_pkg_Cls_method` */
export function resolveByExport(lookup: (sym: string) => number | undefined): void {
  rt.jniResolver = (cls: string, sig: string) => {
    const [name, desc] = splitSig(sig);
    const mangle = (s: string) => s.replace(/_/g, "_1").replace(/;/g, "_2").replace(/\[/g, "_3").replace(/\//g, "_").replace(/[^A-Za-z0-9_]/g, (c) => "_0" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    const short = "Java_" + mangle(java.jni.binaryName(cls)) + "_" + mangle(name);
    const fn = lookup(short) ?? lookup(short + "__" + mangle(java.jni.binaryName(desc.slice(1, desc.indexOf(")")))));
    if (fn === undefined) return null;
    const c = java.jni.find(cls);
    if (!c) return null;
    registerNative(c, name, desc, fn);
    return rt.jni.get(cls + "|" + sig) ?? null;
  };
}
