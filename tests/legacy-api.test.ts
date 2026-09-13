import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { Resources } from "../src/android/res";
import { JAssetManager, type JResources } from "../src/android/resnative";
import { PROCESS_PID } from "../src/android/os";

const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

rt.register({ name: "test/NoopRunnable", ctor: class extends JObj {}, ifaces: ["java/lang/Runnable"], methods: { "run()V": function () {} } });
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

test("reached platform queries return device state and default WebView identity", async () => {
  const context = await newObj("android/content/Context");
  expect(await scall("android/provider/Settings", "canDrawOverlays", "(Landroid/content/Context;)Z", context)).toBe(0);
  expect(await scall("android/webkit/WebSettings", "getDefaultUserAgent", "(Landroid/content/Context;)Ljava/lang/String;", context)).toContain("Android 13");
  expect(await vcall(rt.classFor("java/lang/String"), "getAnnotations", "()[Ljava/lang/annotation/Annotation;")).toHaveLength(0);
});

test("Runtime.exec(String) tokenizes the program and reports the unavailable process", async () => {
  const runtime = await scall("java/lang/Runtime", "getRuntime", "()Ljava/lang/Runtime;");
  await expect(vcall(runtime, "exec", "(Ljava/lang/String;)Ljava/lang/Process;", "getprop ro.product.cpu.abi"))
    .rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor, msg: expect.stringContaining('"getprop"') });
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

test("Os.sysconf reports the configured page and processor counts", () => {
  expect(scall("android/system/Os", "sysconf", "(I)J", 0x27)).toBe(4096n);
  expect(scall("android/system/Os", "sysconf", "(I)J", 0x61)).toBe(4n);
  expect(scall("android/system/Os", "sysconf", "(I)J", -1)).toBe(-1n);
});

test("Process.isApplicationUid checks the app id across users", () => {
  expect(scall("android/os/Process", "isApplicationUid", "(I)Z", 10001)).toBe(1);
  expect(scall("android/os/Process", "isApplicationUid", "(I)Z", 210001)).toBe(1);
  expect(scall("android/os/Process", "isApplicationUid", "(I)Z", 1000)).toBe(0);
  expect(scall("android/os/Process", "isApplicationUid", "(I)Z", 90000)).toBe(0);
});

test("security providers retain their constructor metadata", async () => {
  const provider = await newObj("java/security/Provider", "(Ljava/lang/String;DLjava/lang/String;)V", "Test", 1.5, "test provider");
  expect(await vcall(provider, "getName", "()Ljava/lang/String;")).toBe("Test");
  expect(await vcall(provider, "getVersion", "()D")).toBe(1.5);
  expect(await vcall(provider, "getInfo", "()Ljava/lang/String;")).toBe("test provider");
  expect(await vcall(provider, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "Cipher.Test", "Implementation")).toBeNull();
  expect(await vcall(provider, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "Cipher.Test")).toBe("Implementation");
  expect(scall("javax/net/ssl/SSLServerSocketFactory", "getDefault", "()Ljavax/net/ServerSocketFactory;")).not.toBeNull();
  scall("java/security/Security", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)V", "test.key", "value");
  expect(scall("java/security/Security", "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", "test.key")).toBe("value");
});

test("reached JDK utility primitives preserve their Java behavior", async () => {
  const list = await newObj("java/util/ArrayList");
  for (const value of [1, 2, 3, 4]) await vcall(list, "add", "(Ljava/lang/Object;)Z", value);
  const random = await newObj("java/util/Random", "(J)V", 1n);
  await scall("java/util/Collections", "shuffle", "(Ljava/util/List;Ljava/util/Random;)V", list, random);
  expect((list as { a: unknown[] }).a).toEqual([4, 1, 2, 3]);

  const reverse = scall("java/util/Collections", "reverseOrder", "()Ljava/util/Comparator;");
  expect(await vcall(reverse, "compare", "(Ljava/lang/Object;Ljava/lang/Object;)I", "a", "b")).toBeGreaterThan(0);
  expect(scall("java/util/Collections", "reverseOrder", "(Ljava/util/Comparator;)Ljava/util/Comparator;", reverse)).not.toBeNull();

  const levelCtor = rt.link("java/util/logging/Level").ctor as any;
  await rt.initClass(rt.link("java/util/logging/Level"));
  const info = levelCtor[mangleStaticField("INFO")];
  expect(await vcall(info, "intValue", "()I")).toBe(800);
  expect(await vcall(info, "getName", "()Ljava/lang/String;")).toBe("INFO");

  const writer = await newObj("java/io/CharArrayWriter");
  await vcall(writer, "write", "(Ljava/lang/String;)V", "hello");
  expect(await vcall(writer, "size", "()I")).toBe(5);
  expect(Array.from(await vcall(writer, "toCharArray", "()[C"))).toEqual([104, 101, 108, 108, 111]);
  await vcall(writer, "reset", "()V");
  expect(await vcall(writer, "toString", "()Ljava/lang/String;")).toBe("");

  const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/data/read-only");
  expect(await vcall(file, "setReadOnly", "()Z")).toBe(1);
});

test("network support objects retain packet and HTTP parameter state", async () => {
  const address = await scall("java/net/InetAddress", "getByAddress", "([B)Ljava/net/InetAddress;", Int8Array.of(-17, -1, -1, -6));
  const bytes = Int8Array.of(1, 2, 3);
  const packet = await newObj("java/net/DatagramPacket", "([BILjava/net/InetAddress;I)V", bytes, bytes.length, address, 1900);
  expect(await vcall(packet, "getData", "()[B")).toBe(bytes);
  expect(await vcall(packet, "getLength", "()I")).toBe(3);
  expect(await vcall(packet, "getPort", "()I")).toBe(1900);
  expect(await vcall(await vcall(packet, "getAddress", "()Ljava/net/InetAddress;"), "getHostAddress", "()Ljava/lang/String;")).toBe("239.255.255.250");

  const params = await newObj("org/apache/http/params/BasicHttpParams");
  expect(await vcall(params, "setBooleanParameter", "(Ljava/lang/String;Z)Lorg/apache/http/params/HttpParams;", "enabled", 1)).toBe(params);
  expect(await vcall(params, "getBooleanParameter", "(Ljava/lang/String;Z)Z", "enabled", 0)).toBe(1);
  expect(await vcall(params, "getIntParameter", "(Ljava/lang/String;I)I", "missing", 42)).toBe(42);

  const random = await newObj("java/util/Random", "(J)V", 7n);
  const integer = await newObj("java/math/BigInteger", "(ILjava/util/Random;)V", 13, random);
  expect(await vcall(integer, "bitLength", "()I")).toBeLessThanOrEqual(13);
  expect(await vcall(integer, "signum", "()I")).toBeGreaterThanOrEqual(0);

  const server = await newObj("java/net/ServerSocket");
  await expect(vcall(server, "bind", "(Ljava/net/SocketAddress;)V", null)).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
});

test("optional device services report their unavailable state", async () => {
  const agent = await newObj("android/app/backup/BackupAgentHelper");
  const helper = rt.make("android/app/backup/BackupHelper");
  await vcall(agent, "addHelper", "(Ljava/lang/String;Landroid/app/backup/BackupHelper;)V", "prefs", helper);
  const backup = await newObj("android/app/backup/BackupManager", "(Landroid/content/Context;)V", null);
  expect(await vcall(backup, "requestRestore", "(Landroid/app/backup/RestoreObserver;)I", null)).toBe(-1);
  expect(scall("android/hardware/Camera", "getNumberOfCameras", "()I")).toBe(0);
  expect(scall("android/os/VibrationEffect", "createPredefined", "(I)Landroid/os/VibrationEffect;", 0)).not.toBeNull();
  expect(await newObj("android/media/session/MediaController$Callback")).not.toBeNull();
  expect(await newObj("android/media/MediaRoute2ProviderService")).not.toBeNull();

  const builder = scall("android/util/StatsEvent", "newBuilder", "()Landroid/util/StatsEvent$Builder;");
  expect(await vcall(builder, "setAtomId", "(I)Landroid/util/StatsEvent$Builder;", 100)).toBe(builder);
  expect(await vcall(builder, "writeInt", "(I)Landroid/util/StatsEvent$Builder;", 7)).toBe(builder);
  expect(await vcall(builder, "build", "()Landroid/util/StatsEvent;")).not.toBeNull();

  const range = await newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", "b", "d");
  expect(await vcall(range, "contains", "(Ljava/lang/Comparable;)Z", "c")).toBe(1);
  expect(await vcall(range, "clamp", "(Ljava/lang/Comparable;)Ljava/lang/Comparable;", "z")).toBe("d");
});

test("AbstractExecutorService submit returns the virtual newTaskFor result", async () => {
  const executor = scall("java/util/concurrent/Executors", "newSingleThreadExecutor", "()Ljava/util/concurrent/ExecutorService;");
  const runnable = rt.make("test/NoopRunnable");
  const future = await vcall(executor, "submit", "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;", runnable, "done");
  expect(rt.iof(future, "java/util/concurrent/FutureTask")).toBe(1);
  expect(rt.iof(future, "java/lang/Runnable")).toBe(1);
  expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("done");
});

test("sets retain their intersection and a non-HDR display reports no modes", async () => {
  const set = await newObj("java/util/HashSet");
  expect(rt.iof(set, "java/util/SortedSet")).toBe(0);
  await vcall(set, "add", "(Ljava/lang/Object;)Z", "a");
  await vcall(set, "add", "(Ljava/lang/Object;)Z", "b");
  const keep = await newObj("java/util/HashSet");
  await vcall(keep, "add", "(Ljava/lang/Object;)Z", "b");
  expect(await vcall(set, "retainAll", "(Ljava/util/Collection;)Z", keep)).toBe(1);
  expect(await vcall(set, "contains", "(Ljava/lang/Object;)Z", "a")).toBe(0);
  expect(await vcall(set, "contains", "(Ljava/lang/Object;)Z", "b")).toBe(1);

  const display = await newObj("android/view/Display");
  const hdr = await vcall(display, "getHdrCapabilities", "()Landroid/view/Display$HdrCapabilities;");
  expect(await vcall(hdr, "getSupportedHdrTypes", "()[I")).toHaveLength(0);
});

test("Arrays sorts a natural-order object subrange", async () => {
  const values = ["z", "c", "a", "b", "y"];
  await scall("java/util/Arrays", "sort", "([Ljava/lang/Object;II)V", values, 1, 4);
  expect(values).toEqual(["z", "a", "b", "c", "y"]);
});

test("BigInteger returns quotient and remainder together", async () => {
  const value = await newObj("java/math/BigInteger", "(Ljava/lang/String;)V", "23");
  const divisor = await newObj("java/math/BigInteger", "(Ljava/lang/String;)V", "5");
  const result = await vcall(value, "divideAndRemainder", "(Ljava/math/BigInteger;)[Ljava/math/BigInteger;", divisor);
  expect(await vcall(result[0], "intValue", "()I")).toBe(4);
  expect(await vcall(result[1], "intValue", "()I")).toBe(3);
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

test("ColorMatrix saturation, scale and concat feed a ColorMatrixColorFilter", async () => {
  const m = await newObj("android/graphics/ColorMatrix");
  await vcall(m, "setSaturation", "(F)V", 0);
  const a: Float32Array = await vcall(m, "getArray", "()[F");
  expect(a[0]).toBeCloseTo(0.213); expect(a[1]).toBeCloseTo(0.715); expect(a[2]).toBeCloseTo(0.072); expect(a[18]).toBe(1);
  const scale = await newObj("android/graphics/ColorMatrix");
  await vcall(scale, "setScale", "(FFFF)V", 2, 1, 1, 1);
  await vcall(m, "postConcat", "(Landroid/graphics/ColorMatrix;)V", scale);
  expect((await vcall(m, "getArray", "()[F"))[0]).toBeCloseTo(0.426);
  const filter = await newObj("android/graphics/ColorMatrixColorFilter", "(Landroid/graphics/ColorMatrix;)V", m);
  const copy = await newObj("android/graphics/ColorMatrix");
  await vcall(filter, "getColorMatrix", "(Landroid/graphics/ColorMatrix;)V", copy);
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", m)).toBe(1);
  const { matrixColor } = await import("../src/android/graphics");
  const grey = new Float32Array(20); grey.set([0.213, 0.715, 0.072, 0, 0, 0.213, 0.715, 0.072, 0, 0, 0.213, 0.715, 0.072, 0, 0, 0, 0, 0, 1, 0]);
  expect(matrixColor(grey, 0xffff0000 | 0) >>> 0).toBe(0xff363636);
  await expect(newObj("android/graphics/ColorMatrix", "([F)V", new Float32Array(3))).rejects.toMatchObject({ constructor: rt.link("java/lang/ArrayIndexOutOfBoundsException").ctor });
});

test("UrlQuerySanitizer drops unregistered parameters unless allowed and sanitizes values", async () => {
  const strict = await newObj("android/net/UrlQuerySanitizer", "(Ljava/lang/String;)V", "http://x/?a=1&b=2");
  expect(await vcall(strict, "hasParameter", "(Ljava/lang/String;)Z", "a")).toBe(0);
  const open = await newObj("android/net/UrlQuerySanitizer");
  await vcall(open, "setAllowUnregisteredParamaters", "(Z)V", 1);
  await vcall(open, "setUnregisteredParameterValueSanitizer", "(Landroid/net/UrlQuerySanitizer$ValueSanitizer;)V",
    await scall("android/net/UrlQuerySanitizer", "getUrlAndSpaceLegal", "()Landroid/net/UrlQuerySanitizer$ValueSanitizer;"));
  await vcall(open, "parseUrl", "(Ljava/lang/String;)V", "http://x/p?q=hello+w%21rld&z=<b>&q=second");
  expect(await vcall(open, "getValue", "(Ljava/lang/String;)Ljava/lang/String;", "q")).toBe("second");
  expect(await vcall(open, "getValue", "(Ljava/lang/String;)Ljava/lang/String;", "z")).toBe("b");
  const list = await vcall(open, "getParameterList", "()Ljava/util/List;");
  expect(await vcall(list, "size", "()I")).toBe(3);
  const first = await vcall(list, "get", "(I)Ljava/lang/Object;", 0);
  expect(first.mParameter).toBe("q"); expect(first.mValue).toBe("hello w!rld");
});

test("a Looper Printer sees the dispatch lines around a handled message", async () => {
  const lines: string[] = [];
  rt.register({ name: "test/LinePrinter", ctor: class extends JObj {}, ifaces: ["android/util/Printer"],
    methods: { "println(Ljava/lang/String;)V": (s: string) => { lines.push(s); } } });
  const looper = await scall("android/os/Looper", "getMainLooper", "()Landroid/os/Looper;");
  await vcall(looper, "setMessageLogging", "(Landroid/util/Printer;)V", rt.make("test/LinePrinter"));
  const handler = await newObj("android/os/Handler", "(Landroid/os/Looper;)V", looper);
  const task = rt.make("test/NoopRunnable");
  await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", task);
  await new Promise((r) => setTimeout(r, 20));
  await vcall(looper, "setMessageLogging", "(Landroid/util/Printer;)V", null);
  expect(lines.length).toBe(2);
  expect(lines[0].startsWith(">>>>> Dispatching to ")).toBe(true);
  expect(lines[1].startsWith("<<<<< Finished to ")).toBe(true);
});

test("Resources string getters throw NotFoundException for ids the table lacks", async () => {
  const host = new Resources(null, {});
  const assets = rt.make("android/content/res/AssetManager") as JAssetManager;
  assets.host = host;
  const res = await newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V", assets, null, null) as JResources;
  const notFound = { constructor: rt.link("android/content/res/Resources$NotFoundException").ctor };
  await expect(vcall(res, "getString", "(I)Ljava/lang/String;", 0x7f11240f)).rejects.toMatchObject(notFound);
  await expect(vcall(res, "getText", "(I)Ljava/lang/CharSequence;", 0x7f11240f)).rejects.toMatchObject(notFound);
  await expect(vcall(res, "getStringArray", "(I)[Ljava/lang/String;", 0x7f030001)).rejects.toMatchObject(notFound);
  expect(await vcall(res, "getText", "(ILjava/lang/CharSequence;)Ljava/lang/CharSequence;", 0x7f11240f, "fallback")).toBe("fallback");
});

test("Locale constants carry their language and country, and JSON text prints a stored long's digits", async () => {
  const japan = (rt.link("java/util/Locale").ctor as any).s$JAPAN;
  expect(await vcall(japan, "getLanguage", "()Ljava/lang/String;")).toBe("ja");
  expect(await vcall(japan, "getCountry", "()Ljava/lang/String;")).toBe("JP");
  const map = await newObj("java/util/HashMap");
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "big", await newObj("java/lang/Long", "(J)V", 9007199254740993n));
  const json = await newObj("org/json/JSONObject", "(Ljava/util/Map;)V", map);
  expect(await vcall(json, "toString", "()Ljava/lang/String;")).toBe('{"big":9007199254740993}');
});
