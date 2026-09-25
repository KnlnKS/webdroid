import { expect, test } from "bun:test";
import { mainThread } from "../src/jvm/natives/jlang";
import { Cpu, setA64 } from "../src/native/cpu";
import { lookupHost } from "../src/native/host";
import { mem } from "../src/native/mem";
import { stdioInit } from "../src/native/stdio";

test("native duplication keeps close-on-exec per descriptor", async () => {
  setA64(true); stdioInit();
  const cpu = new Cpu(mainThread, "descriptor-flags"), out = mem.malloc(8);
  const call = (name: string, ...args: number[]) => {
    const fn = lookupHost(name, "libc.so");
    if (fn === undefined) throw new Error(name);
    return cpu.call(fn, args);
  };
  let read = -1, write = -1, duplicate = -1;
  try {
    expect(await call("pipe2", out, 0x80000)).toBe(0);
    read = mem.ld32(out); write = mem.ld32(out + 4);
    expect(await call("fcntl", read, 1)).toBe(1);
    expect(await call("fcntl", write, 1)).toBe(1);
    duplicate = await call("dup", read);
    expect(await call("fcntl", duplicate, 1)).toBe(0);
    expect(await call("dup3", read, duplicate, 0x80000)).toBe(duplicate);
    expect(await call("fcntl", duplicate, 1)).toBe(1);
    expect(await call("dup2", read, duplicate)).toBe(duplicate);
    expect(await call("fcntl", duplicate, 1)).toBe(0);
  } finally {
    for (const fd of [read, write, duplicate]) if (fd >= 0) await call("close", fd);
    mem.free(out); cpu.dispose(); setA64(false);
  }
});
