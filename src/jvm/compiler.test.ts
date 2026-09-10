import { expect, test } from "bun:test";
import { perf } from "../perf";
import { DexFile } from "./dex";
import { mangleMethod } from "./abi";
import { rt } from "./runtime";
import { JThread, curThread, mainThread, setCurThread, linkInit, vcall } from "./natives/jlang";

test("compiled continuations preserve registers, catch ranges and thread identity across calls and back edges", async () => {
  const dex = new DexFile(new Uint8Array(await Bun.file(new URL("./fixtures/suspension.dex", import.meta.url)).arrayBuffer()));
  rt.loadDex(dex);
  const ctor = (await linkInit("webdroid/SuspensionFixture")).ctor;
  rt.link("java/lang/IllegalStateException");
  const worker = new JThread(), seen: number[] = [], threads: unknown[] = [];
  const refuel = rt.refuel, fuel = rt.fuel;
  let yields = 0;
  rt.refuel = () => { yields++; return Promise.resolve(); };
  rt.jni.set("webdroid/SuspensionFixture|step(I)I", (n: number) => {
    seen.push(n); threads.push(curThread); rt.fuel = -1;
    if (n === 4) return Promise.reject(rt.mkThrowable("java/lang/IllegalStateException", "step failed"));
    return n % 2 ? n : Promise.resolve(n);
  });
  try {
    setCurThread(worker);
    expect(await vcall(ctor, "run", "(I)I", 6)).toBe(108);
    expect(seen).toEqual([0, 1, 11, 2, 3, 4, 100, 5]);
    expect(threads.every((thread) => thread === worker)).toBe(true);
    expect(yields).toBe(6);
    expect(curThread).toBe(mainThread);
    const entry = ctor[mangleMethod("run", "(I)I")];
    for (let i = 0; i < 40; i++) {
      setCurThread(worker);
      expect(await entry(6)).toBe(108);
    }
    seen.length = 0;
    setCurThread(worker);
    const immediate = ctor[mangleMethod("immediate", "()I")]();
    expect(seen).toEqual([7, 9]);
    expect(curThread).toBe(worker);
    expect(await immediate).toBe(16);
    const bytes = rt.hotSourceBytes, immediateEntry = ctor[mangleMethod("immediate", "()I")];
    rt.hotSourceBytes = 32 * 1024 * 1024;
    try {
      for (let i = 0; i < 64; i++) expect(await immediateEntry()).toBe(16);
      const compileMs = perf.compileMs;
      for (let i = 0; i < 40; i++) expect(await immediateEntry()).toBe(16);
      expect(perf.compileMs).toBe(compileMs);
      expect(ctor[mangleMethod("immediate", "()I")]).toBe(immediateEntry);
      expect(rt.hotSourceBytes).toBe(32 * 1024 * 1024);
    } finally { rt.hotSourceBytes = bytes; }
    seen.length = 0;
    rt.refuel = () => null;
    const loop = ctor[mangleMethod("immediateLoop", "()I")]();
    expect(seen.length).toBe(100);
    expect(curThread).toBe(worker);
    expect(await loop).toBe(700);
    for (let i = 0; i < 40; i++) {
      const n = 0x7123456789012345n + BigInt(i);
      expect(await vcall(ctor, "wide", "(J)J", n)).toBe(n ^ 0x123456789abcdef0n);
      expect(await vcall(ctor, "decimal", "()F")).toBe(1.25);
      expect(await vcall(ctor, "array", "(Ljava/lang/Object;)I", i % 2 ? {} : null)).toBe(9);
    }
  } finally {
    rt.refuel = refuel; rt.fuel = fuel; setCurThread(mainThread);
  }
});
