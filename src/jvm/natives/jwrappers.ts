import { splitSig } from "../abi";
import { JObj, rt, type NativeSpec, driven, type Gen } from "../runtime";
import { vcall, vcallOn, curThread, after } from "./jlang";

type Methods = NonNullable<NativeSpec["methods"]>;
type Kind = "collection" | "list" | "set" | "sortedSet" | "map" | "sortedMap";
type Mode = "unmodifiable" | "synchronized";

class JWrapper extends JObj {
  delegate: unknown = null;
  mode: Mode = "unmodifiable";
  mutex: object = this;
  entries = false;
}
class JUnmodifiableCollection extends JWrapper {}
class JUnmodifiableList extends JUnmodifiableCollection {}
class JUnmodifiableRandomAccessList extends JUnmodifiableList {}
class JReadOnlyIterator extends JObj {
  delegate: unknown = null;
  entries = false;
}
class JReadOnlyEntry extends JObj { delegate: unknown = null; }

const unsupported = () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", null); };

/** Forward to the delegate; a synchronized wrapper holds its mutex across the call. */
function call(wrapper: JWrapper, name: string, descriptor: string, args: unknown[]): unknown {
  const forwarded = name === "equals" && args[0] instanceof JWrapper ? [args[0].delegate] : args;
  if (wrapper.mode === "unmodifiable") return vcall(wrapper.delegate, name, descriptor, ...forwarded);
  return rt.drive(locked(wrapper, name, descriptor, forwarded));
}
function* locked(wrapper: JWrapper, name: string, descriptor: string, args: unknown[]): Gen {
  const thread = curThread;
  const entered = rt.monitors.enter(wrapper.mutex, thread);
  if (entered) yield entered;
  try { return yield vcallOn(thread, wrapper.delegate, name, descriptor, ...args); }
  finally { rt.monitors.exit(wrapper.mutex, thread); }
}

const names: Record<Mode, Record<Kind, string>> = {
  unmodifiable: {
    collection: "java/util/Collections$UnmodifiableCollection", list: "java/util/Collections$UnmodifiableList",
    set: "webdroid/UnmodifiableSet", sortedSet: "webdroid/UnmodifiableSortedSet",
    map: "webdroid/UnmodifiableMap", sortedMap: "webdroid/UnmodifiableSortedMap",
  },
  synchronized: {
    collection: "webdroid/SynchronizedCollection", list: "webdroid/SynchronizedList",
    set: "webdroid/SynchronizedSet", sortedSet: "webdroid/SynchronizedSet",
    map: "webdroid/SynchronizedMap", sortedMap: "webdroid/SynchronizedSortedMap",
  },
};

function wrap(value: unknown, mode: Mode, kind: Kind, mutex?: object, entries = false): JWrapper {
  if (value === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const name = mode === "unmodifiable" && kind === "list" && rt.iof(value, "java/util/RandomAccess")
    ? "java/util/Collections$UnmodifiableRandomAccessList" : names[mode][kind];
  const wrapper: JWrapper = rt.make(name);
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
  return Object.fromEntries(signatures.map((signature) => {
    const [name, descriptor] = splitSig(signature), transform = transforms[signature];
    return [signature, function (this: JWrapper, ...args: unknown[]) {
      const value = call(this, name, descriptor, args);
      return transform ? after(value, (v) => transform(v, this) ?? v) : value;
    }];
  }));
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

/** a returned view wrapped the same way as the collection it came from */
const view = (kind: Kind): Transform => (value, wrapper) => wrap(value, wrapper.mode, kind, wrapper.mutex);
const listIteratorView: Transform = (value, wrapper) => wrapper.mode === "unmodifiable" ? readOnlyIterator(value, false) : value;
const collectionTransforms: Record<string, Transform> = {
  "iterator()Ljava/util/Iterator;": (value, wrapper) => wrapper.mode === "unmodifiable" ? readOnlyIterator(value, wrapper.entries) : value,
  "listIterator()Ljava/util/ListIterator;": listIteratorView,
  "listIterator(I)Ljava/util/ListIterator;": listIteratorView,
  "subList(II)Ljava/util/List;": view("list"),
  "subSet(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedSet;": view("sortedSet"),
  "headSet(Ljava/lang/Object;)Ljava/util/SortedSet;": view("sortedSet"),
  "tailSet(Ljava/lang/Object;)Ljava/util/SortedSet;": view("sortedSet"),
};
const mapTransforms: Record<string, Transform> = {
  "keySet()Ljava/util/Set;": view("set"),
  "values()Ljava/util/Collection;": view("collection"),
  "entrySet()Ljava/util/Set;": (value, wrapper) => wrap(value, wrapper.mode, "set", wrapper.mutex, wrapper.mode === "unmodifiable"),
  "subMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedMap;": view("sortedMap"),
  "headMap(Ljava/lang/Object;)Ljava/util/SortedMap;": view("sortedMap"),
  "tailMap(Ljava/lang/Object;)Ljava/util/SortedMap;": view("sortedMap"),
};

function registerCollection(name: string, mode: Mode, kind: "collection" | "list" | "set" | "sortedSet", ifaces: string[], extra: Partial<NativeSpec> = {}): void {
  const reads = [...collectionReads, ...(kind === "list" ? listReads : []), ...(kind === "set" || kind === "sortedSet" ? setReads : []), ...(kind === "sortedSet" ? sortedSetReads : [])];
  const mutations = [...collectionWrites, ...(kind === "list" ? listWrites : [])];
  rt.register({ name, ctor: extra.ctor ?? class extends JWrapper {}, sup: extra.sup, ifaces,
    serialization: extra.serialization,
    methods: { ...forwards(reads, collectionTransforms), ...writes(mutations, mode), ...extra.methods } });
}

function registerMap(name: string, mode: Mode, sorted: boolean): void {
  rt.register({
    name, ctor: class extends JWrapper {}, ifaces: sorted ? ["java/util/SortedMap", "java/util/Map"] : ["java/util/Map"],
    methods: { ...forwards([...mapReads, ...(sorted ? sortedMapReads : [])], mapTransforms), ...writes(mapWrites, mode) },
  });
}

rt.register({
  name: "webdroid/UnmodifiableIterator", ctor: JReadOnlyIterator, ifaces: ["java/util/Iterator", "java/util/ListIterator"],
  methods: {
    "hasNext()Z": function (this: JReadOnlyIterator) { return vcall(this.delegate, "hasNext", "()Z"); },
    "next()Ljava/lang/Object;": function (this: JReadOnlyIterator) {
      const value = vcall(this.delegate, "next", "()Ljava/lang/Object;");
      return this.entries ? after(value, readOnlyEntry) : value;
    },
    "forEachRemaining(Ljava/util/function/Consumer;)V": driven(function* (this: JReadOnlyIterator, consumer: unknown): Gen {
      while (yield vcall(this, "hasNext", "()Z")) yield vcall(consumer, "accept", "(Ljava/lang/Object;)V", yield vcall(this, "next", "()Ljava/lang/Object;"));
    }),
    "hasPrevious()Z": function (this: JReadOnlyIterator) { return vcall(this.delegate, "hasPrevious", "()Z"); },
    "previous()Ljava/lang/Object;": function (this: JReadOnlyIterator) {
      const value = vcall(this.delegate, "previous", "()Ljava/lang/Object;");
      return this.entries ? after(value, readOnlyEntry) : value;
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

registerCollection("java/util/Collections$UnmodifiableCollection", "unmodifiable", "collection",
  ["java/util/Collection", "java/io/Serializable"], {
    ctor: JUnmodifiableCollection,
    serialization: { uid: 1820017752578914078n, fields: [{ name: "c", desc: "Ljava/util/Collection;", prop: "delegate" }] },
  });
registerCollection("java/util/Collections$UnmodifiableList", "unmodifiable", "list",
  ["java/util/List"], {
    ctor: JUnmodifiableList, sup: "java/util/Collections$UnmodifiableCollection",
    serialization: { uid: -283967356065247728n, fields: [{ name: "list", desc: "Ljava/util/List;", prop: "delegate" }] },
    methods: { "readResolve()Ljava/lang/Object;": function (this: JUnmodifiableList) {
      return rt.iof(this.delegate, "java/util/RandomAccess") ? wrap(this.delegate, "unmodifiable", "list") : this;
    } },
  });
rt.register({ name: "java/util/Collections$UnmodifiableRandomAccessList", ctor: JUnmodifiableRandomAccessList,
  sup: "java/util/Collections$UnmodifiableList", ifaces: ["java/util/RandomAccess"],
  serialization: { uid: -2542308836966382001n, fields: [] },
  methods: {
    "writeReplace()Ljava/lang/Object;": function (this: JUnmodifiableRandomAccessList) {
      const list = rt.make("java/util/Collections$UnmodifiableList");
      list.delegate = this.delegate;
      return list;
    },
  } });
registerCollection("webdroid/UnmodifiableSet", "unmodifiable", "set", ["java/util/Set", "java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/UnmodifiableSortedSet", "unmodifiable", "sortedSet", ["java/util/SortedSet", "java/util/Set", "java/util/Collection", "java/lang/Iterable"]);
registerMap("webdroid/UnmodifiableMap", "unmodifiable", false);
registerMap("webdroid/UnmodifiableSortedMap", "unmodifiable", true);
registerCollection("webdroid/SynchronizedCollection", "synchronized", "collection", ["java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/SynchronizedList", "synchronized", "list", ["java/util/List", "java/util/Collection", "java/lang/Iterable"]);
registerCollection("webdroid/SynchronizedSet", "synchronized", "set", ["java/util/Set", "java/util/Collection", "java/lang/Iterable"]);
registerMap("webdroid/SynchronizedMap", "synchronized", false);
registerMap("webdroid/SynchronizedSortedMap", "synchronized", true);

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

export const synchronizedSortedMap = (value: unknown) => wrap(value, "synchronized", "sortedMap");
