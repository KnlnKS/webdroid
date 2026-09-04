import { afterAll, beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { JCtor } from "../jvm/natives/jreflect";
import { JObj, rt } from "../jvm/runtime";
import { Cpu, setA64 } from "./cpu";
import { ldp, PTR } from "./host";
import { deref, jniInit, javaVM } from "./jni";
import { mem } from "./mem";

class ConstructorTarget extends JObj { value = 0; }
let cpu: Cpu;

function jni(env: number, index: number): number {
  return ldp(ldp(env) + index * PTR);
}

beforeAll(() => {
  setA64(true);
  rt.register({
    name: "webdroid/JniConstructorTarget", ctor: ConstructorTarget,
    methods: { "<init>(I)V": function (this: ConstructorTarget, value: number) { this.value = value; } },
  });
  jniInit();
  cpu = new Cpu(mainThread, "jni constructor test");
});
afterAll(() => setA64(false));

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
