import { expect, test, beforeAll } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { JClassLoader, JThread, curThread, newObj, setCurThread, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { Resources } from "../src/android/res";
import { PROCESS_PID } from "../src/android/os";
import { fireActivityLifecycle, JActivity, JApplication } from "../src/android/app";
import { appHost, setAppHost } from "../src/android/apphost";
import { onMain } from "../src/android/mainloop";
import { vfs } from "../src/shell/vfs";
import { defaultDisplay } from "../src/android/display";
import { scall, loadLibcore, appResources, preloadTextPaint, loadFrameworkJar } from "./java";
import { toJsArray } from "../src/jvm/natives/jcoll";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);


rt.register({ name: "test/NoopRunnable", ctor: class extends JObj {}, ifaces: ["java/lang/Runnable"], methods: { "run()V": function () {} } });
rt.register({
  name: "test/StringLength", ctor: class extends JObj {}, ifaces: ["java/util/function/ToIntFunction"],
  methods: {
    "<init>()V": function () {},
    "applyAsInt(Ljava/lang/Object;)I": (value: unknown) => String(value).length,
  },
});
rt.register({
  name: "test/DuplicateStream", ctor: class extends JObj {}, ifaces: ["java/util/function/Function"],
  methods: {
    "apply(Ljava/lang/Object;)Ljava/lang/Object;": (value: unknown) =>
      scall("java/util/stream/Stream", "of", "([Ljava/lang/Object;)Ljava/util/stream/Stream;", Object.assign([value, value], { $t: "Ljava/lang/Object;" })),
  },
});
rt.linkNatives();
beforeAll(preloadTextPaint);

const RESOURCES_CTOR = "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V";

function lifecycleActivity(application: JApplication): JActivity {
  const activity = new JActivity();
  Reflect.set(activity, "$host", { application });
  return activity;
}
function useCurrentActivity(activity: JActivity): void {
  Reflect.set(activity.$host, "currentActivity", () => activity);
  setAppHost(activity.$host);
}

test("a lifecycle observer registered on main waits for the next real event", async () => {
  const calls: string[] = [];
  const app = new JApplication();
  const activity = lifecycleActivity(app);
  const key = mangleMethod("onActivityResumed", "(Landroid/app/Activity;)V");
  const observer = { [key]: () => { calls.push("resumed"); } };
  const previousHost = appHost;
  useCurrentActivity(activity);
  try {
    await vcall(app, "registerActivityLifecycleCallbacks", "(Landroid/app/Application$ActivityLifecycleCallbacks;)V", observer);
    activity.resumed = true;
    await onMain(() => {});
    expect(calls).toEqual([]);
  } finally {
    setAppHost(previousHost);
  }
});

test("activity callbacks registered during pre-create receive later create stages", async () => {
  const calls: string[] = [];
  const app = new JApplication();
  const activity = lifecycleActivity(app);
  const activityObserver = {
    [mangleMethod("onActivityCreated", "(Landroid/app/Activity;Landroid/os/Bundle;)V")]: () => { calls.push("created"); },
    [mangleMethod("onActivityPostCreated", "(Landroid/app/Activity;Landroid/os/Bundle;)V")]: () => { calls.push("post"); },
  };
  const appObserver = {
    [mangleMethod("onActivityPreCreated", "(Landroid/app/Activity;Landroid/os/Bundle;)V")]: () =>
      vcall(activity, "registerActivityLifecycleCallbacks", "(Landroid/app/Application$ActivityLifecycleCallbacks;)V", activityObserver),
  };
  await vcall(app, "registerActivityLifecycleCallbacks", "(Landroid/app/Application$ActivityLifecycleCallbacks;)V", appObserver);
  await fireActivityLifecycle(activity, "Created");
  expect(calls).toEqual(["created", "post"]);
});

test("background lifecycle registration catches up to the current activity", async () => {
  const calls: string[] = [];
  const app = new JApplication();
  const activity = lifecycleActivity(app);
  activity.resumed = true;
  const observer = {
    [mangleMethod("onActivityCreated", "(Landroid/app/Activity;Landroid/os/Bundle;)V")]: () => { calls.push("created"); },
    [mangleMethod("onActivityStarted", "(Landroid/app/Activity;)V")]: () => { calls.push("started"); },
    [mangleMethod("onActivityResumed", "(Landroid/app/Activity;)V")]: () => { calls.push("resumed"); },
  };
  const previousHost = appHost;
  const previousThread = curThread;
  useCurrentActivity(activity);
  try {
    setCurThread(new JThread());
    await vcall(app, "registerActivityLifecycleCallbacks", "(Landroid/app/Application$ActivityLifecycleCallbacks;)V", observer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await onMain(() => {});
    expect(calls).toEqual(["resumed"]);
  } finally {
    setCurThread(previousThread);
    setAppHost(previousHost);
  }
});

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
    await expect(vcallAsync(map, "contains", "(Ljava/lang/Object;)Z", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
  }
});

test("reached platform queries return device state and default WebView identity", async () => {
  const context = await newObj("android/content/Context");
  expect(await scall("android/webkit/WebSettings", "getDefaultUserAgent", "(Landroid/content/Context;)Ljava/lang/String;", context)).toContain("Android 13");
  expect(await vcall(rt.classFor("java/lang/String"), "getAnnotations", "()[Ljava/lang/annotation/Annotation;")).toHaveLength(0);
});

test("Runtime.exec(String) tokenizes the program and reports the unavailable process", async () => {
  const runtime = await scall("java/lang/Runtime", "getRuntime", "()Ljava/lang/Runtime;");
  await expect(vcallAsync(runtime, "exec", "(Ljava/lang/String;)Ljava/lang/Process;", "getprop ro.product.cpu.abi"))
    .rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor, msg: expect.stringContaining('"getprop"') });
});

test("finite number checks and stream flattening preserve Java semantics", async () => {
  expect(scall("java/lang/Double", "isFinite", "(D)Z", 1.5)).toBe(1);
  expect(scall("java/lang/Double", "isFinite", "(D)Z", Infinity)).toBe(0);
  const source = scall("java/util/stream/Stream", "of", "([Ljava/lang/Object;)Ljava/util/stream/Stream;", Object.assign(["a", "b"], { $t: "Ljava/lang/Object;" }));
  const flattened = await vcall(source, "flatMap", "(Ljava/util/function/Function;)Ljava/util/stream/Stream;", rt.make("test/DuplicateStream"));
  expect(await toJsArray(await vcall(flattened, "toList", "()Ljava/util/List;"))).toEqual(["a", "a", "b", "b"]);
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

test("Os.sysconf reports the configured page and processor counts", async () => {
  await loadLibcore();
  expect(await scall("android/system/Os", "sysconf", "(I)J", 0x27)).toBe(4096n);
  expect(await scall("android/system/Os", "sysconf", "(I)J", 0x61)).toBe(4n);
  expect(await scall("android/system/Os", "sysconf", "(I)J", -1)).toBe(-1n);
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
  await scall("java/security/Security", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)V", "test.key", "value");
  expect(await scall("java/security/Security", "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", "test.key")).toBe("value");
});

test("reached JDK utility primitives preserve their Java behavior", async () => {
  await loadLibcore();
  const reverse = scall("java/util/Collections", "reverseOrder", "()Ljava/util/Comparator;");
  expect(await vcall(reverse, "compare", "(Ljava/lang/Object;Ljava/lang/Object;)I", "a", "b")).toBeGreaterThan(0);
  expect(scall("java/util/Collections", "reverseOrder", "(Ljava/util/Comparator;)Ljava/util/Comparator;", reverse)).not.toBeNull();

  const levelCtor = rt.link("java/util/logging/Level").ctor as any;
  await rt.initClass(rt.link("java/util/logging/Level"));
  const info = levelCtor[mangleStaticField("INFO")];
  expect(await vcall(info, "intValue", "()I")).toBe(800);
  expect(await vcall(info, "getName", "()Ljava/lang/String;")).toBe("INFO");

  const writer = await newObj("java/io/CharArrayWriter");
  const lockField = rt.link("java/io/Writer").fieldTable.get("lock")!;
  expect(writer[lockField]).toBe(writer);
  const lock = rt.make("java/lang/Object");
  const lockedWriter = await newObj("java/io/Writer", "(Ljava/lang/Object;)V", lock);
  expect(lockedWriter[lockField]).toBe(lock);
  await expect((async () => newObj("java/io/Writer", "(Ljava/lang/Object;)V", null))()).rejects.toThrow();
  await vcall(writer, "write", "(Ljava/lang/String;)V", "hello");
  expect(await vcall(writer, "size", "()I")).toBe(5);
  expect(Array.from(await vcall(writer, "toCharArray", "()[C"))).toEqual([104, 101, 108, 108, 111]);
  await vcall(writer, "reset", "()V");
  expect(await vcall(writer, "toString", "()Ljava/lang/String;")).toBe("");

  const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/data/read-only");
  expect(await vcall(file, "setReadOnly", "()Z")).toBe(0);
  vfs.write("/data/read-only", new Uint8Array(0));
  expect(await vcall(file, "setReadOnly", "()Z")).toBe(1);
});

test("Writer overloads reach virtual range writes without dropping JSON tokens", async () => {
  const writer = await newObj("java/io/Writer"), chunks: string[] = [];
  writer[mangleMethod("write", "([CII)V")] = async (chars: Uint16Array, off: number, len: number) => {
    await Promise.resolve(); chunks.push(String.fromCharCode(...chars.subarray(off, off + len)));
  };
  await vcall(writer, "write", "(I)V", 123);
  await vcall(writer, "write", "(Ljava/lang/String;)V", '"n":');
  await vcall(writer, "write", "(Ljava/lang/String;II)V", "x42x", 1, 2);
  await vcall(writer, "append", "(C)Ljava/io/Writer;", 125);
  expect(chunks.join("")).toBe('{"n":42}');
  writer[mangleMethod("write", "(Ljava/lang/String;II)V")] = async (text: string, off: number, len: number) => {
    await Promise.resolve(); chunks.push(text.slice(off, off + len));
  };
  await vcall(writer, "write", "(Ljava/lang/String;)V", "\ud83d\ude00");
  expect(chunks.at(-1)).toBe("\ud83d\ude00");
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

  const display = await defaultDisplay();
  const hdr = await vcall(display, "getHdrCapabilities", "()Landroid/view/Display$HdrCapabilities;");
  expect(await vcall(hdr, "getSupportedHdrTypes", "()[I")).toHaveLength(0);
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
  await expect((async () => newObj("java/util/EventObject", "(Ljava/lang/Object;)V", null))()).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
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
  await expect((async () => newObj("android/graphics/ColorMatrix", "([F)V", new Float32Array(3)))()).rejects.toMatchObject({ constructor: rt.link("java/lang/ArrayIndexOutOfBoundsException").ctor });
});

test("JSON text prints a stored long's digits", async () => {
  const map = await newObj("java/util/HashMap");
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "big", await newObj("java/lang/Long", "(J)V", 9007199254740993n));
  const json = await newObj("org/json/JSONObject", "(Ljava/util/Map;)V", map);
  expect(await vcall(json, "toString", "()Ljava/lang/String;")).toBe('{"big":9007199254740993}');
});

test("Android path loaders expose their hierarchy and readable native library paths", async () => {
  for (const name of ["dalvik/system/PathClassLoader", "dalvik/system/DexClassLoader", "webdroid/PackageClassLoader"]) {
    expect(rt.iof(rt.make(name), "dalvik/system/BaseDexClassLoader")).toBe(1);
  }
  const loader = rt.make("dalvik/system/PathClassLoader");
  if (!(loader instanceof JClassLoader)) throw new Error("Invalid class loader");
  loader.runtime = rt.fork();
  loader.runtime.classpath["lib/arm64-v8a/libfixture.so"] = new Uint8Array([1, 2, 3]);
  loader.runtime.classpathLocations.set("lib/arm64-v8a/libfixture.so", "/data/fixture.apk");
  const path = await vcall(loader, "findLibrary", "(Ljava/lang/String;)Ljava/lang/String;", "fixture");
  expect(vfs.read(path)).toEqual(new Uint8Array([1, 2, 3]));
  expect(await vcall(loader, "findLibrary", "(Ljava/lang/String;)Ljava/lang/String;", "absent")).toBeNull();
  vfs.delete(path);
});

test("In-memory DEX loaders read the buffer window and preserve defining-loader identity", async () => {
  const bytes = new Uint8Array(await Bun.file(import.meta.dir + "/fixtures/JvmTierProbe.dex").arrayBuffer());
  const padded = new Int8Array(bytes.length + 16);
  padded.set(bytes, 8);
  const buffer = await scall("java/nio/ByteBuffer", "wrap", "([BII)Ljava/nio/ByteBuffer;", padded, 8, bytes.length);
  const load = () => newObj("dalvik/system/InMemoryDexClassLoader", "(Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V", buffer, null);
  const first = await load(), second = await load();
  const cls = await vcall(first, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "JvmTierProbe");
  expect(await vcall(first, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "JvmTierProbe")).toBe(cls);
  expect(await vcall(second, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "JvmTierProbe")).not.toBe(cls);
  expect(await vcall(cls, "getClassLoader", "()Ljava/lang/ClassLoader;")).toBe(first);
  expect(await vcall(buffer, "position", "()I")).toBe(8);
  expect(await vcall(buffer, "limit", "()I")).toBe(8 + bytes.length);
});

test("ContextWrapper.getResources reaches a base context's overriding getResources, and Context.getString goes through it", async () => {
  const host = new Resources(null, {});
  const plain = await appResources(host, "wrapper");
  const assets = await vcall(plain, "getAssets", "()Landroid/content/res/AssetManager;");
  // a Resources subclass that serves strings the table lacks, behind a ContextWrapper subclass
  // that answers getResources with it: what a string-store proxy installed by attachBaseContext does
  rt.register({ name: "test/StoreResources", ctor: class extends (rt.link("android/content/res/Resources").ctor as any) {}, sup: "android/content/res/Resources",
    methods: { "getString(I)Ljava/lang/String;": (id: number) => "store:" + id.toString(16) } });
  rt.register({ name: "test/ProxyContext", ctor: class extends (rt.link("android/content/ContextWrapper").ctor as any) {}, sup: "android/content/ContextWrapper",
    methods: { "getResources()Landroid/content/res/Resources;": function (this: { store: unknown }) { return this.store; } } });
  const store = await newObj("test/StoreResources", RESOURCES_CTOR, assets, null, null);
  const base = rt.make("android/content/Context") as JObj & { $host: unknown };
  base.$host = { res: host, jresources: plain, pkg: "test" };
  const proxy = await newObj("test/ProxyContext", "(Landroid/content/Context;)V", base) as JObj & { store: unknown };
  proxy.store = store;
  const outer = await newObj("android/view/ContextThemeWrapper", "(Landroid/content/Context;I)V", proxy, 0);
  expect(await vcall(outer, "getResources", "()Landroid/content/res/Resources;")).toBe(store);
  expect(await vcall(outer, "getString", "(I)Ljava/lang/String;", 0x7f1143e8)).toBe("store:7f1143e8");
  // a wrapper over the platform context still answers the platform's own Resources directly
  const direct = await newObj("android/content/ContextWrapper", "(Landroid/content/Context;)V", base);
  expect(await vcall(direct, "getResources", "()Landroid/content/res/Resources;")).toBe(plain);
});



test("modern Java helpers preserve their public contracts", async () => {
  const hex = await scall("java/lang/Long", "valueOf", "(Ljava/lang/String;I)Ljava/lang/Long;", "7fffffffffffffff", 16);
  expect(await vcall(hex, "longValue", "()J")).toBe(9223372036854775807n);
  await expect((async () => Promise.resolve().then(() => scall("java/lang/Long", "valueOf", "(Ljava/lang/String;I)Ljava/lang/Long;", "8000000000000000", 16)))())
    .rejects.toMatchObject({ constructor: rt.link("java/lang/NumberFormatException").ctor });

  expect(await scall("java/util/Objects", "toString", "(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/String;", null, "fallback")).toBe("fallback");
  expect(await scall("java/lang/Character", "isJavaIdentifierPart", "(C)Z", "_".charCodeAt(0))).toBe(1);
  expect(await scall("java/lang/Character", "isJavaIdentifierPart", "(C)Z", "-".charCodeAt(0))).toBe(0);

  const source = Object.assign(["a", "b"], { $t: "Ljava/lang/String;" });
  const stream = await scall("java/util/Arrays", "stream", "([Ljava/lang/Object;)Ljava/util/stream/Stream;", source);
  source[0] = "changed";
  expect(await vcall(stream, "count", "()J")).toBe(2n);
  const empty = await scall("java/util/Collections", "emptyIterator", "()Ljava/util/Iterator;");
  expect(await vcall(empty, "hasNext", "()Z")).toBe(0);
  await expect(vcallAsync(empty, "next", "()Ljava/lang/Object;")).rejects.toMatchObject({ constructor: rt.link("java/util/NoSuchElementException").ctor });

  const byKey = await scall("java/util/Map$Entry", "comparingByKey", "()Ljava/util/Comparator;");
  const first = await newObj("java/util/AbstractMap$SimpleImmutableEntry", "(Ljava/lang/Object;Ljava/lang/Object;)V", "a", 2);
  const second = await newObj("java/util/AbstractMap$SimpleImmutableEntry", "(Ljava/lang/Object;Ljava/lang/Object;)V", "b", 1);
  expect(await vcall(byKey, "compare", "(Ljava/lang/Object;Ljava/lang/Object;)I", first, second)).toBe(-1);

  const methods = await vcall(rt.classFor("test/StringLength"), "getDeclaredMethods", "()[Ljava/lang/reflect/Method;");
  const apply = methods.find((method: any) => method.name === "applyAsInt");
  expect(await vcall(apply, "getParameterCount", "()I")).toBe(1);
  const constructors = await vcall(rt.classFor("test/StringLength"), "getDeclaredConstructors", "()[Ljava/lang/reflect/Constructor;");
  expect(rt.iof(constructors[0], "java/lang/reflect/AccessibleObject")).toBe(1);
  expect(await vcall(constructors[0], "trySetAccessible", "()Z")).toBe(1);

  const uri = await scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://user%20name@example.com:8443/path");
  expect(await vcall(uri, "getAuthority", "()Ljava/lang/String;")).toBe("user name@example.com:8443");
  expect(await vcall(uri, "getRawAuthority", "()Ljava/lang/String;")).toBe("user%20name@example.com:8443");
  const rebuilt = await newObj("java/net/URI",
    "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
    "https", "example.com:8443", "/shop", "q=book", "results");
  expect(await vcall(rebuilt, "toString", "()Ljava/lang/String;")).toBe("https://example.com:8443/shop?q=book#results");
  const utf8 = await scall("java/nio/charset/Charset", "forName", "(Ljava/lang/String;)Ljava/nio/charset/Charset;", "UTF-8");
  const encoder = await vcall(utf8, "newEncoder", "()Ljava/nio/charset/CharsetEncoder;");
  expect(await vcall(encoder, "maxBytesPerChar", "()F")).toBe(3);
  const encoded = await vcall(utf8, "encode", "(Ljava/lang/String;)Ljava/nio/ByteBuffer;", "A£");
  expect(await vcall(encoded, "remaining", "()I")).toBe(3);
  expect([...(await vcall(encoded, "array", "()[B")).subarray(0, 3)]).toEqual([65, -62, -93]);
});

test("concrete maps, EnumSet factories, and primitive streams preserve Java dispatch", async () => {
  const map = await newObj("java/util/concurrent/ConcurrentHashMap");
  expect(await vcall(map, "putIfAbsent", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", "first")).toBeNull();
  expect(await vcall(map, "putIfAbsent", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", "second")).toBe("first");
  expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "key")).toBe("first");

  const units = rt.link("java/util/concurrent/TimeUnit"); await rt.initClass(units);
  const enumSet = await scall("java/util/EnumSet", "of",
    "(Ljava/lang/Enum;Ljava/lang/Enum;Ljava/lang/Enum;Ljava/lang/Enum;)Ljava/util/EnumSet;",
    Reflect.get(units.ctor, "s$NANOSECONDS"), Reflect.get(units.ctor, "s$MICROSECONDS"),
    Reflect.get(units.ctor, "s$MILLISECONDS"), Reflect.get(units.ctor, "s$SECONDS"));
  expect(await vcall(enumSet, "size", "()I")).toBe(4);

  const source = await scall("java/util/stream/Stream", "of", "([Ljava/lang/Object;)Ljava/util/stream/Stream;",
    Object.assign(["a", "four", "six"], { $t: "Ljava/lang/Object;" }));
  const ints = await vcall(source, "mapToInt", "(Ljava/util/function/ToIntFunction;)Ljava/util/stream/IntStream;", rt.make("test/StringLength"));
  expect(Array.from(await vcall(ints, "toArray", "()[I"))).toEqual([1, 4, 3]);
});

test("CharArrayReader supports its initial and explicit marks", async () => {
  const chars = Uint16Array.from("abcd", (c) => c.charCodeAt(0));
  const reader = await newObj("java/io/CharArrayReader", "([C)V", chars);
  expect(await vcall(reader, "read", "()I")).toBe("a".charCodeAt(0));
  await vcall(reader, "mark", "(I)V", 10);
  expect(await vcall(reader, "read", "()I")).toBe("b".charCodeAt(0));
  await vcall(reader, "reset", "()V");
  expect(await vcall(reader, "read", "()I")).toBe("b".charCodeAt(0));
});




test("String.split preserves the unsplit tail for a positive limit", async () => {
  const arn = "arn:aws:remote-config:us-west-2:455205533140:appConfig:apiz0o87";
  expect(Array.from(await vcall(arn, "split", "(Ljava/lang/String;I)[Ljava/lang/String;", ":", 6))).toEqual([
    "arn", "aws", "remote-config", "us-west-2", "455205533140", "appConfig:apiz0o87",
  ]);
  expect(Array.from(await vcall("a::", "split", "(Ljava/lang/String;I)[Ljava/lang/String;", ":", -1))).toEqual(["a", "", ""]);
  expect(Array.from(await vcall("a::", "split", "(Ljava/lang/String;I)[Ljava/lang/String;", ":", 0))).toEqual(["a"]);
  for (let i = 0; i < 3; i++) {
    expect(Array.from(await vcall("appConfig:apiz0o87", "split", "(Ljava/lang/String;I)[Ljava/lang/String;", "[:/]", 2))).toEqual(["appConfig", "apiz0o87"]);
  }
});

test("BufferedReader mark and reset replay buffered characters", async () => {
  const source = await newObj("java/io/StringReader", "(Ljava/lang/String;)V", "abc");
  const reader = await newObj("java/io/BufferedReader", "(Ljava/io/Reader;)V", source);
  expect(await vcall(reader, "markSupported", "()Z")).toBe(1);
  expect(await vcall(reader, "read", "()I")).toBe("a".charCodeAt(0));
  await vcall(reader, "mark", "(I)V", 2);
  expect(await vcall(reader, "read", "()I")).toBe("b".charCodeAt(0));
  await vcall(reader, "reset", "()V");
  expect(await vcall(reader, "read", "()I")).toBe("b".charCodeAt(0));
});

test("PBKDF2 secret keys derive through PBEKeySpec", async () => {
  const password = Uint16Array.from("password", (c) => c.charCodeAt(0));
  const salt = Int8Array.from(new TextEncoder().encode("salt"));
  const spec = await newObj("javax/crypto/spec/PBEKeySpec", "([C[BII)V", password, salt, 1, 160);
  const factory = await scall("javax/crypto/SecretKeyFactory", "getInstance", "(Ljava/lang/String;)Ljavax/crypto/SecretKeyFactory;", "PBKDF2WithHmacSHA1");
  const key = await vcall(factory, "generateSecret", "(Ljava/security/spec/KeySpec;)Ljavax/crypto/SecretKey;", spec);
  expect(Array.from(await vcall(key, "getEncoded", "()[B"), (v: number) => v & 255)).toEqual([
    12, 96, 200, 15, 150, 31, 14, 113, 243, 169, 181, 36, 175, 96, 18, 6, 47, 224, 55, 166,
  ]);
});

test("Wi-Fi locks expose their held state", async () => {
  const manager = rt.make("android/net/wifi/WifiManager");
  const lock = await vcall(manager, "createWifiLock", "(ILjava/lang/String;)Landroid/net/wifi/WifiManager$WifiLock;", 1, "test");
  expect(await vcall(lock, "isHeld", "()Z")).toBe(0);
  await vcall(lock, "acquire", "()V");
  await vcall(lock, "acquire", "()V");
  await vcall(lock, "release", "()V");
  expect(await vcall(lock, "isHeld", "()Z")).toBe(1);
  await vcall(lock, "release", "()V");
  expect(await vcall(lock, "isHeld", "()Z")).toBe(0);
  await expect(vcallAsync(lock, "release", "()V"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/RuntimeException").ctor });
  await vcall(lock, "setReferenceCounted", "(Z)V", 0);
  await vcall(lock, "release", "()V");
  await vcall(lock, "acquire", "()V");
  await vcall(lock, "release", "()V");
  await vcall(lock, "release", "()V");
  expect(await vcall(lock, "isHeld", "()Z")).toBe(0);
});

