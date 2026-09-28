import { expect, test, describe } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall, curThread, JThread, mainThread, setCurThread, vcallOn, vcallAsync, newObj } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { synchronizedMap } from "../src/jvm/natives/jwrappers";
import { scall } from "./java";

rt.linkNatives();

describe("abstract-sequential-list", () => {
  class Sequential extends rt.link("java/util/AbstractSequentialList").ctor {
    values = newArrayList(["a", "b", "c"]);
    positions: number[] = [];
    failure: unknown = null;
  }
  rt.register({ name: "test/Sequential", ctor: Sequential, sup: "java/util/AbstractSequentialList", methods: {
    "size()I": function (this: Sequential) { return vcall(this.values, "size", "()I"); },
    "listIterator(I)Ljava/util/ListIterator;": async function (this: Sequential, index: number) {
      await Promise.resolve();
      this.positions.push(index);
      if (this.failure) throw this.failure;
      return vcall(this.values, "listIterator", "(I)Ljava/util/ListIterator;", index);
    },
  } });
  rt.linkNatives();

  test("sequential list access and bulk insertion use the subclass's live iterator", async () => {
    const list = new Sequential();
    expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 1)).toBe("b");
    expect(await vcall(list, "set", "(ILjava/lang/Object;)Ljava/lang/Object;", 1, "B")).toBe("b");
    expect(await vcall(list, "remove", "(I)Ljava/lang/Object;", 0)).toBe("a");
    await vcall(list, "add", "(ILjava/lang/Object;)V", 1, "x");
    list.positions.length = 0;
    expect(await vcall(list, "addAll", "(ILjava/util/Collection;)Z", 1, newArrayList(["y", "z"]))).toBe(1);
    expect(list.positions).toEqual([1]);
    expect(await vcall(list, "toArray", "()[Ljava/lang/Object;")).toEqual(["B", "y", "z", "x", "c"]);
    list.positions.length = 0;
    const it = await vcall(list, "iterator", "()Ljava/util/Iterator;");
    expect(list.positions).toEqual([0]);
    expect(await vcall(it, "next", "()Ljava/lang/Object;")).toBe("B");
    await vcall(it, "remove", "()V");
    expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 0)).toBe("y");
    expect(await vcall(list, "indexOf", "(Ljava/lang/Object;)I", "x")).toBe(2);
    expect(await vcall(list, "addAll", "(ILjava/util/Collection;)Z", 4, newArrayList())).toBe(0);
    expect(rt.iof(list, "java/util/List")).toBe(1);
  });

  test("sequential list converts iterator exhaustion without suppressing other failures", async () => {
    const list = new Sequential();
    for (const [name, desc, args] of [
      ["get", "(I)Ljava/lang/Object;", [3]],
      ["set", "(ILjava/lang/Object;)Ljava/lang/Object;", [3, "x"]],
      ["remove", "(I)Ljava/lang/Object;", [3]],
    ] satisfies [string, string, unknown[]][]) {
      await expect(vcallAsync(list, name, desc, ...args)).rejects.toMatchObject({ msg: "Index: 3" });
    }
    const failure = rt.mkThrowable("java/lang/UnsupportedOperationException", "iterator is immutable");
    list.failure = failure;
    await expect(vcallAsync(list, "add", "(ILjava/lang/Object;)V", 0, "x")).rejects.toBe(failure);
    list.failure = rt.mkThrowable("java/util/NoSuchElementException", "exhausted");
    await expect(vcallAsync(list, "addAll", "(ILjava/util/Collection;)Z", 8, newArrayList())).rejects.toMatchObject({ msg: "Index: 8" });
  });


  test("sequential iterator callbacks retain their caller after suspension", async () => {
    const seen: JThread[] = [];
    class ThreadIterator extends JObj {}
    rt.register({ name: "test/SequentialThreadIterator", ctor: ThreadIterator, methods: {
      "next()Ljava/lang/Object;": async () => { seen.push(curThread); await Promise.resolve(); return "old"; },
      "set(Ljava/lang/Object;)V": () => { seen.push(curThread); },
    } });
    class ThreadList extends rt.link("java/util/AbstractSequentialList").ctor {}
    rt.register({ name: "test/SequentialThreadList", ctor: ThreadList, sup: "java/util/AbstractSequentialList", methods: {
      "listIterator(I)Ljava/util/ListIterator;": async () => { seen.push(curThread); await Promise.resolve(); return new ThreadIterator(); },
    } });
    rt.linkNatives();
    const caller = new JThread();
    const result = vcallOn(caller, new ThreadList(), "set", "(ILjava/lang/Object;)Ljava/lang/Object;", 0, "new");
    setCurThread(mainThread);
    expect(await result).toBe("old");
    expect(seen.map(thread => thread === caller)).toEqual([true, true, true]);
    expect(curThread).toBe(mainThread);
  });
});

describe("android-pair", () => {
  test("Android Pair compares nested values and hashes equal pairs equally", async () => {
    const pair = (a: unknown, b: unknown) => newObj("android/util/Pair", "(Ljava/lang/Object;Ljava/lang/Object;)V", a, b);
    const first = await pair("outer", await pair("left", "right"));
    const same = await pair("outer", await pair("left", "right"));
    const different = await pair("outer", await pair("left", "other"));

    expect(await vcall(first, "equals", "(Ljava/lang/Object;)Z", same)).toBe(1);
    expect(await vcall(first, "equals", "(Ljava/lang/Object;)Z", different)).toBe(0);
    expect(await vcall(first, "hashCode", "()I")).toBe(await vcall(same, "hashCode", "()I"));
    expect(await vcall(first, "toString", "()Ljava/lang/String;")).toBe("Pair{outer Pair{left right}}");
  });
});

describe("array-binary-search", () => {
  test("Arrays.binarySearch awaits a comparator and reports insertion points", async () => {
    const comparator = {
      [mangleMethod("compare", "(Ljava/lang/Object;Ljava/lang/Object;)I")]: async (a: number, b: number) => {
        await Promise.resolve();
        return b - a;
      },
    };
    const arrays = rt.link("java/util/Arrays").ctor;
    const desc = "([Ljava/lang/Object;Ljava/lang/Object;Ljava/util/Comparator;)I";
    for (const [key, result] of [[9, 0], [5, 1], [2, 2], [10, -1], [6, -2], [0, -4]]) {
      expect(await vcall(arrays, "binarySearch", desc, [9, 5, 2], key, comparator)).toBe(result);
    }
    expect(await vcall(arrays, "binarySearch", desc, ["a", "b", "d"], "b", null)).toBe(1);
  });
  for (const [type, ArrayType] of [["F", Float32Array], ["D", Float64Array]] as const) {
    test(`Arrays.binarySearch orders ${type} NaN and signed zero and validates ranges`, async () => {
      const arrays = rt.link("java/util/Arrays").ctor;
      const values = new ArrayType([-Infinity, -2, -0, 0, 1, Infinity, NaN]);
      for (const [i, value] of values.entries()) {
        expect(await vcall(arrays, "binarySearch", `([${type}${type})I`, values, value)).toBe(i);
      }
      expect(await vcall(arrays, "binarySearch", `([${type}${type})I`, values, 0.5)).toBe(-5);
      expect(await vcall(arrays, "binarySearch", `([${type}II${type})I`, values, 2, 5, -2)).toBe(-3);
      expect(await vcall(arrays, "binarySearch", `([${type}II${type})I`, values, 2, 5, NaN)).toBe(-6);
      for (const [from, to, error] of [[4, 2, "IllegalArgumentException"], [-1, 2, "ArrayIndexOutOfBoundsException"], [0, 8, "ArrayIndexOutOfBoundsException"]] as const) {
        try { await vcall(arrays, "binarySearch", `([${type}II${type})I`, values, from, to, 0); throw new Error("Accepted invalid range"); }
        catch (e) { expect(rt.iof(e, "java/lang/" + error)).toBe(1); }
      }
      const cls = rt.link(type === "F" ? "java/lang/Float" : "java/lang/Double").ctor;
      expect(await vcall(cls, "compare", `(${type}${type})I`, -0, 0)).toBe(-1);
      expect(await vcall(cls, "compare", `(${type}${type})I`, 0, -0)).toBe(1);
      expect(await vcall(cls, "compare", `(${type}${type})I`, NaN, NaN)).toBe(0);
    });
  }
});

describe("array-deep-string", () => {
  const stringify = (a: unknown[] | null) => vcall(rt.link("java/util/Arrays").ctor, "deepToString", "([Ljava/lang/Object;)Ljava/lang/String;", a);
  test("deep array strings distinguish cycles from shared arrays and format primitive elements", async () => {
    const shared = ["value"], a: unknown[] = [shared, shared];
    a.push(a, new Uint16Array([65, 66]), new Uint8Array([1, 0]), new Float32Array([1.5, 2]), new BigInt64Array([9n]), null);
    expect(await stringify(a)).toBe("[[value], [value], [...], [A, B], [true, false], [1.5, 2.0], [9], null]");
    expect(await stringify(null)).toBe("null");
  });
});

describe("array-sort-range", () => {
  test("natural array range sorting awaits Comparable and preserves equal-element order", async () => {
    const comparable = (rank: number) => ({
      rank,
      [mangleMethod("compareTo", "(Ljava/lang/Object;)I")]: async (other: { rank: number }) => {
        await Promise.resolve();
        return rank - other.rank;
      },
    });
    const first = comparable(1), second = comparable(1), large = comparable(2);
    const array = [null, large, first, second, null];
    const sort = (from: number, to: number) => vcall(rt.link("java/util/Arrays").ctor, "sort", "([Ljava/lang/Object;II)V", array, from, to);
    await sort(1, 4);
    expect(array).toEqual([null, first, second, large, null]);
    for (const [from, to, cls] of [[3, 2, "IllegalArgumentException"], [-1, 0, "ArrayIndexOutOfBoundsException"], [0, 6, "ArrayIndexOutOfBoundsException"]] as const) {
      let error: unknown;
      try { await sort(from, to); } catch (e) { error = e; }
      expect(rt.iof(error, `java/lang/${cls}`)).toBe(1);
    }
  });
});

describe("bidi-formatter", () => {
  test("bidi wrapping isolates opposite-direction text and retains embedded spans", async () => {
    const ltr = await vcall(rt.link("android/text/BidiFormatter").ctor, "getInstance", "(Z)Landroid/text/BidiFormatter;", 0);
    const rtl = await vcall(rt.link("android/text/BidiFormatter").ctor, "getInstance", "(Z)Landroid/text/BidiFormatter;", 1);
    const wrap = (formatter: unknown, text: string) => vcall(formatter, "unicodeWrap", "(Ljava/lang/String;)Ljava/lang/String;", text);
    expect(await wrap(ltr, "Golden Gate Bridge")).toBe("Golden Gate Bridge");
    expect(await wrap(ltr, "שלום")).toBe("\u200e\u202bשלום\u202c\u200e");
    expect(await wrap(rtl, "Bridge")).toBe("\u200f\u202aBridge\u202c\u200f");
    expect(await wrap(ltr, "Bridge שלום")).toBe("Bridge שלום\u200e");
    expect(await wrap(ltr, "\u202b123\u202c")).toBe("\u200e\u202b123\u202c\u200e");
    const source = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "שלום");
    const span = new JObj();
    await vcall(source, "setSpan", "(Ljava/lang/Object;III)V", span, 1, 3, 33);
    const wrapped = await vcall(ltr, "unicodeWrap", "(Ljava/lang/CharSequence;)Ljava/lang/CharSequence;", source);
    expect(await vcall(wrapped, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(3);
    expect(await vcall(source, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(1);
  });

  test("first-strong heuristics ignore isolate contents and respect the requested range", async () => {
    const heuristics = rt.link("android/text/TextDirectionHeuristics").ctor;
    const ltr = heuristics[mangleStaticField("FIRSTSTRONG_LTR")];
    const check = (text: string, start = 0, count = text.length) => vcall(ltr, "isRtl", "(Ljava/lang/CharSequence;II)Z", text, start, count);
    expect(await check("\u2067שלום\u2069Bridge")).toBe(0);
    expect(await check("\u2066Bridge\u2069שלום")).toBe(1);
    expect(await check("aשלום", 1, 4)).toBe(1);
  });
});

describe("collection-clone", () => {
  const O = "Ljava/lang/Object;";

  test("ArrayList.clone has its own element store", async () => {
    const list = await newObj("java/util/ArrayList", "()V");
    for (const s of ["a", "b", "c"]) await vcall(list, "add", `(${O})Z`, s);
    const copy = await vcall(list, "clone", `()${O}`);
    expect(copy).not.toBe(list);
    expect(rt.iof(copy, "java/util/ArrayList")).toBe(1);
    await vcall(list, "remove", `(${O})Z`, "b");
    expect(await vcall(copy, "size", "()I")).toBe(3);
    await vcall(copy, "add", `(${O})Z`, "d");
    expect(await vcall(list, "size", "()I")).toBe(2);
  });

  test("HashMap and HashSet clones are independent shallow copies in the same order", async () => {
    const map = await newObj("java/util/LinkedHashMap", "()V");
    await vcall(map, "put", `(${O}${O})${O}`, "z", 1);
    await vcall(map, "put", `(${O}${O})${O}`, "a", 2);
    const copy = await vcall(map, "clone", `()${O}`);
    expect(rt.iof(copy, "java/util/LinkedHashMap")).toBe(1);
    await vcall(copy, "put", `(${O}${O})${O}`, "z", 9);
    expect(await vcall(map, "get", `(${O})${O}`, "z")).toBe(1);
    expect(await vcall(await vcall(copy, "keySet", "()Ljava/util/Set;"), "toString", "()Ljava/lang/String;")).toBe("[z, a]");
    const set = await newObj("java/util/HashSet", "()V");
    await vcall(set, "add", `(${O})Z`, "x");
    const setCopy = await vcall(set, "clone", `()${O}`);
    await vcall(setCopy, "add", `(${O})Z`, "y");
    expect(await vcall(set, "size", "()I")).toBe(1);
    expect(await vcall(setCopy, "contains", `(${O})Z`, "x")).toBe(1);
  });
});

describe("collection-startup", () => {
  test("a synchronized map can copy its own entries across suspension on the owning thread", async () => {
    const map = synchronizedMap(await newObj("java/util/HashMap")), thread = new JThread();
    await vcallOn(thread, map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", "value");
    await vcallOn(thread, map, "putAll", "(Ljava/util/Map;)V", map);
    expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "key")).toBe("value");
    expect(rt.monitors.blocked()).toEqual([]);
  }, 1000);

  class Destination extends JObj { values: unknown[] = []; }
  rt.register({ name: "test/DrainDestination", ctor: Destination, ifaces: ["java/util/Collection"], methods: {
    "add(Ljava/lang/Object;)Z": function (this: Destination, value: unknown) {
      if (value === "second") throw rt.mkThrowable("java/lang/IllegalArgumentException", "rejected");
      this.values.push(value); return 1;
    },
  } });
  rt.linkNatives();

  test("drainTo limits transfers and retains untransferred items after add throws", async () => {
    const queue = await newObj("java/util/concurrent/LinkedBlockingQueue");
    for (const value of ["first", "second", "third"]) await vcall(queue, "add", "(Ljava/lang/Object;)Z", value);
    const destination = new Destination();
    const error = await vcallAsync(queue, "drainTo", "(Ljava/util/Collection;I)I", destination, 3).then(() => null, e => e);
    expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBeTruthy();
    expect(destination.values).toEqual(["first"]);
    const list = newArrayList();
    expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;I)I", list, 1)).toBe(1);
    expect(list.a).toEqual(["second"]);
    expect(await vcall(queue, "poll", "()Ljava/lang/Object;")).toBe("third");
  });

  test("emptyIterator has no elements and rejects removal without a preceding next", async () => {
    const iterator = await vcall(rt.link("java/util/Collections").ctor, "emptyIterator", "()Ljava/util/Iterator;");
    expect(await vcall(iterator, "hasNext", "()Z")).toBe(0);
    const next = await vcallAsync(iterator, "next", "()Ljava/lang/Object;").then(() => null, e => e);
    expect(rt.iof(next, "java/util/NoSuchElementException")).toBeTruthy();
    const remove = await vcallAsync(iterator, "remove", "()V").then(() => null, e => e);
    expect(rt.iof(remove, "java/lang/IllegalStateException")).toBeTruthy();
  });

  test("CopyOnWriteArrayList exposes indexed removal while its iterator stays immutable", async () => {
    const list = await newObj("java/util/concurrent/CopyOnWriteArrayList");
    expect(rt.iof(list, "java/util/RandomAccess")).toBe(1);
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "first");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "second");
    const iterator = await vcall(list, "iterator", "()Ljava/util/Iterator;");
    expect(await vcall(iterator, "next", "()Ljava/lang/Object;")).toBe("first");
    expect(rt.iof(await vcallAsync(iterator, "remove", "()V").catch(e => e), "java/lang/UnsupportedOperationException")).toBe(1);
    expect(await vcall(list, "remove", "(I)Ljava/lang/Object;", 0)).toBe("first");
    expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 0)).toBe("second");
  });

  test("Java identifier parts include currency, combining marks and ignorable controls", async () => {
    const character = rt.link("java/lang/Character").ctor;
    for (const code of [65, 0x24, 0x301, 0x200c, 0, 0x1b, 0x203f, 0x2160, 0x10400])
      expect(await vcall(character, "isJavaIdentifierPart", "(I)Z", code)).toBe(1);
    for (const code of [-1, 0x110000, 0xd800, 9, 0x1c, 32, 0x1f600])
      expect(await vcall(character, "isJavaIdentifierPart", "(I)Z", code)).toBe(0);
  });

  test("AtomicLongArray lazySet publishes full-width values and checks the index", async () => {
    const array = await newObj("java/util/concurrent/atomic/AtomicLongArray", "(I)V", 1);
    await vcall(array, "lazySet", "(IJ)V", 0, 9007199254740993n);
    expect(await vcall(array, "get", "(I)J", 0)).toBe(9007199254740993n);
    const error = await vcallAsync(array, "lazySet", "(IJ)V", 1, 0n).then(() => null, e => e);
    expect(rt.iof(error, "java/lang/IndexOutOfBoundsException")).toBeTruthy();
  });

  class OfferedQueue extends rt.link("java/util/AbstractQueue").ctor { values: unknown[] = []; }
  rt.register({ name: "test/OfferedQueue", ctor: OfferedQueue, sup: "java/util/AbstractQueue", methods: {
    "offer(Ljava/lang/Object;)Z": function (this: OfferedQueue, value: unknown) { this.values.push(value); return 1; },
    "poll()Ljava/lang/Object;": function (this: OfferedQueue) { return this.values.shift() ?? null; },
    "peek()Ljava/lang/Object;": function (this: OfferedQueue) { return this.values[0] ?? null; },
  } });
  rt.link("test/OfferedQueue");

  test("abstract queue defaults use subclass storage", async () => {
    const queue = new OfferedQueue();
    await vcall(queue, "addAll", "(Ljava/util/Collection;)Z", newArrayList(["first", "second"]));
    expect(queue.values).toEqual(["first", "second"]);
    expect(await vcall(queue, "element", "()Ljava/lang/Object;")).toBe("first");
    expect(await vcall(queue, "remove", "()Ljava/lang/Object;")).toBe("first");
    await vcall(queue, "clear", "()V");
    expect(queue.values).toEqual([]);
    const failure = await vcallAsync(queue, "remove", "()Ljava/lang/Object;").catch(e => e);
    expect(rt.iof(failure, "java/util/NoSuchElementException")).toBe(1);
    const selfAdd = await vcallAsync(queue, "addAll", "(Ljava/util/Collection;)Z", queue).catch(e => e);
    expect(rt.iof(selfAdd, "java/lang/IllegalArgumentException")).toBe(1);
  });

  test("list retainAll preserves live sublists and rejects immutable mutations", async () => {
    const list = newArrayList(["outside", "keep", "remove", "keep", "tail"]);
    const view = await vcall(list, "subList", "(II)Ljava/util/List;", 1, 4);
    expect(await vcall(view, "retainAll", "(Ljava/util/Collection;)Z", newArrayList(["keep"]))).toBe(1);
    expect(list.a).toEqual(["outside", "keep", "keep", "tail"]);
    expect(await vcall(view, "retainAll", "(Ljava/util/Collection;)Z", view)).toBe(0);
    await expect(vcallAsync(newArrayList(), "retainAll", "(Ljava/util/Collection;)Z", null)).rejects.toBeDefined();
    const immutable = await vcall(rt.link("java/util/List").ctor, "of", "(Ljava/lang/Object;)Ljava/util/List;", "keep");
    await expect(vcallAsync(immutable, "retainAll", "(Ljava/util/Collection;)Z", newArrayList())).rejects.toBeDefined();
  });
});

describe("collection-supers", () => {
  test("collections are instances of their abstract supers", async () => {
    expect(rt.iof(await newObj("java/util/HashSet"), "java/util/AbstractCollection")).toBe(1);
    expect(rt.iof(await newObj("java/util/HashSet"), "java/util/AbstractSet")).toBe(1);
    expect(rt.iof(await newObj("java/util/ArrayList"), "java/util/AbstractList")).toBe(1);
    expect(rt.iof(await newObj("java/util/HashMap"), "java/util/AbstractMap")).toBe(1);
    expect(rt.iof(await newObj("java/util/Stack"), "java/util/Vector")).toBe(1);
  });
});

describe("collections-disjoint", () => {
  const disjoint = (a: unknown, b: unknown) => vcallAsync(rt.link("java/util/Collections").ctor, "disjoint", "(Ljava/util/Collection;Ljava/util/Collection;)Z", a, b);

  test("disjoint handles empty collections, shared members and null", async () => {
    const empty = newArrayList(), list = newArrayList(["x", null]);
    expect(await disjoint(empty, empty)).toBe(1);
    expect(await disjoint(list, list)).toBe(0);
    expect(await disjoint(list, newArrayList(["y"]))).toBe(1);
    expect(await disjoint(list, newArrayList([null]))).toBe(0);
    expect(await disjoint(empty, null).catch(e => rt.iof(e, "java/lang/NullPointerException"))).toBe(1);
  });

  test("disjoint dispatches suspending equality and Set membership", async () => {
    class Value extends JObj {}
    rt.register({ name: "test/DisjointValue", ctor: Value, methods: {
      "equals(Ljava/lang/Object;)Z": async (other: unknown) => other instanceof Value ? 1 : 0,
      "hashCode()I": () => 19,
    } });
    rt.link("test/DisjointValue");
    const set = await newObj("java/util/HashSet");
    await vcall(set, "add", "(Ljava/lang/Object;)Z", new Value());
    expect(await disjoint(set, newArrayList([new Value()]))).toBe(0);
    expect(await disjoint(newArrayList([new Value()]), set)).toBe(0);
    expect(await disjoint(set, newArrayList(["other"]))).toBe(1);
  });
});

describe("enumset", () => {
  test("EnumSet factories and both clone descriptors keep class identity and independent membership", async () => {
    const days = await scall("java/util/concurrent/TimeUnit", "values", "()[Ljava/util/concurrent/TimeUnit;");
    const single = await scall("java/util/EnumSet", "of", "(Ljava/lang/Enum;)Ljava/util/EnumSet;", days[0]);
    expect(await vcall(single, "contains", "(Ljava/lang/Object;)Z", days[0])).toBe(1);
    const set = await scall("java/util/EnumSet", "of", "(Ljava/lang/Enum;[Ljava/lang/Enum;)Ljava/util/EnumSet;", days[0], days.slice(0, 4));
    expect(rt.iof(set, "java/util/EnumSet")).toBe(1);
    for (const desc of ["()Ljava/lang/Object;", "()Ljava/util/EnumSet;"]) {
      const clone = await vcall(set, "clone", desc);
      expect(rt.iof(clone, "java/util/EnumSet")).toBe(1);
      await vcall(clone, "clear", "()V");
      expect(await vcall(set, "size", "()I")).toBe(4);
    }
    const copy = await scall("java/util/EnumSet", "copyOf", "(Ljava/util/Collection;)Ljava/util/EnumSet;", set);
    expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", set)).toBe(1);
  });
});

describe("lru-cache", () => {
  const O = "Ljava/lang/Object;";

  test("LruCache resize evicts least-recent entries and snapshot is independent", async () => {
    const cache = await newObj("android/util/LruCache", "(I)V", 3);
    for (const key of ["a", "b", "c"]) await vcall(cache, "put", `(${O}${O})${O}`, key, key);
    await vcall(cache, "get", `(${O})${O}`, "a");
    await vcall(cache, "resize", "(I)V", 2);
    expect(await vcall(cache, "get", `(${O})${O}`, "b")).toBe(null);
    expect(await vcall(cache, "hitCount", "()I")).toBe(1);
    expect(await vcall(cache, "missCount", "()I")).toBe(1);
    expect(await vcall(cache, "evictionCount", "()I")).toBe(1);
    const snapshot = await vcall(cache, "snapshot", "()Ljava/util/Map;");
    await vcall(cache, "remove", `(${O})${O}`, "a");
    expect(await vcall(snapshot, "get", `(${O})${O}`, "a")).toBe("a");
    await expect(vcallAsync(cache, "resize", "(I)V", 0)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  });

  test("access order moves entries on put and get, custom-equals keys included", async () => {
    class Key extends JObj {}
    rt.register({ name: "test/LruKey", ctor: Key, methods: {
      "equals(Ljava/lang/Object;)Z": function (this: Key, o: unknown) { return +(o === this); },
      "hashCode()I": () => 1,
    } });
    rt.linkNatives();
    const key = new Key(), map = await newObj("java/util/LinkedHashMap", "(IFZ)V", 0, 0.75, 1);
    const keys = async () => vcall(await vcall(map, "keySet", "()Ljava/util/Set;"), "toArray", `()[${O}`);
    for (const k of [key, "a", "b"]) await vcall(map, "put", `(${O}${O})${O}`, k, 1);
    await vcall(map, "get", `(${O})${O}`, "a");
    await vcall(map, "put", `(${O}${O})${O}`, "b", 2);
    expect(await keys()).toEqual([key, "a", "b"]);
    await vcall(map, "get", `(${O})${O}`, key);
    expect(await keys()).toEqual(["a", "b", key]);

    const cache = await newObj("android/util/LruCache", "(I)V", 2);
    for (const k of ["a", "b", "a", "c"]) await vcall(cache, "put", `(${O}${O})${O}`, k, k);
    expect(await vcall(cache, "get", `(${O})${O}`, "b")).toBe(null);
    expect(await vcall(cache, "get", `(${O})${O}`, "a")).toBe("a");
  });
});

describe("map-equality", () => {
  class Value extends JObj {
    constructor(readonly value: number) { super(); }
  }
  rt.register({
    name: "test/MapValue",
    ctor: Value,
    methods: {
      "equals(Ljava/lang/Object;)Z": async function (this: Value, other: unknown) {
        return other instanceof Value && this.value === other.value ? 1 : 0;
      },
      "hashCode()I": async function (this: Value) { return this.value; },
    },
  });
  rt.linkNatives();

  const O = "Ljava/lang/Object;";
  const map = (cls = "java/util/HashMap") => newObj(cls);
  const put = (target: unknown, key: unknown, value: unknown) =>
    vcall(target, "put", `(${O}${O})${O}`, key, value);
  const equals = (a: unknown, b: unknown) => vcall(a, "equals", `(${O})Z`, b);
  const hash = (value: unknown) => vcall(value, "hashCode", "()I");

  test("maps compare structurally and hash equal entries identically", async () => {
    const a = await map(), b = await map("java/util/LinkedHashMap");
    await put(a, "a", new Value(7));
    await put(a, "b", "value");
    await put(b, "b", "value");
    await put(b, "a", new Value(7));

    expect(await equals(a, b)).toBe(1);
    expect(await equals(b, a)).toBe(1);
    expect(await hash(a)).toBe(await hash(b));
  });

  test("IdentityHashMap uses reference identity for keys and values", async () => {
    const target = await map("java/util/IdentityHashMap");
    const first = new Value(7), equalValue = new Value(7);
    await put(target, first, first);

    expect(await vcall(target, "get", `(${O})${O}`, first)).toBe(first);
    expect(await vcall(target, "get", `(${O})${O}`, equalValue)).toBeNull();
    expect(await vcall(target, "containsValue", `(${O})Z`, equalValue)).toBe(0);
    expect(await vcall(target, "containsValue", `(${O})Z`, first)).toBe(1);
    await put(target, equalValue, equalValue);
    expect(await vcall(target, "size", "()I")).toBe(2);
  });

  test("a null mapping is distinct from an absent key", async () => {
    const a = await map(), b = await map();
    await put(a, "present", null);
    await put(b, "other", null);

    expect(await equals(a, b)).toBe(0);
    await put(b, "present", null);
    expect(await equals(a, b)).toBe(0);
  });

  test("copy constructors do not share mutable mapping entries", async () => {
    for (const name of ["java/util/HashMap", "java/util/EnumMap"]) {
      const source = await map(name);
      const key = name.endsWith("EnumMap") ? Reflect.get(rt.link("java/util/concurrent/TimeUnit").ctor, "s$SECONDS") : "key";
      await put(source, key, "before");
      const copy = await newObj(name, name.endsWith("EnumMap") ? "(Ljava/util/EnumMap;)V" : "(Ljava/util/Map;)V", source);
      await put(copy, key, "after");
      expect(await vcall(source, "get", `(${O})${O}`, key)).toBe("before");
      expect(await vcall(copy, "get", `(${O})${O}`, key)).toBe("after");
    }
  });

  test("hash maps filter stored hashes before calling key equality", async () => {
    class Key extends JObj { hash = 1; comparisons = 0; comparedOn: JThread | null = null; }
    rt.register({ name: "test/HashFilteredKey", ctor: Key, methods: {
      "hashCode()I": async function (this: Key) { await Promise.resolve(); return this.hash; },
      "equals(Ljava/lang/Object;)Z": function (this: Key) { this.comparedOn = curThread; this.comparisons++; return 1; },
    } });
    rt.link("test/HashFilteredKey");
    const a = new Key(), b = new Key(); b.hash = 2;
    const target = await map();
    await put(target, a, "first"); await put(target, b, "second");
    expect(await vcall(target, "size", "()I")).toBe(2);
    expect(b.comparisons).toBe(0);
    expect(await vcall(target, "get", `(${O})${O}`, b)).toBe("second");
    a.hash = 3;
    expect(await vcall(target, "get", `(${O})${O}`, a)).toBeNull();
    const lookup = new Key();
    const original = curThread, worker = await newObj("java/lang/Thread");
    let result: Promise<unknown>;
    setCurThread(worker);
    try { result = vcall(target, "get", `(${O})${O}`, lookup); }
    finally { setCurThread(original); }
    expect(await result).toBe("first");
    expect(lookup.comparisons).toBe(1);
    expect(lookup.comparedOn).toBe(worker);
  });
});

describe("map-interfaces", () => {
  test("hash maps expose their actual collection contracts", () => {
    for (const name of ["java/util/HashMap", "java/util/LinkedHashMap", "java/util/concurrent/ConcurrentHashMap", "java/util/WeakHashMap", "java/util/IdentityHashMap", "java/util/Hashtable", "java/util/EnumMap", "android/util/ArrayMap"]) {
      const map = rt.make(name);
      expect(rt.iof(map, "java/util/Map")).toBe(1);
      expect(rt.iof(map, "java/util/SortedMap")).toBe(0);
      expect(rt.iof(map, "java/util/concurrent/ConcurrentMap")).toBe(name.endsWith("/ConcurrentHashMap") ? 1 : 0);
    }
    expect(rt.iof(rt.make("java/util/TreeMap"), "java/util/SortedMap")).toBe(1);
  });
});

describe("range", () => {
  const range = (lo: string, hi: string) => newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", lo, hi);
  test("ranges intersect, extend and clamp while preserving contained range identity", async () => {
    const outer = await range("a", "z"), inner = await range("c", "f");
    expect(await vcall(outer, "intersect", "(Landroid/util/Range;)Landroid/util/Range;", inner)).toBe(inner);
    expect(await vcall(inner, "extend", "(Landroid/util/Range;)Landroid/util/Range;", outer)).toBe(outer);
    expect(await vcall(inner, "clamp", "(Ljava/lang/Comparable;)Ljava/lang/Comparable;", "z")).toBe("f");
    expect(await vcall(inner, "contains", "(Ljava/lang/Comparable;)Z", "c")).toBe(1);
    expect(await vcall(inner, "contains", "(Landroid/util/Range;)Z", outer)).toBe(0);
    const overlap = await vcall(inner, "intersect", "(Landroid/util/Range;)Landroid/util/Range;", await range("e", "h"));
    expect(await vcall(overlap, "toString", "()Ljava/lang/String;")).toBe("[e, f]");
    expect(await vcall(overlap, "equals", "(Ljava/lang/Object;)Z", await range("e", "f"))).toBe(1);
    let error: unknown;
    try { await vcall(inner, "intersect", "(Landroid/util/Range;)Landroid/util/Range;", await range("k", "m")); } catch (e) { error = e; }
    expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBe(1);
  });
});

describe("rational", () => {
  const rational = (n: number, d: number) => newObj("android/util/Rational", "(II)V", n, d);

  test("Rational reduces values and preserves exact order near integer limits", async () => {
    const a = await rational(6, -8), b = await rational(-3, 4);
    expect(await vcall(a, "toString", "()Ljava/lang/String;")).toBe("-3/4");
    expect(await vcall(a, "equals", "(Ljava/lang/Object;)Z", b)).toBe(1);
    expect(await vcall(a, "hashCode", "()I")).toBe(await vcall(b, "hashCode", "()I"));
    expect(await vcall(await rational(2147483646, 2147483647), "compareTo", "(Landroid/util/Rational;)I", await rational(2147483645, 2147483646))).toBe(1);
    const parsed = await vcall(rt.link("android/util/Rational").ctor, "parseRational", "(Ljava/lang/String;)Landroid/util/Rational;", "3:+6");
    expect(await vcall(parsed, "doubleValue", "()D")).toBe(0.5);
  });

  test("Rational orders NaN and saturates infinite conversions", async () => {
    const nan = await rational(0, 0), inf = await rational(5, 0), neg = await rational(-2, 0);
    expect(await vcall(nan, "equals", "(Ljava/lang/Object;)Z", await rational(0, 0))).toBe(1);
    expect(await vcall(nan, "compareTo", "(Landroid/util/Rational;)I", inf)).toBe(1);
    expect(await vcall(neg, "compareTo", "(Landroid/util/Rational;)I", await rational(-500, 1))).toBe(-1);
    expect(await vcall(inf, "intValue", "()I")).toBe(2147483647);
    expect(await vcall(neg, "longValue", "()J")).toBe(-9223372036854775808n);
    expect(await vcall(nan, "intValue", "()I")).toBe(0);
  });
});

describe("set-equality", () => {
  const set = (cls: string, ...items: unknown[]) => newObj(cls).then(async (s) => {
    for (const v of items) await vcall(s, "add", "(Ljava/lang/Object;)Z", v);
    return s;
  });
  const eq = (a: unknown, b: unknown) => vcall(a, "equals", "(Ljava/lang/Object;)Z", b);
  const hash = (o: unknown) => vcall(o, "hashCode", "()I");
  const rejects = (call: () => unknown, name: string) =>
    expect((async () => call())()).rejects.toMatchObject({ constructor: rt.link("java/lang/" + name).ctor });

  test("empty sets are equal across Set implementations", async () => {
    const empty = await vcall(rt.link("java/util/Collections").ctor, "emptySet", "()Ljava/util/Set;");
    const hashSet = await set("java/util/HashSet");
    expect(await eq(hashSet, empty)).toBe(1);
    expect(await eq(empty, await set("java/util/LinkedHashSet"))).toBe(1);
    expect(await eq(hashSet, await newObj("java/util/ArrayList"))).toBe(0);
  });

  test("set equality is membership and its hash is the member hash sum", async () => {
    const a = await set("java/util/HashSet", "x", "y"), b = await set("java/util/LinkedHashSet", "y", "x");
    expect(await eq(a, b)).toBe(1);
    expect(await eq(a, await set("java/util/HashSet", "x"))).toBe(0);
    expect(await eq(a, await set("java/util/HashSet", "x", "z"))).toBe(0);
    expect(await hash(a)).toBe(await hash(b));
    expect(await hash(await set("java/util/HashSet"))).toBe(0);
  });

  test("a set is a value key in a HashMap", async () => {
    const map = await newObj("java/util/HashMap");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", await set("java/util/HashSet", "k"), "v");
    expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", await set("java/util/LinkedHashSet", "k"))).toBe("v");
  });

  test("Set.of rejects null and duplicates and stays immutable", async () => {
    const of = (...values: unknown[]) => scall("java/util/Set", "of", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Set;", ...values);
    const immutable = await of("a", "b");
    expect(await vcall(immutable, "contains", "(Ljava/lang/Object;)Z", "a")).toBe(1);
    await rejects(() => vcall(immutable, "add", "(Ljava/lang/Object;)Z", "c"), "UnsupportedOperationException");
    await rejects(() => of("a", "a"), "IllegalArgumentException");
    await rejects(() => of("a", null), "NullPointerException");
  });

  test("Collection.stream exposes collection contents to stream operations", async () => {
    const values = await newObj("java/util/ArrayList");
    await vcall(values, "add", "(Ljava/lang/Object;)Z", "a");
    await vcall(values, "add", "(Ljava/lang/Object;)Z", "b");
    const stream = await vcall(values, "stream", "()Ljava/util/stream/Stream;");
    expect(await vcall(stream, "count", "()J")).toBe(2n);
  });

  test("Map.of rejects null and duplicate keys and stays immutable", async () => {
    const of = (...values: unknown[]) => scall("java/util/Map", "of",
      "(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Map;", ...values);
    const immutable = await of("a", 1, "b", 2);
    expect(await vcall(immutable, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "b")).toBe(2);
    await rejects(() => vcall(immutable, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "c", 3), "UnsupportedOperationException");
    const entries = await vcall(immutable, "entrySet", "()Ljava/util/Set;");
    const entryIterator = await vcall(entries, "iterator", "()Ljava/util/Iterator;");
    const entry = await vcall(entryIterator, "next", "()Ljava/lang/Object;");
    await rejects(() => vcall(entry, "setValue", "(Ljava/lang/Object;)Ljava/lang/Object;", 3), "UnsupportedOperationException");
    const keys = await vcall(immutable, "keySet", "()Ljava/util/Set;");
    await rejects(() => vcall(keys, "clear", "()V"), "UnsupportedOperationException");
    await rejects(() => vcall(entryIterator, "remove", "()V"), "UnsupportedOperationException");
    expect(await vcall(immutable, "size", "()I")).toBe(2);
    await rejects(() => of("a", 1, "a", 2), "IllegalArgumentException");
    await rejects(() => of("a", 1, "b", null), "NullPointerException");
  });

  test("Collections wrappers stay live without exposing unmodifiable mutations", async () => {
    const list = await newObj("java/util/ArrayList");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "a");
    const readOnly = await scall("java/util/Collections", "unmodifiableList", "(Ljava/util/List;)Ljava/util/List;", list);
    expect(readOnly).not.toBe(list);
    await rejects(() => vcall(readOnly, "add", "(Ljava/lang/Object;)Z", "blocked"), "UnsupportedOperationException");
    const iterator = await vcall(readOnly, "iterator", "()Ljava/util/Iterator;");
    await vcall(iterator, "next", "()Ljava/lang/Object;");
    await rejects(() => vcall(iterator, "remove", "()V"), "UnsupportedOperationException");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "b");
    expect(await vcall(readOnly, "size", "()I")).toBe(2);

    const synchronized = await scall("java/util/Collections", "synchronizedList", "(Ljava/util/List;)Ljava/util/List;", list);
    expect(synchronized).not.toBe(list);
    await vcall(synchronized, "add", "(Ljava/lang/Object;)Z", "c");
    expect(await vcall(list, "size", "()I")).toBe(3);
  });

  test("List.of rejects null and stays immutable", async () => {
    const of = (...values: unknown[]) => scall("java/util/List", "of", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/List;", ...values);
    const immutable = await of("a", "b");
    expect(await vcall(immutable, "get", "(I)Ljava/lang/Object;", 1)).toBe("b");
    await rejects(() => vcall(immutable, "add", "(Ljava/lang/Object;)Z", "c"), "UnsupportedOperationException");
    await rejects(() => of("a", null), "NullPointerException");
  });

  test("unordered and insertion-ordered sets do not implement SortedSet", () => {
    for (const name of ["HashSet", "LinkedHashSet", "EnumSet", "concurrent/CopyOnWriteArraySet", "concurrent/ConcurrentHashMap$KeySetView"]) {
      const set = rt.make("java/util/" + name);
      expect(rt.iof(set, "java/util/Set")).toBe(1);
      expect(rt.iof(set, "java/util/SortedSet")).toBe(0);
    }
    expect(rt.iof(rt.make("java/util/TreeSet"), "java/util/SortedSet")).toBe(1);
  });
});

describe("sparse-values", () => {
  test("LongSparseArray orders full-width keys and searches insertion positions", async () => {
    const a = await newObj("android/util/LongSparseArray");
    const hi = 9007199254740993n;
    for (const [key, value] of [[hi, "high"], [-hi, "low"], [0n, "zero"]]) await vcall(a, "put", "(JLjava/lang/Object;)V", key, value);
    expect(await vcall(a, "keyAt", "(I)J", 0)).toBe(-hi);
    expect(await vcall(a, "indexOfKey", "(J)I", hi - 1n)).toBe(~2);
    expect(await vcall(a, "indexOfValue", "(Ljava/lang/Object;)I", "high")).toBe(2);
    const copy = await vcall(a, "clone", "()Landroid/util/LongSparseArray;");
    await vcall(a, "remove", "(J)V", hi);
    expect(await vcall(copy, "get", "(J)Ljava/lang/Object;", hi)).toBe("high");
  });
  test("Arrays.deepEquals compares nested primitive arrays with Java floating equality", async () => {
    const cls = rt.link("java/util/Arrays").ctor;
    const eq = (a: unknown[], b: unknown[]) => vcall(cls, "deepEquals", "([Ljava/lang/Object;[Ljava/lang/Object;)Z", a, b);
    expect(await eq([Float64Array.of(NaN, -0), [Int8Array.of(1, 2)]], [Float64Array.of(NaN, -0), [Int8Array.of(1, 2)]])).toBe(1);
    expect(await eq([Float64Array.of(-0)], [Float64Array.of(0)])).toBe(0);
    expect(await eq([Int8Array.of(1)], [Int16Array.of(1)])).toBe(0);
  });
  test("Collections.shuffle uses the supplied Random and updates the list", async () => {
    const random = await newObj("java/util/Random", "(J)V", 123n);
    const copyRandom = await newObj("java/util/Random", "(J)V", 123n);
    const list = await newObj("java/util/ArrayList");
    const expected = [0, 1, 2, 3, 4];
    for (const value of expected) await vcall(list, "add", "(Ljava/lang/Object;)Z", value);
    for (let i = expected.length; i > 1; i--) {
      const j = await vcall(copyRandom, "nextInt", "(I)I", i);
      [expected[i - 1], expected[j]] = [expected[j], expected[i - 1]];
    }
    await vcall(rt.link("java/util/Collections").ctor, "shuffle", "(Ljava/util/List;Ljava/util/Random;)V", list, random);
    expect(await vcall(list, "toArray", "()[Ljava/lang/Object;")).toEqual(expected);
  });
  test("Collections.rotate updates a live sublist", async () => {
    const list = await newObj("java/util/ArrayList");
    for (const value of [0, 1, 2, 3, 4]) await vcall(list, "add", "(Ljava/lang/Object;)Z", value);
    const middle = await vcall(list, "subList", "(II)Ljava/util/List;", 1, 4);
    await vcall(rt.link("java/util/Collections").ctor, "rotate", "(Ljava/util/List;I)V", middle, -1);
    expect(await vcall(list, "toArray", "()[Ljava/lang/Object;")).toEqual([0, 2, 3, 1, 4]);
  });
});
