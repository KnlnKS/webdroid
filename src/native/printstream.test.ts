import { afterAll, beforeAll, expect, test } from "bun:test";
import { JOutputStream } from "../jvm/natives/jio";
import { mainThread, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { Cpu, setA64 } from "./cpu";
import { ldp, PTR } from "./host";
import { deref, jniInit, javaVM } from "./jni";
import { mem } from "./mem";

let cpu: Cpu, env: number;
const jni = (index: number) => ldp(ldp(env) + index * PTR);
beforeAll(async () => {
  setA64(true);
  rt.link("java/io/ByteArrayOutputStream"); rt.link("java/io/PrintStream");
  rt.link("java/lang/IllegalArgumentException");
  jniInit(); cpu = new Cpu(mainThread, "PrintStream JNI test");
  const out = mem.hostAlloc(PTR);
  await cpu.call(ldp(ldp(javaVM.addr) + 6 * PTR), [javaVM.addr, out, 0x10006]);
  env = ldp(out);
});
afterAll(() => setA64(false));

test("JNI-created PrintStream writes exception text and raw UTF-8 to its byte stream", async () => {
  const baos = await cpu.call(jni(6), [env, mem.hostStr("java/io/ByteArrayOutputStream")]);
  const baosInit = await cpu.call(jni(33), [env, baos, mem.hostStr("<init>"), mem.hostStr("()V")]);
  const target = await cpu.call(jni(28), [env, baos, baosInit]);
  const cls = await cpu.call(jni(6), [env, mem.hostStr("java/io/PrintStream")]);
  const init = await cpu.call(jni(33), [env, cls, mem.hostStr("<init>"), mem.hostStr("(Ljava/io/OutputStream;)V")]);
  expect(init).not.toBe(0);
  const ref = await cpu.call(jni(28), [env, cls, init, target]);
  expect(ref).not.toBe(0);
  expect(cpu.exc).toBeNull();
  const stream = deref(ref, cpu), bytes = deref(target, cpu);
  await vcall(stream, "print", "(Ljava/lang/String;)V", "héllo ");
  await vcall(stream, "write", "([B)V", new Int8Array([0x78, 0x0a]));
  await vcall(rt.mkThrowable("java/lang/IllegalArgumentException", "JNI failure"), "printStackTrace", "(Ljava/io/PrintStream;)V", stream);
  const result = await vcall(bytes, "toString", "()Ljava/lang/String;");
  expect(result).toStartWith("héllo x\njava.lang.IllegalArgumentException: JNI failure\n");
  expect(await vcall(stream, "checkError", "()Z")).toBe(0);
  expect(await cpu.call(jni(28), [env, cls, init, 0])).toBe(0);
  expect(cpu.exc).toBeInstanceOf(rt.link("java/lang/NullPointerException").ctor);
  await cpu.call(jni(17), [env]);
});

test("PrintStream awaits formatting, flushes its sink, and records IO failures", async () => {
  class Sink extends JOutputStream { flushes = 0; closed = false; fail = false; }
  rt.register({
    name: "webdroid/test/PrintSink", ctor: Sink, sup: "java/io/OutputStream",
    methods: {
      "write([BII)V": async function (this: Sink, bytes: Int8Array, off: number, len: number) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (this.fail) throw rt.mkThrowable("java/io/IOException", "sink failed");
        for (let i = 0; i < len; i++) this.chunks.push(bytes[off + i] & 255);
      },
      "flush()V": function (this: Sink) { this.flushes++; },
      "close()V": function (this: Sink) { this.closed = true; },
    },
  });
  rt.link("webdroid/test/PrintSink");
  const sink = new Sink(), stream = new (rt.link("java/io/PrintStream").ctor)();
  await vcall(stream, "<init>", "(Ljava/io/OutputStream;Z)V", sink, 1);
  expect(await vcall(stream, "printf", "(Ljava/lang/String;[Ljava/lang/Object;)Ljava/io/PrintStream;", "%s", ["ready"])).toBe(stream);
  expect(new TextDecoder().decode(Uint8Array.from(sink.chunks))).toBe("ready");
  expect(sink.flushes).toBeGreaterThan(0);
  sink.fail = true;
  await vcall(stream, "println", "(Ljava/lang/String;)V", "failure");
  expect(await vcall(stream, "checkError", "()Z")).toBe(1);
  await vcall(stream, "close", "()V");
  expect(sink.closed).toBe(true);
});
