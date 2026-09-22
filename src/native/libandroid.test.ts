import { expect, test } from "bun:test";
import "../natives";
import { JLooper } from "../android/os";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { ndkInit } from "./libandroid";

test("Java and NDK code share one thread looper without preparing unrelated threads", async () => {
  setA64(true); ndkInit();
  const thread = new JThread(), cpu = new Cpu(thread, "looper-test");
  const other = new Cpu(new JThread(), "unprepared-test");
  const get = lookupHost("ALooper_forThread", "libandroid.so")!;
  try {
    expect(await cpu.call(get)).toBe(0);
    thread.looper = new JLooper(thread);
    const handle = await cpu.call(get);
    expect(handle).toBeGreaterThan(0);
    expect(await cpu.call(lookupHost("ALooper_prepare", "libandroid.so")!, [1])).toBe(handle);
    expect(await cpu.call(get)).toBe(handle);
    expect(await other.call(get)).toBe(0);
  } finally { cpu.dispose(); other.dispose(); setA64(false); }
});
