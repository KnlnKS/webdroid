// java.util's collections run from libcore. TS builds and reads the ones it exchanges with Java
// through these helpers: ArrayList by its own fields, anything else through its Java API.
import { jarray, mangleField } from "../abi";
import { rt, driven, type Gen, type Intrinsic } from "../runtime";
import { vcall, scall, stringHash } from "./jlang";

const AL = "java/util/ArrayList", HM = "java/util/HashMap", NODE = "java/util/HashMap$Node", ITR = "java/util/ArrayList$Itr";
const DATA = mangleField(AL, "elementData"), SIZE = mangleField(AL, "size"), MOD = mangleField("java/util/AbstractList", "modCount");
const TABLE = mangleField(HM, "table"), IVALUE = mangleField("java/lang/Integer", "value");
const HASH = mangleField(NODE, "hash"), KEY = mangleField(NODE, "key"), VALUE = mangleField(NODE, "value"), NEXT = mangleField(NODE, "next");
const OUTER = mangleField(ITR, "this$0"), CURSOR = mangleField(ITR, "cursor"), LIMIT = mangleField(ITR, "limit"),
  LAST = mangleField(ITR, "lastRet"), EXPECTED = mangleField(ITR, "expectedModCount");

type Obj = Record<string, any>;
let arrayListCtor: (new () => Obj) | undefined;
function arrayList(): new () => Obj {
  if (arrayListCtor) return arrayListCtor;
  const info = rt.link(AL);
  rt.initClass(info);
  return arrayListCtor = info.ctor as new () => Obj;
}

/** A java.util.ArrayList over `items`, which it takes as its backing array. */
export function newArrayList(items: unknown[] = []): Obj {
  const l = new (arrayList())();
  l[DATA] = jarray(items);
  l[SIZE] = items.length;
  return l;
}

/** a Java Collection's elements, in its iteration order */
export function toJsArray(c: unknown): unknown[] | Promise<unknown[]> {
  if (c === null || c === undefined) return [];
  if ((c as Obj).constructor === arrayListCtor) return (c as Obj)[DATA].slice(0, (c as Obj)[SIZE]);
  return iterateAll(c);
}
const iterateAll = driven(function* iterateAll(c: unknown): Gen<unknown[]> {
  const out: unknown[] = [];
  const it = yield vcall(c, "iterator", "()Ljava/util/Iterator;");
  while (yield vcall(it, "hasNext", "()Z")) out.push(yield vcall(it, "next", "()Ljava/lang/Object;"));
  return out;
});

/** Java equality: identity, else `a.equals(b)` */
export function jeq(a: unknown, b: unknown): number | Promise<number> {
  if (a === b) return 1;
  if (a === null || b === null || a === undefined || b === undefined || typeof a === "string") return 0;
  return vcall(a, "equals", "(Ljava/lang/Object;)Z", b);
}

/** a java.util.Iterator over `items` */
export const mkIter = (items: unknown[]): unknown => vcall(newArrayList(items), "iterator", "()Ljava/util/Iterator;");
/** a java.util.Enumeration over `items` */
export const mkEnumeration = (items: unknown[]): unknown =>
  scall("java/util/Collections", "enumeration", "(Ljava/util/Collection;)Ljava/util/Enumeration;", newArrayList(items));

/** a Java collection of class `cls` holding `items`, added in order */
export const newCollection = driven(function* newCollection(cls: string, items: Iterable<unknown>): Gen<Obj> {
  const info = rt.link(cls);
  const init = rt.initClass(info);
  if (init) yield init;
  const c = new (info.ctor as new () => Obj)();
  yield vcall(c, "<init>", "()V");
  for (const item of items) yield vcall(c, "add", "(Ljava/lang/Object;)Z", item);
  return c;
});
export const newStringSet = (items: Iterable<string>) => newCollection("java/util/HashSet", items);
export const newLinkedHashSet = (items: Iterable<unknown>) => newCollection("java/util/LinkedHashSet", items);

const AM = "android/util/ArrayMap", AM_ARRAY = mangleField(AM, "mArray"), AM_SIZE = mangleField(AM, "mSize");
/** an android.util.ArrayMap's entries, by its own fields */
export function arrayMapEntries(map: Obj): [unknown, unknown][] {
  const array = map[AM_ARRAY], out: [unknown, unknown][] = [];
  for (let i = 0; i < map[AM_SIZE]; i++) out.push([array[2 * i], array[2 * i + 1]]);
  return out;
}

// §4.7 intrinsics: the index, size and iteration steps UI code runs most, and HashMap lookups of
// String and Integer keys, whose hashCode and equals cannot suspend. Anything else (bounds and
// modification failures, tree bins, other keys) is the AOSP body's. Each is compiled with its
// fields' own names (`$field` below): a named load stays monomorphic where a keyed one would not.
const FIELDS: Record<string, string> = { data: DATA, size: SIZE, mod: MOD, outer: OUTER, cursor: CURSOR, limit: LIMIT, last: LAST,
  expected: EXPECTED, table: TABLE, hash: HASH, key: KEY, value: VALUE, next: NEXT,
  seed: mangleField("java/util/Random", "seed"), long: mangleField("java/util/concurrent/atomic/AtomicLong", "value"), ivalue: IVALUE };
const compile = (params: string, body: string, env: Record<string, unknown> = {}): Intrinsic => (base) =>
  new Function("base", ...Object.keys(env), `return function(${params}){${body.replace(/\$(\w+)/g, (_, f: string) => FIELDS[f])}}`)(base, ...Object.values(env));
rt.intrinsic(AL, {
  "get(I)Ljava/lang/Object;": compile("i", "return i >>> 0 < this.$size ? this.$data[i] : base.call(this, i);"),
  "set(ILjava/lang/Object;)Ljava/lang/Object;": compile("i, e", `
    if (i >>> 0 >= this.$size) return base.call(this, i, e);
    const data = this.$data, old = data[i];
    data[i] = e;
    return old;`),
  "add(Ljava/lang/Object;)Z": compile("e", `
    const data = this.$data, size = this.$size;
    if (size === data.length) return base.call(this, e);
    this.$mod++;
    data[size] = e;
    this.$size = size + 1;
    return 1;`),
  "size()I": compile("", "return this.$size;"),
  "isEmpty()Z": compile("", "return this.$size === 0 ? 1 : 0;"),
});
rt.intrinsic(ITR, {
  "hasNext()Z": compile("", "return this.$cursor < this.$limit ? 1 : 0;"),
  "next()Ljava/lang/Object;": compile("", `
    const list = this.$outer, i = this.$cursor, data = list.$data;
    if (list.$mod !== this.$expected || i >= this.$limit || i >= data.length) return base.call(this);
    this.$cursor = i + 1;
    return data[this.$last = i];`),
});

// every grown ArrayList, ArrayDeque and PriorityQueue copies through here; the copy has the
// original's own array class
rt.intrinsic("java/util/Arrays", {
  "static copyOf([Ljava/lang/Object;I)[Ljava/lang/Object;": (base) => (original: unknown[] | null, n: number) => {
    if (original === null || n < 0) return base(original, n);
    const copy = original.slice(0, n);
    while (copy.length < n) copy.push(null);
    return jarray(copy, (original as { $t?: string }).$t);
  },
});

/** a class's constructor, looked up on first use */
const linked = (cls: string) => { let c: unknown; return () => c ??= rt.link(cls).ctor; };
/** the HashMap node holding `key`, null, or undefined when the AOSP body must answer */
const findNode = compile("map, key", `
  let h;
  if (typeof key === "string") h = stringHash(key);
  else if (key !== null && key.constructor === integer()) h = key.$ivalue;
  else return undefined;
  h ^= h >>> 16;
  const table = map.$table;
  if (table === null) return null;
  let e = table[(table.length - 1) & h];
  if (e === null) return null;
  if (e instanceof treeNode()) return undefined;
  if (typeof key === "string") {
    for (; e !== null; e = e.$next) if (e.$hash === h && e.$key === key) return e;
  } else {
    const v = key.$ivalue, I = key.constructor;
    for (; e !== null; e = e.$next) if (e.$hash === h && (e.$key === key || e.$key !== null && e.$key.constructor === I && e.$key.$ivalue === v)) return e;
  }
  return null;`, { stringHash, treeNode: linked("java/util/HashMap$TreeNode"), integer: linked("java/lang/Integer") })(() => undefined);
rt.intrinsic(HM, {
  "getNode(Ljava/lang/Object;)Ljava/util/HashMap$Node;": compile("key", "const e = findNode(this, key); return e === undefined ? base.call(this, key) : e;", { findNode }),
  "get(Ljava/lang/Object;)Ljava/lang/Object;": compile("key", "const e = findNode(this, key); return e === undefined ? base.call(this, key) : e === null ? null : e.$value;", { findNode }),
  "containsKey(Ljava/lang/Object;)Z": compile("key", "const e = findNode(this, key); return e === undefined ? base.call(this, key) : e === null ? 0 : 1;", { findNode }),
});
// ConcurrentHashMap's bin accessors: an Unsafe access at a long offset each, where a realm's single
// thread makes every ordering plain
const N = "Ljava/util/concurrent/ConcurrentHashMap$Node;";
rt.intrinsic("java/util/concurrent/ConcurrentHashMap", {
  [`static tabAt([${N}I)${N}`]: () => (tab: unknown[], i: number) => tab[i],
  [`static setTabAt([${N}I${N})V`]: () => (tab: unknown[], i: number, v: unknown) => { tab[i] = v; },
  [`static casTabAt([${N}I${N}${N})Z`]: () => (tab: unknown[], i: number, c: unknown, v: unknown) => {
    if (tab[i] !== c) return 0;
    tab[i] = v;
    return 1;
  },
});
// Random's 48-bit LCG step over three 16-bit limbs of the seed's AtomicLong, reading and writing it
// through one word instead of BigInt arithmetic
const word = new BigInt64Array(1), halves = new Int32Array(word.buffer);
rt.intrinsic("java/util/Random", {
  "next(I)I": compile("bits", `
    const seed = this.$seed;
    word[0] = seed.$long;
    const lo = halves[0], s2 = halves[1];
    if (!(bits >= 1 && bits <= 32) || s2 >>> 16 !== 0) return base.call(this, bits);
    const s0 = lo & 0xffff, s1 = lo >>> 16;
    const r0 = s0 * 0xe66d + 0xb, r1 = s1 * 0xe66d + s0 * 0xdeec + Math.floor(r0 / 65536);
    const n1 = r1 & 0xffff, n2 = (s2 * 0xe66d + s1 * 0xdeec + s0 * 5 + Math.floor(r1 / 65536)) & 0xffff;
    halves[0] = n1 << 16 | r0 & 0xffff;
    halves[1] = n2;
    seed.$long = word[0];
    return ((n2 << 16 | n1) >>> (32 - bits)) | 0;`, { word, halves }),
});
