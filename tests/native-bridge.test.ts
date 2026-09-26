import { expect, test, describe } from "bun:test";
import "../src/natives";
import { driven, type Gen, rt, JObj } from "../src/jvm/runtime";
import { Cpu, setA64 } from "../src/native/cpu";
import { mem } from "../src/native/mem";
import { mainThread, newObj, curThread, JThread, setCurThread, vcall } from "../src/jvm/natives/jlang";
import { RET_SENTINEL, PAGE_SIZE, STACK_SIZE } from "../src/native/abi";
import { mkIter } from "../src/jvm/natives/jutil";
import { lookupHost, hostFn, type ArgReader, hostLib, vaList } from "../src/native/host";
import { stdioInit } from "../src/native/stdio";
import { eglInit } from "../src/native/egl";
import { gl } from "../src/android/gl";
import { EglContext } from "../src/android/glview";
import { bindEglCurrent, boundEglCurrent, glSurfaces } from "../src/native/egl-current";
import { gles3Init } from "../src/native/gles3";

describe("driven", () => {
  test("generator natives receive arguments past their defaulted parameters", () => {
    // caller-sensitive natives (System.load) take the caller's Runtime this way
    const native = driven(function* (path: string, owner = "root"): Gen { return `${path}@${owner}`; }) as (...a: unknown[]) => unknown;
    expect(native("lib.so", "child")).toBe("lib.so@child");
    expect(native("lib.so")).toBe("lib.so@root");
  });
});

describe("native-arm-status", () => {
  test("Thumb APSR transfer preserves condition flags", () => {
    setA64(false);
    const address = mem.malloc(32);
    const code = [0x2000, 0x2800, 0xf3ef, 0x8300, 0x2001, 0xf383, 0x8800, 0xf3ef, 0x8200, 0x4770];
    code.forEach((word, i) => mem.st16(address + i * 2, word));
    const cpu = new Cpu(mainThread, "apsr-test");
    cpu.w[28] = RET_SENTINEL;
    cpu.setPc(address | 1);
    expect(cpu.runSlice(32)).toBe(2);
    expect(cpu.w[4] & 0xf0000000).toBe(0x60000000);
  });
});

describe("native-construction-thread", () => {
  rt.linkNatives();
  test("native construction retains the caller thread through class initialization", async () => {
    const thread = new JThread(), seen: JThread[] = [];
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    rt.register({ name: "test/ThreadConstruction", ctor: class extends JObj {
      constructor() { super(); seen.push(curThread); }
    }, clinit: () => ready, methods: {
      "<init>()V": () => { seen.push(curThread); },
    } });
    setCurThread(thread);
    const creating = newObj("test/ThreadConstruction");
    setCurThread(mainThread);
    finish();
    await creating;
    expect(seen.map(t => t === thread)).toEqual([true, true]);
    expect(curThread).toBe(mainThread);
  });
});

describe("native-defaults", () => {
  class Consumer extends JObj { values: unknown[] = []; }
  rt.register({ name: "test/NativeIteratorConsumer", ctor: Consumer, ifaces: ["java/util/function/Consumer"], methods: {
    "accept(Ljava/lang/Object;)V": function (this: Consumer, value: unknown) { this.values.push(value); },
  } });
  rt.linkNatives();

  test("native-created iterators receive interface defaults without explicit class initialization", async () => {
    const iterator = mkIter(["first", "second", "third"]), consumer = new Consumer();
    expect(await vcall(iterator, "next", "()Ljava/lang/Object;")).toBe("first");
    await vcall(iterator, "forEachRemaining", "(Ljava/util/function/Consumer;)V", consumer);
    expect(consumer.values).toEqual(["second", "third"]);
    expect(await vcall(iterator, "hasNext", "()Z")).toBe(0);
    await vcall(iterator, "remove", "()V");
    expect(iterator.arr).toEqual(["first", "second"]);
  });
});

describe("native-descriptor-flags", () => {
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
});

describe("native-egl", () => {
  eglInit();

  function args(ints: number[] = [], longs: bigint[] = [], strings: string[] = []): ArgReader {
    let ni = 0, nl = 0, ns = 0;
    const integer = () => ints[ni++] ?? 0;
    return {
      i: integer, u: integer, p: integer, va: () => BigInt(integer()),
      l: () => longs[nl++] ?? 0n, ul: () => BigInt.asUintN(64, longs[nl++] ?? 0n),
      f: integer, d: integer, vd: integer,
      str: () => strings[ns++] ?? "", strAt: () => strings[ns++] ?? "",
    };
  }

  const cpu = { jthread: curThread } as Cpu;

  test("EGL config arrays use guest pointer width while counts remain EGLint", () => {
    const p = mem.malloc(16);
    try {
      for (const a64 of [false, true]) {
        setA64(a64);
        for (const name of ["eglGetConfigs", "eglChooseConfig"]) {
          mem.u8.fill(0xff, p, p + 16);
          const values = name === "eglGetConfigs" ? [1, p, 1, p + 8] : [1, 0, p, 1, p + 8];
          expect(hostFn("libEGL.so", name)!(cpu, args(values))).toBe(1);
          expect(mem.ld32(p)).toBe(1);
          expect(mem.ld32(p + 4)).toBe(a64 ? 0 : -1);
          expect(mem.ld32(p + 8)).toBe(1);
          expect(mem.ld32(p + 12)).toBe(-1);
        }
      }
    } finally { mem.free(p); setA64(false); }
  });

  test("EGL advertises and resolves presentation timestamps", () => {
    const query = hostFn("libEGL.so", "eglQueryString");
    const proc = hostFn("libEGL.so", "eglGetProcAddress");
    if (!query || !proc) throw new Error("EGL hosts are not registered");
    expect(query(cpu, args([1, 0x3055]))).not.toBe(0);
    expect(proc(cpu, args([], [], ["eglPresentationTimeANDROID"]))).not.toBe(0);
  });

  test("eglPresentationTimeANDROID validates and accepts surfaces", () => {
    const create = hostFn("libEGL.so", "eglCreatePbufferSurface");
    const present = hostFn("libEGL.so", "eglPresentationTimeANDROID");
    const error = hostFn("libEGL.so", "eglGetError");
    if (!create || !present || !error) throw new Error("EGL hosts are not registered");
    expect(present(cpu, args([1, 99], [123n]))).toBe(0);
    expect(error(cpu, args())).toBe(0x300d);
    const surface = create(cpu, args([1, 1, 0]));
    if (typeof surface !== "number") throw new Error("pbuffer surface has no numeric handle");
    expect(present(cpu, args([1, surface], [123n]))).toBe(1);
  });
});

describe("native-egl-thread-current", () => {
  function args(values: number[]): ArgReader {
    let index = 0;
    const next = () => values[index++] ?? 0;
    return { i: next, u: next, p: next, va: () => BigInt(next()), l: () => BigInt(next()), ul: () => BigInt(next()),
      f: next, d: next, vd: next, str: () => "", strAt: () => "" };
  }

  test("unbinding one EGL thread does not clear another thread's GLES context", () => {
    const calls: number[] = [];
    const glA = { activeTexture: () => {}, getParameter: () => 0x84c0 };
    const glB = { activeTexture: (texture: number) => calls.push(texture), getParameter: () => 0x84c0 };
    const contextA = Object.assign(Object.create(EglContext.prototype), { gl: glA, target: null, major: 2 });
    const contextB = Object.assign(Object.create(EglContext.prototype), { gl: glB, target: null, major: 2 });
    const cpuA = { jthread: {} }, cpuB = { jthread: {} };

    gles3Init();
    eglInit();
    bindEglCurrent(cpuA.jthread, contextA);
    bindEglCurrent(cpuB.jthread, contextB);
    const makeCurrent = hostFn("libEGL.so", "eglMakeCurrent");
    if (!makeCurrent) throw new Error("EGL host is not registered");
    makeCurrent(cpuA as Cpu, args([1, 0, 0, 0]));
    expect(glSurfaces.current).toBeNull();

    const activeTexture = hostFn("libGLESv2.so", "glActiveTexture");
    if (!activeTexture) throw new Error("GLES host is not registered");
    activeTexture(cpuB as Cpu, args([0x84c1]));

    expect(boundEglCurrent(cpuB.jthread)).toBe(contextB);
    expect(gl).toBe(contextB.gl);
    expect(calls).toEqual([0x84c1]);
  });

  test("Java EGL current state is visible to native GLES on the same thread", async () => {
    gles3Init();
    const original = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
    const calls: number[] = [];
    const context = { isContextLost: () => false, activeTexture: (texture: number) => calls.push(texture), getParameter: () => 0x84c0 };
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: class {
      width: number; height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return context; }
    } });
    const previous = curThread, thread = new JThread(), cpu = { jthread: thread } as Cpu;
    setCurThread(thread);
    try {
      const egl = rt.make("javax/microedition/khronos/egl/EGL10");
      const display = await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null);
      const eglContext = await vcall(egl, "eglCreateContext", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljavax/microedition/khronos/egl/EGLContext;[I)Ljavax/microedition/khronos/egl/EGLContext;", display, null, null, null);
      const surface = await vcall(egl, "eglCreatePbufferSurface", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;[I)Ljavax/microedition/khronos/egl/EGLSurface;", display, null, null);
      expect(await vcall(egl, "eglMakeCurrent", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z", display, surface, surface, eglContext)).toBe(1);
      expect(boundEglCurrent(thread)).toBe((eglContext as { egl: EglContext }).egl);

      const activeTexture = hostFn("libGLESv2.so", "glActiveTexture");
      if (!activeTexture) throw new Error("GLES host is not registered");
      activeTexture(cpu, args([0x84c2]));
      expect(calls).toEqual([0x84c2]);
    } finally {
      bindEglCurrent(thread, null);
      setCurThread(previous);
      if (original) Object.defineProperty(globalThis, "OffscreenCanvas", original);
      else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    }
  });
});

describe("native-mapped-residency", () => {
  test("reserved native mappings become resident on commit and disappear on unmap", () => {
    setA64(true);
    const base = BigInt(mem.mapVa(STACK_SIZE, true));
    expect(base).not.toBe(0n);
    try {
      expect(mem.residentVa(base)).toBe(0);
      expect(mem.commitVa(base, PAGE_SIZE)).toBe(true);
      expect(mem.residentVa(base)).toBe(1);
      expect(mem.residentVa(base + BigInt(PAGE_SIZE))).toBe(0);
    } finally {
      expect(mem.unmapVa(base, STACK_SIZE)).toBe(true);
      expect(mem.residentVa(base)).toBe(-1);
      setA64(false);
    }
  });

  test("nested native calls keep the high half of a mapped stack pointer", async () => {
    setA64(true);
    const base = BigInt(mem.mapVa(STACK_SIZE, false));
    const cpu = new Cpu(mainThread, "high-stack-callback");
    const guestSp = base + 0x8000n;
    let observed = 0n;
    hostLib("libc.so", {
      webdroid_test_inner_stack: c => {
        observed = (BigInt(c.w[63] >>> 0) << 32n) | BigInt(c.w[62] >>> 0);
        return 0;
      },
      webdroid_test_outer_stack: async c => {
        c.w[62] = Number(guestSp & 0xffffffffn); c.w[63] = Number(guestSp >> 32n);
        await c.call(lookupHost("webdroid_test_inner_stack", "libc.so")!);
        return 0;
      },
    });
    try {
      await cpu.call(lookupHost("webdroid_test_outer_stack", "libc.so")!);
      expect(observed).toBe(guestSp - 64n);
      expect(mem.txVa(observed)).toBe(mem.txVa(guestSp) - 64);
    } finally {
      cpu.dispose(); mem.unmapVa(base, STACK_SIZE); setA64(false);
    }
  });
});

describe("valist", () => {
  test("an AAPCS64 va_list serves stack arguments without touching a register-area pointer it never uses", () => {
    setA64(true);
    const list = mem.reserve(4096, 4096), stack = list + 256;
    mem.st32(stack, 42); mem.st32(stack + 4, 0);
    mem.st64(stack + 8, 0x1122334455667788n);
    mem.st32(list, stack); mem.st32(list + 4, 0);          // __stack
    // no register argument was saved, so clang built __gr_top and __vr_top from whatever the
    // slots held: a value that is not an address must not be translated
    mem.st32(list + 8, 0); mem.st32(list + 12, 0xffffff80 | 0);
    mem.st32(list + 16, 0); mem.st32(list + 20, 0xffffff80 | 0);
    mem.st32(list + 24, 0); mem.st32(list + 28, -128);     // __gr_offs exhausted, __vr_offs untouched
    const args = vaList(list);
    expect(args.i()).toBe(42);
    expect(args.l()).toBe(0x1122334455667788n);
  });
});
