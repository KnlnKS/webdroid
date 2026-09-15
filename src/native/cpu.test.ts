import { describe, expect, test } from "bun:test";
import { curThread, JThread, mainThread, setCurThread } from "../jvm/natives/jlang";
import { Cpu, setA64, sigHandlers, slice } from "./cpu";
import { defineHost } from "./host";
import { mem } from "./mem";

for (const a64 of [false, true]) describe(a64 ? "A64 thread identity" : "ARM32 thread identity", () => {
  test("static TLS is initialized once per guest thread", () => {
    setA64(a64);
    const first = new Cpu(new JThread(), "tls-a"), second = new Cpu(new JThread(), "tls-b"), key = {};
    try {
      const image = Uint8Array.of(3, 5, 8), a = first.staticTls(key, image, 8, 16), b = second.staticTls(key, image, 8, 16);
      expect(a & 15).toBe(0);
      expect(a).not.toBe(b);
      expect(first.staticTls(key, image, 8, 16)).toBe(a);
      expect([...mem.u8.subarray(a, a + 8)]).toEqual([3, 5, 8, 0, 0, 0, 0, 0]);
      mem.u8[a] = 13;
      expect(mem.u8[b]).toBe(3);
    } finally {
      first.dispose(); second.dispose();
    }
  });

  test("a parked guest releases its Java thread on host completion and rejection", async () => {
    setA64(a64);
    for (const reject of [false, true]) {
      const worker = new JThread(), cpu = new Cpu(worker, "identity");
      const deferred = Promise.withResolvers<number>();
      const entered: JThread[] = [];
      const address = defineHost("test.thread.park." + reject, () => { entered.push(curThread); return deferred.promise; });
      const failure = new Error("host rejected");
      setCurThread(mainThread);
      try {
        const result = cpu.call(address).catch(error => error);
        const parked = curThread;
        if (reject) deferred.reject(failure); else deferred.resolve(17);
        const value = await result;
        expect(entered).toEqual([worker]);
        expect(parked).toBe(mainThread);
        expect(curThread).toBe(mainThread);
        expect(value).toBe(reject ? failure : 17);
        expect(cpu.depth).toBe(0);
      } finally { cpu.dispose(); setCurThread(mainThread); }
    }
  });

  test("a budget yield releases Java identity and the next host call resumes its guest thread", async () => {
    setA64(a64);
    const worker = new JThread(), cpu = new Cpu(worker, "identity");
    const entered: JThread[] = [];
    const host = defineHost("test.thread.yield", (_cpu, args) => { entered.push(curThread); return args.i() + 1; });
    const address = mem.reserve(4096, 4096);
    mem.u32.set(a64 ? [0x528000e0, 0x58000070, 0xd61f0200, 0xd503201f, host, 0] : [0xe3a00007, 0xe51ff004, host], address >>> 2);
    const budget = slice.instr;
    slice.instr = 1;
    setCurThread(mainThread);
    try {
      const result = cpu.call(address);
      const yielded = curThread;
      expect(await result).toBe(8);
      expect(yielded).toBe(mainThread);
      expect(entered).toEqual([worker]);
      expect(curThread).toBe(mainThread);
    } finally { slice.instr = budget; cpu.dispose(); setCurThread(mainThread); }
  });

  test("a synchronous guest return releases Java identity before its caller resumes", async () => {
    setA64(a64);
    const worker = new JThread(), cpu = new Cpu(worker, "identity");
    const address = defineHost("test.thread.return", () => 9);
    setCurThread(mainThread);
    try {
      const result = cpu.call(address);
      const returned = curThread;
      expect(await result).toBe(9);
      expect(returned).toBe(mainThread);
    } finally { cpu.dispose(); setCurThread(mainThread); }
  });

  test("a signal handler restores the interrupted guest's Java identity", async () => {
    setA64(a64);
    const worker = new JThread(), cpu = new Cpu(worker, "identity"), entered: JThread[] = [];
    const handler = defineHost("test.thread.signal", () => { entered.push(curThread); return 0; });
    const address = defineHost("test.thread.interrupted", () => { entered.push(curThread); return 23; });
    const previous = sigHandlers.get(12);
    sigHandlers.set(12, { fn: handler, mask: 0n, flags: 0 });
    cpu.signals.push(12);
    setCurThread(mainThread);
    try {
      expect(await cpu.call(address)).toBe(23);
      expect(entered).toEqual([worker, worker]);
      expect(curThread).toBe(mainThread);
    } finally {
      if (previous) sigHandlers.set(12, previous); else sigHandlers.delete(12);
      cpu.dispose(); setCurThread(mainThread);
    }
  });

  test("a base entry waits for a queued signal handler", async () => {
    setA64(a64);
    const cpu = new Cpu(new JThread(), "signal-order"), order: string[] = [];
    const deferred = Promise.withResolvers<number>();
    const handler = defineHost("test.signal.order." + a64, async () => {
      order.push("handler");
      await deferred.promise;
      order.push("handled");
      return 0;
    });
    const previous = sigHandlers.get(12);
    sigHandlers.set(12, { fn: handler, mask: 0n, flags: 0 });
    try {
      cpu.kill(12);
      const idle = cpu.awaitIdleBase().then(() => order.push("idle"));
      await Promise.resolve();
      expect(order).toEqual(["handler"]);
      deferred.resolve(0);
      await idle;
      expect(order).toEqual(["handler", "handled", "idle"]);
    } finally {
      if (previous) sigHandlers.set(12, previous); else sigHandlers.delete(12);
      cpu.dispose();
    }
  });

  test("a signal waits for an exiting call to release its frame", async () => {
    setA64(a64);
    const cpu = new Cpu(new JThread(), "signal-teardown");
    let handlerFrames: string[] = [];
    const entry = defineHost("test.signal.teardown.entry." + a64, () => 0);
    const handler = defineHost("test.signal.teardown.handler." + a64, () => {
      handlerFrames = [...cpu.frames];
      return 0;
    });
    const previous = sigHandlers.get(12);
    sigHandlers.set(12, { fn: handler, mask: 0n, flags: 0 });
    try {
      const result = cpu.call(entry, [], "outer call");
      cpu.kill(12);
      await result;
      await cpu.awaitIdleBase();
      expect(handlerFrames).toEqual(["signal 12"]);
    } finally {
      if (previous) sigHandlers.set(12, previous); else sigHandlers.delete(12);
      cpu.dispose();
    }
  });
});


test("A64 floating arguments spill independently of available integer registers", async () => {
  setA64(true);
  const cpu = new Cpu(new JThread(), "float-arguments");
  const floats = Array.from({ length: 16 }, (_, i) => i + 0.25);
  const integers = Array.from({ length: 9 }, (_, i) => i + 100);
  let actual: { floats: number[]; integers: number[] } | undefined;
  const address = defineHost("test.arguments.float-spill", (_cpu, args) => {
    const first = [args.i(), args.i()];
    actual = { floats: floats.map(() => args.f()), integers: [...first, ...integers.slice(2).map(() => args.i())] };
    return 0;
  });
  try {
    await cpu.call(address, [...integers.slice(0, 2), ...floats.map(f => ({ f })), ...integers.slice(2)]);
    expect(actual).toEqual({ floats, integers });
  } finally { cpu.dispose(); setA64(false); }
});

test("A64 mixed floating spills retain eight-byte slots and leave integer registers available", async () => {
  setA64(true);
  const cpu = new Cpu(new JThread(), "mixed-arguments");
  let actual: number[] = [];
  const address = defineHost("test.arguments.mixed-spill", (_cpu, args) => {
    actual = [args.i(), ...Array.from({ length: 8 }, () => args.d()), args.f(), args.i(), args.d(), args.f()];
    return 0;
  });
  try {
    await cpu.call(address, [12, ...Array.from({ length: 8 }, (_, i) => ({ d: i + 0.125 })), { f: -2.5 }, 23, { d: Math.PI }, { f: 4.75 }]);
    expect(actual).toEqual([12, ...Array.from({ length: 8 }, (_, i) => i + 0.125), -2.5, 23, Math.PI, 4.75]);
  } finally { cpu.dispose(); setA64(false); }
});
