import { expect, test } from "bun:test";
import { eglInit } from "../src/native/egl";
import { hostFn, type ArgReader } from "../src/native/host";
import { curThread } from "../src/jvm/natives/jlang";
import type { Cpu } from "../src/native/cpu";

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
