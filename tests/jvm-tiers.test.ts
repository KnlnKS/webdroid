import { expect, spyOn, test } from "bun:test";
import { Runtime, JObj, stubs, isPlaceholderMethod } from "../src/jvm/runtime";
import { DexFile } from "../src/jvm/dex";
import { mangleMethod, descToName } from "../src/jvm/abi";
import { setLazyMethods } from "../src/jvm/compiler";
import { perf } from "../src/perf";
import * as codecache from "../src/jvm/codecache";
import { configureJvm, jvmProfiler } from "../src/jvm/profile";

const bytes = new Uint8Array(await Bun.file(import.meta.dir + "/fixtures/JvmTierProbe.dex").arrayBuffer());
test("DEX method references preserve class boundaries and refresh after loading", () => {
  const dex = new DexFile(bytes), R = new Runtime();
  const expected = new Map<string, Map<string, string>>();
  for (let i = 0; i < dex.methodCount; i++) {
    const method = dex.method(i), owner = descToName(dex.type(method.cls)), desc = dex.methodDesc(i);
    let refs = expected.get(owner);
    if (!refs) expected.set(owner, refs = new Map());
    refs.set(method.name + desc, desc);
  }
  expect(R.methodRefs("JvmTierProbe").size).toBe(0);
  R.loadDex(new DexFile(bytes));
  for (const [owner, refs] of expected) expect(R.methodRefs(owner)).toEqual(refs);
  for (const owner of ["A", "JvmTierProbe$Absent", "zz/Missing", "[Ljava/lang/Object;"])
    expect(R.methodRefs(owner).size).toBe(0);
});

test("class lookup preserves first DEX precedence across files", async () => {
  const first = new DexFile(bytes);
  const second = new DexFile(new Uint8Array(await Bun.file(import.meta.dir + "/fixtures/SerializationProbe.dex").arrayBuffer()));
  const R = new Runtime();
  R.register({ name: "java/lang/Object", ctor: class extends JObj {} });
  R.loadDex(first);
  R.loadDex(second);
  R.loadDex(new DexFile(bytes));
  const firstName = descToName(first.type(first.classDef2Type(0)));
  const secondName = descToName(second.type(second.classDef2Type(0)));
  expect(R.link(firstName).dex).toBe(first);
  expect(R.link(secondName).dex).toBe(second);
});

const modes = ["hot", "cold", "promoted", "denied"] as const;
type Mode = typeof modes[number];
async function fixture(mode: Mode) {
  const R = new Runtime(), worker = {}, main = {};
  let thread: unknown = worker;
  const seen: [number, unknown][] = [];
  const pending: { resolve: (value: number) => void; reject: (error: unknown) => void }[] = [];
  let park = false;
  let callback: ((value: number) => unknown) | undefined;
  R.th = () => thread; R.st = (value) => { thread = value; }; R.su = () => { thread = main; };
  R.register({ name: "java/lang/Object", ctor: class extends JObj {}, methods: { "<init>()V"() {} } });
  R.register({ name: "java/lang/Throwable", ctor: class extends JObj {} });
  R.register({ name: "java/lang/Exception", sup: "java/lang/Throwable", ctor: class extends JObj {} });
  R.register({ name: "java/lang/RuntimeException", sup: "java/lang/Exception", ctor: class extends JObj {} });
  R.mkThrowable = (name, message) => Object.assign(R.make(name), { message });
  R.register({ name: "JvmTierProbe$Host", ctor: class extends JObj {}, methods: {
    "static call(II)I"(which: number, value: number) {
      seen.push([value, thread]);
      if (which && callback) return callback(value);
      return park && which ? new Promise<number>((resolve, reject) => pending.push({ resolve, reject })) : value;
    },
  } });
  const dex = new DexFile(bytes);
  R.loadDex(dex);
  setLazyMethods(mode !== "hot");
  try {
    for (let i = 0; i < dex.classDefCount; i++) R.ensureCompiled(R.link(descToName(dex.type(dex.classDef2Type(i)))));
  } finally { setLazyMethods(true); }
  const info = R.link("JvmTierProbe");
  await R.initClass(info);
  const fn = (name: string, desc: string): ((...args: unknown[]) => unknown) => {
    const value: unknown = Reflect.get(info.ctor, mangleMethod(name, desc));
    if (typeof value !== "function") throw new Error("missing fixture method " + name);
    return (...args) => { thread = worker; return value(...args); };
  };
  const warm = async (name: string, desc: string, args: unknown[]) => {
    const call = fn(name, desc);
    if (mode === "denied") R.hotSourceBytes = 32 * 1024 * 1024;
    if (mode === "promoted" || mode === "denied") for (let i = 0; i < 33; i++) await call(...args);
    seen.length = 0;
    return call;
  };
  const next = async () => {
    for (let i = 0; i < 32 && !pending.length; i++) await Promise.resolve();
    const value = pending.shift();
    if (!value) throw new Error("fixture did not suspend");
    return value;
  };
  return { R, worker, main, seen, fn, warm, next, thread: () => thread, park: () => { park = true; },
    reenter: (call: (value: number) => unknown) => { callback = call; } };
}

test("DEX tiers preserve constants, CFG joins, wide values and nulls", async () => {
  for (const mode of modes) {
    const f = await fixture(mode);
    const constants = await f.warm("constants", "(I)F", [0]);
    for (const [value, expected] of [[0, 1.75], [1, -2], [2, 4.25]]) expect(await constants(value)).toBe(expected);
    const zero = await f.warm("negativeZero", "(I)F", [0]);
    expect(Object.is(await zero(0), -0)).toBe(true);
    const wide = await f.warm("wide", "(J)J", [1n]);
    expect(await wide(9007199254740993n)).toBe(BigInt.asIntN(64, (9007199254740993n << 9n) ^ -1234567890123n));
    const nullable = await f.warm("nullValue", "(Ljava/lang/Object;)Z", [null]);
    expect(await nullable(null)).toBe(1); expect(await nullable({})).toBe(0);
    expect(f.R.missing.size).toBe(0);
  }
});

test("DEX tiers retain synchronous prefixes, catch/finally and thread identity across suspension", async () => {
  for (const mode of modes) for (const reject of [false, true]) {
    const f = await fixture(mode), call = await f.warm("suspended", "(II)I", [0, 7]);
    f.park();
    const result = call(1, 7);
    expect(f.seen.map(([value]) => value)).toEqual([-1, 7]);
    const pending = await f.next();
    // a call that suspends leaves its caller's thread; the activation releases it once resumed
    expect(f.thread()).toBe(f.worker);
    if (reject) pending.reject(f.R.mkThrowable("java/lang/RuntimeException", "probe")); else pending.resolve(7);
    expect(await result).toBe(reject ? -1 : 8);
    expect(f.seen.map(([value]) => value)).toEqual([-1, 7, reject ? 3 : 2, 4]);
    expect(f.seen.every(([, thread]) => thread === f.worker)).toBe(true);
    expect(f.thread()).toBe(f.main);
  }
});

test("DEX tiers preserve native callbacks that re-enter the active Java method", async () => {
  for (const mode of modes) {
    const f = await fixture(mode), call = await f.warm("suspended", "(II)I", [0, 7]);
    f.reenter((value) => {
      expect(f.thread()).toBe(f.worker);
      return call(0, value);
    });
    // Nothing suspends, so the re-entrant activation completes synchronously on its thread.
    expect(call(1, 7)).toBe(9);
    expect(f.seen.map(([value]) => value)).toEqual([-1, 7, -1, 7, 2, 4, 2, 4]);
    expect(f.seen.every(([, thread]) => thread === f.worker)).toBe(true);
    expect(f.thread()).toBe(f.worker);
  }
});

test("DEX resumes successive class-init and method suspensions at the same invoke", async () => {
  for (const mode of ["hot", "cold"] as const) {
    const f = await fixture(mode);
    f.park();
    const result = f.fn("late", "(I)I")(8);
    (await f.next()).resolve(41);
    (await f.next()).resolve(8);
    expect(await result).toBe(49);
    expect(f.seen.map(([value]) => value)).toEqual([41, 8]);
    expect(f.seen.every(([, thread]) => thread === f.worker)).toBe(true);
  }
});

test("DEX backedges yield and captured direct/interface entries follow promotion", async () => {
  for (const mode of modes) {
    const f = await fixture(mode), loop = await f.warm("loop", "(I)I", [3]);
    let yields = 0;
    f.R.fuel = 0;
    f.R.refuel = () => { f.R.fuel = 2; yields++; return Promise.resolve(); };
    expect(await loop(9)).toBe(36); expect(yields).toBeGreaterThan(0);
    const worker = f.R.link("JvmTierProbe$Worker");
    await f.R.initClass(worker);
    const instance = new worker.ctor();
    const direct = f.R.dexLink(worker.dex!).rdp0(worker.def!.directMethods.find((method) => worker.dex!.method(method.methodIdx).name === "twice")!.methodIdx);
    const call = await f.warm("dispatch", "(LJvmTierProbe$Callable;I)I", [instance, 1]);
    // an interface default reaching its private method on an implementor
    const composed = await f.warm("composed", "(LJvmTierProbe$Callable;I)I", [instance, 1]);
    for (let i = 0; i < 40; i++) {
      expect(await call(instance, i)).toBe(i * 2 + 1);
      expect(await direct.call(instance, i)).toBe(i * 2);
      expect(await composed(instance, i)).toBe(i * 2 + 4);
    }
  }
});

test("DEX promotes a long-running cold activation at a yielded backedge", async () => {
  const f = await fixture("cold"), loop = f.fn("loop", "(I)I");
  const before = perf.osrMethods;
  f.R.fuel = 0;
  f.R.refuel = () => { f.R.fuel = 128; return Promise.resolve(); };
  expect(await loop(2000)).toBe(1_999_000);
  expect(perf.osrMethods).toBe(before + 1);
  expect(await loop(9)).toBe(36);
});

test("JVM profiling follows installed hot methods through suspension", async () => {
  configureJvm({ profile: true, tier: "js" });
  try {
    const f = await fixture("cold");
    f.park();

    const lazy = f.fn("suspended", "(II)I");
    const first = lazy(1, 7);
    (await f.next()).resolve(7);
    expect(await first).toBe(8);

    jvmProfiler.reset();
    const installed = f.fn("suspended", "(II)I");
    const result = installed(1, 7);
    (await f.next()).resolve(7);
    expect(await result).toBe(8);

    const method = jvmProfiler.snapshot().methods.find((entry) => entry.name === "JvmTierProbe.suspended(II)I");
    expect(method?.entries).toBe(1);
    expect(method?.suspensions).toBe(1);
  } finally {
    configureJvm({ profile: false, tier: "auto" });
    jvmProfiler.reset();
  }
});

test("a native spec's missing methods fall through to platform bodies that only touch its fields", async () => {
  const R = new Runtime();
  R.register({ name: "java/lang/Object", ctor: class extends JObj {}, methods: { "<init>()V"() {} } });
  R.mkThrowable = (name, message) => Object.assign(new Error(message ?? ""), { $javaClass: name });
  R.register({ name: "JvmTierProbe$Host", ctor: class extends JObj {}, methods: { "static call(II)I": (_: number, v: number) => v } });
  R.register({ name: "JvmTierProbe$Worker", ctor: class extends JObj {}, methods: { "<init>()V"() {} } });
  R.register({ name: "JvmTierProbe$Late", ctor: class extends JObj {} });
  R.loadDex(new DexFile(bytes), true);
  const worker = R.make("JvmTierProbe$Worker");
  expect(worker[mangleMethod("apply", "(I)I")](20)).toBe(41);
  const late = R.link("JvmTierProbe$Late").ctor;
  expect(() => late[mangleMethod("get", "(I)I")](1)).toThrow("unsafe-fallthrough JvmTierProbe$Late.get(I)I JvmTierProbe$Late.value");
});

test("a native class's absent field throws on read until something writes it", async () => {
  const R = new Runtime();
  R.register({ name: "java/lang/Object", ctor: class extends JObj {} });
  R.register({ name: "InvokeProbe", ctor: class extends JObj {} });
  R.mkThrowable = (name, message) => Object.assign(new Error(message ?? ""), { $javaClass: name });
  const dex = new DexFile(new Uint8Array(await Bun.file(import.meta.dir + "/fixtures/InvokeProbe.dex").arrayBuffer()));
  const def = [...Array(dex.classDefCount).keys()].map((i) => dex.classDef(i)).find((d) => dex.type(d.typeIdx) === "LInvokeProbe;")!;
  const obj = R.make("InvokeProbe"), prop = R.resolveInstanceField(dex, def.instanceFields[0].fieldIdx);
  expect(() => obj[prop]).toThrow("is not a field of the native class");
  obj[prop] = 7;
  expect(obj[prop]).toBe(7);
  expect(() => R.make("InvokeProbe")[prop]).toThrow();
});

test("each placeholder records its first caller, then answers as before", () => {
  const R = new Runtime();
  R.register({ name: "java/lang/Object", ctor: class extends JObj {} });
  R.register({ name: "PlaceholderProbe", ctor: class extends JObj {}, methods: stubs(7, "a()I", "static b()I") });
  R.javaFrames = () => ["Caller.run()V"];
  const ctor = R.link("PlaceholderProbe").ctor, obj = R.make("PlaceholderProbe"), a = mangleMethod("a", "()I");
  expect(isPlaceholderMethod(obj[a])).toBe(true);
  expect(obj[a]()).toBe(7);
  expect(obj[a]()).toBe(7);
  expect(ctor[mangleMethod("b", "()I")]()).toBe(7);
  expect([...R.placeholders]).toEqual(["PlaceholderProbe.a()I", "PlaceholderProbe.b()I"]);
  expect(R.placeholderAt.get("PlaceholderProbe.a()I")).toEqual(["Caller.run()V"]);
  expect(isPlaceholderMethod(obj[a])).toBe(true);
});

test("persisted bodies install hot from the first call and behave as compiled ones", async () => {
  const { codeText, useCode } = await import("../src/jvm/codecache");
  const recorded = await fixture("promoted"), wide = await recorded.warm("wide", "(J)J", [1n]);
  const expected = await wide(9007199254740993n);
  const text = codeText();
  expect(text).toContain(":e\":((C,D,R,S,P,$R)=>{");
  useCode((await import(URL.createObjectURL(new Blob([text], { type: "text/javascript" })))).default);
  try {
    const cold = perf.coldCalls, persisted = await fixture("cold"), call = persisted.fn("wide", "(J)J");
    expect(await call(9007199254740993n)).toBe(expected);
    expect(perf.coldCalls).toBe(cold);
  } finally { useCode({}); }
});

test("idle preparation belongs to each method instance and preserves suspended frames and cached bodies", async () => {
  const callbacks: IdleRequestCallback[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "requestIdleCallback");
  Object.defineProperty(globalThis, "requestIdleCallback", { configurable: true,
    value: (callback: IdleRequestCallback) => { callbacks.push(callback); return callbacks.length; } });
  const flush = () => { while (callbacks.length) callbacks.shift()!({ timeRemaining: () => 1000, didTimeout: false }); };
  try {
    const f = await fixture("cold"), sibling = await fixture("cold");
    const call = f.fn("suspended", "(II)I"), other = sibling.fn("suspended", "(II)I");
    f.park();
    const first = call(1, 7), pending = await f.next();
    other(0, 7);
    flush();
    pending.resolve(7);
    expect(await first).toBe(8);
    const compiledBytes = f.R.hotSourceBytes;
    expect(compiledBytes).toBeGreaterThan(sibling.R.hotSourceBytes);
    const read = spyOn(f.R.link("JvmTierProbe").dex!, "code");
    try {
      const cold = perf.coldCalls, second = call(1, 8);
      (await f.next()).resolve(8);
      expect(await second).toBe(9);
      expect(other(0, 8)).toBe(9);
      expect(perf.coldCalls).toBe(cold);
      expect(f.R.hotSourceBytes).toBe(compiledBytes);
      expect(read).not.toHaveBeenCalled();
      expect(f.thread()).toBe(f.main);
    } finally { read.mockRestore(); }
    // Source recorded by another instance must not prevent this instance warming.
    const later = await fixture("cold"), third = later.fn("suspended", "(II)I");
    third(0, 7); flush();
    const cold = perf.coldCalls;
    expect(third(0, 8)).toBe(9);
    expect(perf.coldCalls).toBe(cold);

    const cached = await fixture("cold"), fourth = cached.fn("suspended", "(II)I");
    cached.park(); const suspended = fourth(1, 7), completion = await cached.next();
    const rec = cached.R.link("JvmTierProbe").lazy!.find((r) => r.name === "suspended")!;
    let bytesAtBind = -1;
    codecache.useCode({ [codecache.codeKey(rec.dex.id, rec.m.methodIdx, "r")]: () => {
      bytesAtBind = cached.R.hotSourceBytes;
      return () => 0;
    } });
    flush();
    expect(bytesAtBind).toBeGreaterThan(0);
    expect(cached.R.hotSourceBytes).toBe(bytesAtBind);
    completion.resolve(7);
    expect(await suspended).toBe(8);

    const reserved = await fixture("cold"), wide = reserved.fn("wide", "(J)J");
    reserved.R.hotSourceBytes = 24 * 1024 * 1024;
    wide(1n); flush();
    const before = perf.coldCalls;
    wide(1n);
    expect(perf.coldCalls).toBe(before + 1);
    expect(reserved.R.hotSourceBytes).toBe(24 * 1024 * 1024);
    for (let i = 0; i < 31; i++) wide(1n);
    flush();
    const promoted = perf.coldCalls;
    wide(1n);
    expect(perf.coldCalls).toBe(promoted);
    expect(reserved.R.hotSourceBytes).toBeGreaterThan(24 * 1024 * 1024);
  } finally {
    codecache.useCode({});
    flush();
    if (previous) Object.defineProperty(globalThis, "requestIdleCallback", previous);
    else Reflect.deleteProperty(globalThis, "requestIdleCallback");
  }
});
