import { describe, expect, test } from "vite-plus/test";
import { NODE_ARGS, run } from "../../scripts/node.ts";
import { curThread, JThread, mainThread, setCurThread } from "../jvm/natives/jentry.ts";
import { Cpu, setA64, slice } from "./cpu.ts";
import { dispositions, sigHandler } from "./signals.ts";
import { defineHost } from "./host.ts";
import { mem } from "./mem.ts";
import { futex } from "./pthread.ts";
import { E, RET_SENTINEL } from "./abi.ts";
import { jitStats, JIT_HEAT } from "./core.ts";
import { kernelInit, rawSyscall, syscallEntry } from "./syscall.ts";

/** `sig` is handled as `d` until the result puts back what was there */
function install(sig: number, d: ReturnType<typeof sigHandler>): () => void {
  const previous = dispositions.get(sig);
  dispositions.set(sig, d);
  return () => { if (previous) dispositions.set(sig, previous); else dispositions.delete(sig); };
}

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
    const restore = install(12, sigHandler(handler, 0, 0n));
    cpu.signals.set(12, null);
    setCurThread(mainThread);
    try {
      expect(await cpu.call(address)).toBe(23);
      expect(entered).toEqual([worker, worker]);
      expect(curThread).toBe(mainThread);
    } finally {
      restore();
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
    const restore = install(12, sigHandler(handler, 0, 0n));
    try {
      cpu.kill(12);
      const idle = cpu.awaitIdleBase().then(() => order.push("idle"));
      await Promise.resolve();
      expect(order).toEqual(["handler"]);
      deferred.resolve(0);
      await idle;
      expect(order).toEqual(["handler", "handled", "idle"]);
    } finally {
      restore();
      cpu.dispose();
    }
  });

  test("signal masks are restored before an interrupted host call resumes", async () => {
    setA64(a64);
    const cpu = new Cpu(new JThread(), "signal-mask"), deferred = Promise.withResolvers<number>();
    const entry = defineHost("test.signal.mask.wait." + a64, () => deferred.promise);
    let resumedMask = -1n;
    const observe = defineHost("test.signal.mask.observe." + a64, () => { resumedMask = cpu.signalMask; return 0; });
    const handler = defineHost("test.signal.mask.handler." + a64, () => { deferred.resolve(0); return 0; });
    const address = mem.reserve(4096, 4096);
    const restore = install(30, sigHandler(handler, 0, 0xffffffffffffffffn));
    mem.u32.set(a64
      ? [0xa9bf7bfd, 0x580000f0, 0xd63f0200, 0x580000f0, 0xd63f0200, 0xa8c17bfd, 0xd65f03c0, 0xd503201f, entry, 0, observe, 0]
      : [0xe92d4010, 0xe59fc00c, 0xe12fff3c, 0xe59fc008, 0xe12fff3c, 0xe8bd8010, entry, observe], address >>> 2);
    try {
      const initial = cpu.signalMask, result = cpu.call(address);
      cpu.kill(30);
      await result;
      expect(resumedMask).toBe(initial);
      expect(cpu.signalMask).toBe(initial);
    } finally {
      restore();
      cpu.dispose();
    }
  });

  test("a signal waits for an exiting call to release its frame", async () => {
    setA64(a64);
    const cpu = new Cpu(new JThread(), "signal-teardown");
    let handlerFrames: string[] = [];
    const entry = defineHost("test.signal.teardown.entry." + a64, () => 0);
    const handler = defineHost("test.signal.teardown.handler." + a64, () => {
      handlerFrames = cpu.frames.map((f) => f.label);
      return 0;
    });
    const restore = install(12, sigHandler(handler, 0, 0n));
    try {
      const result = cpu.call(entry, [], "outer call");
      cpu.kill(12);
      await result;
      await cpu.awaitIdleBase();
      expect(handlerFrames).toEqual(["signal 12"]);
    } finally {
      restore();
      cpu.dispose();
    }
  });
});

test("a signal interrupts an ARM64 futex before its handler observes the saved context", async () => {
  setA64(true);
  const cpu = new Cpu(new JThread(), "futex-signal"), addr = mem.reserve(4096, 4096);
  mem.st32(addr, 7);
  const order: string[] = [];
  let savedSp = 0n, contextSp = 0n, contextPc = 0n;
  const entry = defineHost("test.signal.futex.wait", (c) => { order.push("wait"); return futex(c, addr, 0, 7, 0); });
  const handler = defineHost("test.signal.futex.handler", (_c, a) => {
    a.i(); a.p(); const context = a.p();
    contextSp = mem.ld64(context + 0x1b0);
    contextPc = mem.ld64(context + 0x1b8);
    order.push("handler");
    return 0;
  });
  const restore = install(12, sigHandler(handler, 4, 0n));
  try {
    const result = cpu.call(entry);
    savedSp = BigInt(cpu.sp >>> 0);
    expect(cpu.signalInterrupt).not.toBeNull();
    cpu.kill(12);
    expect(await result).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(4);
    expect(order).toEqual(["wait", "handler"]);
    expect(contextSp).toBe(savedSp);
    expect(contextPc).toBe(BigInt(RET_SENTINEL));
  } finally {
    restore();
    cpu.dispose(); setA64(false);
  }
});

test("an ARM64 signal context is restored before the interrupted frame runs on", async () => {
  setA64(true);
  const cpu = new Cpu(new JThread(), "signal-context"), first = Promise.withResolvers<number>(), second = Promise.withResolvers<number>();
  let seconds = 0;
  const entry = defineHost("test.signal.context.wait", () => first.promise);
  const next = defineHost("test.signal.context.next", () => { seconds++; return second.promise; });
  const handler = defineHost("test.signal.context.handler", () => { first.resolve(0); return 0; });
  const address = mem.reserve(4096, 4096);
  const restore = install(30, sigHandler(handler, 4, 0n));
  mem.u32.set([0xa9bf7bfd, 0x580000f0, 0xd63f0200, 0x580000f0, 0xd63f0200, 0xa8c17bfd, 0xd65f03c0, 0xd503201f, entry, 0, next, 0], address >>> 2);
  try {
    const result = cpu.call(address);
    cpu.kill(30);
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.resolve(5);
    expect(await result).toBe(5);
    expect(seconds).toBe(1);
  } finally {
    restore();
    cpu.dispose(); setA64(false);
  }
});

test("an ARM64 handler that restores the interrupted sp by hand returns from the interrupted call", async () => {
  setA64(true);
  const cpu = new Cpu(new JThread(), "signal-escape");
  const raise = defineHost("test.signal.escape.raise", (c) => { c.kill(30); return 0; });
  const address = mem.reserve(4096, 4096);
  // f: push fp/lr; x19 = sp; raise; x0 = 1; pop; ret. handler: sp = x19; x0 = 7; pop; ret (f's return)
  mem.u32.set([0xa9bf7bfd, 0x910003f3, 0x580000d0, 0xd63f0200, 0xd2800020, 0xa8c17bfd, 0xd65f03c0, 0xd503201f, raise, 0,
    0x9100027f, 0xd28000e0, 0xa8c17bfd, 0xd65f03c0], address >>> 2);
  const restore = install(30, sigHandler(address + 0x28, 4, 0n));
  try {
    expect(await cpu.call(address)).toBe(7);
    expect(cpu.signalMask & 1n << 29n).toBe(1n << 29n);
  } finally {
    restore();
    cpu.dispose(); setA64(false);
  }
});

// cmp; a load through a null pointer; an add only when the compare's flags say equal; return
const FAULTING = {
  a64: { words: [0xeb03005f, 0xf9400020, 0x9a801400, 0xd65f03c0], step: 4, thumb: 0 },
  arm: { words: [0xe1520003, 0xe5910000, 0x02800001, 0xe12fff1e], step: 4, thumb: 0 },
  thumb: { words: [0x6808429a, 0x3001bf08, 0x4770], step: 2, thumb: 1 },
};
for (const [isa, program] of Object.entries(FAULTING)) test(`a ${isa} memory fault reaches its SIGSEGV handler, which resumes past it, in both tiers`, async () => {
  const a64 = isa === "a64";
  setA64(a64);
  const cpu = new Cpu(new JThread(), "segv-" + isa), at = mem.reserve(4096, 4096), seen: number[][] = [];
  mem.u32.set(program.words, at >>> 2);
  const ctxPc = a64 ? 0x1b8 : 92, ctxR0 = a64 ? 0xb8 : 32;
  const handler = defineHost("test.segv." + isa, (_c, a) => {
    const sig = a.i(), info = a.p(), ctx = a.p(), pc = mem.ld32(ctx + ctxPc) >>> 0;
    seen.push([sig, mem.ld32(info), mem.ld32(info + 8), mem.ld32(info + (a64 ? 16 : 12)), pc - at, mem.ld32(ctx + ctxR0 + (a64 ? 8 : 4))]);
    mem.st32(ctx + ctxR0, 40);
    mem.st32(ctx + ctxPc, pc + program.step);
    return 0;
  });
  const restore = install(11, sigHandler(handler, 4, 0n));
  // an ARM32 address past the 2 GiB the process has is unmapped too, not a wasm trap
  const pointers = a64 ? [8] : [8, 0x9000_0000];
  const runs = async (n: number, p: number) => { const out = []; for (let i = 0; i < n; i++) out.push(await cpu.call(at | program.thumb, [0, p, 5, 5 + (i & 1)])); return out; };
  try {
    for (const p of pointers) {
      jitStats.on = false;
      seen.length = 0;
      expect(await runs(2, p)).toEqual([41, 40]);
      expect(seen[0]).toEqual([11, 11, 1, p | 0, program.step, p | 0]);
      jitStats.on = true;
      const before = jitStats.regions;
      await runs(JIT_HEAT + 2, p);
      if (p === 8) expect(jitStats.regions).toBeGreaterThan(before);
      seen.length = 0;
      expect(await runs(2, p)).toEqual([41, 40]);
      expect(seen[0]).toEqual([11, 11, 1, p | 0, program.step, p | 0]);
    }
  } finally {
    restore();
    cpu.dispose(); setA64(false);
  }
});

test("an ARM32 store past 2 GiB or to space the memory does not yet back faults as SEGV_MAPERR", async () => {
  setA64(false);
  const cpu = new Cpu(new JThread(), "segv-store"), at = mem.reserve(4096, 4096), seen: number[] = [];
  mem.u32.set([0xe5810000, 0xe12fff1e], at >>> 2);                                     // str r0, [r1]; bx lr
  const handler = defineHost("test.segv.store", (_c, a) => {
    a.i(); const info = a.p(), ctx = a.p();
    seen.push(mem.ld32(info + 8), mem.ld32(info + 12) >>> 0);
    mem.st32(ctx + 92, mem.ld32(ctx + 92) + 4);
    return 0;
  });
  const restore = install(11, sigHandler(handler, 4, 0n));
  try {
    // the first page past what the memory backs, when it lies below 2 GiB (a shared memory)
    const unbacked = mem.buf.byteLength < 0x8000_0000 ? mem.buf.byteLength : 0x9000_0000;
    for (const p of new Set([0x9000_0000, unbacked])) {
      seen.length = 0;
      await cpu.call(at, [7, p]);
      expect(seen).toEqual([1, p]);
    }
  } finally {
    restore();
    cpu.dispose();
  }
});

test("a bad pointer fails a system call with EFAULT and faults a libc body with SIGSEGV", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(new JThread(), "bad-pointer"), at = mem.reserve(4096, 4096), seen: bigint[] = [];
  mem.u32.set([0xd2801408, 0xd4000001, 0xd65f03c0], at >>> 2);                         // uname(x0) by svc
  const libcSyscall = defineHost("syscall", syscallEntry);
  const userRead = defineHost("test.bad.read", (_c, a) => mem.ld32(a.p()));
  const handler = defineHost("test.bad.segv", (_c, a) => {
    a.i(); const info = a.p(), ctx = a.p();
    seen.push(mem.ld64(info + 16));
    mem.st64(ctx + 0xb8, 7n);
    mem.st64(ctx + 0x1b8, mem.ld64(ctx + 0xb8 + 30 * 8));                              // return to the caller
    return 0;
  });
  const restore = install(11, sigHandler(handler, 4, 0n));
  try {
    expect(await cpu.call(at, [8])).toBe(-E.FAULT);
    expect(await cpu.call(libcSyscall, [160, 8])).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(E.FAULT);
    expect(await cpu.call(userRead, [0x24])).toBe(7);
    expect(seen).toEqual([0x24n]);
  } finally {
    restore();
    cpu.dispose(); setA64(false);
  }
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

test("ARM signal entry clears Thumb IT state and restores it on return", async () => {
  setA64(false);
  const cpu = new Cpu(new JThread(), "signal-it"), address = mem.reserve(4096, 4096);
  mem.u16.set([0x2107, 0x6021, 0x4770], address >>> 1);
  cpu.w[8] = address + 64;
  cpu.cpsr = 0x820;
  const restore = install(30, sigHandler(address | 1, 0, 0n));
  try {
    await cpu.deliver(30);
    expect(mem.ld32(address + 64)).toBe(7);
    expect(cpu.cpsr).toBe(0x820);
  } finally {
    restore();
    cpu.dispose();
  }
});

test("ARM64 sigtimedwait fills siginfo for pending and subsequently queued signals", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(new JThread(), "signal-wait"), storage = mem.calloc(1, 152);
  const set = storage, info = storage + 8, timeout = info + 128;
  const entry = defineHost("test.signal.timedwait", (c, a) => rawSyscall(c, 137, a));
  cpu.signalMask = 1n << 11n;
  mem.st64(set, cpu.signalMask);
  try {
    cpu.kill(12);
    expect(await cpu.call(entry, [set, info, timeout, 8])).toBe(12);
    expect(mem.ld32(info)).toBe(12);
    expect(mem.ld64(timeout)).toBe(0n);
    expect(await cpu.call(entry, [set, 0, timeout, 8])).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(E.AGAIN);
    mem.memset(info, 0, 128);
    const waiting = cpu.call(entry, [set, info, 0, 8]);
    expect(cpu.sigQueued).not.toBeNull();
    cpu.kill(12);
    expect(await waiting).toBe(12);
    expect(mem.ld32(info)).toBe(12);
    expect(cpu.sigQueued).toBeNull();
  } finally { mem.free(storage); cpu.dispose(); }
});

test("an unhandled terminating signal ends the process once unblocked; ignored ones are discarded", async () => {
  // in a child process: dying marks this one's native tier exited for good
  const at = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const code = `
    import { Cpu, setA64 } from ${at("./cpu.ts")};
    import { dispositions } from ${at("./signals.ts")};
    import { processExited } from ${at("../process-exit.ts")};
    import { JThread } from ${at("../jvm/natives/jentry.ts")};
    setA64(true);
    const cpu = new Cpu(new JThread(), "victim"), turn = () => new Promise((r) => setTimeout(r, 0));
    cpu.signalMask = 0n;
    dispositions.set(15, { kind: "ignore" });
    for (const sig of [17, 23, 28, 15]) cpu.kill(sig);
    await turn();
    const ignored = !processExited() && !cpu.signals.size;
    cpu.signalMask = 1n << 5n; cpu.kill(6);
    await turn();
    const pending = !processExited() && cpu.signals.has(6);
    cpu.signalMask = 0n; cpu.pump();
    await turn();
    console.log(JSON.stringify({ ignored, pending, exited: processExited() }));`;
  const { stdout, stderr: err } = await run(process.execPath, [...NODE_ARGS, "--input-type=module", "-e", code]);
  expect(JSON.parse(stdout.toString().trim().split("\n").at(-1)!)).toEqual({ ignored: true, pending: true, exited: true });
  expect(err).toContain("Fatal signal 6 (SIGABRT) in tid");
  expect(err).toContain("name: victim");
});
