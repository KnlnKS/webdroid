// JavaVM + JNIEnv function tables in guest memory, the object-handle tables, and the marshalling
// between guest natives (AAPCS words) and the JVM's value model.

import { mem } from "./mem";
import { defineHost, type HostFn, type Args, VaList, fbits, bitsf, dbits, bitsd, retPair } from "./host";
import { Cpu, cpuFor } from "./cpu";
import { rt, JObj, type ClassInfo } from "../jvm/runtime";
import { mangleMethod, mangleStaticField, parseMethodDesc, jarray } from "../jvm/abi";
import { curThread, JClass, stackTraceText } from "../jvm/natives/jlang";

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
export function toRef(o: unknown, cpu: Cpu | null = cur): number {
  if (o === null || o === undefined) return 0;
  const l = locals(cpu!);
  l.refs.push(o);
  return l.refs.length - 1;
}
export function newGlobalRef(o: unknown): number {
  if (o === null || o === undefined) return 0;
  const i = freeGlobals.pop();
  if (i !== undefined) { globals[i] = o; return GLOBAL_BIT | i; }
  globals.push(o);
  return GLOBAL_BIT | (globals.length - 1);
}
export function deref(h: number): unknown {
  if (h === 0) return null;
  if (h & GLOBAL_BIT) return globals[h & ~GLOBAL_BIT] ?? null;
  return locals(cur!).refs[h] ?? null;
}
export function pushFrame(cpu: Cpu): void { const l = locals(cpu); l.frames.push(l.refs.length); }
export function popFrame(cpu: Cpu): void { const l = locals(cpu); const m = l.frames.pop(); if (m !== undefined) l.refs.length = m; }

interface MethodRec { info: ClassInfo; name: string; desc: string; mangled: string; isStatic: boolean; params: string[]; ret: string }
interface FieldRec { prop: string; type: string; isStatic: boolean; owner: any }
const methods: MethodRec[] = [null as unknown as MethodRec];
const fields: FieldRec[] = [null as unknown as FieldRec];

export interface Registered { cls: string; name: string; sig: string; fn: number; isStatic: boolean }
export const registered: Registered[] = [];

const clsName = (o: unknown): string => {
  if (typeof o === "string") return "java/lang/String";
  if (o instanceof JClass) return "java/lang/Class";
  if (Array.isArray(o)) return "[" + ((o as any).$t ?? "Ljava/lang/Object;");
  if (o instanceof Int8Array) return "[B"; if (o instanceof Uint8Array) return "[Z"; if (o instanceof Uint16Array) return "[C"; if (o instanceof Int16Array) return "[S";
  if (o instanceof Int32Array) return "[I"; if (o instanceof BigInt64Array) return "[J"; if (o instanceof Float32Array) return "[F"; if (o instanceof Float64Array) return "[D";
  return ((o as any)?.constructor?.$i as ClassInfo | undefined)?.name ?? "java/lang/Object";
};
function infoOf(clsRef: number): ClassInfo | null {
  const c = deref(clsRef);
  if (c instanceof JClass) return c.ci ?? (c.arrDesc ? rt.link(c.arrDesc) : null);
  return null;
}
function pend(cpu: Cpu, e: unknown): void {
  cpu.exc = e;
  if (jniTrace.on) console.warn("[jni] pending exception", e);
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
function retWord(ret: string, v: unknown, cpu: Cpu): number | bigint {
  switch (ret[0]) {
    case "V": return 0;
    case "Z": return v ? 1 : 0;
    case "J": return v as bigint;
    case "F": return fbits(v as number);
    case "D": return dbits(v as number);
    case "L": case "[": return toRef(v, cpu);
    default: return (v as number) | 0;
  }
}

async function invoke(cpu: Cpu, m: MethodRec, self: unknown, args: unknown[], nonvirtual: boolean): Promise<number | bigint> {
  try {
    let fn: any;
    if (m.isStatic) {
      const p = rt.initClass(m.info); if (p) await p;
      fn = m.info.ctor[m.mangled];
      if (typeof fn !== "function") throw throwable("java/lang/NoSuchMethodError", m.name + m.desc);
      const r = fn.apply(m.info.ctor, args);
      return retWord(m.ret, r instanceof Promise ? await r : r, cpu);
    }
    if (self === null || self === undefined) throw throwable("java/lang/NullPointerException", "JNI call on null " + m.name);
    fn = nonvirtual ? m.info.ctor.prototype[m.mangled] : (self as any)[m.mangled];
    if (typeof fn !== "function") throw throwable("java/lang/NoSuchMethodError", m.name + m.desc);
    const r = fn.apply(self, args);
    return retWord(m.ret, r instanceof Promise ? await r : r, cpu);
  } catch (e) {
    pend(cpu, rt.jx(e));
    return m.ret === "J" || m.ret === "D" ? 0n : 0;
  }
}

/** a Java native method whose body is guest code: marshal, run on the caller's Cpu, convert the result */
export async function callGuestNative(cpu: Cpu, r: Registered, self: unknown, args: unknown[]): Promise<unknown> {
  const { params, ret } = parseMethodDesc(r.sig);
  const prevCur = cur;
  cur = cpu;
  pushFrame(cpu);
  const list: (number | bigint)[] = [envFor(cpu), toRef(r.isStatic ? rt.classFor(r.cls) : self)];
  for (let i = 0; i < params.length; i++) {
    const t = params[i], v = args[i];
    switch (t[0]) {
      case "J": list.push(v as bigint); break;
      case "F": list.push(fbits(v as number)); break;
      case "D": list.push(dbits(v as number)); break;
      case "L": case "[": list.push(toRef(v)); break;
      default: list.push((v as number) | 0);
    }
  }
  if (jniTrace.on) console.log("[jni] →", r.cls, r.name, r.sig);
  let r0: number, r1: number;
  try {
    r0 = await cpu.call(r.fn, list);
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
    case "F": out = bitsf(r0); break;
    case "D": out = bitsd(retPair(r0, r1)); break;
    default: out = deref(r0);
  }
  popFrame(cpu);
  cur = prevCur;
  const exc = cpu.exc;
  if (exc) { cpu.exc = null; throw exc; }
  return out;
}

let envTable = 0;
const envs = new WeakMap<Cpu, number>();
export function envFor(cpu: Cpu): number {
  let e = envs.get(cpu);
  if (!e) { e = mem.hostAlloc(4); mem.st32(e, envTable); envs.set(cpu, e); cpu.env = e; }
  return e;
}

const PRIM = ["Object", "Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double", "Void"];
const PRIM_DESC = ["L", "Z", "B", "C", "S", "I", "J", "F", "D", "V"];
const arrayCtor: Record<string, (n: number) => unknown> = {
  Z: (n) => new Uint8Array(n), B: (n) => new Int8Array(n), C: (n) => new Uint16Array(n), S: (n) => new Int16Array(n),
  I: (n) => new Int32Array(n), J: (n) => new BigInt64Array(n), F: (n) => new Float32Array(n), D: (n) => new Float64Array(n),
};
const elemSize: Record<string, number> = { Z: 1, B: 1, C: 2, S: 2, I: 4, J: 8, F: 4, D: 8 };
const pinned = new Map<number, { arr: any; type: string }>();
function copyOut(type: string, arr: any, p: number, start: number, len: number): void {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset + start * elemSize[type], len * elemSize[type]);
  mem.u8.set(bytes, p);
}
function copyIn(type: string, arr: any, p: number, start: number, len: number): void {
  const dst = new Uint8Array(arr.buffer, arr.byteOffset + start * elemSize[type], len * elemSize[type]);
  dst.set(mem.u8.subarray(p, p + len * elemSize[type]));
}

export function jniInit(): void {
  const T: (HostFn | null)[] = new Array(233).fill(null);
  const names: string[] = new Array(233).fill("?");
  const def = (i: number, name: string, fn: HostFn) => { T[i] = fn; names[i] = name; };
  const utf8Len = (s: string) => new TextEncoder().encode(s).length;

  def(4, "GetVersion", () => 0x00010006);
  def(6, "FindClass", (cpu, a) => {
    a.p(); const name = a.str();
    const n = name.replace(/\./g, "/");
    const info = rt.link(n[0] === "[" ? n : n);
    if (info.stub) { pend(cpu, rt.ncdfe(n)); return 0; }
    return toRef(rt.classFor(n));
  });
  def(10, "GetSuperclass", (_c, a) => { a.p(); const i = infoOf(a.p()); return i?.superInfo ? toRef(rt.classFor(i.superInfo.name)) : 0; });
  def(11, "IsAssignableFrom", (_c, a) => { a.p(); const s = infoOf(a.p()), t = infoOf(a.p()); return s && t && s.types.has(t.name) ? 1 : 0; });
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
  def(27, "AllocObject", async (cpu, a) => { a.p(); const i = infoOf(a.p()); if (!i) return 0; const p = rt.initClass(i); if (p) await p; return toRef(new i.ctor(), cpu); });
  const newObject = (read: (m: MethodRec, a: Args) => unknown[]) => async (cpu: Cpu, a: Args) => {
    a.p(); const i = infoOf(a.p()); const m = methods[a.i()];
    if (!i || !m) return 0;
    try {
      const p = rt.initClass(i); if (p) await p;
      const args = read(m, a);
      const o = new i.ctor();
      const fn = o[m.mangled];
      if (typeof fn !== "function") throw throwable("java/lang/NoSuchMethodError", "<init>" + m.desc);
      const r = fn.apply(o, args);
      if (r instanceof Promise) await r;
      return toRef(o, cpu);
    } catch (e) { pend(cpu, rt.jx(e)); return 0; }
  };
  def(28, "NewObject", newObject((m, a) => readArgs(m.params, a)));
  def(29, "NewObjectV", newObject((m, a) => readArgs(m.params, new VaList(a.p()))));
  def(30, "NewObjectA", newObject((m, a) => readJvalues(m.params, a.p())));
  def(31, "GetObjectClass", (_c, a) => { a.p(); const o = deref(a.p()); return o === null ? 0 : toRef(rt.classFor(clsName(o))); });
  def(32, "IsInstanceOf", (_c, a) => { a.p(); const o = deref(a.p()); const i = infoOf(a.p()); return o === null ? 1 : i ? rt.iof(o, i.name) : 0; });
  const getMethodID = (isStatic: boolean) => async (cpu: Cpu, a: Args) => {
    a.p(); const i = infoOf(a.p()); const name = a.str(), sig = a.str();
    if (!i) { pend(cpu, throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    const p = rt.initClass(i); if (p) await p;
    const mangled = mangleMethod(name, sig);
    const have = isStatic ? typeof i.ctor[mangled] === "function" : typeof i.ctor.prototype?.[mangled] === "function" || (i.name === "java/lang/String" && typeof (String.prototype as any)[mangled] === "function");
    if (!have) { pend(cpu, throwable("java/lang/NoSuchMethodError", `${i.name}.${name}${sig}`)); jniMissing.add(`${isStatic ? "static " : ""}${i.name}.${name}${sig}`); return 0; }
    const { params, ret } = parseMethodDesc(sig);
    methods.push({ info: i, name, desc: sig, mangled, isStatic, params, ret });
    return methods.length - 1;
  };
  def(33, "GetMethodID", getMethodID(false));
  def(113, "GetStaticMethodID", getMethodID(true));
  // Call<Type>Method / V / A, Nonvirtual, Static
  for (let k = 0; k < 10; k++) {
    const P = PRIM[k];
    const mk = (base: number, kind: "virtual" | "nonvirtual" | "static") => {
      const readers: ((m: MethodRec, a: Args) => unknown[])[] = [
        (m, a) => readArgs(m.params, a), (m, a) => readArgs(m.params, new VaList(a.p())), (m, a) => readJvalues(m.params, a.p()),
      ];
      const suffix = ["", "V", "A"];
      for (let v = 0; v < 3; v++) {
        const read = readers[v];
        def(base + v, `Call${kind === "static" ? "Static" : kind === "nonvirtual" ? "Nonvirtual" : ""}${P}Method${suffix[v]}`, (cpu, a) => {
          a.p();
          const self = kind === "static" ? null : deref(a.p());
          if (kind !== "virtual") a.p(); // jclass
          const m = methods[a.i()];
          if (!m) { pend(cpu, throwable("java/lang/NoSuchMethodError", "bad methodID")); return 0; }
          const args = read(m, a);
          if (jniTrace.on) console.log("[jni] ←", m.info.name, m.name, m.desc);
          return invoke(cpu, m, self, args, kind === "nonvirtual");
        });
      }
    };
    mk(34 + k * 3, "virtual");
    mk(64 + k * 3, "nonvirtual");
    mk(114 + k * 3, "static");
  }
  const getFieldID = (isStatic: boolean) => async (cpu: Cpu, a: Args) => {
    a.p(); const i = infoOf(a.p()); const name = a.str(), sig = a.str();
    if (!i) { pend(cpu, throwable("java/lang/NoClassDefFoundError", "null class")); return 0; }
    const p = rt.initClass(i); if (p) await p;
    if (isStatic) {
      const prop = mangleStaticField(name);
      let owner: ClassInfo | null = i;
      while (owner && !Object.prototype.hasOwnProperty.call(owner.ctor, prop)) owner = owner.superInfo;
      if (!owner) { pend(cpu, throwable("java/lang/NoSuchFieldError", `${i.name}.${name}`)); jniMissing.add(`static field ${i.name}.${name}`); return 0; }
      fields.push({ prop, type: sig, isStatic: true, owner: owner.ctor });
      return fields.length - 1;
    }
    let info: ClassInfo | null = i, prop: string | undefined;
    while (info && !(prop = info.fieldTable.get(name))) info = info.superInfo;
    if (!prop) { pend(cpu, throwable("java/lang/NoSuchFieldError", `${i.name}.${name}`)); jniMissing.add(`field ${i.name}.${name}`); return 0; }
    fields.push({ prop, type: sig, isStatic: false, owner: null });
    return fields.length - 1;
  };
  def(94, "GetFieldID", getFieldID(false));
  def(144, "GetStaticFieldID", getFieldID(true));
  for (let k = 0; k < 9; k++) {
    const P = PRIM[k], D = PRIM_DESC[k];
    const fromJava = (v: unknown, cpu: Cpu): number | bigint => retWord(D, v, cpu);
    const toJava = (a: Args): unknown => D === "J" ? a.l() : D === "F" ? a.f() : D === "D" ? a.d() : D === "L" ? deref(a.p()) : D === "Z" ? (a.i() ? 1 : 0) : a.i();
    def(95 + k, `Get${P}Field`, (cpu, a) => { a.p(); const o = deref(a.p()) as any; const f = fields[a.i()]; return o && f ? fromJava(o[f.prop], cpu) : D === "J" ? 0n : 0; });
    def(104 + k, `Set${P}Field`, (_c, a) => { a.p(); const o = deref(a.p()) as any; const f = fields[a.i()]; const v = toJava(a); if (o && f) o[f.prop] = v; });
    def(145 + k, `GetStatic${P}Field`, (cpu, a) => { a.p(); a.p(); const f = fields[a.i()]; return f ? fromJava(f.owner[f.prop], cpu) : D === "J" ? 0n : 0; });
    def(154 + k, `SetStatic${P}Field`, (_c, a) => { a.p(); a.p(); const f = fields[a.i()]; const v = toJava(a); if (f) f.owner[f.prop] = v; });
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
    def(174 + k, `New${P}Array`, (_c, a) => { a.p(); return toRef(arrayCtor[D](a.i())); });
    def(182 + k, `Get${P}ArrayElements`, (_c, a) => {
      a.p(); const arr = deref(a.p()) as any; const isCopy = a.p();
      if (!arr) return 0;
      const p = mem.malloc(Math.max(1, arr.length * elemSize[D]));
      copyOut(D, arr, p, 0, arr.length);
      pinned.set(p, { arr, type: D });
      if (isCopy) mem.st8(isCopy, 1);
      return p;
    });
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
  def(222, "GetPrimitiveArrayCritical", (_c, a) => {
    a.p(); const arr = deref(a.p()) as any; const isCopy = a.p();
    if (!arr) return 0;
    const D = clsName(arr)[1];
    const p = mem.malloc(Math.max(1, arr.length * elemSize[D]));
    copyOut(D, arr, p, 0, arr.length);
    pinned.set(p, { arr, type: D });
    if (isCopy) mem.st8(isCopy, 1);
    return p;
  });
  def(223, "ReleasePrimitiveArrayCritical", T[191]!);
  def(215, "RegisterNatives", (cpu, a) => {
    a.p(); const i = infoOf(a.p()); const tab = a.p(), n = a.i();
    if (!i) return -1;
    for (let k = 0; k < n; k++) {
      const name = mem.cstr(mem.ld32(tab + k * 12)), sig = mem.cstr(mem.ld32(tab + k * 12 + 4)), fn = mem.ld32(tab + k * 12 + 8) >>> 0;
      registerNative(i, name, sig, fn);
    }
    void cpu;
    return 0;
  });
  def(216, "UnregisterNatives", () => 0);
  def(217, "MonitorEnter", () => 0);
  def(218, "MonitorExit", () => 0);
  def(219, "GetJavaVM", (_c, a) => { a.p(); mem.st32(a.p(), javaVM.addr); return 0; });
  def(226, "NewWeakGlobalRef", T[21]!);
  def(227, "DeleteWeakGlobalRef", T[22]!);
  def(228, "ExceptionCheck", (cpu) => (cpu.exc ? 1 : 0));
  def(229, "NewDirectByteBuffer", () => 0);
  def(230, "GetDirectBufferAddress", () => 0);
  def(231, "GetDirectBufferCapacity", () => -1);
  def(232, "GetObjectRefType", (_c, a) => { a.p(); const h = a.p(); return h === 0 ? 0 : h & GLOBAL_BIT ? 2 : 1; });

  envTable = mem.hostAlloc(233 * 4);
  for (let i = 0; i < 233; i++) {
    const fn = T[i];
    const name = fn ? names[i] : `JNI#${i}`;
    const wrapped: HostFn = fn
      ? (cpu, a) => { cur = cpu; return fn(cpu, a); }
      : (cpu) => { if (!jniMissing.has(name)) { jniMissing.add(name); console.warn("[jni missing]", name); } void cpu; return 0; };
    mem.st32(envTable + i * 4, defineHost("JNI:" + name, wrapped));
  }
  const vmTable = mem.hostAlloc(8 * 4);
  const vmFns: [number, string, HostFn][] = [
    [3, "DestroyJavaVM", () => 0],
    [4, "AttachCurrentThread", (cpu, a) => { a.p(); mem.st32(a.p(), envFor(cpu)); return 0; }],
    [5, "DetachCurrentThread", () => 0],
    [6, "GetEnv", (cpu, a) => { a.p(); mem.st32(a.p(), envFor(cpu)); return 0; }],
    [7, "AttachCurrentThreadAsDaemon", (cpu, a) => { a.p(); mem.st32(a.p(), envFor(cpu)); return 0; }],
  ];
  for (const [i, name, fn] of vmFns) mem.st32(vmTable + i * 4, defineHost("JavaVM:" + name, (cpu, a) => { cur = cpu; return fn(cpu, a); }));
  javaVM.addr = mem.hostAlloc(4);
  mem.st32(javaVM.addr, vmTable);
}

function registerNative(info: ClassInfo, name: string, sig: string, fn: number): void {
  // static or instance is not in the JNINativeMethod record: the dex knows
  let isStatic = false;
  const def = info.def, dex = info.dex;
  if (def && dex) {
    for (const m of def.directMethods) { const mr = dex.method(m.methodIdx); if (mr.name === name && dex.methodDesc(m.methodIdx) === sig) { isStatic = (m.flags & 0x8) !== 0; break; } }
  }
  const rec: Registered = { cls: info.name, name, sig, fn, isStatic };
  registered.push(rec);
  rt.registerJni(info.name, name + sig, function (this: unknown, ...args: unknown[]) {
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
  rt.jniResolver = (cls: string, sig: string) => {
    const name = sig.slice(0, sig.indexOf("(")), desc = sig.slice(sig.indexOf("("));
    const mangle = (s: string) => s.replace(/_/g, "_1").replace(/;/g, "_2").replace(/\[/g, "_3").replace(/\//g, "_").replace(/[^A-Za-z0-9_]/g, (c) => "_0" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    const short = "Java_" + mangle(cls) + "_" + mangle(name);
    const fn = lookup(short) ?? lookup(short + "__" + mangle(desc.slice(1, desc.indexOf(")"))));
    if (fn === undefined) return null;
    const info = rt.link(cls);
    registerNative(info, name, desc, fn);
    return rt.jni.get(cls + "|" + sig) ?? null;
  };
}
