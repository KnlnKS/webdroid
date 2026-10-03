import { expect, test } from "bun:test";
import "../natives";
import { rt, JObj } from "../jvm/runtime";
import { type ClassDef, type DexFile } from "../jvm/dex";
import { JThread, curThread, mainThread, setCurThread } from "../jvm/natives/jlang";
import { cpuFor, setA64 } from "./cpu";
import { defineHost, retD, PTR, ldp, cstr } from "./host";
import { javaVM, jniInit, resolveByExport } from "./jni";
import { mkMethod } from "../jvm/natives/jreflect";
import { mem } from "./mem";

rt.linkNatives();
for (const a64 of [false, true]) test(`${a64 ? "A64" : "ARM32"} critical natives omit JNI handles while fast natives retain them`, async () => {
  setA64(a64); jniInit();
  const previousResolver = rt.jniResolver;
  const thread = new JThread(), cpu = cpuFor(thread);
  try {
    for (const critical of [false, true]) {
      const cls = `test/NativeAbi${+a64}${+critical}`, sig = "(IJFD)D";
      rt.register({ name: cls, ctor: class extends JObj {} });
      const info = rt.link(cls);
      const dex = {
        method: () => ({ name: "call" }), methodDesc: () => sig,
        classAnnotations: () => ({ cls: [], fields: new Map(), params: new Map(), methods: new Map([[0, [{
          visibility: 0, type: "dalvik/annotation/optimization/" + (critical ? "CriticalNative" : "FastNative"), elements: {}, dex,
        }]]]) }),
      } as unknown as DexFile;
      info.dex = dex;
      info.def = { dex, directMethods: [{ methodIdx: 0, flags: 0x109, codeOff: 0 }], virtualMethods: [], staticFields: [], instanceFields: [] } as unknown as ClassDef;
      const seen: unknown[][] = [];
      const address = defineHost(cls, (cpu, args) => {
        if (!critical) { expect(args.p()).toBeGreaterThan(0); expect(args.p()).toBeGreaterThan(0); }
        const values = [args.i(), args.l(), args.f(), args.d()];
        seen.push(values);
        return retD(cpu, Number(values[0]) + Number(values[1]) + Number(values[2]) + Number(values[3]));
      });
      resolveByExport(() => address);
      const fn = rt.jniResolver!.call(rt, cls, "call" + sig)!;
      setCurThread(thread);
      expect(await fn.apply(info.ctor, [123, 40n, 1.25, 2.5] as never[])).toBe(166.75);
      expect(seen).toEqual([[123, 40n, 1.25, 2.5]]);
    }
  } finally { rt.jniResolver = previousResolver; cpu.dispose(); setCurThread(mainThread); }
});

test("JNI callbacks retain their caller after suspended class initialization", async () => {
  setA64(true); jniInit();
  const thread = new JThread(), cpu = cpuFor(thread), out = mem.malloc(PTR);
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  rt.register({ name: "test/JniInitThread", ctor: class extends JObj {}, clinit: () => ready,
    methods: { "static current()Z": () => +(curThread === thread) } });
  const info = rt.link("test/JniInitThread");
  rt.register({ name: "test/JniReflect", ctor: class extends JObj {}, methods: {
    "static method()Ljava/lang/reflect/Method;": () => mkMethod(info, "current", "()Z", true, null),
  } });
  try {
    await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, out, 0x10006]);
    const env = ldp(out), table = ldp(env);
    const call = (slot: number, ...args: number[]) => cpu.call(ldp(table + slot * PTR), [env, ...args]);
    const factory = await call(6, cstr("test/JniReflect"));
    const factoryMethod = await call(113, factory, cstr("method"), cstr("()Ljava/lang/reflect/Method;"));
    const reflected = await call(114, factory, factoryMethod);
    const method = await call(7, reflected), cls = await call(6, cstr("test/JniInitThread"));
    const result = call(117, cls, method);
    setCurThread(mainThread); finish();
    expect(await result).toBe(1);
    expect(cpu.exc).toBeNull();
  } finally { mem.free(out); cpu.dispose(); setCurThread(mainThread); }
});

for (const a64 of [false, true]) test(`${a64 ? "A64" : "ARM32"} JNI callbacks park only when Java suspends`, async () => {
  setA64(a64); jniInit();
  const thread = new JThread(), cpu = cpuFor(thread), out = mem.malloc(PTR);
  let body: () => unknown = () => 42;
  const cls = `test/JniCallback${+a64}`;
  rt.register({ name: cls, ctor: class extends JObj {}, methods: { "static value()I": () => { expect(curThread).toBe(thread); return body(); } } });
  try {
    await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, out, 0x10006]);
    const env = ldp(out), table = ldp(env);
    const call = (slot: number, ...args: number[]) => cpu.call(ldp(table + slot * PTR), [env, ...args]);
    const klass = await call(6, cstr(cls)), method = await call(113, klass, cstr("value"), cstr("()I"));
    const immediate = call(129, klass, method);
    expect(cpu.parked).toBe(false);
    expect(await immediate).toBe(42);

    const deferred = Promise.withResolvers<number>();
    body = () => deferred.promise;
    const suspended = call(129, klass, method);
    expect(cpu.parked).toBe(true);
    deferred.resolve(73);
    expect(await suspended).toBe(73);

    const failure = rt.mkThrowable("java/lang/IllegalStateException", "callback failed");
    for (const asynchronous of [false, true]) {
      body = () => { if (asynchronous) return Promise.reject(failure); throw failure; };
      expect(await call(129, klass, method)).toBe(0);
      expect(cpu.exc).toBe(failure);
      cpu.exc = null;
    }
  } finally { mem.free(out); cpu.dispose(); setCurThread(mainThread); }
});
