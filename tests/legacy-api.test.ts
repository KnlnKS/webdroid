import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { Resources } from "../src/android/res";
import { JAssetManager, type JResources } from "../src/android/resnative";
import { PROCESS_PID } from "../src/android/os";

const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

rt.linkNatives();

test("ByteBuffer absolute long and double accessors leave the position alone", async () => {
  const buffer = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 24);
  await vcall(buffer, "putLong", "(IJ)Ljava/nio/ByteBuffer;", 8, -2n);
  await vcall(buffer, "putDouble", "(ID)Ljava/nio/ByteBuffer;", 16, 1.5);
  expect(await vcall(buffer, "getLong", "(I)J", 8)).toBe(-2n);
  expect(await vcall(buffer, "getDouble", "(I)D", 16)).toBe(1.5);
  expect(await vcall(buffer, "position", "()I")).toBe(0);
});

test("Hashtable-style contains is containsValue and rejects null", async () => {
  for (const cls of ["java/util/concurrent/ConcurrentHashMap", "java/util/Hashtable"]) {
    const map = await newObj(cls);
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "k", "v");
    expect(await vcall(map, "contains", "(Ljava/lang/Object;)Z", "v")).toBe(1);
    expect(await vcall(map, "contains", "(Ljava/lang/Object;)Z", "k")).toBe(0);
    await expect(vcall(map, "contains", "(Ljava/lang/Object;)Z", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
  }
});

test("Double.valueOf(String) boxes a parsed value and rejects junk", async () => {
  const boxed = await scall("java/lang/Double", "valueOf", "(Ljava/lang/String;)Ljava/lang/Double;", " 2.5e1 ");
  expect(await vcall(boxed, "doubleValue", "()D")).toBe(25);
  await expect(Promise.resolve().then(() => scall("java/lang/Double", "valueOf", "(Ljava/lang/String;)Ljava/lang/Double;", "x")))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/NumberFormatException").ctor });
});

test("JSONObject copies only the named keys that exist", async () => {
  const source = await newObj("org/json/JSONObject", "(Ljava/lang/String;)V", '{"a":1,"b":"two","c":null}');
  const names = Object.assign(["a", "c", "missing"], { $t: "Ljava/lang/String;" });
  const copy = await newObj("org/json/JSONObject", "(Lorg/json/JSONObject;[Ljava/lang/String;)V", source, names);
  expect(await vcall(copy, "toString", "()Ljava/lang/String;")).toBe('{"a":1,"c":null}');
});

test("HandlerThread.getThreadId is -1 until started, then a stable tid distinct from the main thread's", async () => {
  const thread = await newObj("android/os/HandlerThread", "(Ljava/lang/String;)V", "worker");
  expect(await vcall(thread, "getThreadId", "()I")).toBe(-1);
  await vcall(thread, "start", "()V");
  const tid = await vcall(thread, "getThreadId", "()I");
  expect(tid).toBe(await vcall(thread, "getThreadId", "()I"));
  expect(tid).not.toBe(PROCESS_PID);
  expect(await scall("android/os/Process", "myTid", "()I")).toBe(PROCESS_PID);
});

test("Resources(AssetManager, DisplayMetrics, Configuration) scopes its own configuration and metrics", async () => {
  const host = new Resources(null, {});
  const assets = rt.make("android/content/res/AssetManager") as JAssetManager;
  assets.host = host;
  const config = await newObj("android/content/res/Configuration");
  (config as { densityDpi: number }).densityDpi = 320;
  const metrics = await newObj("android/util/DisplayMetrics");
  (metrics as { widthPixels: number }).widthPixels = 777;
  const res = await newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V", assets, metrics, config) as JResources;
  expect(res.host).not.toBe(host);
  expect((await vcall(res, "getConfiguration", "()Landroid/content/res/Configuration;")).densityDpi).toBe(320);
  const dm = await vcall(res, "getDisplayMetrics", "()Landroid/util/DisplayMetrics;");
  expect(dm.widthPixels).toBe(777);
  expect(dm.density).toBe(2);
  expect(host.dm.widthPixels).not.toBe(777);
  await expect(newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V", null, null, null))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});

test("ZipInputStream walks entries in local order and serves each entry's bytes", async () => {
  const { zipSync } = await import("fflate");
  const zip = zipSync({ "a.txt": new TextEncoder().encode("alpha"), "dir/": new Uint8Array(0), "dir/b.bin": new Uint8Array([1, 2, 3, 4]) }, { level: 6 });
  const input = await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(zip.buffer, zip.byteOffset, zip.length));
  const stream = await newObj("java/util/zip/ZipInputStream", "(Ljava/io/InputStream;)V", input);
  const names: string[] = [], sizes: number[] = [];
  for (let entry = await vcall(stream, "getNextEntry", "()Ljava/util/zip/ZipEntry;"); entry; entry = await vcall(stream, "getNextEntry", "()Ljava/util/zip/ZipEntry;")) {
    names.push(await vcall(entry, "getName", "()Ljava/lang/String;"));
    const out = new Int8Array(16);
    let n = 0;
    for (let r = await vcall(stream, "read", "([BII)I", out, n, 16 - n); r > 0; r = await vcall(stream, "read", "([BII)I", out, n, 16 - n)) n += r;
    sizes.push(n);
    if (names.at(-1) === "a.txt") expect(new TextDecoder().decode(new Uint8Array(out.buffer, 0, n))).toBe("alpha");
    await vcall(stream, "closeEntry", "()V");
  }
  expect(names).toEqual(["a.txt", "dir/", "dir/b.bin"]);
  expect(sizes).toEqual([5, 0, 4]);
});

test("List.containsAll, CharBuffer.wrap and EventObject", async () => {
  const list = await newObj("java/util/ArrayList");
  for (const v of ["x", "y"]) await vcall(list, "add", "(Ljava/lang/Object;)Z", v);
  const other = await newObj("java/util/ArrayList");
  await vcall(other, "add", "(Ljava/lang/Object;)Z", "y");
  expect(await vcall(list, "containsAll", "(Ljava/util/Collection;)Z", other)).toBe(1);
  await vcall(other, "add", "(Ljava/lang/Object;)Z", "z");
  expect(await vcall(list, "containsAll", "(Ljava/util/Collection;)Z", other)).toBe(0);

  const chars = Uint16Array.from("hello", (c) => c.charCodeAt(0));
  const buffer = await scall("java/nio/CharBuffer", "wrap", "([CII)Ljava/nio/CharBuffer;", chars, 1, 3);
  expect(await vcall(buffer, "get", "()C")).toBe("e".charCodeAt(0));
  expect(await vcall(buffer, "remaining", "()I")).toBe(2);

  const event = await newObj("java/util/EventObject", "(Ljava/lang/Object;)V", "src");
  expect(await vcall(event, "getSource", "()Ljava/lang/Object;")).toBe("src");
  await expect(newObj("java/util/EventObject", "(Ljava/lang/Object;)V", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
});

test("DateUtils formats elapsed time and knows today", async () => {
  expect(await scall("android/text/format/DateUtils", "formatElapsedTime", "(J)Ljava/lang/String;", 65n)).toBe("1:05");
  expect(await scall("android/text/format/DateUtils", "formatElapsedTime", "(J)Ljava/lang/String;", 3725n)).toBe("1:02:05");
  expect(await scall("android/text/format/DateUtils", "isToday", "(J)Z", BigInt(Date.now()))).toBe(1);
  expect(await scall("android/text/format/DateUtils", "isToday", "(J)Z", BigInt(Date.now() - 2 * 86400000))).toBe(0);
});
