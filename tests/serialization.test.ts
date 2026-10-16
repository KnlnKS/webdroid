import { expect, test, describe } from "vite-plus/test";
import { readFileSync } from "node:fs";
import "../src/natives.ts";
import { newObj, vcall, scall } from "../src/jvm/natives/jentry.ts";
import { getDeclared } from "../src/jvm/runtime.ts";
import { loadDex } from "../src/jvm/tier.ts";
import { hexBytes, i8 } from "../src/jvm/abi.ts";
import { exportParcel, importParcel } from "../src/android/binder.ts";
import { nativeParcel } from "../src/android/parcel.ts";
import { DexFile } from "../src/jvm/dex.ts";


async function input(bytes: Int8Array) {
  return newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", await newObj("java/io/ByteArrayInputStream", "([B)V", bytes));
}
/** Java serialization of `value` written twice, so the second copy is a back reference. */
async function encode(value: unknown) {
  const target = await newObj("java/io/ByteArrayOutputStream");
  const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", target);
  await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
  await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
  await vcall(output, "close", "()V");
  return vcall(target, "toByteArray", "()[B");
}

describe("object-stream-external", () => {
  // on the boot class path, where ObjectInputStream resolves a class when no app code is on the stack
  loadDex(new DexFile(new Uint8Array(readFileSync(import.meta.dirname + "/fixtures/SerializationProbe.dex"))), true);
  const oracle = "aced00057372001a53657269616c697a6174696f6e50726f6265245061796c6f616400000000000000070c000078707716ffffffffffffffef075bcd150008c080eda0bdedba8071007e00017704000003e77871007e0001";
  const makeValue = () => newObj("SerializationProbe$Value", "(JI)V", -17n, 123456789);
  function checkValue(value: object) {
    expect(getDeclared<bigint>(value, "SerializationProbe$Value", "seconds")).toBe(-17n);
    expect(getDeclared<number>(value, "SerializationProbe$Value", "nanos")).toBe(123456789);
  }
  test("externalized objects read Java bytes, skip unread data, and resolve repeated references", async () => {
    for (const bytes of [i8(hexBytes(oracle)), await encode(await makeValue())]) {
      const stream = await input(bytes);
      const value = await vcall(stream, "readObject", "()Ljava/lang/Object;");
      checkValue(value);
      expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(value);
    }
  });
  test("Serializable survives Parcel marshalling without object side tables", async () => {
    const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(parcel, "writeSerializable", "(Ljava/io/Serializable;)V", await makeValue());
    await vcall(parcel, "writeValue", "(Ljava/lang/Object;)V", await makeValue());
    const binder = await newObj("android/os/Binder");
    const wire = await exportParcel(nativeParcel(parcel));
    expect(wire.objects).toEqual([]);
    await vcall(parcel, "writeStrongBinder", "(Landroid/os/IBinder;)V", binder);
    const transported = await importParcel(structuredClone(await exportParcel(nativeParcel(parcel))));
    checkValue(await vcall(transported, "readSerializable", "()Ljava/io/Serializable;"));
    checkValue(await vcall(transported, "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null));
    expect(await vcall(transported, "readStrongBinder", "()Landroid/os/IBinder;")).toBe(binder);
    const bytes = wire.bytes;
    const copy = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(copy, "unmarshall", "([BII)V", bytes, 0, bytes.length);
    await vcall(copy, "setDataPosition", "(I)V", 0);
    checkValue(await vcall(copy, "readSerializable", "()Ljava/io/Serializable;"));
    checkValue(await vcall(copy, "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null));
  });
  test("strings use modified UTF and long strings retain back references", async () => {
    for (const value of [null, "\0🚀", "x".repeat(70000)]) {
      const stream = await input(await encode(value));
      expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(value);
      expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(value);
    }
  });
  test("default and custom fields preserve graph identity and initialize only the non-serializable superclass", async () => {
    const oracle = readFileSync(import.meta.dirname + "/fixtures/SerializationProbe.hex", "utf8").trim();
    for (const bytes of [i8(hexBytes(oracle)), await encode(await newObj("SerializationProbe$Graph"))]) {
      const graph = await vcall(await input(bytes), "readObject", "()Ljava/lang/Object;");
      const get = (name: string) => getDeclared(graph, "SerializationProbe$Graph", name);
      expect([get("flag"), get("small"), get("letter"), get("medium"), get("integer"), get("large"), get("single"), get("wide")])
        .toEqual([1, -123, 65535, -32000, 1234567, -987654321012345n, 1.25, -9.75]);
      expect(get("cycle")).toBe(graph);
      expect(await vcall(get("set"), "size", "()I")).toBe(2);
      expect(await vcall(get("set"), "contains", "(Ljava/lang/Object;)Z", "two")).toBe(1);
      // arrays are equal only to themselves
      expect(await vcall(get("numbers"), "equals", "(Ljava/lang/Object;)Z", await vcall(get("list"), "get", "(I)Ljava/lang/Object;", 1))).toBe(1);
      expect(await vcall(get("list"), "get", "(I)Ljava/lang/Object;", 2)).toBe(graph);
      expect(getDeclared<number>(graph, "SerializationProbe$Base", "initialized")).toBe(31);
    }
  });

  test("primitive arrays retain their Java element types and values", async () => {
    for (const value of [Int8Array.of(-128, 127), Int16Array.of(-32768, 32767), Uint16Array.of(0, 65535),
      Int32Array.of(-2147483648, 2147483647), BigInt64Array.of(-9223372036854775808n, 9223372036854775807n),
      Float32Array.of(1.25, -Infinity), Float64Array.of(-9.75, NaN)]) {
      const stream = await input(await encode(value));
      const actual = await vcall(stream, "readObject", "()Ljava/lang/Object;");
      expect(actual).toBeInstanceOf(value.constructor);
      for (let i = 0; i < value.length; i++) expect(Object.is(actual[i], value[i])).toBe(true);
    }
  });

});
