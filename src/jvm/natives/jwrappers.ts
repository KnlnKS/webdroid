import { splitSig } from "../abi";
import { JObj, rt, type NativeSpec } from "../runtime";
import { vcall } from "./jlang";

type Methods = NonNullable<NativeSpec["methods"]>;
type Kind = "collection" | "list" | "set" | "sortedSet" | "map" | "sortedMap";
type Mode = "unmodifiable" | "synchronized";

class JWrapper extends JObj {
  delegate: unknown = null;
  mode: Mode = "unmodifiable";
  mutex: object = this;
  entries = false;
}
class JReadOnlyIterator extends JObj {
  delegate: unknown = null;
  entries = false;
}
class JReadOnlyEntry extends JObj { delegate: unknown = null; }

const unsupported = () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", null); };

async function call(wrapper: JWrapper, signature: string, args: unknown[]): Promise<unknown> {
  const [name, descriptor] = splitSig(signature);
  const forwarded = signature === "equals(Ljava/lang/Object;)Z" && args[0] instanceof JWrapper ? [args[0].delegate] : args;
  if (wrapper.mode === "unmodifiable") return vcall(wrapper.delegate, name, descriptor, ...forwarded);
  const thread = rt.th();
  const entered = rt.monitors.enter(wrapper.mutex, thread);
  if (entered) await entered;
  try { return await vcall(wrapper.delegate, name, descriptor, ...forwarded); }
  finally { rt.monitors.exit(wrapper.mutex, thread); }
}

const names: Record<Mode, Record<Kind, string>> = {
  unmodifiable: {
    collection: "webdroid/UnmodifiableCollection", list: "webdroid/UnmodifiableList",
    set: "webdroid/UnmodifiableSet", sortedSet: "webdroid/UnmodifiableSortedSet",
    map: "webdroid/UnmodifiableMap", sortedMap: "webdroid/UnmodifiableSortedMap",
  },
  synchronized: {
    collection: "webdroid/SynchronizedCollection", list: "webdroid/SynchronizedList",
    set: "webdroid/SynchronizedSet", sortedSet: "webdroid/SynchronizedSet",
    map: "webdroid/SynchronizedMap", sortedMap: "webdroid/SynchronizedMap",
  },
};

function wrap(value: unknown, mode: Mode, kind: Kind, mutex?: object, entries = false): JWrapper {
  if (value === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const wrapper: JWrapper = rt.make(names[mode][kind]);
  wrapper.delegate = value;
  wrapper.mode = mode;
  wrapper.mutex = mutex ?? wrapper;
  wrapper.entries = entries;
  return wrapper;
}

function readOnlyIterator(iterator: unknown, entries: boolean): JReadOnlyIterator {
  const out: JReadOnlyIterator = rt.make("webdroid/UnmodifiableIterator");
  out.delegate = iterator;
  out.entries = entries;
  return out;
}

function readOnlyEntry(entry: unknown): JReadOnlyEntry {
  const out: JReadOnlyEntry = rt.make("webdroid/UnmodifiableEntry");
  out.delegate = entry;
  return out;
}

type Transform = (value: unknown, wrapper: JWrapper) => unknown;
function forwards(signatures: readonly string[], transforms: Record<string, Transform> = {}): Methods {
  return Object.fromEntries(signatures.map((signature) => [signature, async function (this: JWrapper, ...args: unknown[]) {
    const value = await call(this, signature, args);
    return transforms[signature]?.(value, this) ?? value;
  }]));
}
function writes(signatures: readonly string[], mode: Mode): Methods {
  if (mode === "unmodifiable") return Object.fromEntries(signatures.map((signature) => [signature, unsupported]));
  return forwards(signatures);
}

const collectionReads = [
  "size()I", "isEmpty()Z", "contains(Ljava/lang/Object;)Z", "containsAll(Ljava/util/Collection;)Z",
  "toArray()[Ljava/lang/Object;", "toArray([Ljava/lang/Object;)[Ljava/lang/Object;", "iterator()Ljava/util/Iterator;",
  "forEach(Ljava/util/function/Consumer;)V", "stream()Ljava/util/stream/Stream;", "parallelStream()Ljava/util/stream/Stream;",
  "spliterator()Ljava/util/Spliterator;", "toString()Ljava/lang/String;",
] as const;
const collectionWrites = [
  "add(Ljava/lang/Object;)Z", "remove(Ljava/lang/Object;)Z", "addAll(Ljava/util/Collection;)Z",
  "removeAll(Ljava/util/Collection;)Z", "retainAll(Ljava/util/Collection;)Z", "removeIf(Ljava/util/function/Predicate;)Z", "clear()V",
] as const;
const listReads = [
  "get(I)Ljava/lang/Object;", "indexOf(Ljava/lang/Object;)I", "lastIndexOf(Ljava/lang/Object;)I",
  "listIterator()Ljava/util/ListIterator;", "listIterator(I)Ljava/util/ListIterator;", "subList(II)Ljava/util/List;",
  "equals(Ljava/lang/Object;)Z", "hashCode()I",
] as const;
const listWrites = [
  "set(ILjava/lang/Object;)Ljava/lang/Object;", "add(ILjava/lang/Object;)V", "remove(I)Ljava/lang/Object;",
  "addAll(ILjava/util/Collection;)Z", "replaceAll(Ljava/util/function/UnaryOperator;)V", "sort(Ljava/util/Comparator;)V",
] as const;
const setReads = ["equals(Ljava/lang/Object;)Z", "hashCode()I"] as const;
const sortedSetReads = [
  "comparator()Ljava/util/Comparator;", "first()Ljava/lang/Object;", "last()Ljava/lang/Object;",
  "subSet(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedSet;", "headSet(Ljava/lang/Object;)Ljava/util/SortedSet;",
  "tailSet(Ljava/lang/Object;)Ljava/util/SortedSet;",
] as const;
const mapReads = [
  "size()I", "isEmpty()Z", "containsKey(Ljava/lang/Object;)Z", "containsValue(Ljava/lang/Object;)Z",
  "get(Ljava/lang/Object;)Ljava/lang/Object;", "getOrDefault(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
  "forEach(Ljava/util/function/BiConsumer;)V", "keySet()Ljava/util/Set;", "values()Ljava/util/Collection;",
  "entrySet()Ljava/util/Set;", "equals(Ljava/lang/Object;)Z", "hashCode()I", "toString()Ljava/lang/String;",
] as const;
const mapWrites = [
  "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "remove(Ljava/lang/Object;)Ljava/lang/Object;",
  "remove(Ljava/lang/Object;Ljava/lang/Object;)Z", "clear()V", "putAll(Ljava/util/Map;)V",
  "replaceAll(Ljava/util/function/BiFunction;)V", "putIfAbsent(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
  "replace(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "replace(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Z",
  "compute(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;",
  "computeIfAbsent(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;",
  "computeIfPresent(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;",
  "merge(Ljava/lang/Object;Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;",
] as const;
const sortedMapReads = [
  "comparator()Ljava/util/Comparator;", "firstKey()Ljava/lang/Object;", "lastKey()Ljava/lang/Object;",
  "subMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedMap;", "headMap(Ljava/lang/Object;)Ljava/util/SortedMap;",
  "tailMap(Ljava/lang/Object;)Ljava/util/SortedMap;",
] as const;

function registerCollection(name: string, mode: Mode, kind: "collection" | "list" | "set" | "sortedSet", ifaces: string[]): void {
  const transforms: Record<string, Transform> = {
    "iterator()Ljava/util/Iterator;": (value, wrapper) => wrapper.mode === "unmodifiable" ? readOnlyIterator(value, wrapper.entries) : value,
    "listIterator()Ljava/util/ListIterator;": (value, wrapper) => wrapper.mode === "unmodifiable" ? readOnlyIterator(value, false) : value,
    "listIterator(I)Ljava/util/ListIterator;": (value, wrapper) => wrapper.mode === "unmodifiable" ? readOnlyIterator(value, false) : value,
    "subList(II)Ljava/util/List;": (value, wrapper) => wrap(value, wrapper.mode, "list", wrapper.mutex),
    "subSet(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedSet;": (value, wrapper) => wrap(value, wrapper.mode, "sortedSet", wrapper.mutex),
    "headSet(Ljava/lang/Object;)Ljava/util/SortedSet;": (value, wrapper) => wrap(value, wrapper.mode, "sortedSet", wrapper.mutex),
    "tailSet(Ljava/lang/Object;)Ljava/util/SortedSet;": (value, wrapper) => wrap(value, wrapper.mode, "sortedSet", wrapper.mutex),
  };
  const reads = [...collectionReads, ...(kind === "list" ? listReads : []), ...(kind === "set" || kind === "sortedSet" ? setReads : []), ...(kind === "sortedSet" ? sortedSetReads : [])];
  const mutations = [...collectionWrites, ...(kind === "list" ? listWrites : [])];
  rt.register({ name, ctor: class extends JWrapper {}, ifaces, methods: { ...forwards(reads, transforms), ...writes(mutations, mode) } });
}

function registerMap(name: string, mode: Mode, sorted: boolean): void {
  const transforms: Record<string, Transform> = {
    "keySet()Ljava/util/Set;": (value, wrapper) => wrap(value, wrapper.mode, "set", wrapper.mutex),
    "values()Ljava/util/Collection;": (value, wrapper) => wrap(value, wrapper.mode, "collection", wrapper.mutex),
    "entrySet()Ljava/util/Set;": (value, wrapper) => wrap(value, wrapper.mode, "set", wrapper.mutex, wrapper.mode === "unmodifiable"),
    "subMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedMap;": (value, wrapper) => wrap(value, wrapper.mode, "sortedMap", wrapper.mutex),
    "headMap(Ljava/lang/Object;)Ljava/util/SortedMap;": (value, wrapper) => wrap(value, wrapper.mode, "sortedMap", wrapper.mutex),
    "tailMap(Ljava/lang/Object;)Ljava/util/SortedMap;": (value, wrapper) => wrap(value, wrapper.mode, "sortedMap", wrapper.mutex),
  };
  rt.register({
    name, ctor: class extends JWrapper {}, ifaces: sorted ? ["java/util/SortedMap", "java/util/Map"] : ["java/util/Map"],
    methods: { ...forwards([...mapReads, ...(sorted ? sortedMapReads : [])], transforms), ...writes(mapWrites, mode) },
  });
}

rt.register({
  name: "webdroid/UnmodifiableIterator", ctor: JReadOnlyIterator, ifaces: ["java/util/Iterator", "java/util/ListIterator"],
  methods: {
    "hasNext()Z": function (this: JReadOnlyIterator) { return vcall(this.delegate, "hasNext", "()Z"); },
    "next()Ljava/lang/Object;": async function (this: JReadOnlyIterator) {
      const value = await vcall(this.delegate, "next", "()Ljava/lang/Object;");
      return this.entries ? readOnlyEntry(value) : value;
    },
    "forEachRemaining(Ljava/util/function/Consumer;)V": async function (this: JReadOnlyIterator, consumer: unknown) {
      while (await vcall(this, "hasNext", "()Z")) await vcall(consumer, "accept", "(Ljava/lang/Object;)V", await vcall(this, "next", "()Ljava/lang/Object;"));
    },
    "hasPrevious()Z": function (this: JReadOnlyIterator) { return vcall(this.delegate, "hasPrevious", "()Z"); },
    "previous()Ljava/lang/Object;": async function (this: JReadOnlyIterator) {
      const value = await vcall(this.delegate, "previous", "()Ljava/lang/Object;");
      return this.entries ? readOnlyEntry(value) : value;
    },
    "nextIndex()I": function (this: JReadOnlyIterator) { return vcall(this.delegate, "nextIndex", "()I"); },
    "previousIndex()I": function (this: JReadOnlyIterator) { return vcall(this.delegate, "previousIndex", "()I"); },
    "remove()V": unsupported, "set(Ljava/lang/Object;)V": unsupported, "add(Ljava/lang/Object;)V": unsupported,
  },
});
rt.register({
  name: "webdroid/UnmodifiableEntry", ctor: JReadOnlyEntry, ifaces: ["java/util/Map$Entry"],
  methods: {
    "getKey()Ljava/lang/Object;": function (this: JReadOnlyEntry) { return vcall(this.delegate, "getKey", "()Ljava/lang/Object;"); },
    "getValue()Ljava/lang/Object;": function (this: JReadOnlyEntry) { return vcall(this.delegate, "getValue", "()Ljava/lang/Object;"); },
    "setValue(Ljava/lang/Object;)Ljava/lang/Object;": unsupported,
    "equals(Ljava/lang/Object;)Z": function (this: JReadOnlyEntry, other: unknown) {
      return vcall(this.delegate, "equals", "(Ljava/lang/Object;)Z", other instanceof JReadOnlyEntry ? other.delegate : other);
    },
    "hashCode()I": function (this: JReadOnlyEntry) { return vcall(this.delegate, "hashCode", "()I"); },
    "toString()Ljava/lang/String;": function (this: JReadOnlyEntry) { return vcall(this.delegate, "toString", "()Ljava/lang/String;"); },
  },
});

registerCollection("webdroid/UnmodifiableCollection", "unmodifiable", "collection", ["java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/UnmodifiableList", "unmodifiable", "list", ["java/util/List", "java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/UnmodifiableSet", "unmodifiable", "set", ["java/util/Set", "java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/UnmodifiableSortedSet", "unmodifiable", "sortedSet", ["java/util/SortedSet", "java/util/Set", "java/util/Collection", "java/lang/Iterable"]);
registerMap("webdroid/UnmodifiableMap", "unmodifiable", false);
registerMap("webdroid/UnmodifiableSortedMap", "unmodifiable", true);
registerCollection("webdroid/SynchronizedCollection", "synchronized", "collection", ["java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/SynchronizedList", "synchronized", "list", ["java/util/List", "java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/SynchronizedSet", "synchronized", "set", ["java/util/Set", "java/util/Collection", "java/lang/Iterable"]);
registerMap("webdroid/SynchronizedMap", "synchronized", false);

export const unmodifiableCollection = (value: unknown) => wrap(value, "unmodifiable", "collection");
export const unmodifiableList = (value: unknown) => wrap(value, "unmodifiable", "list");
export const unmodifiableSet = (value: unknown) => wrap(value, "unmodifiable", "set");
export const unmodifiableSortedSet = (value: unknown) => wrap(value, "unmodifiable", "sortedSet");
export const unmodifiableMap = (value: unknown) => wrap(value, "unmodifiable", "map");
export const unmodifiableSortedMap = (value: unknown) => wrap(value, "unmodifiable", "sortedMap");
export const synchronizedCollection = (value: unknown) => wrap(value, "synchronized", "collection");
export const synchronizedList = (value: unknown) => wrap(value, "synchronized", "list");
export const synchronizedSet = (value: unknown) => wrap(value, "synchronized", "set");
export const synchronizedMap = (value: unknown) => wrap(value, "synchronized", "map");
