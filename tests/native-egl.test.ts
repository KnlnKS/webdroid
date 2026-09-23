import { expect, test } from "bun:test";
import { eglInit } from "../src/native/egl";
import { hostFn, type ArgReader } from "../src/native/host";
import { curThread } from "../src/jvm/natives/jlang";
import type { Cpu } from "../src/native/cpu";
import { setA64 } from "../src/native/cpu";
import { mem } from "../src/native/mem";

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
