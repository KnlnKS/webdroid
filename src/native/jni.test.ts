import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { DexFile } from "../jvm/dex";
import { loadDex } from "../jvm/tier";
import { JThread, mainThread, setCurThread, scall, newObj, vcall, staticField, classNameOf } from "../jvm/natives/jentry";
import { cpuFor, setA64, type Cpu, type CallArg } from "./cpu";
import { defineHost, retPair, PTR, ldp, cstr, type ArgReader } from "./host";
import { javaVM, jniInit, pinnedCount, resolveByExport } from "./jni";
import { mem } from "./mem";
import { handle, deref } from "../android/handles";

// The members and natives under test are tests/fixtures/JniProbe.java.
loadDex(new DexFile(new Uint8Array(await Bun.file(new URL("../../tests/fixtures/JniProbe.dex", import.meta.url)).arrayBuffer())));

const TYPES = ["Object", "Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double", "Void"];
/** slots of the JNIEnv function table (jni.h) */
const S = {
  FindClass: 6, GetSuperclass: 10, IsAssignableFrom: 11, Throw: 13, ThrowNew: 14, ExceptionOccurred: 15, ExceptionClear: 17, PushLocalFrame: 19, PopLocalFrame: 20,
  NewGlobalRef: 21, DeleteGlobalRef: 22, DeleteLocalRef: 23, IsSameObject: 24, NewLocalRef: 25, AllocObject: 27, NewObjectA: 30, GetObjectClass: 31, IsInstanceOf: 32,
  GetMethodID: 33, GetFieldID: 94, GetStaticMethodID: 113, GetStaticFieldID: 144,
  NewString: 163, GetStringLength: 164, GetStringChars: 165, ReleaseStringChars: 166, NewStringUTF: 167, GetStringUTFLength: 168, GetStringUTFChars: 169, ReleaseStringUTFChars: 170,
  GetArrayLength: 171, NewObjectArray: 172, GetObjectArrayElement: 173, SetObjectArrayElement: 174, FromReflectedMethod: 7, ToReflectedMethod: 9, RegisterNatives: 215, MonitorEnter: 217, MonitorExit: 218, GetStringRegion: 220, GetStringUTFRegion: 221,
  GetPrimitiveArrayCritical: 222, ReleasePrimitiveArrayCritical: 223, NewWeakGlobalRef: 226, DeleteWeakGlobalRef: 227, ExceptionCheck: 228,
  NewDirectByteBuffer: 229, GetDirectBufferAddress: 230, GetDirectBufferCapacity: 231, GetObjectRefType: 232,
};
/** Call<Type>Method (kind "", "Nonvirtual" or "Static"; form "", "V" or "A") */
const call = (kind: "" | "Nonvirtual" | "Static", type: string, form: "" | "V" | "A" = "") => ({ "": 34, Nonvirtual: 64, Static: 114 })[kind] + 3 * TYPES.indexOf(type) + ["", "V", "A"].indexOf(form);
/** Get<Type>Field and Set<Type>Field */
const field = (op: "Get" | "Set", type: string, isStatic = false) => ({ Get: 95, Set: 104 })[op] + TYPES.indexOf(type) + (isStatic ? 50 : 0);
/** New<Type>Array, Get<Type>ArrayElements, Release<Type>ArrayElements, Get<Type>ArrayRegion, Set<Type>ArrayRegion */
const array = (op: "New" | "Get" | "Release" | "GetRegion" | "SetRegion", type: string) => ({ New: 174, Get: 182, Release: 190, GetRegion: 198, SetRegion: 206 })[op] + TYPES.indexOf(type);

/** native code's view of a JNIEnv: a call of one of its functions on the Cpu, and the results it leaves in registers */
class Env {
  constructor(readonly cpu: Cpu, readonly env: number) {}
  call(slot: number, ...args: CallArg[]): Promise<number> { return this.cpu.call(ldp(ldp(this.env) + slot * PTR), [this.env, ...args]); }
  async long(slot: number, ...args: CallArg[]): Promise<bigint> { const r = await this.call(slot, ...args); return retPair(r, this.cpu.ret1); }
  async double(slot: number, ...args: CallArg[]): Promise<number> { await this.call(slot, ...args); return this.cpu.retD(); }
  async float(slot: number, ...args: CallArg[]): Promise<number> { await this.call(slot, ...args); return this.cpu.retF(); }
  cls = (name: string) => this.call(S.FindClass, cstr(name));
  staticMethod = (cls: number, name: string, sig: string) => this.call(S.GetStaticMethodID, cls, cstr(name), cstr(sig));
  method = (cls: number, name: string, sig: string) => this.call(S.GetMethodID, cls, cstr(name), cstr(sig));
  field = (cls: number, name: string, sig: string) => this.call(S.GetFieldID, cls, cstr(name), cstr(sig));
  staticField = (cls: number, name: string, sig: string) => this.call(S.GetStaticFieldID, cls, cstr(name), cstr(sig));
  string = (s: string) => this.call(S.NewStringUTF, cstr(s));
  /** a new JniProbe, its constructor run */
  async probe(): Promise<number> { const cls = await this.cls("JniProbe"); return this.call(S.NewObjectA, cls, await this.method(cls, "<init>", "()V"), 0); }
  async utf(ref: number): Promise<string> { const p = await this.call(S.GetStringUTFChars, ref, 0), s = mem.cstr(p); await this.call(S.ReleaseStringUTFChars, ref, p); return s; }
  /** jvalues for a call: eight bytes each */
  values(...v: (number | bigint | { f: number } | { d: number })[]): number {
    const p = mem.calloc(v.length + 1, 8);
    v.forEach((x, i) => { const at = p + 8 * i; if (typeof x === "bigint") mem.st64(at, x); else if (typeof x === "number") mem.st32(at, x); else if ("f" in x) mem.stf32(at, x.f); else mem.stf64(at, x.d); });
    return p;
  }
  /** the class name of the pending exception, or null; the exception stays pending */
  async pending(): Promise<string | null> {
    const e = await this.call(S.ExceptionOccurred);
    if (!e) return null;
    const getName = await this.method(await this.cls("java/lang/Class"), "getName", "()Ljava/lang/String;");
    return this.utf(await this.call(call("", "Object"), await this.call(S.GetObjectClass, e), getName));
  }
  async clear(): Promise<void> { await this.call(S.ExceptionClear); }
}

/** runs `body` with a JNIEnv on a thread of its own */
async function withEnv(a64: boolean, body: (env: Env) => Promise<void>): Promise<void> {
  setA64(a64); jniInit();
  const thread = new JThread(), cpu = cpuFor(thread), out = mem.malloc(PTR);
  try {
    await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, out, 0x10006]);
    await body(new Env(cpu, ldp(out)));
  } finally { mem.free(out); cpu.dispose(); setCurThread(mainThread); }
}
const abis = [false, true] as const;
const abi = (a64: boolean) => (a64 ? "A64" : "ARM32");
/** the class and message of the Java exception `f` throws */
const thrown = async (f: () => unknown): Promise<string | null> => {
  try { await f(); } catch (e) { return `${classNameOf(e)}: ${await vcall(e, "getMessage", "()Ljava/lang/String;")}`; }
  return null;
};

for (const a64 of abis) test(`${abi(a64)} FindClass, GetMethodID and the Call families run Java, virtually and not`, () => withEnv(a64, async (j) => {
  const probe = await j.cls("JniProbe"), child = await j.cls("JniProbe$Child");
  expect(probe).toBeGreaterThan(0);
  expect(await j.call(call("Static", "Int"), probe, await j.staticMethod(probe, "twice", "(I)I"), 21)).toBe(42);
  expect(await j.long(call("Static", "Long", "A"), probe, await j.staticMethod(probe, "widen", "(IJ)J"), j.values(5, 1n << 40n))).toBe((1n << 40n) + 5n);
  expect(await j.double(call("Static", "Double", "A"), probe, await j.staticMethod(probe, "mix", "(IJFD)D"), j.values(1, 2n, { f: 0.5 }, { d: 0.25 }))).toBe(3.75);
  expect(await j.call(call("Static", "Boolean"), probe, await j.staticMethod(probe, "flip", "(Z)Z"), 0)).toBe(1);
  const cat = await j.call(call("Static", "Object"), probe, await j.staticMethod(probe, "cat", "(Ljava/lang/String;I)Ljava/lang/String;"), await j.string("ab"), 3);
  expect(await j.utf(cat)).toBe("ab3");

  // a Child answers plus() as itself; a nonvirtual call runs the method of the class named
  const made = await j.call(call("Static", "Object"), probe, await j.staticMethod(probe, "child", "()LJniProbe;")), plus = await j.method(probe, "plus", "(I)I");
  expect(await j.call(call("", "Int"), made, plus, 4)).toBe(-4);
  expect(await j.call(call("Nonvirtual", "Int"), made, probe, plus, 4)).toBe(9);
  expect(await j.call(S.IsSameObject, await j.call(S.GetObjectClass, made), child)).toBe(1);
  expect(await j.call(S.IsInstanceOf, made, probe)).toBe(1);
  expect(await j.call(S.IsInstanceOf, made, await j.cls("java/lang/String"))).toBe(0);
  expect(await j.call(S.IsSameObject, await j.call(S.GetSuperclass, child), probe)).toBe(1);
  expect(await j.call(S.IsAssignableFrom, child, probe)).toBe(1);
  expect(await j.call(S.IsAssignableFrom, probe, child)).toBe(0);

  // a constructor with arguments, and an object no constructor has run on
  const ctor = await j.method(probe, "<init>", "(ILjava/lang/String;)V"), seven = await j.call(S.NewObjectA, probe, ctor, j.values(7, await j.string("seven")));
  expect(await j.call(call("", "Int"), seven, plus, 1)).toBe(8);
  expect(await j.call(call("", "Int"), await j.call(S.AllocObject, probe), plus, 1)).toBe(1);

  // a method and its java.lang.reflect.Method are the same method id
  for (const [id, isStatic] of [[plus, 0], [await j.staticMethod(probe, "cat", "(Ljava/lang/String;I)Ljava/lang/String;"), 1], [ctor, 0]] as const) {
    const reflected = await j.call(S.ToReflectedMethod, probe, id, isStatic);
    expect(reflected).not.toBe(0);
    expect(await j.call(S.FromReflectedMethod, reflected)).toBe(id);
  }

  // a method or a class that does not exist
  expect(await j.staticMethod(probe, "nope", "()V")).toBe(0);
  expect(await j.pending()).toBe("java.lang.NoSuchMethodError");
  await j.clear();
  expect(await j.cls("no/such/Klass")).toBe(0);
  expect(await j.pending()).toBe("java.lang.NoClassDefFoundError");
  await j.clear();
  expect(await j.call(S.ExceptionCheck)).toBe(0);
}));

for (const a64 of abis) test(`${abi(a64)} Get and Set<Type>Field reach instance and static fields of every type`, () => withEnv(a64, async (j) => {
  const probe = await j.cls("JniProbe"), o = await j.probe();
  expect(await j.long(field("Get", "Long"), o, await j.field(probe, "l", "J"))).toBe(6n << 33n);
  expect(await j.call(field("Get", "Int"), o, await j.field(probe, "i", "I"))).toBe(5);
  expect(await j.call(field("Get", "Byte"), o, await j.field(probe, "b", "B"))).toBe(-1);
  expect(await j.call(field("Get", "Short"), o, await j.field(probe, "s", "S"))).toBe(-2);
  expect(await j.call(field("Get", "Char"), o, await j.field(probe, "c", "C"))).toBe(0x63);
  expect(await j.float(field("Get", "Float"), o, await j.field(probe, "f", "F"))).toBe(0.25);
  expect(await j.double(field("Get", "Double"), o, await j.field(probe, "d", "D"))).toBe(9.5);
  expect(await j.utf(await j.call(field("Get", "Object"), o, await j.field(probe, "str", "Ljava/lang/String;")))).toBe("inst");

  // a write is seen by Java, and a read sees what Java wrote
  await j.call(field("Set", "Int"), o, await j.field(probe, "i", "I"), 99);
  await j.call(field("Set", "Boolean"), o, await j.field(probe, "z", "Z"), 1);
  await j.call(field("Set", "Float"), o, await j.field(probe, "f", "F"), { f: 2.5 });
  await j.call(field("Set", "Object"), o, await j.field(probe, "str", "Ljava/lang/String;"), await j.string("written"));
  expect(await j.call(call("", "Int"), o, await j.method(probe, "plus", "(I)I"), 1)).toBe(100);
  expect(await j.call(field("Get", "Boolean"), o, await j.field(probe, "z", "Z"))).toBe(1);
  expect(await j.float(field("Get", "Float"), o, await j.field(probe, "f", "F"))).toBe(2.5);
  expect(await j.utf(await j.call(field("Get", "Object"), o, await j.field(probe, "str", "Ljava/lang/String;")))).toBe("written");

  expect(await j.call(field("Get", "Int", true), probe, await j.staticField(probe, "sInt", "I"))).toBe(7);
  expect(await j.long(field("Get", "Long", true), probe, await j.staticField(probe, "sLong", "J"))).toBe(1n << 40n);
  expect(await j.float(field("Get", "Float", true), probe, await j.staticField(probe, "sFloat", "F"))).toBe(1.5);
  expect(await j.double(field("Get", "Double", true), probe, await j.staticField(probe, "sDouble", "D"))).toBe(2.5);
  expect(await j.call(field("Get", "Short", true), probe, await j.staticField(probe, "sShort", "S"))).toBe(300);
  await j.call(field("Set", "Int", true), probe, await j.staticField(probe, "sInt", "I"), 70);
  await j.call(field("Set", "Double", true), probe, await j.staticField(probe, "sDouble", "D"), { d: -0.5 });
  await j.call(field("Set", "Object", true), probe, await j.staticField(probe, "sObj", "Ljava/lang/Object;"), o);
  expect(await staticField<number>("JniProbe", "sInt")).toBe(70);
  expect(await staticField<number>("JniProbe", "sDouble")).toBe(-0.5);
  expect(await staticField("JniProbe", "sObj")).not.toBeNull();

  expect(await j.field(probe, "nope", "I")).toBe(0);
  expect(await j.pending()).toBe("java.lang.NoSuchFieldError");
  await j.clear();
  await j.call(field("Set", "Int", true), probe, await j.staticField(probe, "sInt", "I"), 7);
  await j.call(field("Set", "Double", true), probe, await j.staticField(probe, "sDouble", "D"), { d: 2.5 });
}));

for (const a64 of abis) test(`${abi(a64)} strings cross as Java strings: UTF-8 and UTF-16 copies, regions and lengths`, () => withEnv(a64, async (j) => {
  const text = "héllo ✓ 😀", s = await j.string(text);
  expect(await j.call(S.GetStringLength, s)).toBe(text.length);
  expect(await j.call(S.GetStringUTFLength, await j.string("h\u00e9llo \u2713"))).toBe(1 + 2 + 3 + 1 + 3);
  expect(await j.utf(s)).toBe(text);
  const chars = await j.call(S.GetStringChars, s, 0);
  expect(Array.from({ length: text.length }, (_, i) => String.fromCharCode(mem.ld16u(chars + 2 * i))).join("")).toBe(text);
  expect(mem.ld16u(chars + 2 * text.length)).toBe(0);
  await j.call(S.ReleaseStringChars, s, chars);
  const buf = mem.calloc(1, 64);
  await j.call(S.GetStringRegion, s, 1, 4, buf);
  expect(Array.from({ length: 4 }, (_, i) => String.fromCharCode(mem.ld16u(buf + 2 * i))).join("")).toBe("éllo");
  await j.call(S.GetStringUTFRegion, s, 1, 4, buf);
  expect(mem.cstr(buf)).toBe("éllo");
  const made = await j.call(S.NewString, 0, 0);
  expect(await j.call(S.GetStringLength, made)).toBe(0);
  // Java gets the string it is given, and a string Java makes comes back as one
  const probe = await j.cls("JniProbe");
  const cat = await j.call(call("Static", "Object"), probe, await j.staticMethod(probe, "cat", "(Ljava/lang/String;I)Ljava/lang/String;"), s, 1);
  expect(await j.utf(cat)).toBe(text + "1");
  expect(await j.call(S.IsSameObject, s, s)).toBe(1);
  mem.free(buf);
}));

for (const a64 of abis) test(`${abi(a64)} arrays are the Java arrays: regions, pinned copies and object arrays`, () => withEnv(a64, async (j) => {
  const probe = await j.cls("JniProbe"), fill = await j.staticMethod(probe, "fill", "([BI)V"), sum = await j.staticMethod(probe, "sum", "([I)I"), buf = mem.calloc(1, 64);
  const bytes = await j.call(array("New", "Byte"), 5);
  expect(await j.call(S.GetArrayLength, bytes)).toBe(5);
  mem.write(buf, [1, 2, 3, 4, 5]);
  await j.call(array("SetRegion", "Byte"), bytes, 1, 3, buf);
  mem.write(buf, new Uint8Array(8));
  await j.call(array("GetRegion", "Byte"), bytes, 0, 5, buf);
  expect([...mem.bytes(buf, 5)]).toEqual([0, 1, 2, 3, 0]);
  // Java writes the very array native code holds: a global reference sees it
  const held = await j.call(S.NewGlobalRef, bytes);
  await j.call(call("Static", "Void"), probe, fill, bytes, 9);
  await j.call(array("GetRegion", "Byte"), held, 0, 5, buf);
  expect([...mem.bytes(buf, 5)]).toEqual([9, 9, 9, 9, 9]);
  await j.call(array("GetRegion", "Byte"), bytes, 4, 3, buf);
  expect(await j.pending()).toBe("java.lang.ArrayIndexOutOfBoundsException");
  await j.clear();
  await j.call(S.DeleteGlobalRef, held);

  // the elements of an int[] as a copy: mode 0 writes it back and frees it, JNI_COMMIT writes it back and keeps it, JNI_ABORT frees it
  const ints = await j.call(array("New", "Int"), 3);
  mem.write(buf, new Uint8Array(new Int32Array([10, 20, 30]).buffer));
  await j.call(array("SetRegion", "Int"), ints, 0, 3, buf);
  const before = pinnedCount(), p = await j.call(array("Get", "Int"), ints, 0);
  expect(pinnedCount()).toBe(before + 1);
  expect(mem.ld32(p + 4)).toBe(20);
  mem.st32(p + 4, 25);
  // an array that crosses a call is synced around it: Java sees the copy as native code left it
  expect(await j.call(call("Static", "Int"), probe, sum, ints)).toBe(65);
  mem.st32(p, 11);
  await j.call(array("Release", "Int"), ints, p, 1);
  expect(pinnedCount()).toBe(before + 1);
  expect(await j.call(call("Static", "Int"), probe, sum, ints)).toBe(66);
  mem.st32(p, 1000);
  await j.call(array("Release", "Int"), ints, p, 2);
  expect(pinnedCount()).toBe(before);
  expect(await j.call(call("Static", "Int"), probe, sum, ints)).toBe(66);
  const q = await j.call(array("Get", "Int"), ints, 0);
  mem.st32(q + 8, 4);
  await j.call(array("Release", "Int"), ints, q, 0);
  expect(pinnedCount()).toBe(before);
  expect(await j.call(call("Static", "Int"), probe, sum, ints)).toBe(40);
  const critical = await j.call(S.GetPrimitiveArrayCritical, ints, 0);
  expect(mem.ld32(critical + 8)).toBe(4);
  await j.call(S.ReleasePrimitiveArrayCritical, ints, critical, 0);
  expect(pinnedCount()).toBe(before);

  // an array in a field is reached as any other object
  const viaField = await j.call(field("Get", "Object"), await j.probe(), await j.field(probe, "ints", "[I"));
  expect(await j.call(S.GetArrayLength, viaField)).toBe(3);
  await j.call(array("GetRegion", "Int"), viaField, 0, 3, buf);
  expect([...new Int32Array(mem.bytes(buf, 12).slice().buffer)]).toEqual([1, 2, 3]);

  // object arrays
  const strings = await j.call(S.NewObjectArray, 3, await j.cls("java/lang/String"), await j.string("init"));
  await j.call(S.SetObjectArrayElement, strings, 1, await j.string("middle"));
  expect(await j.call(S.GetArrayLength, strings)).toBe(3);
  expect(await j.utf(await j.call(S.GetObjectArrayElement, strings, 0))).toBe("init");
  expect(await j.utf(await j.call(S.GetObjectArrayElement, strings, 1))).toBe("middle");
  expect(await j.call(S.GetObjectArrayElement, strings, 3)).toBe(0);
  expect(await j.pending()).toBe("java.lang.ArrayIndexOutOfBoundsException");
  await j.clear();
  mem.free(buf);
}));

for (const a64 of abis) test(`${abi(a64)} exceptions are Java throwables: raised by native code, by Java, and kept pending`, () => withEnv(a64, async (j) => {
  const probe = await j.cls("JniProbe"), message = await j.method(await j.cls("java/lang/Throwable"), "getMessage", "()Ljava/lang/String;");
  await j.call(S.ThrowNew, await j.cls("java/lang/IllegalStateException"), cstr("boom"));
  expect(await j.call(S.ExceptionCheck)).toBe(1);
  expect(await j.pending()).toBe("java.lang.IllegalStateException");
  const e = await j.call(S.ExceptionOccurred);
  await j.clear();
  expect(await j.call(S.ExceptionCheck)).toBe(0);
  expect(await j.utf(await j.call(call("", "Object"), e, message))).toBe("boom");
  await j.call(S.Throw, e);
  expect(await j.call(S.IsSameObject, await j.call(S.ExceptionOccurred), e)).toBe(1);
  await j.clear();

  // an exception Java throws is pending when the call returns
  await j.call(call("Static", "Void"), probe, await j.staticMethod(probe, "fail", "(Ljava/lang/String;)V"), await j.string("from java"));
  expect(await j.pending()).toBe("java.lang.IllegalStateException");
  expect(await j.utf(await j.call(call("", "Object"), await j.call(S.ExceptionOccurred), message))).toBe("from java");
  await j.clear();
}));

for (const a64 of abis) test(`${abi(a64)} MonitorEnter and MonitorExit lock the object, and exit without enter is an error`, () => withEnv(a64, async (j) => {
  const o = await j.probe();
  expect(await j.call(S.MonitorEnter, o)).toBe(0);
  expect(await j.call(S.MonitorEnter, o)).toBe(0);
  expect(await j.call(S.MonitorExit, o)).toBe(0);
  expect(await j.call(S.MonitorExit, o)).toBe(0);
  expect(await j.call(S.ExceptionCheck)).toBe(0);
  expect(await j.call(S.MonitorExit, o)).not.toBe(0);
  expect(await j.pending()).toBe("java.lang.IllegalMonitorStateException");
  await j.clear();
}));

test("MonitorEnter of a lock another thread holds waits for its MonitorExit", async () => {
  setA64(true); jniInit();
  const first = new JThread(), second = new JThread(), cpus = [cpuFor(first), cpuFor(second)], out = mem.malloc(2 * PTR);
  try {
    const envs: Env[] = [];
    for (const [i, cpu] of cpus.entries()) {
      setCurThread(i ? second : first);
      await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, out + i * PTR, 0x10006]);
      envs.push(new Env(cpu, ldp(out + i * PTR)));
    }
    setCurThread(first);
    const o = await envs[0].call(S.NewGlobalRef, await envs[0].probe());
    expect(await envs[0].call(S.MonitorEnter, o)).toBe(0);
    setCurThread(second);
    let entered = false;
    const waiting = envs[1].call(S.MonitorEnter, o).then((r) => { entered = true; return r; });
    await new Promise((r) => setTimeout(r, 30));
    expect(entered).toBe(false);
    setCurThread(first);
    expect(await envs[0].call(S.MonitorExit, o)).toBe(0);
    expect(await waiting).toBe(0);
    setCurThread(second);
    expect(await envs[1].call(S.MonitorExit, o)).toBe(0);
  } finally { mem.free(out); cpus.forEach((cpu) => cpu.dispose()); setCurThread(mainThread); }
});

for (const a64 of abis) test(`${abi(a64)} references: local frames, global and weak global references`, () => withEnv(a64, async (j) => {
  const probe = await j.cls("JniProbe"), kind = (r: number) => j.call(S.GetObjectRefType, r);
  const made = await j.probe(), global = await j.call(S.NewGlobalRef, made), weak = await j.call(S.NewWeakGlobalRef, made);
  expect([await kind(made), await kind(global), await kind(weak), await kind(0)]).toEqual([1, 2, 3, 0]);
  expect(await j.call(S.IsSameObject, global, made)).toBe(1);
  expect(await j.call(S.IsSameObject, weak, made)).toBe(1);
  // a deleted local reference is the null reference, and the object lives on in the others
  await j.call(S.DeleteLocalRef, made);
  expect(await j.call(S.IsSameObject, made, 0)).toBe(1);
  expect(await j.call(S.IsSameObject, global, 0)).toBe(0);
  const again = await j.call(S.NewLocalRef, weak);
  expect(again).not.toBe(0);
  expect(await j.call(S.IsSameObject, again, global)).toBe(1);
  // a frame's references end with it, but its result is a reference of the caller's
  await j.call(S.PushLocalFrame, 8);
  const kept = await j.call(S.PopLocalFrame, await j.probe());
  expect(await kind(kept)).toBe(1);
  expect(await j.call(S.IsInstanceOf, kept, probe)).toBe(1);
  await j.call(S.DeleteWeakGlobalRef, weak);
  await j.call(S.DeleteGlobalRef, global);
  // a weak reference does not keep its object alive
  await j.call(S.PushLocalFrame, 8);
  const loose = await j.call(S.NewWeakGlobalRef, await j.probe());
  await j.call(S.PopLocalFrame, 0);
  expect(await j.call(S.NewWeakGlobalRef, 0)).toBe(0);
  let collected = false;
  for (let i = 0; i < 100 && !collected; i++) {
    await Bun.sleep(5);
    Bun.gc(true);
    collected = (await j.call(S.IsSameObject, loose, 0)) === 1;
  }
  expect(collected).toBe(true);
  expect(await j.call(S.NewLocalRef, loose)).toBe(0);
  await j.call(S.DeleteWeakGlobalRef, loose);
}));

for (const a64 of abis) test(`${abi(a64)} direct buffers share their bytes with native code`, () => withEnv(a64, async (j) => {
  const probe = await j.cls("JniProbe"), peek = await j.staticMethod(probe, "peek", "(Ljava/nio/ByteBuffer;I)I"), buffer = await j.cls("java/nio/ByteBuffer");
  const put = await j.method(buffer, "put", "(IB)Ljava/nio/ByteBuffer;");
  // a buffer over native memory
  const block = mem.calloc(1, 16);
  mem.st8(block + 3, 9);
  const over = await j.call(S.NewDirectByteBuffer, block, 16n);
  expect(await j.call(S.GetDirectBufferAddress, over)).toBe(block);
  expect(await j.long(S.GetDirectBufferCapacity, over)).toBe(16n);
  expect(await j.call(call("Static", "Int"), probe, peek, over, 3)).toBe(9);
  await j.call(call("", "Object"), over, put, 4, 33);
  expect(mem.ld8u(block + 4)).toBe(33);
  // a buffer Java allocated: the same bytes at the address native code is given
  const made = await j.call(call("Static", "Object"), probe, await j.staticMethod(probe, "direct", "(I)Ljava/nio/ByteBuffer;"), 32);
  const address = await j.call(S.GetDirectBufferAddress, made);
  expect(address).toBeGreaterThan(0);
  expect(await j.long(S.GetDirectBufferCapacity, made)).toBe(32n);
  mem.st8(address + 5, 77);
  expect(await j.call(call("Static", "Int"), probe, peek, made, 5)).toBe(77);
  await j.call(call("", "Object"), made, put, 6, 55);
  expect(mem.ld8u(address + 6)).toBe(55);
  mem.free(block);
}));

/** the natives of JniProbe as the guest functions its JNI short names resolve to */
function natives(fns: Record<string, (cpu: Cpu, a: ArgReader) => unknown>): void {
  const addresses = new Map(Object.entries(fns).map(([name, fn]) => [`Java_JniProbe_${name}`, defineHost(name, fn as never)]));
  resolveByExport((sym) => addresses.get(sym));
}

for (const a64 of abis) test(`${abi(a64)} critical natives omit JNI handles while fast natives retain them`, async () => {
  setA64(a64); jniInit();
  const thread = new JThread(), cpu = cpuFor(thread), previous = rt.jniResolver, seen: unknown[][] = [], suffix = a64 ? "64" : "32";
  try {
    // a critical native is called without an environment or a class: its first argument is the first of the method's
    const addresses = new Map<string, number>([
      [`Java_JniProbe_critical${suffix}`, defineHost("critical", (_cpu, a) => { seen.push(["critical", a.i(), a.l(), a.f(), a.d()]); return 0; })],
      [`Java_JniProbe_fast${suffix}`, defineHost("fast", (_cpu, a) => { expect(a.p()).toBeGreaterThan(0); expect(a.p()).toBeGreaterThan(0); seen.push(["fast", a.i(), a.l(), a.f(), a.d()]); return 0; })],
    ]);
    resolveByExport((sym) => addresses.get(sym));
    setCurThread(thread);
    await scall("JniProbe", "critical" + suffix, "(IJFD)D", 123, 40n, 1.25, 2.5);
    await scall("JniProbe", "fast" + suffix, "(IJFD)D", 123, 40n, 1.25, 2.5);
    expect(seen).toEqual([["critical", 123, 40n, 1.25, 2.5], ["fast", 123, 40n, 1.25, 2.5]]);
  } finally { rt.jniResolver = previous; cpu.dispose(); setCurThread(mainThread); }
});

test("natives take references and answer them: the objects themselves", async () => {
  const previous = rt.jniResolver, thread = new JThread();
  setA64(true); jniInit();
  try {
    const seen: number[][] = [];
    natives({
      inst: (_cpu, a) => { a.p(); a.p(); return a.i() * 2 + 1; },
      echo: (_cpu, a) => { a.p(); a.p(); return a.p(); },
      measure: (_cpu, a) => { a.p(); a.p(); seen.push([a.p(), a.p(), a.p()]); return seen[0].every((h, i) => h > 0 && seen[0].indexOf(h) === i) ? 1 : 0; },
    });
    setCurThread(thread);
    const o = await newObj("JniProbe");
    expect(await vcall(o, "inst", "(I)I", 4)).toBe(9);
    expect(await scall("JniProbe", "echo", "(Ljava/lang/Object;)Ljava/lang/Object;", o)).toBe(o);
    expect(await scall("JniProbe", "echo", "(Ljava/lang/Object;)Ljava/lang/Object;", null)).toBeNull();
    expect(await scall("JniProbe", "measure", "(Ljava/lang/String;[B[Ljava/lang/Object;)I", "h\u00e9llo", new Int8Array(7), jarray([null, null], "Ljava/lang/Object;"))).toBe(1);
  } finally { rt.jniResolver = previous; cpuFor(thread).dispose(); setCurThread(mainThread); }
});

// A native that makes JNI calls of its own waits on the Cpu for each.
test("a native's own JNI calls reach Java, and an exception it leaves pending is thrown in Java", async () => {
  const previous = rt.jniResolver, thread = new JThread();
  setA64(true); jniInit();
  try {
    natives({
      calls: async (cpu, a) => {
        const j = new Env(cpu, a.p()), self = a.p(), n = a.i(), cls = await j.call(S.GetObjectClass, self);
        if (n < 0) { await j.call(S.ThrowNew, await j.cls("java/lang/IllegalStateException"), cstr("native says no")); return 0; }
        return n + await j.call(field("Get", "Int"), self, await j.field(cls, "i", "I"));
      },
    });
    setCurThread(thread);
    const o = await newObj("JniProbe");
    expect(await vcall(o, "calls", "(I)I", 4)).toBe(9);
    expect(await thrown(() => vcall(o, "calls", "(I)I", -1))).toBe("java/lang/IllegalStateException: native says no");
  } finally { rt.jniResolver = previous; cpuFor(thread).dispose(); setCurThread(mainThread); }
});

test("RegisterNatives binds a native after its class has run", async () => {
  const previous = rt.jniResolver, thread = new JThread();
  setA64(true); jniInit();
  try {
    resolveByExport(() => undefined);
    setCurThread(thread);
    expect(await scall("JniProbe", "twice", "(I)I", 4)).toBe(8);
    expect(await thrown(() => scall("JniProbe", "late", "(I)I", 1))).toMatch(/^java\/lang\/UnsatisfiedLinkError/);
    const cpu = cpuFor(thread), out = mem.malloc(PTR);
    await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, out, 0x10006]);
    const j = new Env(cpu, ldp(out)), table = mem.calloc(1, 3 * PTR);
    const fn = defineHost("late", (_cpu, a) => { a.p(); a.p(); return a.i() + 1; });
    mem.st64(table, BigInt(cstr("late"))); mem.st64(table + PTR, BigInt(cstr("(I)I"))); mem.st64(table + 2 * PTR, BigInt(fn));
    expect(await j.call(S.RegisterNatives, await j.cls("JniProbe"), table, 1)).toBe(0);
    expect(await scall("JniProbe", "late", "(I)I", 41)).toBe(42);
    cpu.dispose(); mem.free(out);
  } finally { rt.jniResolver = previous; setCurThread(mainThread); }
});

// A class initializer or a callback that waits parks the strand that called it.
test("JNI callbacks retain their caller after suspended class initialization", () => withEnv(true, async (env) => {
  const klass = await env.cls("JniSlowInit"), method = await env.staticMethod(klass, "value", "()I");
  // the initializer sleeps: the call waits for it, and the answer is the one the initialized class gives
  expect(await env.call(call("Static", "Int"), klass, method)).toBe(1);
  expect(env.cpu.exc).toBeNull();
}));

for (const a64 of abis) test(`${abi(a64)} JNI callbacks park only when Java suspends`, () => withEnv(a64, async (env) => {
  const cpu = env.cpu;
  const klass = await env.cls("JniCallback"), method = await env.staticMethod(klass, "value", "()I");
  const run = () => env.call(call("Static", "Int"), klass, method);
  const mode = async (m: number) => { await env.call(field("Set", "Int", true), klass, await env.staticField(klass, "mode", "I"), m); };
  await mode(0);
  // the first call links the method, which may yield a turn
  await run();
  const immediate = run();
  expect(cpu.parked).toBe(false);
  expect(await immediate).toBe(42);

  await mode(1);
  const suspended = run();
  expect(cpu.parked).toBe(true);
  expect(await suspended).toBe(73);

  // a callback that throws, at once or after waiting, leaves the throwable pending and answers 0
  for (const m of [2, 3]) {
    await mode(m);
    expect(await run()).toBe(0);
    expect(await env.pending()).toBe("java.lang.IllegalStateException");
    await env.clear();
  }
}));

test("an address that stands for a Java array gives a native the array, and what it writes is the array's", async () => {
  rt.registerJni("JniProbe", "handleOf(Ljava/lang/Object;)J", Object.assign((array: object) => handle(array), { javaValues: true }) as never);
  rt.registerJni("JniProbe", "poke(J)V", ((h: bigint) => { deref<Int32Array>(h)[1] = 99; }) as never);
  expect(await scall("JniProbe", "viaHandle", "()I")).toBe(99);
});
