import { DexFile } from "../jvm/dex";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { JThread, mainThread, vcall } from "../jvm/natives/jlang";
import { JBuffer, bufferView } from "../jvm/natives/jnio";
import { JCtor } from "../jvm/natives/jreflect";
import { JObj, rt } from "../jvm/runtime";
import { Cpu, setA64 } from "./cpu";
import { hostDispatch, defineHost, ldp, stp, PTR } from "./host";
import { trampSlot } from "./abi";
import { deref, jniInit, javaVM } from "./jni";
import { mem } from "./mem";

class ConstructorTarget extends JObj { value = 0; enabled = 0; }
let cpu: Cpu;

function jni(env: number, index: number): number {
  return ldp(ldp(env) + index * PTR);
}

beforeAll(() => {
  setA64(true);
  rt.link("java/nio/IntBuffer");
  rt.register({
    name: "webdroid/JniConstructorTarget", ctor: ConstructorTarget, fields: { enabled: "enabled" }, statics: { enabled: 0 },
    methods: { "<init>(I)V": function (this: ConstructorTarget, value: number) { this.value = value; } },
  });
  jniInit();
  cpu = new Cpu(mainThread, "jni constructor test");
});
afterAll(() => setA64(false));

test("JNI monitors share Java ownership, suspend only under contention, and pend invalid exits", async () => {
  const envOut = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006]);
  const env = ldp(envOut);
  const local = await cpu.call(jni(env, 167), [env, mem.hostStr("JNI monitor")]);
  const ref = await cpu.call(jni(env, 21), [env, local]);
  const obj = deref(ref);
  if (typeof obj !== "string") throw new Error("NewStringUTF did not return a string");
  const thread = new JThread(), native = new Cpu(thread, "JNI monitor test"), java = new JThread();
  const call = (index: number, object = ref) => {
    native.w[0] = env; native.w[2] = object; native.w[1] = native.w[3] = 0;
    hostDispatch(native, trampSlot(jni(env, index)));
    return native.pending ?? native.w[0];
  };
  try {
    expect(call(217)).toBe(0);
    expect(call(217)).toBe(0);
    expect(rt.monitors.holds(obj, thread)).toBe(true);
    const entered = rt.monitors.enter(obj, java);
    expect(entered).toBeInstanceOf(Promise);
    expect(call(218)).toBe(0);
    expect(rt.monitors.holds(obj, thread)).toBe(true);
    expect(call(218)).toBe(0);
    await entered;
    expect(rt.monitors.holds(obj, java)).toBe(true);
    expect(call(218)).toBe(-1);
    expect(native.exc).toBeInstanceOf(rt.link("java/lang/IllegalMonitorStateException").ctor);
    native.exc = null;
    const pending = call(217);
    expect(pending).toBeInstanceOf(Promise);
    rt.monitors.exit(obj, java);
    expect(await pending).toBe(0);
    native.pending = null;
    expect(rt.monitors.holds(obj, thread)).toBe(true);
    expect(call(218)).toBe(0);
    expect(call(217, 0)).toBe(-1);
    expect(native.exc).toBeInstanceOf(rt.link("java/lang/NullPointerException").ctor);
  } finally {
    native.exc = null;
    await cpu.call(jni(env, 22), [env, ref]);
  }
});

test("JNI direct buffers share native writes with Java slices and typed views", async () => {
  const envOut = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006]);
  const env = ldp(envOut), address = mem.malloc(16);
  try {
    const ref = await cpu.call(jni(env, 229), [env, address, 16n]);
    const b = deref(ref, cpu);
    if (!(b instanceof JBuffer)) throw new Error("NewDirectByteBuffer did not return a buffer");
    expect(await cpu.call(jni(env, 230), [env, ref])).toBe(address);
    expect(await cpu.call(jni(env, 231), [env, ref])).toBe(16);
    expect(cpu.ret1).toBe(0);
    mem.st8(address + 3, 42);
    expect(await vcall(b, "get", "(I)B", 3)).toBe(42);
    b.pos = 4; b.lim = 12;
    const slice = await vcall(b, "slice", "()Ljava/nio/ByteBuffer;");
    await vcall(slice, "put", "(IB)Ljava/nio/ByteBuffer;", 2, 77);
    expect(mem.ld8u(address + 6)).toBe(77);
    const ints = await vcall(b, "asIntBuffer", "()Ljava/nio/IntBuffer;");
    await vcall(ints, "put", "(II)Ljava/nio/IntBuffer;", 1, 0x01020304);
    expect([...mem.u8.subarray(address + 8, address + 12)]).toEqual([1, 2, 3, 4]);
    expect(b.pos).toBe(4);
    expect(await cpu.call(jni(env, 230), [env, ref])).toBe(address);
  } finally { mem.free(address); }
});

test("JNI lazily promotes direct allocations with preexisting views and rejects heap buffers", async () => {
  const envOut = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006]);
  const env = ldp(envOut);
  const cls = await cpu.call(jni(env, 6), [env, mem.hostStr("java/nio/ByteBuffer")]);
  for (const allocation of ["allocateDirect", "allocate"]) {
    const method = await cpu.call(jni(env, 113), [env, cls, mem.hostStr(allocation), mem.hostStr("(I)Ljava/nio/ByteBuffer;")]);
    const ref = await cpu.call(jni(env, 114), [env, cls, method, 20]);
    const b = deref(ref, cpu);
    if (!(b instanceof JBuffer)) throw new Error("allocation did not return a buffer");
    expect(b.ab).not.toBe(mem.buf);
    await vcall(b, "put", "(IB)Ljava/nio/ByteBuffer;", 9, 55);
    b.pos = 4; b.lim = 16;
    const sliceId = await cpu.call(jni(env, 33), [env, cls, mem.hostStr("slice"), mem.hostStr("()Ljava/nio/ByteBuffer;")]);
    const sliceRef = await cpu.call(jni(env, 34), [env, ref, sliceId]);
    const slice = deref(sliceRef, cpu);
    if (!(slice instanceof JBuffer)) throw new Error("slice did not return a buffer");
    const ints = await vcall(slice, "asIntBuffer", "()Ljava/nio/IntBuffer;");
    const duplicate = await vcall(b, "duplicate", "()Ljava/nio/ByteBuffer;");
    const address = await cpu.call(jni(env, 230), [env, sliceRef]);
    if (allocation === "allocate") {
      expect(address).toBe(0);
      expect(await cpu.call(jni(env, 231), [env, ref])).toBe(-1);
      expect(cpu.ret1).toBe(-1);
      expect(await vcall(slice, "isDirect", "()Z")).toBe(0);
      continue;
    }
    expect(address).toBeGreaterThan(0);
    expect(await cpu.call(jni(env, 230), [env, ref])).toBe(address - 4);
    expect(await cpu.call(jni(env, 231), [env, sliceRef])).toBe(12);
    expect(mem.ld8u(address + 5)).toBe(55);
    mem.st8(address + 2, 91);
    expect(await vcall(duplicate, "get", "(I)B", 6)).toBe(91);
    await vcall(ints, "put", "(II)Ljava/nio/IntBuffer;", 2, 0x05060708);
    expect([...mem.u8.subarray(address + 8, address + 12)]).toEqual([5, 6, 7, 8]);
    expect(bufferView(slice)).toEqual({ ab: mem.buf, byteOffset: address, byteFromPos: address });
    expect(await vcall(slice, "isDirect", "()Z")).toBe(1);
  }
});

test("native direct buffers retain guest addresses when an arm64 memory plane moves", async () => {
  const reservations: (number | bigint)[] = [];
  const plane = () => {
    for (;;) {
      const address = mem.mapVa(0x1ffff000, true);
      if (!address) throw new Error("native reservation failed");
      reservations.push(address);
      if (typeof address === "bigint") return address;
    }
  };
  try {
    const address = plane(), blocker = plane();
    expect(mem.commitVa(address, 0x1000)).toBe(true);
    const envOut = mem.hostAlloc(PTR);
    await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006]);
    const env = ldp(envOut);
    const ref = await cpu.call(jni(env, 229), [env, address, 16n]);
    const b = deref(ref, cpu);
    if (!(b instanceof JBuffer)) throw new Error("NewDirectByteBuffer did not return a buffer");
    const previous = b.dv;
    previous.setInt8(0, 61);
    expect(mem.commitVa(blocker, 1 << 25)).toBe(true);
    expect(mem.commitVa(address, 2 << 25)).toBe(true);
    expect(b.dv.byteOffset).not.toBe(previous.byteOffset);
    expect(await vcall(b, "get", "(I)B", 0)).toBe(61);
    await vcall(b, "put", "(IB)Ljava/nio/ByteBuffer;", 1, 62);
    expect(mem.ld8u(mem.txVa(address) + 1)).toBe(62);
    const low = await cpu.call(jni(env, 230), [env, ref]);
    expect((BigInt(cpu.ret1) << 32n) | BigInt(low >>> 0)).toBe(address);
  } finally {
    for (const address of reservations) mem.unmapVa(BigInt(address), 0x1ffff000);
  }
});

test("reflected constructors preserve their canonical method ID and construct through NewObjectA", async () => {
  const envOut = mem.hostAlloc(PTR);
  expect(await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006])).toBe(0);
  const env = ldp(envOut);
  const cls = await cpu.call(jni(env, 6), [env, mem.hostStr("webdroid/JniConstructorTarget")]);
  const id = await cpu.call(jni(env, 33), [env, cls, mem.hostStr("<init>"), mem.hostStr("(I)V")]);

  const reflected = await cpu.call(jni(env, 9), [env, cls, id, 0]);
  expect(deref(reflected, cpu)).toBeInstanceOf(JCtor);
  expect(await cpu.call(jni(env, 7), [env, reflected])).toBe(id);
  expect(await cpu.call(jni(env, 33), [env, cls, mem.hostStr("<init>"), mem.hostStr("(I)V")])).toBe(id);

  const args = mem.hostAlloc(8);
  mem.st32(args, 42);
  const object = deref(await cpu.call(jni(env, 30), [env, cls, id, args]), cpu) as ConstructorTarget;
  expect(object).toBeInstanceOf(ConstructorTarget);
  expect(object.value).toBe(42);
});


test("JNI resolves inherited abstract interface methods and dispatches on the receiver", async () => {
  rt.loadDex(new DexFile(new Uint8Array(await Bun.file(new URL("./fixtures/jni-abstract.dex", import.meta.url)).arrayBuffer())));
  const envOut = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006]);
  const env = ldp(envOut);
  const find = (name: string) => cpu.call(jni(env, 6), [env, mem.hostStr(name)]);
  const cls = await find("webdroid/JniAbstractTarget"), iface = await find("webdroid/JniChild");
  const ctor = await cpu.call(jni(env, 33), [env, cls, mem.hostStr("<init>"), mem.hostStr("()V")]);
  const object = await cpu.call(jni(env, 28), [env, cls, ctor]);
  const id = await cpu.call(jni(env, 33), [env, iface, mem.hostStr("value"), mem.hostStr("()I")]);
  expect(id).toBeGreaterThan(0);
  expect(await cpu.call(jni(env, 49), [env, object, id])).toBe(42);
  expect(await cpu.call(jni(env, 33), [env, iface, mem.hostStr("missing"), mem.hostStr("()I")])).toBe(0);
  expect(await cpu.call(jni(env, 228), [env])).toBe(1);
  await cpu.call(jni(env, 17), [env]);
});


test("JNI boolean field setters consume only the low argument byte", async () => {
  const envOut = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006]);
  const env = ldp(envOut), cls = await cpu.call(jni(env, 6), [env, mem.hostStr("webdroid/JniConstructorTarget")]);
  const object = await cpu.call(jni(env, 27), [env, cls]);
  const name = mem.hostStr("enabled"), type = mem.hostStr("Z");
  const field = await cpu.call(jni(env, 94), [env, cls, name, type]);
  const staticField = await cpu.call(jni(env, 144), [env, cls, name, type]);
  expect(await cpu.call(jni(env, 94), [env, cls, name, type])).toBe(field);
  expect(await cpu.call(jni(env, 144), [env, cls, name, type])).toBe(staticField);
  for (const [value, expected] of [[0x100, 0], [0x101, 1], [0xffffff00, 0], [0xffffff80, 1]]) {
    await cpu.call(jni(env, 105), [env, object, field, value]);
    expect(await cpu.call(jni(env, 96), [env, object, field])).toBe(expected);
    await cpu.call(jni(env, 155), [env, cls, staticField, value]);
    expect(await cpu.call(jni(env, 146), [env, cls, staticField])).toBe(expected);
  }
});


test("JNI lookup, method IDs and native registrations retain sibling loader identity", async () => {
  const dex = new DexFile(await Bun.file(new URL("./fixtures/jni-abstract.dex", import.meta.url)).bytes());
  const a = rt.fork(), b = rt.fork();
  a.loadDex(dex); b.loadDex(dex);
  const name = "webdroid/JniAbstractTarget", envOut = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, envOut, 0x10006]);
  const env = ldp(envOut), refs: number[] = [], ids: number[] = [];
  try {
    for (const owner of [a, b]) {
      cpu.nativeRuntime = owner;
      const cls = await cpu.call(jni(env, 6), [env, mem.hostStr(name)]);
      expect(deref(cls, cpu)).toBe(owner.classFor(name));
      const id = await cpu.call(jni(env, 33), [env, cls, mem.hostStr("value"), mem.hostStr("()I")]);
      expect(await cpu.call(jni(env, 33), [env, cls, mem.hostStr("value"), mem.hostStr("()I")])).toBe(id);
      ids.push(id); refs.push(cls);
      const object = await cpu.call(jni(env, 27), [env, cls]);
      expect(deref(await cpu.call(jni(env, 31), [env, object]), cpu)).toBe(owner.classFor(name));
      const target = defineHost("test:jni-loader-" + refs.length, async (native) => {
        expect(native.nativeRuntime).toBe(owner);
        const found = await native.call(jni(env, 6), [env, mem.hostStr(name)]);
        expect(deref(found, native)).toBe(owner.classFor(name));
        return owner === a ? 17 : 29;
      });
      const table = mem.hostAlloc(3 * PTR);
      stp(table, mem.hostStr("value")); stp(table + PTR, mem.hostStr("()I")); stp(table + 2 * PTR, target);
      expect(await cpu.call(jni(env, 215), [env, cls, table, 1])).toBe(0);
      expect(owner.jni.has(name + "|value()I")).toBe(true);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(await cpu.call(jni(env, 11), [env, refs[0], refs[1]])).toBe(0);
    expect(rt.jni.has(name + "|value()I")).toBe(false);
    cpu.nativeRuntime = null;
    for (const owner of [a, b]) {
      expect(await vcall(new (owner.link(name).ctor)(), "value", "()I")).toBe(owner === a ? 17 : 29);
    }
    expect(cpu.nativeRuntime).toBeNull();
  } finally { cpu.nativeRuntime = null; }
});
