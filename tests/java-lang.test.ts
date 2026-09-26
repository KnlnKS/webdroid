import { expect, test, describe } from "bun:test";
import "../src/natives";
import { mangleStaticField, mangleMethod } from "../src/jvm/abi";
import type { DexFile, EncAnnotation } from "../src/jvm/dex";
import { vcall, newObj, vcallAsync } from "../src/jvm/natives/jlang";
import { mkAnnotation, JField } from "../src/jvm/natives/jreflect";
import { JObj, rt } from "../src/jvm/runtime";
import { JSpanned, csText } from "../src/android/text";
import { scall } from "./java";

describe("annotation-enum-init", () => {
  test("explicit enum annotation elements wait for class initialization", async () => {
    const modeName = "test/DeferredAnnotationMode";
    const annotationName = "test/DeferredEnumAnnotation";
    const mode = new JObj();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    class Mode extends JObj {}
    rt.register({
      name: modeName,
      ctor: Mode,
      statics: { MAIN: null },
      clinit: async () => {
        await gate;
        (Mode as unknown as Record<string, unknown>)[mangleStaticField("MAIN")] = mode;
      },
    });
    rt.register({
      name: annotationName,
      ctor: class extends JObj {},
      methods: { [`value()L${modeName};`]: () => null },
    });

    const dex = {
      field: () => ({ cls: 0, type: 0, name: "MAIN" }),
      type: () => `L${modeName};`,
    } as unknown as DexFile;
    const annotation: EncAnnotation = {
      visibility: 1,
      type: annotationName,
      elements: { value: { kind: "enum", idx: 0 } },
      dex,
    };

    mkAnnotation(annotation);
    const second = mkAnnotation(annotation);
    const pending = vcall(second, "value", `()L${modeName};`);
    release();

    expect(await pending).toBe(mode);
  });

  test("annotation arrays retain their declared Java types", async () => {
    const name = "test/ArrayAnnotation";
    rt.register({
      name,
      ctor: class extends JObj {},
      methods: {
        "versions()[I": () => null,
        "names()[Ljava/lang/String;": () => null,
      },
    });
    const annotation = mkAnnotation({
      visibility: 1,
      type: name,
      elements: { versions: [2, 3, 0], names: ["one", "two"] },
      dex: {} as DexFile,
    });

    const versions = await vcall(annotation, "versions", "()[I");
    const names = await vcall(annotation, "names", "()[Ljava/lang/String;");
    expect(versions).toEqual(new Int32Array([2, 3, 0]));
    expect(rt.iof(versions, "[I")).toBe(1);
    expect(names).toEqual(expect.arrayContaining(["one", "two"]));
    expect(rt.iof(names, "[Ljava/lang/String;")).toBe(1);
  });
});

describe("assertion-error", () => {
  rt.linkNatives();
  test("AssertionError retains a throwable detail as its cause", async () => {
    const detail = rt.mkThrowable("java/lang/IllegalStateException", "failure");
    const error = rt.make("java/lang/AssertionError");
    await vcall(error, "<init>", "(Ljava/lang/Object;)V", detail);
    expect(await vcall(error, "getCause", "()Ljava/lang/Throwable;")).toBe(detail);
    expect(await vcall(error, "getMessage", "()Ljava/lang/String;")).toBe("java.lang.IllegalStateException: failure");
  });
});

describe("base64", () => {
  rt.linkNatives();

  test("Base64 encoding preserves signed bytes, slices, padding and 76-character line boundaries", () => {
    const ctor = rt.link("android/util/Base64").ctor;
    const encode = Reflect.get(ctor, mangleMethod("encode", "([BIII)[B"));
    const encodeString = Reflect.get(ctor, mangleMethod("encodeToString", "([BIII)Ljava/lang/String;"));
    if (typeof encode !== "function" || typeof encodeString !== "function") throw new Error("Missing Base64 encoders");
    const input = Int8Array.from({ length: 130 }, (_, i) => i * 79);
    for (let flags = 0; flags < 16; flags++) {
      for (const length of [0, 1, 2, 3, 56, 57, 58, 114]) {
        let expected = Buffer.from(input.subarray(5, 5 + length)).toString("base64");
        if (flags & 8) expected = expected.replaceAll("+", "-").replaceAll("/", "_");
        if (flags & 1) expected = expected.replace(/=+$/, "");
        if (!(flags & 2)) expected = expected.replace(/.{1,76}/g, "$&" + (flags & 4 ? "\r\n" : "\n"));
        expect(encode(input, 5, length, flags)).toEqual(new Int8Array(Buffer.from(expected)));
        expect(encodeString(input, 5, length, flags)).toBe(expected);
      }
    }
  });
});

describe("character-offset", () => {
  rt.linkNatives();
  test("character categories preserve Java category numbers and supplementary characters", async () => {
    const cls = rt.link("java/lang/Character").ctor;
    for (const [cp, category] of [[65, 1], [97, 2], [0x301, 6], [48, 9], [32, 12], [10, 15], [0xd800, 19], [45, 20], [95, 23], [0x1f600, 28], [0x378, 0], [-1, 0], [0x110000, 0]]) {
      expect(await vcall(cls, "getType", "(I)I", cp)).toBe(category);
      expect(await vcall(cls, "isDefined", "(I)Z", cp)).toBe(+(category !== 0));
    }
    expect(await vcall(cls, "getType", "(C)I", 0xd800)).toBe(19);
  });
  test("code point offsets count pairs once and retain unpaired surrogates", async () => {
    const text = "a\ud83d\ude00\ud800b\udc00";
    const offset = (value: unknown, index: number, count: number) => vcall(rt.link("java/lang/Character").ctor, "offsetByCodePoints", "(Ljava/lang/CharSequence;II)I", value, index, count);
    for (const value of [text, await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", text)]) {
      expect(await offset(value, 0, 2)).toBe(3);
      expect(await offset(value, 6, -4)).toBe(1);
      expect(await offset(value, 2, 1)).toBe(3);
      for (const [index, count] of [[-1, 0], [7, 0], [0, 6], [6, -6]]) {
        let error: unknown;
        try { await offset(value, index, count); } catch (e) { error = e; }
        expect(rt.iof(error, "java/lang/IndexOutOfBoundsException")).toBe(1);
      }
    }
    expect(await vcall(text, "offsetByCodePoints", "(II)I", 0, 2)).toBe(3);
  });
});

describe("java-value-contracts", () => {
  rt.linkNatives();
  test("Math.getExponent extracts IEEE fields at subnormal, power-of-two and nonfinite boundaries", async () => {
    const math = rt.link("java/lang/Math").ctor;
    for (const [value, exponent] of [[0, -1023], [Number.MIN_VALUE, -1023], [1, 0], [1 - Number.EPSILON / 2, -1], [2, 1], [-8, 3], [Infinity, 1024], [NaN, 1024]]) {
      expect(await vcall(math, "getExponent", "(D)I", value)).toBe(exponent);
    }
    expect(await vcall(math, "getExponent", "(F)I", 2 ** -149)).toBe(-127);
  });
  test("EnumSet factories and clones preserve Java class identity", async () => {
    const es = rt.link("java/util/EnumSet").ctor;
    const days = rt.link("java/time/DayOfWeek").ctor;
    const values: unknown[] = await vcall(days, "values", "()[Ljava/time/DayOfWeek;");
    const set = await vcall(es, "of", "(Ljava/lang/Enum;[Ljava/lang/Enum;)Ljava/util/EnumSet;", values[0], values.slice(0, 4));
    expect(rt.iof(set, "java/util/EnumSet")).toBe(1);
    const clone = await vcall(set, "clone", "()Ljava/lang/Object;");
    expect(rt.iof(clone, "java/util/EnumSet")).toBe(1);
    await vcall(clone, "clear", "()V");
    expect(await vcall(set, "size", "()I")).toBe(4);
    const copy = await vcall(es, "copyOf", "(Ljava/util/Collection;)Ljava/util/EnumSet;", set);
    expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", set)).toBe(1);
  });
});

describe("math-copy-sign", () => {
  rt.linkNatives();

  const math = rt.link("java/lang/Math").ctor as any;
  const call = (desc: "(DD)D" | "(FF)F", magnitude: number, sign: number): number =>
    math[mangleMethod("copySign", desc)](magnitude, sign);

  test("Math.copySign copies negative and positive zero signs", () => {
    expect(call("(DD)D", 3.5, -0)).toBe(-3.5);
    expect(call("(DD)D", -3.5, 0)).toBe(3.5);
    expect(call("(FF)F", 2.25, -1)).toBe(-2.25);
  });
});

describe("math-log1p", () => {
  rt.linkNatives();
  test("Math.log1p preserves tiny values, signed zero and domain endpoints", async () => {
    const log1p = (x: number) => vcall(rt.link("java/lang/Math").ctor, "log1p", "(D)D", x);
    expect(await log1p(1e-20)).toBe(1e-20);
    expect(Object.is(await log1p(-0), -0)).toBe(true);
    expect(await log1p(-1)).toBe(-Infinity);
    expect(await log1p(Infinity)).toBe(Infinity);
    expect(await log1p(-2)).toBeNaN();
    expect(await log1p(NaN)).toBeNaN();
  });
});

describe("number-parse", () => {
  rt.linkNatives();

  test("Double.valueOf(String) and Float.valueOf(String) box the parsed value", async () => {
    const d = scall("java/lang/Double", "valueOf", "(Ljava/lang/String;)Ljava/lang/Double;", " -73.98563 ");
    expect(await vcall(d, "doubleValue", "()D")).toBe(-73.98563);
    const f = scall("java/lang/Float", "valueOf", "(Ljava/lang/String;)Ljava/lang/Float;", "1.5f");
    expect(await vcall(f, "floatValue", "()F")).toBe(1.5);
    expect(() => scall("java/lang/Double", "valueOf", "(Ljava/lang/String;)Ljava/lang/Double;", "40.7,-74")).toThrow();
  });

  test("Integer.decode recognizes Java decimal, hexadecimal, and octal syntax", async () => {
    const decode = (s: string) => scall("java/lang/Integer", "decode", "(Ljava/lang/String;)Ljava/lang/Integer;", s);
    expect(await vcall(decode("42"), "intValue", "()I")).toBe(42);
    expect(await vcall(decode("-0x80000000"), "intValue", "()I")).toBe(-2147483648);
    expect(await vcall(decode("+077"), "intValue", "()I")).toBe(63);
    expect(await vcall(decode("#7fffffff"), "intValue", "()I")).toBe(2147483647);
    expect(() => decode("0x-1")).toThrow();
    expect(() => decode("09")).toThrow();
    expect(() => decode("019")).toThrow();
    expect(() => scall("java/lang/Integer", "parseInt", "(Ljava/lang/String;I)I", "12z", 10)).toThrow();
  });
});

describe("object-bridge", () => {
  test("host objects retain java.lang.Object.getClass", async () => {
    const cls = await vcall({}, "getClass", "()Ljava/lang/Class;");
    expect(await vcall(cls, "getName", "()Ljava/lang/String;")).toBe("java.lang.Object");
  });
});

describe("pattern-split", () => {
  rt.linkNatives();
  const compile = (source: string) => rt.link("java/util/regex/Pattern").ctor[mangleMethod("compile", "(Ljava/lang/String;)Ljava/util/regex/Pattern;")](source);
  const split = (pattern: unknown, input: string, limit: number) =>
    vcall(pattern, "split", "(Ljava/lang/CharSequence;I)[Ljava/lang/String;", input, limit);

  test("Pattern.split honors positive, zero, and negative limits", async () => {
    const colon = compile(":"), letterO = compile("o");
    expect(Array.from(await split(colon, "boo:and:foo", 2))).toEqual(["boo", "and:foo"]);
    expect(Array.from(await split(colon, "one:two:three", 2))).toEqual(["one", "two:three"]);
    expect(Array.from(await split(letterO, "boo:and:foo", 0))).toEqual(["b", "", ":and:f"]);
    expect(Array.from(await vcall(letterO, "split", "(Ljava/lang/CharSequence;)[Ljava/lang/String;", "boo:and:foo"))).toEqual(["b", "", ":and:f"]);
    expect(Array.from(await split(letterO, "boo:and:foo", -1))).toEqual(["b", "", ":and:f", "", ""]);
    expect(Array.from(await split(colon, "boo:and:foo", 1))).toEqual(["boo:and:foo"]);
  });

  test("Pattern.split excludes captures and skips an initial zero-width match", async () => {
    expect(Array.from(await split(compile("(:)"), "a:b", -1))).toEqual(["a", "b"]);
    expect(Array.from(await split(compile("(?=b)"), "boo", -1))).toEqual(["boo"]);
    expect(Array.from(await split(compile("(?=o)"), "boo", -1))).toEqual(["b", "o", "o"]);
    expect(Array.from(await split(compile(":"), ":a", -1))).toEqual(["", "a"]);
  });

  test("atomic groups commit alternatives and hide internal captures", async () => {
    const matcher = (pattern: string, input: string) => vcall(compile(pattern), "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", input);
    expect(await vcall(await matcher("^(?>a+)a$", "aaa"), "matches", "()Z")).toBe(0);
    expect(await vcall(await matcher("^(?>a+)b$", "aaab"), "matches", "()Z")).toBe(1);
    const path = await matcher("^/(?>(?>\\.\\.?/)+)", "/.././chapter");
    expect(await vcall(path, "find", "()Z")).toBe(1);
    expect(await vcall(path, "groupCount", "()I")).toBe(0);
    expect(await vcall(path, "group", "()Ljava/lang/String;")).toBe("/.././");
  });
});

describe("reference", () => {
  rt.linkNatives();

  test("PhantomReference never yields its referent and enqueues nothing", async () => {
    const queue = await newObj("java/lang/ref/ReferenceQueue");
    const referent = await newObj("java/lang/Object");
    const ref = await newObj("java/lang/ref/PhantomReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", referent, queue);
    expect(rt.iof(ref, "java/lang/ref/Reference")).toBe(1);
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBeNull();
    expect(await vcall(queue, "poll", "()Ljava/lang/ref/Reference;")).toBeNull();
    expect(await vcall(queue, "remove", "(J)Ljava/lang/ref/Reference;", 5n)).toBeNull();
  });

  test("InheritableThreadLocal values reach threads created afterwards", async () => {
    const local = await newObj("java/lang/InheritableThreadLocal");
    await vcall(local, "set", "(Ljava/lang/Object;)V", "inherited");
    const thread = await newObj("java/lang/Thread");
    expect(thread.locals.get(local)).toBe("inherited");
    expect(await vcall(local, "get", "()Ljava/lang/Object;")).toBe("inherited");
    await vcall(await newObj("java/lang/Object"), "hashCode", "()I");
    expect(rt.iof(local, "java/lang/ThreadLocal")).toBe(1);
  });
});

describe("reference-queue", () => {
  rt.linkNatives();
  test("reference queue state survives explicit enqueue, blocked removal and repeated enqueue", async () => {
    const queue = await newObj("java/lang/ref/ReferenceQueue");
    const value = new JObj();
    const ref = await newObj("java/lang/ref/WeakReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", value, queue);
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBe(value);
    expect(await vcall(ref, "isEnqueued", "()Z")).toBe(0);
    const waiting = vcall(queue, "remove", "()Ljava/lang/ref/Reference;");
    expect(await vcall(ref, "enqueue", "()Z")).toBe(1);
    expect(await waiting).toBe(ref);
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBeNull();
    expect(await vcall(ref, "isEnqueued", "()Z")).toBe(0);
    expect(await vcall(ref, "enqueue", "()Z")).toBe(0);
    expect(await vcall(queue, "poll", "()Ljava/lang/ref/Reference;")).toBeNull();
  });
  test("references accept Java string values and clearing does not enqueue them", async () => {
    const queue = await newObj("java/lang/ref/ReferenceQueue");
    const ref = await newObj("java/lang/ref/WeakReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", "text", queue);
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBe("text");
    await vcall(ref, "clear", "()V");
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBeNull();
    expect(await vcall(queue, "poll", "()Ljava/lang/ref/Reference;")).toBeNull();
    expect(await vcall(queue, "remove", "(J)Ljava/lang/ref/Reference;", 1n)).toBeNull();
  });
});

describe("reflection-field", () => {
  class Fields extends JObj { value: number | bigint = 0; static value: number | bigint = 0; }
  rt.register({ name: "test/PrimitiveFields", ctor: Fields });
  rt.linkNatives();
  const owner = rt.link("test/PrimitiveFields");
  const field = (desc: string, isStatic = false) => Object.assign(new JField(), { owner, prop: "value", desc, isStatic });

  test("concurrent proxy creation shares classes without crossing interface sets", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      input === "/vendor/aosp/framework.jar"
        ? Promise.resolve(new Response(Bun.file(new URL("../vendor/aosp/framework.jar", import.meta.url))))
        : originalFetch(input, init), { preconnect: originalFetch.preconnect });
    try {
      const names = ["test/ConcurrentProxyA", "test/ConcurrentProxyB"];
      rt.markers(...names);
      const handler = { [mangleMethod("invoke", "(Ljava/lang/Object;Ljava/lang/reflect/Method;[Ljava/lang/Object;)Ljava/lang/Object;")]: () => null };
      const create = (name: string) => vcall(rt.link("java/lang/reflect/Proxy").ctor, "newProxyInstance",
        "(Ljava/lang/ClassLoader;[Ljava/lang/Class;Ljava/lang/reflect/InvocationHandler;)Ljava/lang/Object;", null, [rt.classFor(name)], handler);
      const [first, repeated, other] = await Promise.all([create(names[0]), create(names[0]), create(names[1])]);
      expect(first.constructor === repeated.constructor).toBe(true);
      expect(first.constructor === other.constructor).toBe(false);
      expect([rt.iof(first, names[0]), rt.iof(first, names[1]), rt.iof(other, names[0]), rt.iof(other, names[1])]).toEqual([1, 0, 0, 1]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("typed field writes preserve primitive representation and Java widening rules", async () => {
    const methods = ["Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double"];
    const descriptors = "ZBCSIJFD";
    const allowed = ["Z", "BSIJFD", "CIJFD", "SIJFD", "IJFD", "JFD", "FD", "D"];
    for (let i = 0; i < methods.length; i++) for (const destination of descriptors) {
      const object = new Fields(), f = field(destination), value = descriptors[i] === "J" ? 1n : 1;
      const write = vcallAsync(f, "set" + methods[i], `(Ljava/lang/Object;${descriptors[i]})V`, object, value);
      if (allowed[i].includes(destination)) {
        await write;
        expect(object.value).toBe(destination === "J" ? 1n : 1);
      } else {
        await expect(write).rejects.toMatchObject({ msg: "Invalid primitive field conversion" });
        expect(object.value).toBe(0);
      }
    }
  });

  test("long field writes keep all bits and round directly when widening to float", async () => {
    const object = new Fields();
    const value = (1n << 62n) + (1n << 38n) + 1n;
    await vcall(field("J"), "setLong", "(Ljava/lang/Object;J)V", object, value);
    expect(object.value).toBe(value);
    await vcall(field("F"), "setLong", "(Ljava/lang/Object;J)V", object, value);
    expect(object.value).toBe(2 ** 62 + 2 ** 39);
    await vcall(field("F"), "setLong", "(Ljava/lang/Object;J)V", object, -value);
    expect(object.value).toBe(-(2 ** 62 + 2 ** 39));
    await vcall(field("F"), "setLong", "(Ljava/lang/Object;J)V", object, value - 1n);
    expect(object.value).toBe(2 ** 62);
  });

  test("typed setters ignore static receivers and reject invalid instance receivers and reference fields", async () => {
    await vcall(field("J", true), "setLong", "(Ljava/lang/Object;J)V", null, 7n);
    expect(Fields.value).toBe(7n);
    const error = await vcallAsync(field("J"), "setLong", "(Ljava/lang/Object;J)V", null, 7n).catch(error => error);
    expect(rt.iof(error, "java/lang/NullPointerException")).toBe(1);
    await expect(vcallAsync(field("J"), "setLong", "(Ljava/lang/Object;J)V", new JObj(), 7n)).rejects.toMatchObject({ msg: "Wrong field receiver" });
    await expect(vcallAsync(field("Ljava/lang/Long;"), "setLong", "(Ljava/lang/Object;J)V", new Fields(), 7n)).rejects.toMatchObject({ msg: "Invalid primitive field conversion" });
  });

  test("a static primitive write waits for its declaring class to initialize", async () => {
    class DelayedFields extends JObj { static value = 0n; }
    rt.register({ name: "test/DelayedFields", ctor: DelayedFields, clinit: async () => {
      await Promise.resolve(); DelayedFields.value = 3n;
    } });
    const f = Object.assign(new JField(), { owner: rt.link("test/DelayedFields"), prop: "value", desc: "J", isStatic: true });
    await vcall(f, "setLong", "(Ljava/lang/Object;J)V", null, 9n);
    expect(DelayedFields.value).toBe(9n);
  });

  test("type variables are equal only within one generic declaration", async () => {
    const forName = (n: string) => (rt.link("java/lang/Class").ctor as any)[mangleMethod("forName", "(Ljava/lang/String;)Ljava/lang/Class;")](n);
    const arrayList = await forName("java.util.ArrayList"), list = await forName("java.util.List");
    const listOfE = (await vcall(arrayList, "getGenericInterfaces", "()[Ljava/lang/reflect/Type;"))[0];
    const eOfArrayList = (await vcall(listOfE, "getActualTypeArguments", "()[Ljava/lang/reflect/Type;"))[0];
    const eOfList = (await vcall(list, "getTypeParameters", "()[Ljava/lang/reflect/TypeVariable;"))[0];
    expect(await vcall(eOfArrayList, "equals", "(Ljava/lang/Object;)Z", (await vcall(arrayList, "getTypeParameters", "()[Ljava/lang/reflect/TypeVariable;"))[0])).toBe(1);
    expect(await vcall(eOfArrayList, "equals", "(Ljava/lang/Object;)Z", eOfList)).toBe(0);
    expect(await vcall(eOfArrayList, "hashCode", "()I")).not.toBe(await vcall(eOfList, "hashCode", "()I"));
    expect(await vcall(eOfArrayList, "toString", "()Ljava/lang/String;")).toBe("E");
    const map = await newObj("java/util/HashMap");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", eOfList, "list");
    expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", eOfArrayList)).toBe(null);
    expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", eOfList)).toBe("list");
  });

  test("Unsafe reference-array offsets preserve adjacent elements and compare-and-swap", async () => {
    const unsafe = await vcall(rt.link("sun/misc/Unsafe").ctor, "getUnsafe", "()Lsun/misc/Unsafe;");
    const cls = rt.classFor("[Ljava/lang/Object;");
    const base = await vcall(unsafe, "arrayBaseOffset", "(Ljava/lang/Class;)I", cls);
    const scale = await vcall(unsafe, "arrayIndexScale", "(Ljava/lang/Class;)I", cls);
    expect([4, 8]).toContain(scale);
    const values = ["first", null, "last"];
    const offset = BigInt(base + scale);
    await vcall(unsafe, "putOrderedObject", "(Ljava/lang/Object;JLjava/lang/Object;)V", values, offset, "middle");
    expect(await vcall(unsafe, "getObjectVolatile", "(Ljava/lang/Object;J)Ljava/lang/Object;", values, offset)).toBe("middle");
    expect(await vcall(unsafe, "compareAndSwapObject", "(Ljava/lang/Object;JLjava/lang/Object;Ljava/lang/Object;)Z", values, offset, "middle", "changed")).toBe(1);
    expect(values).toEqual(["first", "changed", "last"]);
  });
});

describe("string-codepoints", () => {
  rt.linkNatives();

  test("String streams distinguish UTF-16 units from Unicode code points", async () => {
    const value = "A😀B";
    const call = (name: string) => (String.prototype as any)[mangleMethod(name, "()Ljava/util/stream/IntStream;")].call(value);
    expect(Array.from(await vcall(call("chars"), "toArray", "()[I"))).toEqual([65, 0xd83d, 0xde00, 66]);
    expect(Array.from(await vcall(call("codePoints"), "toArray", "()[I"))).toEqual([65, 0x1f600, 66]);
  });

  test("String.valueOf(Object) accepts Webdroid primitive values", async () => {
    const valueOf = (rt.link("java/lang/String").ctor as any)[mangleMethod("valueOf", "(Ljava/lang/Object;)Ljava/lang/String;")];
    expect(await valueOf(1)).toBe("1");
    expect(await valueOf(42n)).toBe("42");
  });
});

describe("text-concat", () => {
  rt.linkNatives();
  const concat = (...parts: unknown[]) => vcall(rt.link("android/text/TextUtils").ctor, "concat", "([Ljava/lang/CharSequence;)Ljava/lang/CharSequence;", parts);
  test("concat retains image spans and offsets through nested concatenations", async () => {
    const drawable = rt.make("android/graphics/drawable/ColorDrawable");
    const span = await newObj("android/text/style/ImageSpan", "(Landroid/graphics/drawable/Drawable;)V", drawable);
    const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "image");
    await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 5, 0x21);
    const first = await concat("4.8 ", text);
    const result = await concat(first, " (100)");
    expect(rt.iof(result, "android/text/SpannedString")).toBe(1);
    expect(rt.iof(result, "android/text/Spannable")).toBe(0);
    expect(await csText(result)).toBe("4.8 image (100)");
    expect(await vcall(result, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(4);
    expect(await vcall(result, "getSpanEnd", "(Ljava/lang/Object;)I", span)).toBe(9);
    expect(await vcall(result, "getSpanFlags", "(Ljava/lang/Object;)I", span)).toBe(0x21);
    await vcall(text, "removeSpan", "(Ljava/lang/Object;)V", span);
    expect(await vcall(result, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(4);
  });
  test("concat preserves one-piece identity, null text and span ownership", async () => {
    expect(await concat()).toBe("");
    expect(await concat(null)).toBeNull();
    expect(await concat("a", null, "b")).toBe("anullb");
    const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "ab");
    const span = rt.make("java/lang/Object"), noCopy = rt.make("android/text/NoCopySpan");
    await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 1, 0x21);
    await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", noCopy, 0, 2, 0x12);
    expect(await concat(text)).toBe(text);
    const result = await concat(text, text);
    if (!(result instanceof JSpanned)) throw new Error("Missing spans");
    expect(result.spans).toEqual([{ span, start: 0, end: 1, flags: 0x21 }]);
  });
  test("concat honors inclusive endpoints while appending later pieces", async () => {
    const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "ab");
    const span = rt.make("java/lang/Object");
    await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 2, 0x12);
    const result = await concat("prefix", text, "tail");
    expect(await vcall(result, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(6);
    expect(await vcall(result, "getSpanEnd", "(Ljava/lang/Object;)I", span)).toBe(12);
  });
});

describe("unicode-block", () => {
  rt.linkNatives();
  const cls = rt.link("java/lang/Character$UnicodeBlock").ctor;
  const of = (cp: number) => vcall(cls, "of", "(I)Ljava/lang/Character$UnicodeBlock;", cp);
  const named = (name: string | null) => vcall(cls, "forName", "(Ljava/lang/String;)Ljava/lang/Character$UnicodeBlock;", name);

  test("Unicode blocks preserve range boundaries, gaps and singleton identity", async () => {
    for (const [cp, name] of [[0, "BASIC_LATIN"], [0x7f, "BASIC_LATIN"], [0x80, "LATIN_1_SUPPLEMENT"],
      [0x4e00, "CJK_UNIFIED_IDEOGRAPHS"], [0xd800, "HIGH_SURROGATES"], [0xdb80, "HIGH_PRIVATE_USE_SURROGATES"],
      [0xdc00, "LOW_SURROGATES"], [0x1f600, "EMOTICONS"], [0x30000, "CJK_UNIFIED_IDEOGRAPHS_EXTENSION_G"],
      [0x10ffff, "SUPPLEMENTARY_PRIVATE_USE_AREA_B"]] as const) {
      const block = await of(cp);
      expect(block).toBe(await named(name));
      expect(await vcall(block, "toString", "()Ljava/lang/String;")).toBe(name);
      expect(rt.iof(block, "java/lang/Character$Subset")).toBe(1);
    }
    expect(await of(0x2fe0)).toBe(null);
    expect(await of(0x31350)).toBe(null);
    expect(await vcall(cls, "of", "(C)Ljava/lang/Character$UnicodeBlock;", 0x41)).toBe(await of(0x41));
    for (const cp of [-1, 0x110000]) await expect((async () => of(cp))()).rejects.toMatchObject({ msg: "Not a valid Unicode code point" });
  });

  test("Unicode block names accept Java aliases without inventing spellings", async () => {
    expect(await named("basic latin")).toBe(await named("BasicLatin"));
    expect(await named("Greek and Coptic")).toBe(await named("GREEK"));
    expect(await named("Latin-1Supplement")).toBe(await named("LATIN_1_SUPPLEMENT"));
    expect(await named("Cyrillic Supplement")).toBe(await named("CYRILLIC_SUPPLEMENTARY"));
    for (const name of ["BASIC-LATIN", " Basic Latin", "SURROGATES_AREA"]) await expect((async () => named(name))()).rejects.toMatchObject({ msg: "Not a valid block name: " + name });
    await expect((async () => named(null))()).rejects.toMatchObject({ msg: "blockName" });
  });
});
