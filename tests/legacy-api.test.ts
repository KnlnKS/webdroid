import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
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

test("ULocale bridges ICU locale ids and java.util.Locale", async () => {
  const locale = await scall("android/icu/util/ULocale", "forLanguageTag", "(Ljava/lang/String;)Landroid/icu/util/ULocale;", "ar-EG");
  expect(await vcall(locale, "getLanguage", "()Ljava/lang/String;")).toBe("ar");
  expect(await vcall(locale, "getCountry", "()Ljava/lang/String;")).toBe("EG");
  expect(await vcall(locale, "isRightToLeft", "()Z")).toBe(1);
  const javaLocale = await vcall(locale, "toLocale", "()Ljava/util/Locale;");
  expect(await vcall(javaLocale, "toLanguageTag", "()Ljava/lang/String;")).toBe("ar-EG");
  expect(await vcall(javaLocale, "equals", "(Ljava/lang/Object;)Z", await scall("java/util/Locale", "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", "ar-EG"))).toBe(1);

  const builder = await newObj("android/icu/util/ULocale$Builder");
  await vcall(builder, "setLanguageTag", "(Ljava/lang/String;)Landroid/icu/util/ULocale$Builder;", "en-US");
  await vcall(builder, "setUnicodeLocaleKeyword", "(Ljava/lang/String;Ljava/lang/String;)Landroid/icu/util/ULocale$Builder;", "calendar", "gregorian");
  const built = await vcall(builder, "build", "()Landroid/icu/util/ULocale;");
  expect(await vcall(built, "getKeywordValue", "(Ljava/lang/String;)Ljava/lang/String;", "calendar")).toBe("gregorian");
});

test("ICU Currency exposes ISO codes, symbols, names, and fraction digits", async () => {
  const currency = await scall("android/icu/util/Currency", "getInstance", "(Ljava/lang/String;)Landroid/icu/util/Currency;", "usd");
  expect(await vcall(currency, "getCurrencyCode", "()Ljava/lang/String;")).toBe("USD");
  expect(await vcall(currency, "getSymbol", "()Ljava/lang/String;")).toBe("$");
  expect(await vcall(currency, "getDefaultFractionDigits", "()I")).toBe(2);
  const locale = await scall("android/icu/util/ULocale", "forLanguageTag", "(Ljava/lang/String;)Landroid/icu/util/ULocale;", "en-US");
  const choice = new Int8Array([1]);
  expect(await vcall(currency, "getName", "(Landroid/icu/util/ULocale;I[Z)Ljava/lang/String;", locale, 1, choice)).toContain("US");
  expect(choice[0]).toBe(0);
});
