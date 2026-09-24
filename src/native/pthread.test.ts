import { expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { mem } from "./mem";
import { pthreadInit } from "./pthread";

test("pthread attributes and cleanup handlers preserve bionic behavior", async () => {
  setA64(true); pthreadInit();
  const cpu = new Cpu(new JThread(), "pthread-test");
  const attr = mem.malloc(64), entry = mem.malloc(24), value = mem.malloc(4), out = mem.malloc(8);
  const routine = mem.reserve(4096, 4096);
  mem.u32.set([0x52800541, 0xb9000001, 0xd65f03c0], routine >>> 2);
  const call = (name: string, args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  try {
    expect(await call("pthread_attr_init", [attr])).toBe(0);
    expect(await call("pthread_attr_setguardsize", [attr, 128])).toBe(0);
    expect(await call("pthread_attr_getguardsize", [attr, out])).toBe(0);
    expect(Number(mem.ld64(out))).toBe(128);
    expect(await call("pthread_attr_setscope", [attr, 0])).toBe(0);
    expect(await call("pthread_attr_setscope", [attr, 1])).toBe(95);
    expect(await call("pthread_attr_setscope", [attr, 2])).toBe(22);
    await call("__pthread_cleanup_push", [entry, routine, value]);
    expect(mem.ld32(entry + 8) >>> 0).toBe(routine);
    await call("__pthread_cleanup_pop", [entry, 1]);
    expect(mem.ld32(value)).toBe(42);
  } finally {
    mem.free(attr); mem.free(entry); mem.free(value); mem.free(out); cpu.dispose(); setA64(false);
  }
});
