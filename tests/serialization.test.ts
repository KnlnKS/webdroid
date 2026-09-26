import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import "../src/natives";
import { newObj, vcall, vcallAsync, vcallOn, JThread, curThread, callOn } from "../src/jvm/natives/jlang";
import { rt, JObj } from "../src/jvm/runtime";
import { hexBytes, i8 } from "../src/jvm/abi";
import { exportParcel, importParcel } from "../src/android/binder";
import { DexFile } from "../src/jvm/dex";

describe("object-stream-external", () => {
  rt.loadDex(new DexFile(new Uint8Array(readFileSync(import.meta.dir + "/fixtures/SerializationProbe.dex"))));
  rt.linkNatives();
  const oracle = "aced00057372001a53657269616c697a6174696f6e50726f6265245061796c6f616400000000000000070c000078707716ffffffffffffffef075bcd150008c080eda0bdedba8071007e00017704000003e77871007e0001";
  const field = (value: object, cls: string, name: string) => Reflect.get(value, rt.link(cls).fieldTable.get(name)!);
  const makeValue = () => newObj("SerializationProbe$Value", "(JI)V", -17n, 123456789);
  async function input(bytes: Int8Array) {
    return newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", await newObj("java/io/ByteArrayInputStream", "([B)V", bytes));
  }
  async function encode(value: unknown) {
    const target = await newObj("java/io/ByteArrayOutputStream");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", target);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
    await vcall(output, "close", "()V");
    return vcall(target, "toByteArray", "()[B");
  }
  function checkValue(value: object) {
    expect(field(value, "SerializationProbe$Value", "seconds")).toBe(-17n);
    expect(field(value, "SerializationProbe$Value", "nanos")).toBe(123456789);
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
    const parcel = await newObj("android/os/Parcel");
    await vcall(parcel, "writeSerializable", "(Ljava/io/Serializable;)V", await makeValue());
    await vcall(parcel, "writeValue", "(Ljava/lang/Object;)V", await makeValue());
    const binder = await newObj("android/os/Binder");
    const wire = exportParcel(parcel);
    expect(wire.objects).toEqual([]);
    await vcall(parcel, "writeStrongBinder", "(Landroid/os/IBinder;)V", binder);
    const transported = importParcel(structuredClone(exportParcel(parcel)));
    checkValue(await vcall(transported, "readSerializable", "()Ljava/io/Serializable;"));
    checkValue(await vcall(transported, "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null));
    expect(await vcall(transported, "readStrongBinder", "()Landroid/os/IBinder;")).toBe(binder);
    const bytes = wire.bytes;
    const copy = await newObj("android/os/Parcel");
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
  test("incompatible serialVersionUID is rejected", async () => {
    const bytes = i8(hexBytes(oracle)); bytes[39] = 8;
    await expect(vcallAsync(await input(bytes), "readObject", "()Ljava/lang/Object;")).rejects.toMatchObject({ msg: expect.stringContaining("serialVersionUID") });
  });
  test("default and custom fields preserve graph identity and initialize only the non-serializable superclass", async () => {
    const oracle = (await Bun.file(import.meta.dir + "/fixtures/SerializationProbe.hex").text()).trim();
    for (const bytes of [i8(hexBytes(oracle)), await encode(await newObj("SerializationProbe$Graph"))]) {
      const graph = await vcall(await input(bytes), "readObject", "()Ljava/lang/Object;");
      const get = (name: string) => field(graph, "SerializationProbe$Graph", name);
      expect([get("flag"), get("small"), get("letter"), get("medium"), get("integer"), get("large"), get("single"), get("wide")])
        .toEqual([1, -123, 65535, -32000, 1234567, -987654321012345n, 1.25, -9.75]);
      expect(get("cycle")).toBe(graph);
      expect(await vcall(get("set"), "size", "()I")).toBe(2);
      expect(await vcall(get("set"), "contains", "(Ljava/lang/Object;)Z", "two")).toBe(1);
      expect(await vcall(get("list"), "get", "(I)Ljava/lang/Object;", 1)).toBe(get("numbers"));
      expect(await vcall(get("list"), "get", "(I)Ljava/lang/Object;", 2)).toBe(graph);
      expect(field(graph, "SerializationProbe$Base", "initialized")).toBe(31);
    }
  });
  test("stream replacement hooks skip null and run once for shared objects", async () => {
    const buffer = await newObj("java/io/ByteArrayOutputStream");
    const output = await newObj("SerializationProbe$Replacing", "(Ljava/io/OutputStream;)V", buffer);
    for (const value of [null, "first", "first"]) await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
    await vcall(output, "close", "()V");
    const bytes = await vcall(buffer, "toByteArray", "()[B");
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", bytes);
    const stream = await newObj("SerializationProbe$Resolving", "(Ljava/io/InputStream;)V", source);
    for (const expected of [null, "resolved", "resolved"]) expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(expected);
    expect(field(output, "SerializationProbe$Replacing", "calls")).toBe(1);
    expect(field(stream, "SerializationProbe$Resolving", "calls")).toBe(1);
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

  test("linked maps retain secret keys through Java object streams", async () => {
    const map = await newObj("java/util/LinkedHashMap");
    const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", Int8Array.of(0, 1, -1, 3), "HmacSHA1");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "one", key);
    const stream = await input(await encode(map));
    const copy = await vcall(stream, "readObject", "()Ljava/lang/Object;");
    expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(copy);
    expect(await vcall(copy, "size", "()I")).toBe(1);
    const restored = await vcall(copy, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "one");
    expect(await vcall(restored, "getAlgorithm", "()Ljava/lang/String;")).toBe("HmacSHA1");
    expect(await vcall(restored, "getEncoded", "()[B")).toEqual(Int8Array.of(0, 1, -1, 3));
  });


  test("serialization retains the caller through nested objects and suspended short reads", async () => {
    const worker = new JThread(), ambient = curThread, calls: string[] = [];
    const record = (name: string) => { expect(curThread).toBe(worker); calls.push(name); };
    rt.register({ name: "test/ThreadExternal", ctor: class extends JObj {}, ifaces: ["java/io/Externalizable"], statics: { serialVersionUID: 1n }, methods: {
      "<init>()V": () => record("init"),
      "writeExternal(Ljava/io/ObjectOutput;)V": async (out: unknown) => {
        record("write"); await Promise.resolve();
        await vcallOn(worker, out, "writeUTF", "(Ljava/lang/String;)V", "\0🚀".repeat(800));
      },
      "readExternal(Ljava/io/ObjectInput;)V": async (input: unknown) => {
        record("read");
        expect(await vcallOn(worker, input, "readUTF", "()Ljava/lang/String;")).toBe("\0🚀".repeat(800));
      },
      "readResolve()Ljava/lang/Object;": function () { record("resolve"); return this; },
    } });
    class ShortInput extends JObj { bytes = new Int8Array(); pos = 0; }
    rt.register({ name: "test/ShortObjectInput", ctor: ShortInput, sup: "java/io/InputStream", methods: {
      "read([BII)I": async function (this: ShortInput, out: Int8Array, offset: number, length: number) {
        expect(curThread).toBe(worker); await Promise.resolve();
        const n = Math.min(length, 17, this.bytes.length - this.pos);
        out.set(this.bytes.subarray(this.pos, this.pos + n), offset); this.pos += n; return n || -1;
      },
    } });
    rt.linkNatives();
    const values = [await callOn(worker, () => newObj("test/ThreadExternal")), await callOn(worker, () => newObj("test/ThreadExternal"))];
    calls.length = 0;
    const buffer = await newObj("java/io/ByteArrayOutputStream");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", buffer);
    await vcallOn(worker, output, "writeObject", "(Ljava/lang/Object;)V", values);
    await vcallOn(worker, output, "close", "()V");
    const source = new ShortInput(); source.bytes = await vcall(buffer, "toByteArray", "()[B");
    const stream = await callOn(worker, () => newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source));
    expect(await vcallOn(worker, stream, "readObject", "()Ljava/lang/Object;")).toHaveLength(2);
    expect(calls).toEqual(["write", "write", "init", "read", "resolve", "init", "read", "resolve"]);
    expect(curThread).toBe(ambient);
  });
});

describe("objectstream", () => {
  rt.linkNatives();

  test("ObjectInputStream consumes complete short blocks and crosses block boundaries", async () => {
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array([
      0xac, 0xed, 0, 5, 0x77, 4, 0x12, 0x34, 0x56, 0x78,
      0x77, 1, 0x11, 0x77, 3, 0x22, 0x33, 0x44,
    ]));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    expect(await vcall(input, "readInt", "()I")).toBe(0x12345678);
    expect(await vcall(input, "readInt", "()I")).toBe(0x11223344);
  });

  test("ObjectOutputStream writes a complete object before explicit flush", async () => {
    const set = await newObj("java/util/TreeSet", "()V");
    await vcall(set, "add", "(Ljava/lang/Object;)Z", await newObj("java/util/UUID", "(JJ)V", 1n, 2n));
    const bytes = await newObj("java/io/ByteArrayOutputStream", "()V");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", bytes);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", set);
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(bytes, "toByteArray", "()[B"));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
    const iterator = await vcall(restored, "iterator", "()Ljava/util/Iterator;");
    const uuid = await vcall(iterator, "next", "()Ljava/lang/Object;");
    expect(await vcall(uuid, "getMostSignificantBits", "()J")).toBe(1n);
    expect(await vcall(uuid, "getLeastSignificantBits", "()J")).toBe(2n);
  });

  test("serialized linked maps retain entries, access order and secret keys", async () => {
    const map = await newObj("java/util/LinkedHashMap", "(IFZ)V", 16, 0.75, 1);
    const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", new Int8Array([1, -2, 3]), "AES");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", key);
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "other", "value");
    const target = await newObj("java/io/ByteArrayOutputStream", "()V");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", target);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", map);
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(target, "toByteArray", "()[B"));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
    expect(await vcall(restored, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "other")).toBe("value");
    const restoredKey = await vcall(restored, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "key");
    expect(await vcall(restoredKey, "getAlgorithm", "()Ljava/lang/String;")).toBe("AES");
    expect([...await vcall(restoredKey, "getEncoded", "()[B")]).toEqual([1, -2, 3]);
    const entries = await vcall(restored, "keySet", "()Ljava/util/Set;");
    const iterator = await vcall(entries, "iterator", "()Ljava/util/Iterator;");
    expect(await vcall(iterator, "next", "()Ljava/lang/Object;")).toBe("other");
    expect(await vcall(iterator, "next", "()Ljava/lang/Object;")).toBe("key");
  });

  test("unmodifiable random-access lists retain their serialized read-only view", async () => {
    const list = await newObj("java/util/ArrayList", "()V");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "saved");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", await newObj("java/util/concurrent/atomic/AtomicInteger", "(I)V", 7));
    const view = await vcall(rt.link("java/util/Collections").ctor, "unmodifiableList", "(Ljava/util/List;)Ljava/util/List;", list);
    const bytes = await newObj("java/io/ByteArrayOutputStream", "()V");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", bytes);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", view);
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(bytes, "toByteArray", "()[B"));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
    expect(rt.iof(restored, "java/util/RandomAccess")).toBe(1);
    expect(await vcall(restored, "get", "(I)Ljava/lang/Object;", 0)).toBe("saved");
    expect(await vcall(await vcall(restored, "get", "(I)Ljava/lang/Object;", 1), "get", "()I")).toBe(7);
    await expect(vcallAsync(restored, "add", "(Ljava/lang/Object;)Z", "new")).rejects.toThrow();
  });
});
