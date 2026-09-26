import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { JThread, newObj, vcall, vcallOn, vcallAsync } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";
import { synchronizedMap } from "../src/jvm/natives/jwrappers";

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
