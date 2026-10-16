import { expect, test, describe } from "bun:test";
import "../src/natives.ts";
import { driven, type Gen, rt } from "../src/jvm/runtime.ts";
import { Cpu, setA64 } from "../src/native/cpu.ts";
import { mem } from "../src/native/mem.ts";
import { mainThread, curThread, JThread, setCurThread, vcall } from "../src/jvm/natives/jentry.ts";
import { RET_SENTINEL, PAGE_SIZE, STACK_SIZE } from "../src/native/abi.ts";
import { lookupHost, hostFn, type ArgReader, hostLib, vaList } from "../src/native/host.ts";
import { libcInit } from "../src/native/libc.ts";
import { kernelInit } from "../src/native/syscall.ts";
import { eglInit } from "../src/native/egl.ts";
import { gl } from "../src/android/gl.ts";
import { EglContext } from "../src/android/glsurface.ts";
import { bindEglCurrent, boundEglCurrent, glSurfaces } from "../src/native/egl-current.ts";
import { gles3Init } from "../src/native/gles3.ts";


/** Host-call arguments: integer-class reads consume `ints`, 64-bit reads `longs`, string reads `strings`. */
function args(ints: number[] = [], longs: bigint[] = [], strings: string[] = []): ArgReader {
  let ni = 0, nl = 0, ns = 0;
  const integer = () => ints[ni++] ?? 0;
  return {
    i: integer, u: integer, p: integer, va: () => BigInt(integer()),
    l: () => longs[nl++] ?? 0n, ul: () => BigInt.asUintN(64, longs[nl++] ?? 0n),
    f: integer, d: integer,
    str: () => strings[ns++] ?? "", strAt: () => strings[ns++] ?? "",
  };
}

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

describe("native-descriptor-flags", () => {
  test("native duplication keeps close-on-exec per descriptor", async () => {
    // dup2 is the ARM32 libc's; a 64-bit process reaches dup3 alone
    setA64(false); kernelInit(); libcInit();
    const cpu = new Cpu(mainThread, "descriptor-flags"), out = mem.malloc(8);
    const call = (name: string, ...args: number[]) => {
      const fn = lookupHost(name, "libc.so");
      if (fn === undefined) throw new Error(name);
      return cpu.call(fn, args);
    };
    let read = -1, write = -1, duplicate = -1, above = -1;
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
      // F_DUPFD_CLOEXEC: the lowest free descriptor at or above the argument
      above = await call("fcntl", read, 0x406, 100);
      expect(above).toBe(100);
      expect(await call("fcntl", above, 1)).toBe(1);
    } finally {
      for (const fd of [read, write, duplicate, above]) if (fd >= 0) await call("close", fd);
      mem.free(out); cpu.dispose(); setA64(false);
    }
  });
});

describe("native-egl", () => {
  eglInit();
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

describe("native-gles-errors", () => {
  test("glGetError reaches WebGL only when a call since its last NO_ERROR may have failed, per context", () => {
    const limits: Record<number, number> = { 0x84e0: 0x84c0, 0x8869: 16, 0x8b4d: 32, 0x0d33: 4096, 0x851c: 4096, 0x84e8: 4096 };
    const make = () => {
      const queued: number[] = [];
      return { queries: 0, queued, isContextLost: () => false, getParameter: (p: number) => limits[p] ?? 0, createTexture: () => ({}),
        bindTexture() {}, texParameteri() {}, texStorage2D() {}, texImage2D() {}, texSubImage2D() {}, drawArrays() {},
        getError() { this.queries++; return queued.shift() ?? 0; } };
    };
    const glA = make(), glB = make();
    const contextA = Object.assign(Object.create(EglContext.prototype), { gl: glA, target: null, major: 3 });
    const contextB = Object.assign(Object.create(EglContext.prototype), { gl: glB, target: null, major: 3 });
    const cpuA = { jthread: {} } as Cpu, cpuB = { jthread: {} } as Cpu;
    gles3Init();
    bindEglCurrent(cpuA.jthread, contextA);
    bindEglCurrent(cpuB.jthread, contextB);
    const call = (cpu: Cpu, name: string, ints: number[] = []) => hostFn("libGLESv2.so", name)!(cpu, args(ints));
    const names = mem.malloc(4);

    expect(call(cpuA, "glGetError")).toBe(0);
    expect(glA.queries).toBe(1);
    call(cpuA, "glGenTextures", [1, names]);
    call(cpuA, "glBindTexture", [0x0de1, mem.ld32(names)]);
    call(cpuA, "glTexParameteri", [0x0de1, 0x2801, 0x2601]);
    call(cpuA, "glTexStorage2D", [0x0de1, 1, 0x8058, 64, 64]);
    expect(call(cpuA, "glGetError")).toBe(0);
    expect(glA.queries).toBe(1);

    // the same storage again is an error WebGL raises, so it is asked
    glA.queued.push(0x502);
    call(cpuA, "glTexStorage2D", [0x0de1, 1, 0x8058, 64, 64]);
    expect(call(cpuA, "glGetError")).toBe(0x502);
    expect(call(cpuA, "glGetError")).toBe(0);
    expect(glA.queries).toBe(3);
    call(cpuA, "glDrawArrays", [4, 0, 3]);
    call(cpuA, "glGetError");
    expect(glA.queries).toBe(4);

    // a level glTexImage2D specified takes uploads in its own format and bounds without asking
    const plane = mem.malloc(64 * 64);
    expect(call(cpuA, "glGetError")).toBe(0);
    const queried = glA.queries;
    call(cpuA, "glGenTextures", [1, names]);
    call(cpuA, "glBindTexture", [0x0de1, mem.ld32(names)]);
    call(cpuA, "glTexImage2D", [0x0de1, 0, 0x1909, 64, 64, 0, 0x1909, 0x1401, 0]);
    call(cpuA, "glTexSubImage2D", [0x0de1, 0, 0, 0, 64, 64, 0x1909, 0x1401, plane]);
    expect(call(cpuA, "glGetError")).toBe(0);
    expect(glA.queries).toBe(queried);
    call(cpuA, "glTexSubImage2D", [0x0de1, 0, 1, 0, 64, 64, 0x1909, 0x1401, plane]);
    call(cpuA, "glGetError");
    expect(glA.queries).toBe(queried + 1);

    // an error GL raises host-side stays with its context
    call(cpuB, "glShaderBinary");
    expect(call(cpuA, "glGetError")).toBe(0);
    expect(call(cpuB, "glGetError")).toBe(0x500);
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
