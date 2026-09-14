import { expect, test } from "bun:test";
import { Runtime, JObj } from "../src/jvm/runtime";
import { DexFile } from "../src/jvm/dex";
import { mangleMethod, descToName } from "../src/jvm/abi";
import { setLazyMethods } from "../src/jvm/compiler";

const bytes = new Uint8Array(await Bun.file(import.meta.dir + "/fixtures/JvmTierProbe.dex").arrayBuffer());
const modes = ["hot", "cold", "promoted", "denied"] as const;
type Mode = typeof modes[number];
async function fixture(mode: Mode) {
  const R = new Runtime(), worker = {}, main = {};
  let thread: unknown = worker;
  const seen: [number, unknown][] = [];
  const pending: { resolve: (value: number) => void; reject: (error: unknown) => void }[] = [];
  let park = false;
  R.th = () => thread; R.st = (value) => { thread = value; }; R.su = () => { thread = main; };
  R.register({ name: "java/lang/Object", ctor: class extends JObj {}, methods: { "<init>()V"() {} } });
  R.register({ name: "java/lang/Throwable", ctor: class extends JObj {} });
  R.register({ name: "java/lang/Exception", sup: "java/lang/Throwable", ctor: class extends JObj {} });
  R.register({ name: "java/lang/RuntimeException", sup: "java/lang/Exception", ctor: class extends JObj {} });
  R.mkThrowable = (name, message) => Object.assign(R.make(name), { message });
  R.register({ name: "JvmTierProbe$Host", ctor: class extends JObj {}, methods: {
    "static call(II)I"(which: number, value: number) {
      seen.push([value, thread]);
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
  return { R, worker, main, seen, fn, warm, next, thread: () => thread, park: () => { park = true; } };
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
    expect(f.thread()).toBe(f.main);
    if (reject) pending.reject(f.R.mkThrowable("java/lang/RuntimeException", "probe")); else pending.resolve(7);
    expect(await result).toBe(reject ? -1 : 8);
    expect(f.seen.map(([value]) => value)).toEqual([-1, 7, reject ? 3 : 2, 4]);
    expect(f.seen.every(([, thread]) => thread === f.worker)).toBe(true);
    expect(f.thread()).toBe(f.main);
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
    for (let i = 0; i < 40; i++) {
      expect(await call(instance, i)).toBe(i * 2 + 1);
      expect(await direct.call(instance, i)).toBe(i * 2);
    }
  }
});
