import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mangleMethod, mangleStaticField } from "../abi";
import { rt } from "../runtime";
import { mem } from "../../native/mem";
import { vcall } from "./jlang";
import "./jreflect";
import "./jmemory";

type StaticMethod = (...args: unknown[]) => unknown;

let address = 0;
let memoryClass: Record<string, StaticMethod>;

function call(name: string, descriptor: string, ...args: unknown[]): unknown {
  return memoryClass[mangleMethod(name, descriptor)](...args);
}

function unsafeCall(name: string, descriptor: string, ...args: unknown[]): unknown {
  const unsafeClass = rt.link("sun/misc/Unsafe").ctor;
  const unsafe = unsafeClass[mangleStaticField("theUnsafe")];
  return unsafe[mangleMethod(name, descriptor)](...args);
}

test("Unsafe.getUnsafe returns the same instance exposed through theUnsafe", () => {
  const cls = rt.link("sun/misc/Unsafe").ctor;
  expect(cls[mangleMethod("getUnsafe", "()Lsun/misc/Unsafe;")]()).toBe(cls[mangleStaticField("theUnsafe")]);
});

beforeAll(() => {
  address = mem.malloc(32);
  memoryClass = rt.link("libcore/io/Memory").ctor;
});

afterAll(() => mem.free(address));

describe("libcore.io.Memory", () => {
  test("exposes the 32-bit and 64-bit methods Android libraries probe", async () => {
    const memory = rt.classFor("libcore/io/Memory");
    const probes = [
      ["peekLong", ["boolean"]],
      ["pokeLong", ["long", "boolean"]],
      ["peekInt", ["boolean"]],
      ["pokeInt", ["int", "boolean"]],
      ["peekByte", []],
      ["pokeByte", ["byte"]],
      ["peekByteArray", ["[B", "int", "int"]],
      ["pokeByteArray", ["[B", "int", "int"]],
    ] as const;
    for (const addressType of ["int", "long"]) {
      for (const [name, tail] of probes) {
        const params = [addressType, ...tail].map((type) => rt.classFor(type));
        expect(await vcall(memory, "getMethod", "(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;", name, params)).not.toBeNull();
      }
    }
  });

  test("reads and writes native and swapped scalar values", () => {
    call("pokeInt", "(JIZ)V", BigInt(address), 0x11223344, 0);
    expect([...mem.bytes(address, 4)]).toEqual([0x44, 0x33, 0x22, 0x11]);
    expect(call("peekInt", "(JZ)I", BigInt(address), 0)).toBe(0x11223344);
    expect(call("peekInt", "(JZ)I", BigInt(address), 1)).toBe(0x44332211);

    call("pokeLong", "(JJZ)V", BigInt(address), 0x0102030405060708n, 1);
    expect([...mem.bytes(address, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(call("peekLong", "(JZ)J", BigInt(address), 1)).toBe(0x0102030405060708n);
  });

  test("copies byte array slices through int addresses", () => {
    const input = Int8Array.of(-1, 10, 20, 30, 40, -2);
    call("pokeByteArray", "(I[BII)V", address, input, 1, 4);
    expect([...mem.bytes(address, 4)]).toEqual([10, 20, 30, 40]);

    const output = new Int8Array(6);
    call("peekByteArray", "(I[BII)V", address, output, 1, 4);
    expect([...output]).toEqual([0, 10, 20, 30, 40, 0]);
  });

  test("keeps Unsafe primitive-array offsets byte-addressed", () => {
    expect(unsafeCall("arrayIndexScale", "(Ljava/lang/Class;)I", rt.classFor("[B"))).toBe(1);
    expect(unsafeCall("arrayIndexScale", "(Ljava/lang/Class;)I", rt.classFor("[I"))).toBe(4);
    expect(unsafeCall("arrayIndexScale", "(Ljava/lang/Class;)I", rt.classFor("[J"))).toBe(8);

    const bytes = Int8Array.of(0x44, 0x33, 0x22, 0x11);
    expect(unsafeCall("getInt", "(Ljava/lang/Object;J)I", bytes, 0n)).toBe(0x11223344);
    unsafeCall("putInt", "(Ljava/lang/Object;JI)V", bytes, 0n, 0x55667788);
    expect([...bytes]).toEqual([-120, 0x77, 0x66, 0x55]);
  });

  test("supports Android's aligned byte access through padded tail words", () => {
    for (const length of [1, 3, 5, 7]) {
      const bytes = Int8Array.from({ length }, (_, i) => i + 1);
      const index = length - 1;
      const aligned = BigInt(index & -4);
      const shift = (index & 3) * 8;
      const word = Number(unsafeCall("getInt", "(Ljava/lang/Object;J)I", bytes, aligned));
      expect((word >>> shift) & 0xff).toBe(length);

      const updated = (word & ~(0xff << shift)) | (0x7f << shift);
      unsafeCall("putInt", "(Ljava/lang/Object;JI)V", bytes, aligned, updated);
      expect(bytes[index]).toBe(0x7f);
      expect([...bytes.subarray(0, index)]).toEqual(Array.from({ length: index }, (_, i) => i + 1));
    }
  });

  test("checks byte array arguments", () => {
    expect(() => call("peekByteArray", "(J[BII)V", BigInt(address), null, 0, 1)).toThrow();
    expect(() => call("pokeByteArray", "(J[BII)V", BigInt(address), new Int8Array(2), 1, 2)).toThrow();
    expect(() => call("peekByteArray", "(J[BII)V", -1n, new Int8Array(0), 0, 0)).not.toThrow();
  });
});
