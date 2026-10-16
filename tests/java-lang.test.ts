import { expect, test, describe } from "bun:test";
import "../src/natives.ts";
import { readFileSync } from "node:fs";
import { jarray, longBitsToDouble } from "../src/jvm/abi.ts";
import { DexFile } from "../src/jvm/dex.ts";
import { vcall, newObj, vcallAsync, mainThread, iof, staticField } from "../src/jvm/natives/jentry.ts";
import { JObj, rt } from "../src/jvm/runtime.ts";
import { loadDex } from "../src/jvm/tier.ts";
import { scall, thrown, loadLibcore, mountApexData } from "./java.ts";
import { detached } from "../src/jvm/natives/jthrowable.ts";

await loadLibcore();
await mountApexData();

describe("strict-math", () => {
  // x, y, then sin cos tan asin acos atan exp log log10 log1p expm1 cbrt sinh cosh tanh atan2(x, y)
  // hypot(x, y) pow(x, y) IEEEremainder(x, y), as raw bits: StrictMath on the reference AVD
  const VECTORS = [
    "400921fb54442d18 bd5650458c95b916 3ca1a62633145c07 bff0000000000000 bca1a62633145c07 7ff8000000000000 7ff8000000000000 3ff433b8a322ddd2 403724046eb09339 3ff250d048e7a1bd 3fdfd14db31ba3ba 3ff6bcbed09f00af 403624046eb09339 3ff76ef7e73104b7 402718f45d72e672 40272f147fee4000 3fefe175fa292810 3ff921fb54442edf 400921fb54442d18 3feffffffffff33a 3d3ead61344ecd28",
    "4086300000000000 9784a07b677e3ee3 3f0f9bd0303f6faf 3fefffffff063930 3f0f9bd03136287d 7ff8000000000000 7ff8000000000000 3ff91c367668c617 7ff0000000000000 401a42d4d1ff8154 4006cf608981902a 401a4445c70632f8 7ff0000000000000 4021d79d3987923a 7fe3e21a464507fa 7fe3e21a464507fa 3ff0000000000000 3ff921fb54442d19 4086300000000000 3ff0000000000000 9726b8a28250d600",
    "4480f0cf064dd592 c091ab3a75709005 bfeb453ab76bf397 3fe0be2cef01c8f4 bffa0f79c1b6b258 7ff8000000000000 7ff8000000000000 3ff921fb54442d18 7ff0000000000000 40495414621954fe 4036000000000000 40495414621954fe 7ff0000000000000 41748bd9ae67b4ba 7ff0000000000000 7ff0000000000000 3ff0000000000000 3ff921fb54442d19 4480f0cf064dd592 0 c074a1fd47414c94",
    "6f26857cda265843 c16ad6d4f156c758 3fe28a8219deb7f1 3fea14ca39312ff2 3fe6bfaa85d67d30 7ff8000000000000 7ff8000000000000 3ff921fb54442d18 7ff0000000000000 40805d58107accd8 406c6da2cc5799f1 40805d58107accd8 7ff0000000000000 4fac76d483df1511 7ff0000000000000 7ff0000000000000 3ff0000000000000 3ff921fb54442d19 6f26857cda265843 0 41540131c08c9b30",
    "c009ee5de5e06bb8 c09159be52513790 3fb9817858494ccc bfefd73d5aa554ad bfb9a21eea3e171d 7ff8000000000000 7ff8000000000000 bff45845cd3e5d07 3fa40628d98c5212 7ff8000000000000 7ff8000000000000 7ff8000000000000 bfeebf9d72673adf bff7add455c1c5e0 c02987b693e68005 40299bbcbcc00c57 bfefe6fa63b84d1e c0091c00ec79e9af 409159c32a7a75ea 7ff8000000000000 c009ee5de5e06bb8",
    "c07fa3c09edcc04f c02b1fe78f0c86b2 3fdb268d7ba6ca55 bfecfa4f46b84004 bfddfb755b27212a 7ff8000000000000 7ff8000000000000 bff919e401df64f0 12493ede86955d12 7ff8000000000000 7ff8000000000000 7ff8000000000000 bff0000000000000 c01fe122792c419b ed8447e0e6c8e42c 6d8447e0e6c8e42c bff0000000000000 bff98fb09068464f 407fa6a89ca129ac 7ff8000000000000 c011b7385d91244c",
    "c272902a377ab0c8 3b7facfb7fb81bcf bfee0682064b2fca bfd622339cbaf4a6 4005b471dd7d8b1b 7ff8000000000000 7ff8000000000000 bff921fb54441f4e 0 7ff8000000000000 7ff8000000000000 7ff8000000000000 bff0000000000000 c0c52ead824d14d7 fff0000000000000 7ff0000000000000 bff0000000000000 bff921fb54442d18 4272902a377ab0c8 7ff8000000000000 bb637720b2f5e448",
    "c027f42b4d8f9c64 3f8fdf988f8dd000 3fe1ca2760410a1b 3fea997207a4cd89 3fe566ce3e835155 7ff8000000000000 7ff8000000000000 bff7ccc8021398c0 3eda5f846cafbc34 7ff8000000000000 7ff8000000000000 7ff8000000000000 bfeffff2d03dc9a8 c0024dbcf19940a5 c0f369e8e97f193e 40f369e8e985b120 bfeffffffff521d6 bff91ca8c60712e6 4027f42ca0da3e21 7ff8000000000000 3f7bb75314342000",
    "3e57a841a9456140 c02b7420689bd2f2 3e57a841a945613f 3feffffffffffffe 3e57a841a9456141 3e57a841a9456141 3ff921fb4e5a1cae 3e57a841a945613f 3ff0000005ea106b c031a1788d166d9d c01ea0b3b8316c42 3e57a841a4e60c7c 3e57a841ada4b606 3f66f73290058f34 3e57a841a9456141 3ff0000000000001 3e57a841a945613f 400921fb540d06b9 402b7420689bd2f2 55c1c7dd9c74bf33 3e57a841a9456140",
    "c028361d7f5ac77b c00049955834da8c 3fdc739495ac2add 3feca9ffb9079b3b 3fdfc33f8c06c80d 7ff8000000000000 7ff8000000000000 bff7d06521c28dbc 3ed72f96e5dfc18a 7ff8000000000000 7ff8000000000000 7ff8000000000000 bfeffff468348d10 c0025e79a6b7a8a8 c0f615177ff84475 40f615177ffe105b bfeffffffff799a8 bffbcc7552eb4a97 40288d28a8a2f3f8 7ff8000000000000 3fbc21427a402b80",
  ];
  test("StrictMath's natives are fdlibm's, bit for bit", async () => {
    const bits = (hex: string) => longBitsToDouble(BigInt.asIntN(64, BigInt("0x" + hex)));
    const hex = (v: number) => new BigUint64Array(new Float64Array([v]).buffer)[0].toString(16);
    const one = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "log10", "log1p", "expm1", "cbrt", "sinh", "cosh", "tanh"];
    const two = ["atan2", "hypot", "pow", "IEEEremainder"];
    for (const row of VECTORS) {
      const [x, y, ...expected] = row.split(" ");
      const got = [...one.map((f) => scall("java/lang/StrictMath", f, "(D)D", bits(x))), ...two.map((f) => scall("java/lang/StrictMath", f, "(DD)D", bits(x), bits(y)))];
      expect((await Promise.all(got)).map(hex)).toEqual(expected);
    }
  });
});

// libcore's Pattern and Matcher over our regex natives
describe("regex", () => {
  const compile = (source: string) => scall("java/util/regex/Pattern", "compile", "(Ljava/lang/String;)Ljava/util/regex/Pattern;", source);

  test("String's regex methods follow Pattern's line terminators, split and replacement rules", async () => {
    const S = "Ljava/lang/String;";
    expect(await vcall("a\nb", "matches", `(${S})Z`, "a.b")).toBe(0);
    expect(await vcall("a\nb", "matches", `(${S})Z`, "(?s)a.b")).toBe(1);
    expect(await vcall("a\nb", "replaceAll", `(${S}${S})${S}`, ".", "x")).toBe("x\nx");
    expect(Array.from(await vcall("a\r\nb", "split", `(${S})[${S}`, "."))).toEqual(["", "\r\n"]);
    expect(Array.from(await vcall(",", "split", `(${S})[${S}`, ","))).toEqual([]);
    expect(Array.from(await vcall("a:b:c:d", "split", `(${S}I)[${S}`, ":", 3))).toEqual(["a", "b", "c:d"]);
    expect(Array.from(await vcall("a::", "split", `(${S}I)[${S}`, ":", -1))).toEqual(["a", "", ""]);
    expect(await vcall("a1b2", "replaceAll", `(${S}${S})${S}`, "(?<d>\\d)", "[${d}\\$\\\\]")).toBe("a[1$\\]b[2$\\]");
    await expect(vcallAsync("abc", "replaceAll", `(${S}${S})${S}`, "b", "$2")).rejects.toBeDefined();
  });

  test("atomic groups commit alternatives and hide internal captures", async () => {
    const matcher = async (pattern: string, input: string) => vcall(await compile(pattern), "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", input);
    expect(await vcall(await matcher("^(?>a+)a$", "aaa"), "matches", "()Z")).toBe(0);
    expect(await vcall(await matcher("^(?>a+)b$", "aaab"), "matches", "()Z")).toBe(1);
    const path = await matcher("^/(?>(?>\\.\\.?/)+)", "/.././chapter");
    expect(await vcall(path, "find", "()Z")).toBe(1);
    expect(await vcall(path, "groupCount", "()I")).toBe(0);
    expect(await vcall(path, "group", "()Ljava/lang/String;")).toBe("/.././");
  });

  test("line terminators, UNIX_LINES and hitEnd/requireEnd follow ICU", async () => {
    // [pattern, flags, input, ops]; each op reports "found start end hitEnd requireEnd"
    const cases: [string, number, string, string, string][] = [
      ["a.b", 0, "a\u0085b", "find", "0 -1 -1 1 0"],
      ["a.b", 1, "a\rb", "find", "1 0 3 0 0"],
      ["abc$", 0, "abc\r\n", "find", "1 0 3 1 1"],
      ["abc$", 1, "abc\r", "find", "0 -1 -1 1 0"],
      ["^b", 8, "a\rb", "find", "1 2 3 0 0"],
      ["^b", 9, "a\rb", "find", "0 -1 -1 1 0"],
      ["^", 8, "a\n", "find,find,find", "1 0 0 0 0;0 -1 -1 1 0;0 -1 -1 1 0"],
      ["\\d{3}", 0, "123", "find", "1 0 3 0 0"],
      ["a+", 0, "aa", "lookingAt", "1 0 2 1 0"],
      ["ab|a", 0, "a", "find", "1 0 1 1 0"],
      ["a|ab", 0, "a", "find", "1 0 1 0 0"],
      ["a\\b", 0, "a", "find", "1 0 1 1 0"],
      ["\\w+(?=\\s*$)", 0, "ab  ", "find", "1 0 2 1 1"],
      ["^abc", 0, "xyz", "find", "0 -1 -1 0 0"],
      ["a(?=.*!)|b", 0, "a b!", "find,find", "1 0 1 1 0;1 2 3 1 0"],
    ];
    for (const [pattern, flags, input, ops, want] of cases) {
      const p = await scall("java/util/regex/Pattern", "compile", "(Ljava/lang/String;I)Ljava/util/regex/Pattern;", pattern, flags);
      const m = await vcall(p, "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", input);
      const got: string[] = [];
      for (const op of ops.split(",")) {
        const found = await vcall(m, op, "()Z");
        const span = found ? [await vcall(m, "start", "()I"), await vcall(m, "end", "()I")] : [-1, -1];
        got.push([found, ...span, await vcall(m, "hitEnd", "()Z"), await vcall(m, "requireEnd", "()Z")].join(" "));
      }
      expect(`${pattern} ${got.join(";")}`).toBe(`${pattern} ${want}`);
    }
  });

  test("named groups report text and bounds and reject unknown names", async () => {
    const m = await vcall(await compile("(?<k>[a-z]+)=(?<v>\\d+)?"), "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", " ab=");
    expect(await vcall(m, "groupCount", "()I")).toBe(2);
    expect(await vcall(m, "find", "()Z")).toBe(1);
    expect(await vcall(m, "group", "(Ljava/lang/String;)Ljava/lang/String;", "k")).toBe("ab");
    expect([await vcall(m, "start", "(Ljava/lang/String;)I", "k"), await vcall(m, "end", "(Ljava/lang/String;)I", "k")]).toEqual([1, 3]);
    expect(await vcall(m, "group", "(Ljava/lang/String;)Ljava/lang/String;", "v")).toBeNull();
    expect(await vcall(m, "start", "(Ljava/lang/String;)I", "v")).toBe(-1);
    await expect(vcallAsync(m, "end", "(Ljava/lang/String;)I", "x")).rejects.toBeDefined();
  });
});

describe("reference", () => {
  test("PhantomReference never yields its referent and enqueues nothing", async () => {
    const queue = await newObj("java/lang/ref/ReferenceQueue");
    const referent = await newObj("java/lang/Object");
    const ref = await newObj("java/lang/ref/PhantomReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", referent, queue);
    expect(iof(ref, "java/lang/ref/Reference")).toBe(true);
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBeNull();
    expect(await vcall(queue, "poll", "()Ljava/lang/ref/Reference;")).toBeNull();
    expect(await vcall(queue, "remove", "(J)Ljava/lang/ref/Reference;", 5n)).toBeNull();
  });
});

describe("reference-queue", () => {
  test("reference queue state survives explicit enqueue, blocked removal and repeated enqueue", async () => {
    const queue = await newObj("java/lang/ref/ReferenceQueue");
    const value = await newObj("java/lang/Object");
    const ref = await newObj("java/lang/ref/WeakReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", value, queue);
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBe(value);
    expect(await vcall(ref, "isEnqueued", "()Z")).toBe(0);
    const waiting = vcall(queue, "remove", "()Ljava/lang/ref/Reference;");
    expect(await vcall(ref, "enqueue", "()Z")).toBe(1);
    expect(await waiting).toBe(ref);
    // only the collector clears a referent it enqueues
    expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBe(value);
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
  test("type variables are equal only within one generic declaration", async () => {
    const forName = (n: string) => scall("java/lang/Class", "forName", "(Ljava/lang/String;)Ljava/lang/Class;", n);
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
    const unsafe = await scall("sun/misc/Unsafe", "getUnsafe", "()Lsun/misc/Unsafe;");
    const cls = rt.classFor("[Ljava/lang/Object;");
    const base = await vcall(unsafe, "arrayBaseOffset", "(Ljava/lang/Class;)I", cls);
    const scale = await vcall(unsafe, "arrayIndexScale", "(Ljava/lang/Class;)I", cls);
    expect([4, 8]).toContain(scale);
    const [first, middle, changed, last] = await Promise.all([0, 1, 2, 3].map(() => newObj("java/lang/Object")));
    const values = jarray([first, null, last], "Ljava/lang/Object;");
    const offset = BigInt(base + scale);
    await vcall(unsafe, "putOrderedObject", "(Ljava/lang/Object;JLjava/lang/Object;)V", values, offset, middle);
    expect(await vcall(unsafe, "getObjectVolatile", "(Ljava/lang/Object;J)Ljava/lang/Object;", values, offset)).toBe(middle);
    expect(await vcall(unsafe, "compareAndSwapObject", "(Ljava/lang/Object;JLjava/lang/Object;Ljava/lang/Object;)Z", values, offset, middle, changed)).toBe(1);
    expect([...values]).toEqual([first, changed, last]);
  });
});

describe("string-codepoints", () => {
  test("String streams distinguish UTF-16 units from Unicode code points", async () => {
    const value = "A😀B";
    const call = async (name: string) => vcall(await vcall(value, name, "()Ljava/util/stream/IntStream;"), "toArray", "()[I");
    expect(Array.from(await call("chars"))).toEqual([65, 0xd83d, 0xde00, 66]);
    expect(Array.from(await call("codePoints"))).toEqual([65, 0x1f600, 66]);
  });

  test("String.indexOf(int) finds supplementary code points and never an invalid one", async () => {
    const at = (name: string, desc: string, ...args: number[]) => vcall("A😀B￿", name, desc, ...args);
    expect(await at("indexOf", "(I)I", 0x1f600)).toBe(1);
    expect(await at("indexOf", "(I)I", 0xf600)).toBe(-1);
    expect(await at("indexOf", "(I)I", -1)).toBe(-1);
    expect(await at("indexOf", "(II)I", 0x42, -5)).toBe(3);
    expect(await at("lastIndexOf", "(I)I", 0x1f600)).toBe(1);
    expect(await at("lastIndexOf", "(II)I", 0x41, -1)).toBe(-1);
  });
});

describe("java-math-boundary", () => {
  const big = (s: string) => newObj("java/math/BigInteger", "(Ljava/lang/String;)V", s);
  test("NativeBN serves modPow, multiply and divide on large operands", async () => {
    const p = (1n << 521n) - 1n, a = 3n ** 300n, e = (1n << 200n) + 12345n;
    const text = (o: unknown) => vcall(o, "toString", "()Ljava/lang/String;");
    let r = 1n;
    for (let b = a % p, x = e; x > 0n; x >>= 1n, b = b * b % p) if (x & 1n) r = r * b % p;
    expect(await text(await vcall(await big(a.toString()), "modPow", "(Ljava/math/BigInteger;Ljava/math/BigInteger;)Ljava/math/BigInteger;", await big(e.toString()), await big(p.toString())))).toBe(r.toString());
    expect(await text(await vcall(await big((-a).toString()), "modPow", "(Ljava/math/BigInteger;Ljava/math/BigInteger;)Ljava/math/BigInteger;", await big("3"), await big(p.toString())))).toBe((((-a) ** 3n % p) + p) % p + "");
    const x = 7n ** 900n, y = -(5n ** 700n);
    expect(await text(await vcall(await big(x.toString()), "multiply", "(Ljava/math/BigInteger;)Ljava/math/BigInteger;", await big(y.toString())))).toBe((x * y).toString());
    const qr = await vcall(await big(x.toString()), "divideAndRemainder", "(Ljava/math/BigInteger;)[Ljava/math/BigInteger;", await big(y.toString())) as unknown[];
    expect(await text(qr[0])).toBe((x / y).toString());
    expect(await text(qr[1])).toBe((x % y).toString());
  });
});

describe("invocation-target", () => {
  test("Method.invoke wraps what the target threw, and a stack trace prints it as the cause", async () => {
    const method = await vcallAsync(rt.classFor("java/lang/Integer"), "getMethod", "(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;",
      "parseInt", jarray([rt.classFor("java/lang/String")], "Ljava/lang/Class;"));
    const e = await vcallAsync(method, "invoke", "(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;", null, jarray(["x"], "Ljava/lang/Object;")).then(() => null, (x) => x);
    expect(iof(e, "java/lang/reflect/InvocationTargetException")).toBe(true);
    const target = await vcallAsync(e, "getTargetException", "()Ljava/lang/Throwable;");
    expect(iof(target, "java/lang/NumberFormatException")).toBe(true);
    expect(await vcallAsync(e, "getCause", "()Ljava/lang/Throwable;") === target).toBe(true);
    const text = await newObj("java/io/StringWriter");
    await vcall(e, "printStackTrace", "(Ljava/io/PrintWriter;)V", await newObj("java/io/PrintWriter", "(Ljava/io/Writer;)V", text));
    expect(await vcall(text, "toString", "()Ljava/lang/String;")).toContain("\nCaused by: java.lang.NumberFormatException: For input string: \"x\"");
  });
});

describe("uncaught-exceptions", () => {
  class Recorder extends JObj { tag = ""; }
  const seen: [string, unknown, unknown][] = [];
  rt.register({ name: "test/UncaughtRecorder", ctor: Recorder, ifaces: ["java/lang/Thread$UncaughtExceptionHandler"], methods: {
    "uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V": function (this: Recorder, t: unknown, e: unknown) { seen.push([this.tag, t, e]); },
  } });
  let failure: unknown;
  rt.register({ name: "test/Throwing", ctor: class extends JObj {}, ifaces: ["java/lang/Runnable"], methods: { "run()V": () => { throw failure; } } });
  const recorder = async (tag: string) => Object.assign(await newObj("test/UncaughtRecorder") as Recorder, { tag });

  test("Thread.dispatchUncaughtException runs the pre-handler, then the thread's handler or its group's default", async () => {
    const H = "(Ljava/lang/Thread$UncaughtExceptionHandler;)V";
    const set = (name: string, handler: unknown) => scall("java/lang/Thread", name, H, handler);
    failure = await newObj("java/lang/IllegalStateException", "(Ljava/lang/String;)V", "escaped");
    await set("setUncaughtExceptionPreHandler", await recorder("pre"));
    await set("setDefaultUncaughtExceptionHandler", await recorder("default"));
    try {
      const thread = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", await newObj("test/Throwing"));
      await vcall(thread, "start", "()V");
      await vcall(thread, "join", "()V");
      expect(seen).toEqual([["pre", thread, failure], ["default", thread, failure]]);
      seen.length = 0;
      const own = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", await newObj("test/Throwing"));
      await vcall(own, "setUncaughtExceptionHandler", H, await recorder("own"));
      await vcall(own, "start", "()V");
      await vcall(own, "join", "()V");
      expect(seen.map(([tag]) => tag)).toEqual(["pre", "own"]);
      // a host-entered call no Java frame waits on escapes the thread that made it
      seen.length = 0;
      detached(() => { throw failure; });
      await Bun.sleep(0);
      const main = await scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;");
      expect(seen).toEqual([["pre", main, failure], ["default", main, failure]]);
    } finally {
      seen.length = 0;
      await set("setUncaughtExceptionPreHandler", null);
      await set("setDefaultUncaughtExceptionHandler", null);
    }
  });
});

describe("thread-group", () => {
  class WaitingTask extends JObj { finish: (() => void) | null = null; }
  rt.register({ name: "test/WaitingTask", ctor: WaitingTask, ifaces: ["java/lang/Runnable"], methods: {
    "run()V": function (this: WaitingTask) { return new Promise<void>(resolve => { this.finish = resolve; }); },
  } });
  test("live threads, suspended ones included, are in libcore's main group, under system, until they end", async () => {
    const task = await newObj("test/WaitingTask") as WaitingTask;
    const thread = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", task);
    const group = await vcall(thread, "getThreadGroup", "()Ljava/lang/ThreadGroup;");
    expect(await vcall(group, "getName", "()Ljava/lang/String;")).toBe("main");
    expect(await vcall(await vcall(group, "getParent", "()Ljava/lang/ThreadGroup;"), "getName", "()Ljava/lang/String;")).toBe("system");
    const activeCount = () => vcall(group, "activeCount", "()I");
    const count = await activeCount();
    await vcall(thread, "start", "()V");
    await Bun.sleep(0);
    try {
      expect(await activeCount()).toBe(count + 1);
      const threads = jarray(new Array(count + 2).fill(null), "Ljava/lang/Thread;");
      expect(await scall("java/lang/Thread", "enumerate", "([Ljava/lang/Thread;)I", threads)).toBe(count + 1);
      expect(threads).toContain(thread);
    } finally { task.finish?.(); }
    await vcall(thread, "join", "()V");
    expect(await activeCount()).toBe(count);
    expect(await vcall(thread, "getThreadGroup", "()Ljava/lang/ThreadGroup;")).toBeNull();
  });
});

describe("thread-state", () => {
  const state = async (thread: unknown) => vcall(await vcall(thread, "getState", "()Ljava/lang/Thread$State;"), "name", "()Ljava/lang/String;");

  test("Thread states distinguish new, runnable and terminated threads", async () => {
    const thread = await newObj("java/lang/Thread");
    expect(await state(thread)).toBe("NEW");
    expect(await state(mainThread)).toBe("RUNNABLE");
    await vcall(thread, "start", "()V");
    await vcall(thread, "join", "()V");
    expect(await state(thread)).toBe("TERMINATED");
    await expect(vcallAsync(thread, "start", "()V")).rejects.toBeDefined();
  });
});

describe("string-case", () => {
  test("case-insensitive comparison folds char by char, as libcore does", async () => {
    const call = (self: string, name: string, desc: string, o: string) => vcall(self, name, desc, o);
    expect(await call("apple", "compareToIgnoreCase", "(Ljava/lang/String;)I", "APRICOT")).toBe(-2);
    expect(await call("hello", "compareToIgnoreCase", "(Ljava/lang/String;)I", "HELLO world")).toBe(-6);
    expect(await call("İ", "equalsIgnoreCase", "(Ljava/lang/String;)Z", "i")).toBe(1);
    expect(await call("Straße", "equalsIgnoreCase", "(Ljava/lang/String;)Z", "STRASSE")).toBe(0);
    expect(await call("MiXeD", "equalsIgnoreCase", "(Ljava/lang/String;)Z", "mixed")).toBe(1);
    expect(await call("a@[", "equalsIgnoreCase", "(Ljava/lang/String;)Z", "a`{")).toBe(0);
    expect(await call("ok", "equalsIgnoreCase", "(Ljava/lang/String;)Z", "o\u212a")).toBe(1);
    const cmp = await staticField("java/lang/String", "CASE_INSENSITIVE_ORDER");
    expect(await vcall(cmp, "compare", "(Ljava/lang/Object;Ljava/lang/Object;)I", "b", "A")).toBe(1);
  });

  test("case mapping follows the locale, and the default locale for the no-argument forms", async () => {
    const tr = await scall("java/util/Locale", "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", "tr");
    const original = await scall("java/util/Locale", "getDefault", "()Ljava/util/Locale;");
    expect(await vcall("TITLE", "toLowerCase", "(Ljava/util/Locale;)Ljava/lang/String;", tr)).toBe("tıtle");
    expect(await vcall("title", "toUpperCase", "(Ljava/util/Locale;)Ljava/lang/String;", tr)).toBe("TİTLE");
    expect(await vcall("TITLE", "toLowerCase", "()Ljava/lang/String;")).toBe("title");
    await scall("java/util/Locale", "setDefault", "(Ljava/util/Locale;)V", tr);
    try { expect(await vcall("TITLE", "toLowerCase", "()Ljava/lang/String;")).toBe("tıtle"); }
    finally { await scall("java/util/Locale", "setDefault", "(Ljava/util/Locale;)V", original); }
    expect(await vcall("TITLE", "toLowerCase", "()Ljava/lang/String;")).toBe("title");
  });

  test("compareTo keeps its value where it is returned and orders by UTF-16 units where only its sign is read", async () => {
    const natural = await scall("java/util/Comparator", "naturalOrder", "()Ljava/util/Comparator;");
    expect(await vcall(natural, "compare", "(Ljava/lang/Object;Ljava/lang/Object;)I", "apple", "apricot")).toBe(-2);
    const keys = ["b", "a\uffff", "a", "\ud83d\ude00", "\uff61", "ab", ""];
    const set = await newObj("java/util/TreeSet", "()V");
    for (const k of keys) await vcall(set, "add", "(Ljava/lang/Object;)Z", k);
    expect(await vcall(set, "toString", "()Ljava/lang/String;")).toBe(`[${[...keys].sort().join(", ")}]`);
  });
});

describe("string-trim", () => {
  test("String.trim removes a proc cmdline terminator", async () => {
    expect(await vcall("\0 com.example.app\0", "trim", "()Ljava/lang/String;")).toBe("com.example.app");
  });
});

describe("invoke-polymorphic-custom", () => {
  test("VarHandles, method handles and record methods", async () => {
    loadDex(new DexFile(new Uint8Array(readFileSync(import.meta.dir + "/fixtures/InvokeProbe.dex"))), true);
    const missing = rt.missing.size, call = (name: string) => scall("InvokeProbe", name, "()Ljava/lang/String;");
    expect(await call("varHandles")).toBe("true,false,5,8,true,true,true,40,42,true,y,oob");
    expect(await call("methodHandles")).toBe("103,107,n7");
    expect(await call("records")).toBe("Point[x=1, label=a, id=9],true,false,true,Point[x=2, label=null, id=9]");
    expect([...rt.missing].slice(missing)).toEqual([]);
  });
});

describe("system-properties", () => {
  test("System.<clinit> builds its properties from the runtime, the environment and the ICU data", async () => {
    const property = (key: string) => scall("java/lang/System", "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", key);
    expect(await property("user.locale")).toBe("en-US");
    expect([await property("user.language"), await property("user.region")]).toEqual(["en", "US"]);
    expect(await property("java.home")).toBe("/apex/com.android.art");
    expect(await property("java.vm.version")).toBe("2.1.0");
    expect([await property("android.icu.unicode.version"), await property("android.icu.cldr.version")]).toEqual(["15.1", "45.0"]);
  });
  test("loadLibrary reports a library the class path lacks as the linker does", async () => {
    expect(await thrown(() => scall("java/lang/System", "loadLibrary", "(Ljava/lang/String;)V", "absent")))
      .toBe('java/lang/UnsatisfiedLinkError: dlopen failed: library "libabsent.so" not found');
  });
  test("Runtime.exec tokenizes the program and reports that processes cannot start", async () => {
    const runtime = await scall("java/lang/Runtime", "getRuntime", "()Ljava/lang/Runtime;");
    const error = await thrown(() => vcall(runtime, "exec", "(Ljava/lang/String;)Ljava/lang/Process;", "getprop ro.product.cpu.abi"));
    expect(error).toStartWith("java/io/IOException: ");
    expect(error).toContain('"getprop"');
  });
});

describe("dex-class-loaders", () => {
  test("in-memory DEX loaders read the buffer window and preserve defining-loader identity", async () => {
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
    expect([await vcall(buffer, "position", "()I"), await vcall(buffer, "limit", "()I")]).toEqual([8, 8 + bytes.length]);
    const { readOnlyBuffer } = await import("../src/jvm/natives/jnio.ts");
    const mapped = await readOnlyBuffer(bytes);
    const paged = await newObj("dalvik/system/InMemoryDexClassLoader", "(Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V", mapped, null);
    const loaded = await vcall(paged,"loadClass","(Ljava/lang/String;)Ljava/lang/Class;","JvmTierProbe");
    expect(await vcall(loaded,"getClassLoader","()Ljava/lang/ClassLoader;")).toBe(paged);
  });
});

