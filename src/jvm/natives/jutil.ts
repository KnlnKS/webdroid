// java.util.* natives. JS Map/Array underneath; sync fast paths for string keys and
// identity-equals objects, async bucket path only for custom equals/hashCode.

import { rt, JObj, type NativeSpec, type ClassInfo } from "../runtime";
import { mangleMethod, jarray } from "../abi";
import { vcall, idHash, stringHash, defineException, fmtDouble, JEnum, JInt, JLong, JFloat, JDouble, JByte, JShort, JBool, JChar } from "./jlang";

/** Java toArray(T[]) contract: fill the GIVEN array when it fits (callers may
 * ignore the return value), null-terminating; else return a new one. */
function fillToArray(items: unknown[], out: unknown[]): unknown[] {
  if (Array.isArray(out) && out.length >= items.length) {
    for (let i = 0; i < items.length; i++) out[i] = items[i];
    if (out.length > items.length) out[items.length] = null;
    return out;
  }
  return jarray(items.slice(), (out as { $t?: string } | null)?.$t);
}

// equality / hashing bridges (sync when possible)
function jeq(a: unknown, b: unknown): number | Promise<number> {
  if (a === b) return 1;
  if (a === null || b === null || a === undefined || b === undefined) return 0;
  if (typeof a === "string") return 0; // string equals only identical strings
  return vcall(a, "equals", "(Ljava/lang/Object;)Z", b);
}
function jhash(o: unknown): number | Promise<number> {
  if (o === null || o === undefined) return 0;
  if (typeof o === "string") return stringHash(o);
  return vcall(o, "hashCode", "()I");
}
export async function jcmp(cmp: unknown, a: unknown, b: unknown): Promise<number> {
  if (cmp) return await vcall(cmp, "compare", "(Ljava/lang/Object;Ljava/lang/Object;)I", a, b);
  const t = typeof a;
  if (typeof b === t && (t === "string" || t === "number" || t === "bigint")) {
    const x = a as number, y = b as number;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return await vcall(a, "compareTo", "(Ljava/lang/Object;)I", b);
}

/** Fast map key for values with value/identity semantics, or SLOW sentinel. */
const SLOW = Symbol("slow");
const EQ_NAME = mangleMethod("equals", "(Ljava/lang/Object;)Z");
const objEq = (JObj.prototype as any)[EQ_NAME];
const enumEq = (JEnum.prototype as any)[EQ_NAME];
function mapKey(k: unknown): unknown {
  if (k === null || k === undefined) return "\0null";
  const t = typeof k;
  if (t === "bigint") return "J" + k; // raw long ≡ boxed Long (natives may leak raw bigints)
  if (t === "string" || t === "number") return k;
  if (k instanceof JInt || k instanceof JByte || k instanceof JShort) return "I" + (k as JInt).v;
  if (k instanceof JLong) return "J" + (k as JLong).v;
  if (k instanceof JChar) return "C" + (k as JChar).v;
  if (k instanceof JBool) return "Z" + (k as JBool).v;
  if (k instanceof JFloat || k instanceof JDouble) return "D" + (k as JFloat).v;
  const eq = (k as any)[EQ_NAME];
  if (eq === objEq || eq === enumEq) return k; // identity semantics → object key
  return SLOW;
}

interface Ent { k: unknown; v: unknown; }
class JMapEntry extends JObj {
  constructor(public e: Ent) { super(); }
}
rt.register({
  name: "java/util/Map$Entry", ctor: class extends JObj {},
});
rt.register({
  name: "webdroid/MapEntry", ctor: JMapEntry, ifaces: ["java/util/Map$Entry"],
  methods: {
    "getKey()Ljava/lang/Object;": function (this: JMapEntry) { return this.e.k; },
    "getValue()Ljava/lang/Object;": function (this: JMapEntry) { return this.e.v; },
    "setValue(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JMapEntry, v: unknown) { const o = this.e.v; this.e.v = v; return o; },
    "hashCode()I": function (this: JMapEntry) { return idHash(this.e.k); },
  },
});

// java.util.AbstractMap.SimpleImmutableEntry — a standalone Map.Entry whose
// setValue() throws (the mutable sibling SimpleEntry isn't implemented; this
// is the only one apps have needed so far).
const GETKEY_NAME = mangleMethod("getKey", "()Ljava/lang/Object;");
const GETVALUE_NAME = mangleMethod("getValue", "()Ljava/lang/Object;");
class JSimpleImmutableEntry extends JObj {
  e: Ent = { k: null, v: null };
}
rt.register({
  name: "java/util/AbstractMap$SimpleImmutableEntry", ctor: JSimpleImmutableEntry, ifaces: ["java/util/Map$Entry"],
  methods: {
    "<init>(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JSimpleImmutableEntry, k: unknown, v: unknown) { this.e = { k, v }; },
    "getKey()Ljava/lang/Object;": function (this: JSimpleImmutableEntry) { return this.e.k; },
    "getValue()Ljava/lang/Object;": function (this: JSimpleImmutableEntry) { return this.e.v; },
    "setValue(Ljava/lang/Object;)Ljava/lang/Object;": function (): never {
      throw rt.mkThrowable("java/lang/UnsupportedOperationException", null);
    },
    "equals(Ljava/lang/Object;)Z": async function (this: JSimpleImmutableEntry, o: unknown) {
      if (o === this) return 1;
      const gk = (o as any)?.[GETKEY_NAME], gv = (o as any)?.[GETVALUE_NAME];
      if (typeof gk !== "function" || typeof gv !== "function") return 0; // not a Map.Entry
      const rk = jeq(this.e.k, await vcall(o, "getKey", "()Ljava/lang/Object;"));
      if (!(rk instanceof Promise ? await rk : rk)) return 0;
      const rv = jeq(this.e.v, await vcall(o, "getValue", "()Ljava/lang/Object;"));
      return (rv instanceof Promise ? await rv : rv) ? 1 : 0;
    },
    "hashCode()I": async function (this: JSimpleImmutableEntry) {
      const rk = jhash(this.e.k), rv = jhash(this.e.v);
      return ((rk instanceof Promise ? await rk : rk) ^ (rv instanceof Promise ? await rv : rv)) | 0;
    },
    "toString()Ljava/lang/String;": async function (this: JSimpleImmutableEntry) {
      const str = async (x: unknown) => (x === null ? "null" : String(typeof x === "object" ? await vcall(x, "toString", "()Ljava/lang/String;") : x));
      return `${await str(this.e.k)}=${await str(this.e.v)}`;
    },
  },
});

// ── iterators over JS arrays
type IterOwner = { removeAt?(i: number): void | Promise<void>; readonly modCount?: number };
class JIter extends JObj {
  i = 0;
  last = -1; // index next()/previous() returned, the target of set()/remove(); -1 once consumed
  expectedMod: number | null = null; // fail-fast snapshot, only set when owner exposes modCount
  constructor(public arr: unknown[], public owner: IterOwner | null = null) {
    super();
    if (owner && owner.modCount !== undefined) this.expectedMod = owner.modCount;
  }
}
function checkMod(it: JIter) {
  if (it.expectedMod !== null && it.owner!.modCount !== it.expectedMod) {
    throw rt.mkThrowable("java/util/ConcurrentModificationException", null);
  }
}
const iterHasNext = function (this: JIter) { return this.i < this.arr.length ? 1 : 0; };
const iterNext = function (this: JIter) {
  checkMod(this);
  if (this.i >= this.arr.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
  this.last = this.i;
  return this.arr[this.i++];
};
rt.register({
  name: "webdroid/Iter", ctor: JIter, ifaces: ["java/util/Iterator", "java/util/ListIterator", "java/util/Enumeration"],
  methods: {
    "hasNext()Z": iterHasNext,
    "next()Ljava/lang/Object;": iterNext,
    "hasMoreElements()Z": iterHasNext,
    "nextElement()Ljava/lang/Object;": iterNext,
    "remove()V": async function (this: JIter) {
      if (this.last < 0) throw rt.mkThrowable("java/lang/IllegalStateException", null);
      checkMod(this);
      if (this.owner?.removeAt) await this.owner.removeAt(this.last);
      else this.arr.splice(this.last, 1);
      if (this.last < this.i) this.i--;
      this.last = -1;
      if (this.expectedMod !== null) this.expectedMod = this.owner!.modCount!;
    },
    "hasPrevious()Z": function (this: JIter) { return this.i > 0 ? 1 : 0; },
    "previous()Ljava/lang/Object;": function (this: JIter) {
      checkMod(this);
      if (this.i <= 0) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      this.last = --this.i;
      return this.arr[this.i];
    },
    "nextIndex()I": function (this: JIter) { return this.i; },
    "previousIndex()I": function (this: JIter) { return this.i - 1; },
    "set(Ljava/lang/Object;)V": function (this: JIter, v: unknown) {
      if (this.last < 0) throw rt.mkThrowable("java/lang/IllegalStateException", null);
      checkMod(this);
      this.arr[this.last] = v;
    },
    "add(Ljava/lang/Object;)V": function (this: JIter, v: unknown) {
      checkMod(this);
      this.arr.splice(this.i++, 0, v);
      this.last = -1;
      if (this.expectedMod !== null) this.expectedMod = this.owner!.modCount!;
    },
  },
});
export function mkIter(arr: unknown[], owner: IterOwner | null = null): JIter {
  return new JIter(arr, owner);
}

async function listBinarySearch(l: unknown, k: unknown, cmp: unknown): Promise<number> {
  const a = await toJsArray(l);
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = await jcmp(cmp, a[mid], k);
    if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else return mid;
  }
  return -(lo + 1);
}
/** A java.util.ArrayList over `items` — compiled code cannot use a bare JS array as a List. */
export function newArrayList(items: unknown[] = []): JList {
  const l = new (rt.link("java/util/ArrayList").ctor as new () => JList)();
  l.a = items;
  return l;
}
/** A java.util.LinkedHashSet over `items` (insertion order, Java equality). */
export async function newLinkedHashSet(items: unknown[] = []): Promise<JSet> {
  const s = new (rt.link("java/util/LinkedHashSet").ctor as new () => JSet)();
  for (const v of items) { const r = addToSet(s, v); if (r instanceof Promise) await r; }
  return s;
}

let ioobeLogged = 0;
function ioobe(i: number, n: number): never {
  if (i < 0 && ioobeLogged++ < 3) console.warn("[webdroid] ioobe neg", new Error().stack);
  throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", `Index: ${i}, Size: ${n}`);
}

// ── ArrayList (also backs LinkedList/Vector/Stack behaviour)
export class JList extends JObj {
  a: unknown[] = [];
  removeAt(i: number) { this.a.splice(i, 1); }
}

/**
 * Backing store for List.subList, which in Java is a live VIEW: everything done through it —
 * set, add, remove, clear — writes through to the backing list. Returning a copy silently
 * drops those writes (Compose's SlotWriter.removeGroups drops dead anchors with
 * `anchors.subList(a, b).clear()`; with a copy the anchors survive, the sorted anchor list
 * stops being sorted, and later anchors resolve to the wrong group).
 * A Proxy over the parent array keeps every JList method working unchanged: indices map into
 * the window, and length changes splice the parent.
 */
function subView(parent: unknown[], from: number, to: number): unknown[] {
  let len = to - from;
  const idx = (p: string | symbol): number =>
    typeof p === "string" && /^(?:0|[1-9]\d*)$/.test(p) ? +p : -1;
  const target: unknown[] = [];
  return new Proxy(target, {
    get(_t, p, r) {
      if (p === "length") return len;
      const i = idx(p);
      if (i >= 0) return i < len ? parent[from + i] : undefined;
      return Reflect.get(target, p, r);
    },
    set(_t, p, v) {
      if (p === "length") {
        const n = Math.max(0, Number(v));
        if (n < len) parent.splice(from + n, len - n);
        else if (n > len) parent.splice(from + len, 0, ...new Array(n - len));
        len = n;
        return true;
      }
      const i = idx(p);
      if (i >= 0) {
        if (i >= len) { parent.splice(from + len, 0, ...new Array(i + 1 - len)); len = i + 1; }
        parent[from + i] = v;
        return true;
      }
      return Reflect.set(target, p, v);
    },
    deleteProperty(_t, p) {
      const i = idx(p);
      if (i >= 0) { if (i < len) parent[from + i] = undefined; return true; }
      return Reflect.deleteProperty(target, p);
    },
    has(_t, p) {
      const i = idx(p);
      if (i >= 0) return i < len;
      return p === "length" || Reflect.has(target, p);
    },
    ownKeys() {
      const k: string[] = [];
      for (let i = 0; i < len; i++) k.push(String(i));
      k.push("length");
      return k;
    },
    getOwnPropertyDescriptor(_t, p) {
      if (p === "length") return { value: len, writable: true, enumerable: false, configurable: false };
      const i = idx(p);
      if (i >= 0 && i < len) return { value: parent[from + i], writable: true, enumerable: true, configurable: true };
      return undefined;
    },
  });
}
type Methods = NonNullable<NativeSpec["methods"]>;
export function listMethods(): Methods {
  return {
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "<init>(Ljava/util/Collection;)V": async function (this: JList, c: unknown) {
      if (c) this.a = (await toJsArray(c)).slice();
    },
    "size()I": function (this: JList) { return this.a.length; },
    "isEmpty()Z": function (this: JList) { return this.a.length === 0 ? 1 : 0; },
    "get(I)Ljava/lang/Object;": function (this: JList, i: number) {
      if (i >>> 0 >= this.a.length) ioobe(i, this.a.length);
      return this.a[i];
    },
    "set(ILjava/lang/Object;)Ljava/lang/Object;": function (this: JList, i: number, v: unknown) {
      if (i >>> 0 >= this.a.length) ioobe(i, this.a.length);
      const o = this.a[i]; this.a[i] = v; return o;
    },
    "add(Ljava/lang/Object;)Z": function (this: JList, v: unknown) { this.a.push(v); return 1; },
    "add(ILjava/lang/Object;)V": function (this: JList, i: number, v: unknown) {
      if (i >>> 0 > this.a.length) ioobe(i, this.a.length);
      this.a.splice(i, 0, v);
    },
    "remove(I)Ljava/lang/Object;": function (this: JList, i: number) {
      if (i >>> 0 >= this.a.length) ioobe(i, this.a.length);
      return this.a.splice(i, 1)[0];
    },
    "remove(Ljava/lang/Object;)Z": async function (this: JList, v: unknown) {
      const i = await indexOfAsync(this.a, v);
      if (i < 0) return 0;
      this.a.splice(i, 1);
      return 1;
    },
    "indexOf(Ljava/lang/Object;)I": function (this: JList, v: unknown) { return indexOfAsync(this.a, v); },
    "lastIndexOf(Ljava/lang/Object;)I": async function (this: JList, v: unknown) {
      for (let i = this.a.length - 1; i >= 0; i--) {
        const r = jeq(this.a[i], v);
        if (r instanceof Promise ? await r : r) return i;
      }
      return -1;
    },
    "contains(Ljava/lang/Object;)Z": async function (this: JList, v: unknown) {
      return (await indexOfAsync(this.a, v)) >= 0 ? 1 : 0;
    },
    "clear()V": function (this: JList) { this.a.length = 0; },
    "iterator()Ljava/util/Iterator;": function (this: JList) { return mkIter(this.a, this); },
    "listIterator()Ljava/util/ListIterator;": function (this: JList) { return mkIter(this.a, this); },
    "listIterator(I)Ljava/util/ListIterator;": function (this: JList, at: number) {
      const it = mkIter(this.a, this);
      (it as unknown as { i: number }).i = at;
      return it;
    },
    "addAll(Ljava/util/Collection;)Z": async function (this: JList, c: unknown) {
      const src = await toJsArray(c);
      this.a.push(...src);
      return src.length ? 1 : 0;
    },
    "addAll(ILjava/util/Collection;)Z": async function (this: JList, i: number, c: unknown) {
      const src = await toJsArray(c);
      this.a.splice(i, 0, ...src);
      return src.length ? 1 : 0;
    },
    "removeAll(Ljava/util/Collection;)Z": async function (this: JList, c: unknown) {
      const src = await toJsArray(c);
      const before = this.a.length;
      for (const s of src) {
        let i: number;
        while ((i = await indexOfAsync(this.a, s)) >= 0) this.a.splice(i, 1);
      }
      return this.a.length !== before ? 1 : 0;
    },
    "toArray()[Ljava/lang/Object;": function (this: JList) { return jarray(this.a.slice()); },
    "toArray([Ljava/lang/Object;)[Ljava/lang/Object;": function (this: JList, out: unknown[]) {
      return fillToArray(this.a, out);
    },
    "subList(II)Ljava/util/List;": function (this: JList, a: number, b: number) {
      if (a < 0 || b > this.a.length || a > b) ioobe(a < 0 ? a : b, this.a.length);
      const l = new (this.constructor as new () => JList)();
      l.a = subView(this.a, a, b);
      return l;
    },
    "sort(Ljava/util/Comparator;)V": function (this: JList, cmp: unknown) { return sortInPlace(this.a, cmp); },
    "equals(Ljava/lang/Object;)Z": async function (this: JList, o: unknown) {
      if (o === this) return 1;
      if (!(o instanceof JList) || o.a.length !== this.a.length) return 0;
      for (let i = 0; i < this.a.length; i++) {
        const r = jeq(this.a[i], o.a[i]);
        if (!(r instanceof Promise ? await r : r)) return 0;
      }
      return 1;
    },
    "hashCode()I": function (this: JList) { return hashSeq(this.a); },
    "toString()Ljava/lang/String;": async function (this: JList) {
      const parts: string[] = [];
      for (const e of this.a) parts.push(e === null ? "null" : String(typeof e === "object" ? await vcall(e, "toString", "()Ljava/lang/String;") : e));
      return "[" + parts.join(", ") + "]";
    },
    // Deque/Queue-ish extras (LinkedList/ArrayDeque share this)
    "addFirst(Ljava/lang/Object;)V": function (this: JList, v: unknown) { this.a.unshift(v); },
    "addLast(Ljava/lang/Object;)V": function (this: JList, v: unknown) { this.a.push(v); },
    "removeFirst()Ljava/lang/Object;": function (this: JList) {
      if (!this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      return this.a.shift();
    },
    "removeLast()Ljava/lang/Object;": function (this: JList) {
      if (!this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      return this.a.pop();
    },
    "getFirst()Ljava/lang/Object;": function (this: JList) { return this.a[0] ?? null; },
    "getLast()Ljava/lang/Object;": function (this: JList) { return this.a[this.a.length - 1] ?? null; },
    "peek()Ljava/lang/Object;": function (this: JList) { return this.a.length ? this.a[0] : null; },
    "peekFirst()Ljava/lang/Object;": function (this: JList) { return this.a.length ? this.a[0] : null; },
    "peekLast()Ljava/lang/Object;": function (this: JList) { return this.a.length ? this.a[this.a.length - 1] : null; },
    "poll()Ljava/lang/Object;": function (this: JList) { return this.a.length ? this.a.shift() : null; },
    "pollFirst()Ljava/lang/Object;": function (this: JList) { return this.a.length ? this.a.shift() : null; },
    "pollLast()Ljava/lang/Object;": function (this: JList) { return this.a.length ? this.a.pop() : null; },
    "descendingIterator()Ljava/util/Iterator;": function (this: JList) { return mkIter([...this.a].reverse()); },
    "offer(Ljava/lang/Object;)Z": function (this: JList, v: unknown) { this.a.push(v); return 1; },
    "offerFirst(Ljava/lang/Object;)Z": function (this: JList, v: unknown) { this.a.unshift(v); return 1; },
    "offerLast(Ljava/lang/Object;)Z": function (this: JList, v: unknown) { this.a.push(v); return 1; },
    "push(Ljava/lang/Object;)V": function (this: JList, v: unknown) { this.a.unshift(v); },
    "pop()Ljava/lang/Object;": function (this: JList) {
      if (!this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      return this.a.shift();
    },
  };
}
async function indexOfAsync(arr: unknown[], v: unknown): Promise<number> {
  for (let i = 0; i < arr.length; i++) {
    const r = jeq(arr[i], v);
    if (r instanceof Promise ? await r : r) return i;
  }
  return -1;
}
/** Java's List.hashCode / Arrays.hashCode / Objects.hash over a sequence */
async function hashSeq(a: unknown[]): Promise<number> {
  let h = 1;
  for (const e of a) {
    const r = jhash(e);
    h = (Math.imul(h, 31) + (r instanceof Promise ? await r : r)) | 0;
  }
  return h;
}
/** sort `a` where it lives: a subList view (and Arrays.sort's caller) must see the writes */
async function sortInPlace(a: unknown[], cmp: unknown, from = 0, to = a.length): Promise<void> {
  const s = await sortAsync(a.slice(from, to), cmp);
  for (let i = 0; i < s.length; i++) a[from + i] = s[i];
}
async function sortAsync(a: unknown[], cmp: unknown): Promise<unknown[]> {
  // merge sort with async comparator
  if (a.length < 2) return a;
  const mid = a.length >> 1;
  const l = await sortAsync(a.slice(0, mid), cmp);
  const r = await sortAsync(a.slice(mid), cmp);
  const out: unknown[] = [];
  let i = 0, j = 0;
  while (i < l.length && j < r.length) out.push((await jcmp(cmp, l[i], r[j])) <= 0 ? l[i++] : r[j++]);
  while (i < l.length) out.push(l[i++]);
  while (j < r.length) out.push(r[j++]);
  return out;
}
/** any java Collection/Iterable → JS array (fast path for our native lists/sets) */
export async function toJsArray(c: unknown): Promise<unknown[]> {
  if (c === null || c === undefined) return [];
  if (c instanceof JList) return c.a;
  if (c instanceof JSet) return setItems(c);
  if (c instanceof JMap) return []; // maps aren't collections
  const out: unknown[] = [];
  const it = await vcall(c, "iterator", "()Ljava/util/Iterator;");
  while (await vcall(it, "hasNext", "()Z")) out.push(await vcall(it, "next", "()Ljava/lang/Object;"));
  return out;
}

rt.register({
  name: "webdroid/BaseList", ctor: JList,
  ifaces: ["java/util/List", "java/util/Collection", "java/lang/Iterable", "java/util/Queue", "java/util/Deque", "java/util/RandomAccess", "java/io/Serializable"],
  methods: listMethods(),
});
// Vector's pre-Collections API, which Stack inherits.
function vectorMethods(base: Methods): Methods {
  const edge = (i: number) => function (this: JList) {
    if (!this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
    return this.a[i < 0 ? this.a.length + i : i];
  };
  return {
    "<init>(II)V": function () {},
    "copyInto([Ljava/lang/Object;)V": function (this: JList, out: unknown[]) {
      if (out === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (out.length < this.a.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", `length=${out.length}; index=${out.length}`);
      for (let i = 0; i < this.a.length; i++) out[i] = this.a[i];
    },
    "elementAt(I)Ljava/lang/Object;": base["get(I)Ljava/lang/Object;"],
    "addElement(Ljava/lang/Object;)V": function (this: JList, v: unknown) { this.a.push(v); },
    "removeElement(Ljava/lang/Object;)Z": base["remove(Ljava/lang/Object;)Z"],
    "removeElementAt(I)V": base["remove(I)Ljava/lang/Object;"],
    "insertElementAt(Ljava/lang/Object;I)V": function (this: JList, v: unknown, i: number) {
      if (i >>> 0 > this.a.length) ioobe(i, this.a.length);
      this.a.splice(i, 0, v);
    },
    "setElementAt(Ljava/lang/Object;I)V": function (this: JList, v: unknown, i: number) {
      if (i >>> 0 >= this.a.length) ioobe(i, this.a.length);
      this.a[i] = v;
    },
    "firstElement()Ljava/lang/Object;": edge(0),
    "lastElement()Ljava/lang/Object;": edge(-1),
    "removeAllElements()V": function (this: JList) { this.a.length = 0; },
    "elements()Ljava/util/Enumeration;": function (this: JList) { return mkIter(this.a); },
  };
}
// Stack's push/pop/peek work at the END of the array (the Deque ones shared above work at
// the front), so they stay consistent with elementAt/firstElement on the same list.
defineException("java/util/EmptyStackException", "java/lang/RuntimeException");
const stackMethods: Methods = {
  "push(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JList, v: unknown) { this.a.push(v); return v; },
  "pop()Ljava/lang/Object;": function (this: JList) {
    if (!this.a.length) throw rt.mkThrowable("java/util/EmptyStackException", null);
    return this.a.pop();
  },
  "peek()Ljava/lang/Object;": function (this: JList) {
    if (!this.a.length) throw rt.mkThrowable("java/util/EmptyStackException", null);
    return this.a[this.a.length - 1];
  },
  "empty()Z": function (this: JList) { return this.a.length === 0 ? 1 : 0; },
  "search(Ljava/lang/Object;)I": async function (this: JList, v: unknown) {
    for (let i = this.a.length - 1; i >= 0; i--) {
      const r = jeq(this.a[i], v);
      if (r instanceof Promise ? await r : r) return this.a.length - i;
    }
    return -1;
  },
};
const listExtras: Record<string, (base: Methods) => Methods> = {
  "java/util/Vector": vectorMethods,
  "java/util/Stack": (base) => ({ ...vectorMethods(base), ...stackMethods }),
};
for (const n of ["java/util/ArrayList", "java/util/LinkedList", "java/util/Vector", "java/util/Stack", "java/util/ArrayDeque"]) {
  const base = listMethods();
  rt.register({
    name: n, ctor: class extends JList {},
    ifaces: ["java/util/List", "java/util/Collection", "java/lang/Iterable", "java/util/Queue", "java/util/Deque", "java/util/RandomAccess", "java/lang/Cloneable", "java/io/Serializable"],
    methods: { ...base, ...listExtras[n]?.(base) },
  });
}

// ── HashMap and friends
class JMap extends JObj {
  m = new Map<unknown, Ent>();       // fast keys
  slow: Ent[] = [];                  // custom-equals keys (linear; rare)
  access = false;                    // LinkedHashMap accessOrder
}
async function slowFind(list: Ent[], k: unknown): Promise<number> {
  for (let i = 0; i < list.length; i++) {
    const r = jeq(list[i].k, k);
    if (r instanceof Promise ? await r : r) return i;
  }
  return -1;
}
function mapMethods(): NativeSpec["methods"] {
  return {
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "<init>(IF)V": function () {},
    "<init>(IFI)V": function () {},
    "<init>(IFZ)V": function (this: JMap, _c: number, _f: number, ao: number) { this.access = !!ao; },
    "<init>(Ljava/util/Map;)V": async function (this: JMap, src: unknown) {
      if (src instanceof JMap) { this.m = new Map(src.m); this.slow = src.slow.slice(); }
      else if (src) await copyMapInto(src, this);
    },
    "size()I": function (this: JMap) { return this.m.size + this.slow.length; },
    "isEmpty()Z": function (this: JMap) { return this.m.size + this.slow.length === 0 ? 1 : 0; },
    "get(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JMap, k: unknown) {
      const mk = mapKey(k);
      if (mk !== SLOW) {
        const e = this.m.get(mk);
        if (e && this.access) { this.m.delete(mk); this.m.set(mk, e); }
        return e ? e.v : null;
      }
      return slowFind(this.slow, k).then((i) => (i >= 0 ? this.slow[i].v : null));
    },
    "getOrDefault(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JMap, k: unknown, d: unknown) {
      const v = await (vcall(this, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", k));
      return v === null ? d : v;
    },
    "containsKey(Ljava/lang/Object;)Z": function (this: JMap, k: unknown) {
      const mk = mapKey(k);
      if (mk !== SLOW) return this.m.has(mk) ? 1 : 0;
      return slowFind(this.slow, k).then((i) => (i >= 0 ? 1 : 0));
    },
    "containsValue(Ljava/lang/Object;)Z": async function (this: JMap, v: unknown) {
      for (const e of allEnts(this)) {
        const r = jeq(e.v, v);
        if (r instanceof Promise ? await r : r) return 1;
      }
      return 0;
    },
    "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function (this: JMap, k: unknown, v: unknown) {
      const mk = mapKey(k);
      if (mk !== SLOW) {
        const e = this.m.get(mk);
        if (e) { const o = e.v; e.v = v; return o; }
        this.m.set(mk, { k, v });
        return null;
      }
      return slowFind(this.slow, k).then((i) => {
        if (i >= 0) { const o = this.slow[i].v; this.slow[i].v = v; return o; }
        this.slow.push({ k, v });
        return null;
      });
    },
    "putIfAbsent(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JMap, k: unknown, v: unknown) {
      const cur = await vcall(this, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", k);
      if (cur !== null) return cur;
      await vcall(this, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", k, v);
      return null;
    },
    "remove(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JMap, k: unknown) {
      const mk = mapKey(k);
      if (mk !== SLOW) {
        const e = this.m.get(mk);
        if (!e) return null;
        this.m.delete(mk);
        return e.v;
      }
      return slowFind(this.slow, k).then((i) => (i >= 0 ? this.slow.splice(i, 1)[0].v : null));
    },
    "clear()V": function (this: JMap) { this.m.clear(); this.slow.length = 0; },
    "putAll(Ljava/util/Map;)V": async function (this: JMap, src: unknown) { if (src) await copyMapInto(src, this); },
    "keySet()Ljava/util/Set;": function (this: JMap) { return new JSetView(this, "k"); },
    "values()Ljava/util/Collection;": function (this: JMap) { return new JSetView(this, "v"); },
    "entrySet()Ljava/util/Set;": function (this: JMap) { return new JSetView(this, "e"); },
    "toString()Ljava/lang/String;": function (this: JMap) {
      return "{" + [...allEnts(this)].map((e) => `${e.k}=${e.v}`).join(", ") + "}";
    },
    "hashCode()I": function (this: JMap) { return idHash(this); },
    "equals(Ljava/lang/Object;)Z": function (this: JMap, o: unknown) { return this === o ? 1 : 0; },
  };
}
function* allEnts(m: JMap): Generator<Ent> {
  yield* m.m.values();
  yield* m.slow;
}
async function copyMapInto(src: unknown, dst: JMap) {
  if (src instanceof JMap) {
    for (const e of allEnts(src)) {
      // through put(), not m.set: slow (custom-equals) keys must go through the bucket path
      await vcall(dst, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", e.k, e.v);
    }
    return;
  }
  const es = await vcall(src, "entrySet", "()Ljava/util/Set;");
  const it = await vcall(es, "iterator", "()Ljava/util/Iterator;");
  while (await vcall(it, "hasNext", "()Z")) {
    const e = await vcall(it, "next", "()Ljava/lang/Object;");
    await vcall(dst, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
      await vcall(e, "getKey", "()Ljava/lang/Object;"), await vcall(e, "getValue", "()Ljava/lang/Object;"));
  }
}

/** live-ish view over a JMap for keySet/values/entrySet (iteration + size + contains + remove) */
class JSetView extends JObj {
  constructor(public map: JMap, public kind: "k" | "v" | "e") { super(); }
  snapshot(): unknown[] {
    const out: unknown[] = [];
    for (const e of allEnts(this.map)) out.push(this.kind === "k" ? e.k : this.kind === "v" ? e.v : new JMapEntry(e));
    return out;
  }
}
rt.register({
  name: "webdroid/SetView", ctor: JSetView,
  ifaces: ["java/util/Set", "java/util/Collection", "java/lang/Iterable"],
  methods: {
    "size()I": function (this: JSetView) { return this.map.m.size + this.map.slow.length; },
    "isEmpty()Z": function (this: JSetView) { return this.map.m.size + this.map.slow.length ? 0 : 1; },
    "iterator()Ljava/util/Iterator;": function (this: JSetView) { return mkIter(this.snapshot()); },
    "contains(Ljava/lang/Object;)Z": function (this: JSetView, v: unknown) {
      if (this.kind === "k") return vcall(this.map, "containsKey", "(Ljava/lang/Object;)Z", v);
      return indexOfAsync(this.snapshot(), v).then((i) => (i >= 0 ? 1 : 0));
    },
    "remove(Ljava/lang/Object;)Z": async function (this: JSetView, v: unknown) {
      if (this.kind === "k") {
        return (await vcall(this.map, "remove", "(Ljava/lang/Object;)Ljava/lang/Object;", v)) !== null ? 1 : 0;
      }
      return 0;
    },
    "toArray()[Ljava/lang/Object;": function (this: JSetView) { return jarray(this.snapshot()); },
    "toArray([Ljava/lang/Object;)[Ljava/lang/Object;": function (this: JSetView, out: unknown[]) {
      return fillToArray(this.snapshot(), out);
    },
    "removeAll(Ljava/util/Collection;)Z": async function (this: JSetView, c: unknown) {
      if (this.kind !== "k") return 0;
      let ch = 0;
      for (const v of await toJsArray(c)) {
        const r = await vcall(this.map, "remove", "(Ljava/lang/Object;)Ljava/lang/Object;", v);
        if (r !== null) ch = 1;
      }
      return ch;
    },
    "retainAll(Ljava/util/Collection;)Z": async function (this: JSetView, c: unknown) {
      if (this.kind !== "k") return 0;
      const keep = await toJsArray(c);
      let ch = 0;
      for (const k of this.snapshot()) {
        if ((await indexOfAsync(keep, k)) < 0) {
          await vcall(this.map, "remove", "(Ljava/lang/Object;)Ljava/lang/Object;", k);
          ch = 1;
        }
      }
      return ch;
    },
    "containsAll(Ljava/util/Collection;)Z": async function (this: JSetView, c: unknown) {
      const snap = this.snapshot();
      for (const v of await toJsArray(c)) if ((await indexOfAsync(snap, v)) < 0) return 0;
      return 1;
    },
    "clear()V": function (this: JSetView) { this.map.m.clear(); this.map.slow.length = 0; },
    "toString()Ljava/lang/String;": function (this: JSetView) { return "[" + this.snapshot().join(", ") + "]"; },
  },
});

rt.register({ name: "webdroid/BaseMap", ctor: JMap, ifaces: ["java/util/Map", "java/io/Serializable"], methods: mapMethods() });
for (const n of ["java/util/HashMap", "java/util/LinkedHashMap", "java/util/concurrent/ConcurrentHashMap",
  "java/util/WeakHashMap", "java/util/IdentityHashMap", "java/util/Hashtable", "java/util/EnumMap"]) {
  rt.register({
    name: n, ctor: class extends JMap {},
    sup: n === "java/util/LinkedHashMap" ? "java/util/HashMap" : "java/lang/Object",
    ifaces: ["java/util/Map", "java/util/concurrent/ConcurrentMap", "java/util/SortedMap", "java/lang/Cloneable", "java/io/Serializable"],
    methods: {
      ...mapMethods(),
      ...(n === "java/util/EnumMap" ? { "<init>(Ljava/lang/Class;)V": function () {} } : {}),
    },
  });
}

// ── HashSet family (backed by JMap-like Map)
class JSet extends JObj {
  m = new Map<unknown, Ent>();
  slow: Ent[] = [];
}
/** the members, fast bucket first then the custom-equals ones (both must be walked: see NOTES) */
function setItems(s: JSet): unknown[] { return [...s.m.values(), ...s.slow].map((e) => e.k); }
function setMethods(): NativeSpec["methods"] {
  return {
    "<init>()V": function () {},
    "<init>(Ljava/util/Comparator;)V": function () {},
    "<init>(I)V": function () {},
    "<init>(Ljava/util/Collection;)V": async function (this: JSet, c: unknown) {
      for (const v of await toJsArray(c)) await addToSet(this, v);
    },
    "size()I": function (this: JSet) { return this.m.size + this.slow.length; },
    "first()Ljava/lang/Object;": async function (this: JSet) {
      const a = await toJsArray(this);
      if (!a.length) throw rt.mkThrowable("java/util/NoSuchElementException", "empty set");
      return a[0];
    },
    "last()Ljava/lang/Object;": async function (this: JSet) {
      const a = await toJsArray(this);
      if (!a.length) throw rt.mkThrowable("java/util/NoSuchElementException", "empty set");
      return a[a.length - 1];
    },
    "isEmpty()Z": function (this: JSet) { return this.m.size + this.slow.length ? 0 : 1; },
    "add(Ljava/lang/Object;)Z": function (this: JSet, v: unknown) { return addToSet(this, v); },
    "remove(Ljava/lang/Object;)Z": function (this: JSet, v: unknown) {
      const mk = mapKey(v);
      if (mk !== SLOW) return this.m.delete(mk) ? 1 : 0;
      return slowFind(this.slow, v).then((i) => (i >= 0 ? (this.slow.splice(i, 1), 1) : 0));
    },
    "contains(Ljava/lang/Object;)Z": function (this: JSet, v: unknown) {
      const mk = mapKey(v);
      if (mk !== SLOW) return this.m.has(mk) ? 1 : 0;
      return slowFind(this.slow, v).then((i) => (i >= 0 ? 1 : 0));
    },
    "clear()V": function (this: JSet) { this.m.clear(); this.slow.length = 0; },
    "iterator()Ljava/util/Iterator;": function (this: JSet) { return mkIter(setItems(this)); },
    "addAll(Ljava/util/Collection;)Z": async function (this: JSet, c: unknown) {
      let ch = 0;
      for (const v of await toJsArray(c)) ch = (await addToSet(this, v)) || ch;
      return ch;
    },
    "removeAll(Ljava/util/Collection;)Z": async function (this: JSet, c: unknown) {
      let ch = 0;
      for (const v of await toJsArray(c)) ch = (await vcall(this, "remove", "(Ljava/lang/Object;)Z", v)) || ch;
      return ch;
    },
    "containsAll(Ljava/util/Collection;)Z": async function (this: JSet, c: unknown) {
      for (const v of await toJsArray(c)) if (!(await vcall(this, "contains", "(Ljava/lang/Object;)Z", v))) return 0;
      return 1;
    },
    "toArray()[Ljava/lang/Object;": function (this: JSet) { return jarray(setItems(this)); },
    "toArray([Ljava/lang/Object;)[Ljava/lang/Object;": function (this: JSet, out: unknown[]) { return fillToArray(setItems(this), out); },
    "toString()Ljava/lang/String;": function (this: JSet) { return "[" + setItems(this).join(", ") + "]"; },
  };
}
function addToSet(s: JSet, v: unknown): number | Promise<number> {
  if (s instanceof JTreeSet) return tadd(s, v);
  const mk = mapKey(v);
  if (mk !== SLOW) {
    if (s.m.has(mk)) return 0;
    s.m.set(mk, { k: v, v: v });
    return 1;
  }
  return slowFind(s.slow, v).then((i) => (i >= 0 ? 0 : (s.slow.push({ k: v, v }), 1)));
}
rt.register({ name: "webdroid/BaseSet", ctor: JSet, ifaces: ["java/util/Set", "java/util/Collection", "java/lang/Iterable", "java/io/Serializable"], methods: setMethods() });
for (const n of ["java/util/HashSet", "java/util/LinkedHashSet",
  "java/util/concurrent/CopyOnWriteArraySet", "java/util/EnumSet"]) {
  rt.register({
    name: n, ctor: class extends JSet {},
    sup: n === "java/util/LinkedHashSet" ? "java/util/HashSet" : "java/lang/Object",
    ifaces: ["java/util/Set", "java/util/Collection", "java/lang/Iterable", "java/util/SortedSet", "java/io/Serializable"],
    methods: n === "java/util/EnumSet" ? { ...setMethods(), ...enumSetStatics() } : setMethods(),
  });
}
function enumSetStatics() {
  const fromValues = async (cls: JObj, all: boolean, extra: unknown[]) => {
    const s = new JSet();
    if (all) {
      const info = (cls as { ci?: ClassInfo }).ci!;
      const p = rt.initClass(info); if (p) await p;
      const vs = (await vcall(info.ctor, "values", `()[L${info.name};`)) as unknown[];
      for (const v of vs) await addToSet(s, v);
    }
    for (const v of extra) await addToSet(s, v);
    return s;
  };
  return {
    "static allOf(Ljava/lang/Class;)Ljava/util/EnumSet;": (c: JObj) => fromValues(c, true, []),
    "static noneOf(Ljava/lang/Class;)Ljava/util/EnumSet;": (c: JObj) => fromValues(c, false, []),
    "static of(Ljava/lang/Enum;)Ljava/util/EnumSet;": (a: unknown) => fromValues(null!, false, [a]),
    "static of(Ljava/lang/Enum;Ljava/lang/Enum;)Ljava/util/EnumSet;": (a: unknown, b: unknown) => fromValues(null!, false, [a, b]),
    "static of(Ljava/lang/Enum;Ljava/lang/Enum;Ljava/lang/Enum;)Ljava/util/EnumSet;": (a: unknown, b: unknown, c: unknown) => fromValues(null!, false, [a, b, c]),
    "static copyOf(Ljava/util/Collection;)Ljava/util/EnumSet;": async (c: JObj) => fromValues(null!, false, await toJsArray(c)),
  };
}
// ── TreeMap / TreeSet: entries live sorted in the `slow` array of the hash
// family, so size/iteration/views/toString come from JMap/JSet unchanged and
// only the key lookups differ (binary search, O(log n) async comparisons).
class JTreeMap extends JMap { cmp: unknown = null; rev = false; }
class JTreeSet extends JSet { cmp: unknown = null; rev = false; }
type Sorted = JTreeMap | JTreeSet;
const UNB = Symbol("unbounded");

/** index of k, else ~insertionPoint */
async function bsearch(t: Sorted, k: unknown): Promise<number> {
  let lo = 0, hi = t.slow.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let c = await jcmp(t.cmp, t.slow[mid].k, k);
    if (t.rev) c = -c;
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1; else hi = mid;
  }
  return ~lo;
}
/** nearest index to k: mode -2 lower, -1 floor, 1 ceiling, 2 higher; -1 = none */
async function near(t: Sorted, k: unknown, mode: number): Promise<number> {
  const i = await bsearch(t, k);
  const j = i >= 0 ? i + (mode === 2 ? 1 : mode === -2 ? -1 : 0) : mode < 0 ? ~i - 1 : ~i;
  return j >= 0 && j < t.slow.length ? j : -1;
}
/** slice index for a range bound; `upper` = exclusive end of the range */
async function bound(t: Sorted, k: unknown, inc: boolean, upper: boolean): Promise<number> {
  const i = await bsearch(t, k);
  return i < 0 ? ~i : inc === upper ? i + 1 : i;
}
function sub<T extends Sorted>(t: T, ents: Ent[], rev = t.rev): T {
  const o = new (t.constructor as new () => T)();
  o.cmp = t.cmp; o.rev = rev; o.slow = ents;
  return o;
}
async function slice<T extends Sorted>(t: T, lo: unknown, loInc: boolean, hi: unknown, hiInc: boolean): Promise<T> {
  const a = lo === UNB ? 0 : await bound(t, lo, loInc, false);
  const b = hi === UNB ? t.slow.length : await bound(t, hi, hiInc, true);
  return sub(t, t.slow.slice(a, Math.max(a, b)));
}
function keysOf(t: JTreeMap, ents: Ent[], rev: boolean): JTreeSet {
  const s = new (rt.link("java/util/TreeSet").ctor as new () => JTreeSet)();
  s.cmp = t.cmp; s.rev = rev; s.slow = ents.map((e) => ({ k: e.k, v: e.k }));
  return s;
}
async function tadd(s: JTreeSet, v: unknown): Promise<number> {
  const i = await bsearch(s, v);
  if (i >= 0) return 0;
  s.slow.splice(~i, 0, { k: v, v });
  return 1;
}
function endOf(t: Sorted, last: boolean): Ent | null {
  return t.slow.length ? t.slow[last ? t.slow.length - 1 : 0] : null;
}

function treeMapMethods(): NativeSpec["methods"] {
  const at = (t: JTreeMap, i: number, key: boolean) => (i < 0 ? null : key ? t.slow[i].k : new JMapEntry(t.slow[i]));
  const nav = (mode: number, key: boolean) => async function (this: JTreeMap, k: unknown) {
    return at(this, await near(this, k, mode), key);
  };
  const end = (last: boolean, poll: boolean) => function (this: JTreeMap) {
    const e = endOf(this, last);
    if (e && poll) this.slow.splice(last ? this.slow.length - 1 : 0, 1);
    return e && new JMapEntry(e);
  };
  const endKey = (last: boolean) => function (this: JTreeMap) {
    const e = endOf(this, last);
    if (!e) throw rt.mkThrowable("java/util/NoSuchElementException", null);
    return e.k;
  };
  return {
    "<init>(Ljava/util/Comparator;)V": function (this: JTreeMap, c: unknown) { this.cmp = c; },
    "<init>(Ljava/util/Map;)V": async function (this: JTreeMap, m: unknown) { if (m) await copyMapInto(m, this); },
    "<init>(Ljava/util/SortedMap;)V": async function (this: JTreeMap, m: unknown) { if (m) await copyMapInto(m, this); },
    "comparator()Ljava/util/Comparator;": function (this: JTreeMap) { return this.cmp; },
    "get(Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JTreeMap, k: unknown) {
      const i = await bsearch(this, k); return i < 0 ? null : this.slow[i].v;
    },
    "containsKey(Ljava/lang/Object;)Z": async function (this: JTreeMap, k: unknown) {
      return (await bsearch(this, k)) < 0 ? 0 : 1;
    },
    "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JTreeMap, k: unknown, v: unknown) {
      const i = await bsearch(this, k);
      if (i >= 0) { const o = this.slow[i].v; this.slow[i].v = v; return o; }
      this.slow.splice(~i, 0, { k, v });
      return null;
    },
    "remove(Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JTreeMap, k: unknown) {
      const i = await bsearch(this, k); return i < 0 ? null : this.slow.splice(i, 1)[0].v;
    },
    "firstKey()Ljava/lang/Object;": endKey(false),
    "lastKey()Ljava/lang/Object;": endKey(true),
    "firstEntry()Ljava/util/Map$Entry;": end(false, false),
    "lastEntry()Ljava/util/Map$Entry;": end(true, false),
    "pollFirstEntry()Ljava/util/Map$Entry;": end(false, true),
    "pollLastEntry()Ljava/util/Map$Entry;": end(true, true),
    "lowerEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;": nav(-2, false),
    "floorEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;": nav(-1, false),
    "ceilingEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;": nav(1, false),
    "higherEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;": nav(2, false),
    "lowerKey(Ljava/lang/Object;)Ljava/lang/Object;": nav(-2, true),
    "floorKey(Ljava/lang/Object;)Ljava/lang/Object;": nav(-1, true),
    "ceilingKey(Ljava/lang/Object;)Ljava/lang/Object;": nav(1, true),
    "higherKey(Ljava/lang/Object;)Ljava/lang/Object;": nav(2, true),
    "headMap(Ljava/lang/Object;)Ljava/util/SortedMap;": function (this: JTreeMap, k: unknown) { return slice(this, UNB, false, k, false); },
    "headMap(Ljava/lang/Object;Z)Ljava/util/NavigableMap;": function (this: JTreeMap, k: unknown, inc: number) { return slice(this, UNB, false, k, !!inc); },
    "tailMap(Ljava/lang/Object;)Ljava/util/SortedMap;": function (this: JTreeMap, k: unknown) { return slice(this, k, true, UNB, false); },
    "tailMap(Ljava/lang/Object;Z)Ljava/util/NavigableMap;": function (this: JTreeMap, k: unknown, inc: number) { return slice(this, k, !!inc, UNB, false); },
    "subMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedMap;": function (this: JTreeMap, a: unknown, b: unknown) { return slice(this, a, true, b, false); },
    "subMap(Ljava/lang/Object;ZLjava/lang/Object;Z)Ljava/util/NavigableMap;": function (this: JTreeMap, a: unknown, ai: number, b: unknown, bi: number) { return slice(this, a, !!ai, b, !!bi); },
    "descendingMap()Ljava/util/NavigableMap;": function (this: JTreeMap) { return sub(this, this.slow.slice().reverse(), !this.rev); },
    "descendingKeySet()Ljava/util/NavigableSet;": function (this: JTreeMap) { return keysOf(this, this.slow.slice().reverse(), !this.rev); },
    "navigableKeySet()Ljava/util/NavigableSet;": function (this: JTreeMap) { return keysOf(this, this.slow, this.rev); },
  };
}
function treeSetMethods(): NativeSpec["methods"] {
  const nav = (mode: number) => async function (this: JTreeSet, v: unknown) {
    const i = await near(this, v, mode); return i < 0 ? null : this.slow[i].k;
  };
  const poll = (last: boolean) => function (this: JTreeSet) {
    return this.slow.length ? this.slow.splice(last ? this.slow.length - 1 : 0, 1)[0].k : null;
  };
  return {
    "<init>(Ljava/util/Comparator;)V": function (this: JTreeSet, c: unknown) { this.cmp = c; },
    "<init>(Ljava/util/Collection;)V": async function (this: JTreeSet, c: unknown) {
      for (const v of await toJsArray(c)) await tadd(this, v);
    },
    "comparator()Ljava/util/Comparator;": function (this: JTreeSet) { return this.cmp; },
    "add(Ljava/lang/Object;)Z": function (this: JTreeSet, v: unknown) { return tadd(this, v); },
    "remove(Ljava/lang/Object;)Z": async function (this: JTreeSet, v: unknown) {
      const i = await bsearch(this, v); return i < 0 ? 0 : (this.slow.splice(i, 1), 1);
    },
    "contains(Ljava/lang/Object;)Z": async function (this: JTreeSet, v: unknown) {
      return (await bsearch(this, v)) < 0 ? 0 : 1;
    },
    "lower(Ljava/lang/Object;)Ljava/lang/Object;": nav(-2),
    "floor(Ljava/lang/Object;)Ljava/lang/Object;": nav(-1),
    "ceiling(Ljava/lang/Object;)Ljava/lang/Object;": nav(1),
    "higher(Ljava/lang/Object;)Ljava/lang/Object;": nav(2),
    "pollFirst()Ljava/lang/Object;": poll(false),
    "pollLast()Ljava/lang/Object;": poll(true),
    "headSet(Ljava/lang/Object;)Ljava/util/SortedSet;": function (this: JTreeSet, k: unknown) { return slice(this, UNB, false, k, false); },
    "headSet(Ljava/lang/Object;Z)Ljava/util/NavigableSet;": function (this: JTreeSet, k: unknown, inc: number) { return slice(this, UNB, false, k, !!inc); },
    "tailSet(Ljava/lang/Object;)Ljava/util/SortedSet;": function (this: JTreeSet, k: unknown) { return slice(this, k, true, UNB, false); },
    "tailSet(Ljava/lang/Object;Z)Ljava/util/NavigableSet;": function (this: JTreeSet, k: unknown, inc: number) { return slice(this, k, !!inc, UNB, false); },
    "subSet(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedSet;": function (this: JTreeSet, a: unknown, b: unknown) { return slice(this, a, true, b, false); },
    "subSet(Ljava/lang/Object;ZLjava/lang/Object;Z)Ljava/util/NavigableSet;": function (this: JTreeSet, a: unknown, ai: number, b: unknown, bi: number) { return slice(this, a, !!ai, b, !!bi); },
    "descendingSet()Ljava/util/NavigableSet;": function (this: JTreeSet) { return sub(this, this.slow.slice().reverse(), !this.rev); },
    "descendingIterator()Ljava/util/Iterator;": function (this: JTreeSet) { return mkIter(this.slow.map((e) => e.k).reverse()); },
  };
}
for (const n of ["java/util/TreeMap", "java/util/concurrent/ConcurrentSkipListMap"]) {
  rt.register({
    name: n, ctor: class extends JTreeMap {},
    ifaces: ["java/util/NavigableMap", "java/util/concurrent/ConcurrentMap", "java/lang/Cloneable", "java/io/Serializable"],
    methods: { ...mapMethods(), ...treeMapMethods() },
  });
}
for (const n of ["java/util/TreeSet", "java/util/concurrent/ConcurrentSkipListSet"]) {
  rt.register({
    name: n, ctor: class extends JTreeSet {},
    ifaces: ["java/util/NavigableSet", "java/lang/Cloneable", "java/io/Serializable"],
    methods: { ...setMethods(), ...treeSetMethods() },
  });
}

export class JPriorityQueue extends JList { cmp: unknown = null; }
/** keep the backing array sorted ascending so poll() takes the head (stable after equal keys) */
export async function pqInsert(q: JPriorityQueue, v: unknown) {
  if (v == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  // the comparator may suspend, and another thread's take()/offer() can move the array under
  // it (Java holds a lock here): search a snapshot and only splice if the live array still is it
  for (;;) {
    const snap = q.a.slice();
    let lo = 0, hi = snap.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((await jcmp(q.cmp, snap[mid], v)) <= 0) lo = mid + 1; else hi = mid;
    }
    if (q.a.length === snap.length && (snap.length === 0 || (q.a[0] === snap[0] && q.a[snap.length - 1] === snap[snap.length - 1]))) {
      q.a.splice(lo, 0, v);
      return;
    }
  }
}
export const priorityQueueMethods = (): NonNullable<NativeSpec["methods"]> => ({
  ...listMethods(),
  "<init>()V": function () {},
  "<init>(I)V": function () {},
  "<init>(ILjava/util/Comparator;)V": function (this: JPriorityQueue, _n: number, c: unknown) { this.cmp = c; },
  "<init>(Ljava/util/Comparator;)V": function (this: JPriorityQueue, c: unknown) { this.cmp = c; },
  "<init>(Ljava/util/Collection;)V": async function (this: JPriorityQueue, c: unknown) { for (const v of await toJsArray(c)) await pqInsert(this, v); },
  "offer(Ljava/lang/Object;)Z": async function (this: JPriorityQueue, v: unknown) { await pqInsert(this, v); return 1; },
  "add(Ljava/lang/Object;)Z": async function (this: JPriorityQueue, v: unknown) { await pqInsert(this, v); return 1; },
  "poll()Ljava/lang/Object;": function (this: JPriorityQueue) { return this.a.length ? this.a.shift()! : null; },
  "remove()Ljava/lang/Object;": function (this: JPriorityQueue) { if (!this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null); return this.a.shift()!; },
  "peek()Ljava/lang/Object;": function (this: JPriorityQueue) { return this.a.length ? this.a[0] : null; },
  "element()Ljava/lang/Object;": function (this: JPriorityQueue) { if (!this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null); return this.a[0]; },
  "comparator()Ljava/util/Comparator;": function (this: JPriorityQueue) { return this.cmp; },
});
rt.register({
  name: "java/util/PriorityQueue", ctor: JPriorityQueue,
  ifaces: ["java/util/Queue", "java/util/Collection", "java/lang/Iterable", "java/io/Serializable"],
  methods: priorityQueueMethods(),
});
rt.register({
  name: "java/util/concurrent/CopyOnWriteArrayList", ctor: class extends JList {},
  ifaces: ["java/util/List", "java/util/Collection", "java/lang/Iterable"],
  methods: listMethods(),
});

// ── BitSet: 32-bit words (Java's are 64-bit, which only shows in size()/hashCode, handled)
class JBitSet extends JObj { w: Int32Array = new Int32Array(2); }
function bsGrow(b: JBitSet, words: number) {
  if (words <= b.w.length) return;
  const n = new Int32Array(Math.max(words, b.w.length * 2));
  n.set(b.w);
  b.w = n;
}
function bsCheck(i: number, to = i) {
  if (i < 0 || to < i) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", to === i ? `bitIndex < 0: ${i}` : `fromIndex: ${i}, toIndex: ${to}`);
}
/** apply `op(word, mask)` over [from, to) — Java's WORD_MASK << from / >>> -to split */
function bsRange(b: JBitSet, from: number, to: number, op: (w: number, m: number) => number) {
  const fw = from >>> 5, lw = (to - 1) >>> 5, fm = -1 << (from & 31), lm = -1 >>> (-to & 31);
  if (fw === lw) { b.w[fw] = op(b.w[fw], fm & lm); return; }
  b.w[fw] = op(b.w[fw], fm);
  for (let i = fw + 1; i < lw; i++) b.w[i] = op(b.w[i], -1);
  b.w[lw] = op(b.w[lw], lm);
}
const bsOr = (w: number, m: number) => w | m, bsClr = (w: number, m: number) => w & ~m, bsXor = (w: number, m: number) => w ^ m;
/** highest set bit + 1 */
function bsLength(b: JBitSet): number {
  for (let i = b.w.length - 1; i >= 0; i--) if (b.w[i]) return i * 32 + 32 - Math.clz32(b.w[i]);
  return 0;
}
function bsLong(b: JBitSet, i: number): bigint {
  const lo = b.w[2 * i] >>> 0, hi = 2 * i + 1 < b.w.length ? b.w[2 * i + 1] >>> 0 : 0;
  return BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo));
}
function bsFromWords(w: Int32Array): JBitSet { const b = new JBitSet(); b.w = w; return b; }
function bsSet(this: JBitSet, i: number) { bsCheck(i); bsGrow(this, (i >>> 5) + 1); this.w[i >>> 5] |= 1 << (i & 31); }
function bsClear(this: JBitSet, i: number) { bsCheck(i); if (i >>> 5 < this.w.length) this.w[i >>> 5] &= ~(1 << (i & 31)); }
function bsSetRange(this: JBitSet, from: number, to: number) {
  bsCheck(from, to);
  if (from === to) return;
  bsGrow(this, ((to - 1) >>> 5) + 1);
  bsRange(this, from, to, bsOr);
}
function bsClearRange(this: JBitSet, from: number, to: number) {
  bsCheck(from, to);
  to = Math.min(to, this.w.length * 32);
  if (from < to) bsRange(this, from, to, bsClr);
}
function bsBinary(f: (a: number, b: number) => number, grow: boolean) {
  return function (this: JBitSet, o: JBitSet) {
    if (grow) bsGrow(this, o.w.length);
    const n = Math.min(this.w.length, o.w.length);
    for (let i = 0; i < n; i++) this.w[i] = f(this.w[i], o.w[i]);
    if (!grow) for (let i = n; i < this.w.length; i++) this.w[i] = f(this.w[i], 0);
  };
}
rt.register({
  name: "java/util/BitSet", ctor: JBitSet, ifaces: ["java/lang/Cloneable", "java/io/Serializable"],
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JBitSet, n: number) {
      if (n < 0) throw rt.mkThrowable("java/lang/NegativeArraySizeException", `nbits < 0: ${n}`);
      this.w = new Int32Array(Math.max(1, (n + 31) >>> 5));
    },
    "set(I)V": bsSet,
    "set(IZ)V": function (this: JBitSet, i: number, v: number) { (v ? bsSet : bsClear).call(this, i); },
    "set(II)V": bsSetRange,
    "set(IIZ)V": function (this: JBitSet, from: number, to: number, v: number) { (v ? bsSetRange : bsClearRange).call(this, from, to); },
    "get(I)Z": function (this: JBitSet, i: number) {
      bsCheck(i);
      const wi = i >>> 5;
      return wi < this.w.length ? (this.w[wi] >>> (i & 31)) & 1 : 0;
    },
    "clear(I)V": bsClear,
    "clear(II)V": bsClearRange,
    "clear()V": function (this: JBitSet) { this.w.fill(0); },
    "flip(I)V": function (this: JBitSet, i: number) { bsCheck(i); bsGrow(this, (i >>> 5) + 1); this.w[i >>> 5] ^= 1 << (i & 31); },
    "flip(II)V": function (this: JBitSet, from: number, to: number) {
      bsCheck(from, to);
      if (from === to) return;
      bsGrow(this, ((to - 1) >>> 5) + 1);
      bsRange(this, from, to, bsXor);
    },
    "isEmpty()Z": function (this: JBitSet) { return bsLength(this) === 0 ? 1 : 0; },
    "cardinality()I": function (this: JBitSet) {
      let n = 0;
      for (let i = 0; i < this.w.length; i++) {
        let v = this.w[i];
        v -= (v >>> 1) & 0x55555555;
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        n += Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
      }
      return n;
    },
    "nextSetBit(I)I": function (this: JBitSet, from: number) {
      bsCheck(from);
      let wi = from >>> 5;
      if (wi >= this.w.length) return -1;
      let word = this.w[wi] & (-1 << (from & 31));
      for (;;) {
        if (word) return wi * 32 + 31 - Math.clz32(word & -word);
        if (++wi === this.w.length) return -1;
        word = this.w[wi];
      }
    },
    "nextClearBit(I)I": function (this: JBitSet, from: number) {
      bsCheck(from);
      let wi = from >>> 5;
      if (wi >= this.w.length) return from;
      let word = ~this.w[wi] & (-1 << (from & 31));
      for (;;) {
        if (word) return wi * 32 + 31 - Math.clz32(word & -word);
        if (++wi === this.w.length) return wi * 32;
        word = ~this.w[wi];
      }
    },
    "previousSetBit(I)I": function (this: JBitSet, from: number) {
      if (from < 0) { if (from === -1) return -1; bsCheck(from); }
      let wi = from >>> 5;
      if (wi >= this.w.length) return bsLength(this) - 1;
      let word = this.w[wi] & (-1 >>> (-(from + 1) & 31));
      for (;;) {
        if (word) return wi * 32 + 31 - Math.clz32(word);
        if (wi-- === 0) return -1;
        word = this.w[wi];
      }
    },
    "length()I": function (this: JBitSet) { return bsLength(this); },
    "size()I": function (this: JBitSet) { return this.w.length * 32; },
    "and(Ljava/util/BitSet;)V": bsBinary((a, b) => a & b, false),
    "or(Ljava/util/BitSet;)V": bsBinary((a, b) => a | b, true),
    "xor(Ljava/util/BitSet;)V": bsBinary((a, b) => a ^ b, true),
    "andNot(Ljava/util/BitSet;)V": bsBinary((a, b) => a & ~b, false),
    "intersects(Ljava/util/BitSet;)Z": function (this: JBitSet, o: JBitSet) {
      for (let i = Math.min(this.w.length, o.w.length) - 1; i >= 0; i--) if (this.w[i] & o.w[i]) return 1;
      return 0;
    },
    "static valueOf([B)Ljava/util/BitSet;": (bytes: Int8Array) => {
      const w = new Int32Array(Math.max(1, (bytes.length + 3) >>> 2));
      for (let i = 0; i < bytes.length; i++) w[i >>> 2] |= (bytes[i] & 0xff) << ((i & 3) * 8);
      return bsFromWords(w);
    },
    "static valueOf([J)Ljava/util/BitSet;": (longs: BigInt64Array) => {
      const w = new Int32Array(Math.max(1, longs.length * 2));
      for (let i = 0; i < longs.length; i++) {
        w[2 * i] = Number(BigInt.asIntN(32, longs[i]));
        w[2 * i + 1] = Number(BigInt.asIntN(32, longs[i] >> 32n));
      }
      return bsFromWords(w);
    },
    "toByteArray()[B": function (this: JBitSet) {
      const out = new Int8Array((bsLength(this) + 7) >>> 3);
      for (let i = 0; i < out.length; i++) out[i] = this.w[i >>> 2] >>> ((i & 3) * 8);
      return out;
    },
    "toLongArray()[J": function (this: JBitSet) {
      const out = new BigInt64Array((bsLength(this) + 63) >>> 6);
      for (let i = 0; i < out.length; i++) out[i] = bsLong(this, i);
      return out;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JBitSet, o: unknown) {
      if (!(o instanceof JBitSet)) return 0;
      const n = Math.max(this.w.length, o.w.length);
      for (let i = 0; i < n; i++) if ((this.w[i] ?? 0) !== (o.w[i] ?? 0)) return 0;
      return 1;
    },
    "hashCode()I": function (this: JBitSet) {
      let h = 1234n;
      for (let i = (bsLength(this) + 63) >>> 6; --i >= 0;) h ^= BigInt.asIntN(64, bsLong(this, i) * BigInt(i + 1));
      return Number(BigInt.asIntN(32, (h >> 32n) ^ h));
    },
    "toString()Ljava/lang/String;": function (this: JBitSet) {
      const parts: number[] = [];
      for (let i = 0; i < this.w.length; i++) for (let v = this.w[i]; v; v &= v - 1) parts.push(i * 32 + 31 - Math.clz32(v & -v));
      return `{${parts.join(", ")}}`;
    },
    "clone()Ljava/lang/Object;": function (this: JBitSet) { return bsFromWords(this.w.slice()); },
  },
});

// AbstractList carries a REAL modCount: apps extending it (and overriding
// add/remove/set) increment `this.modCount` themselves via ordinary iput
// bytecode — the field just has to be a live property (see `fields:` below)
// wired to the fail-fast iterator this class hands out by default.
// native inheritance is JS inheritance: the bases below must extend each other's ctors
class JAbstractCollection extends JObj {}
class JAbstractList extends JAbstractCollection { modCount = 0; }
class JAbstractSet extends JAbstractCollection {}

// JDK AbstractList.ListItr: every step is a virtual get/set/add/remove on the list, so an app's
// overrides are what the iterator sees and writes through to (a snapshot would drop set/add).
class JAbsListIter extends JObj {
  cursor = 0; lastRet = -1; expectedMod: number;
  constructor(public list: JAbstractList, at: number) { super(); this.cursor = at; this.expectedMod = list.modCount; }
  check() { if (this.list.modCount !== this.expectedMod) throw rt.mkThrowable("java/util/ConcurrentModificationException", null); }
}
const size = (o: unknown): Promise<number> => vcall(o, "size", "()I");
const getAt = (o: unknown, i: number): Promise<unknown> => vcall(o, "get", "(I)Ljava/lang/Object;", i);
const iterOf = (o: unknown): Promise<unknown> => vcall(o, "iterator", "()Ljava/util/Iterator;");
const aeq = async (a: unknown, b: unknown) => { const r = jeq(a, b); return (r instanceof Promise ? await r : r) !== 0; };
const uoe = (): never => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", null); };
rt.register({
  name: "webdroid/AbstractListIter", ctor: JAbsListIter, ifaces: ["java/util/Iterator", "java/util/ListIterator"],
  methods: {
    "hasNext()Z": async function (this: JAbsListIter) { return this.cursor !== (await size(this.list)) ? 1 : 0; },
    "next()Ljava/lang/Object;": async function (this: JAbsListIter) {
      this.check();
      const i = this.cursor;
      if (i >= (await size(this.list))) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      const v = await getAt(this.list, i);
      this.lastRet = i;
      this.cursor = i + 1;
      return v;
    },
    "hasPrevious()Z": function (this: JAbsListIter) { return this.cursor !== 0 ? 1 : 0; },
    "previous()Ljava/lang/Object;": async function (this: JAbsListIter) {
      this.check();
      const i = this.cursor - 1;
      if (i < 0) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      const v = await getAt(this.list, i);
      this.lastRet = this.cursor = i;
      return v;
    },
    "nextIndex()I": function (this: JAbsListIter) { return this.cursor; },
    "previousIndex()I": function (this: JAbsListIter) { return this.cursor - 1; },
    "remove()V": async function (this: JAbsListIter) {
      if (this.lastRet < 0) throw rt.mkThrowable("java/lang/IllegalStateException", null);
      this.check();
      await vcall(this.list, "remove", "(I)Ljava/lang/Object;", this.lastRet);
      if (this.lastRet < this.cursor) this.cursor--;
      this.lastRet = -1;
      this.expectedMod = this.list.modCount;
    },
    "set(Ljava/lang/Object;)V": async function (this: JAbsListIter, v: unknown) {
      if (this.lastRet < 0) throw rt.mkThrowable("java/lang/IllegalStateException", null);
      this.check();
      await vcall(this.list, "set", "(ILjava/lang/Object;)Ljava/lang/Object;", this.lastRet, v);
      this.expectedMod = this.list.modCount;
    },
    "add(Ljava/lang/Object;)V": async function (this: JAbsListIter, v: unknown) {
      this.check();
      await vcall(this.list, "add", "(ILjava/lang/Object;)V", this.cursor++, v);
      this.lastRet = -1;
      this.expectedMod = this.list.modCount;
    },
  },
});
// JDK AbstractList.SubList: a live window whose every operation is an offset virtual call on the parent.
class JAbsSubList extends JAbstractList { parent!: JAbstractList; off = 0; n = 0; }
rt.register({
  name: "webdroid/AbstractSubList", ctor: JAbsSubList, sup: "java/util/AbstractList",
  methods: {
    "size()I": function (this: JAbsSubList) { return this.n; },
    "get(I)Ljava/lang/Object;": function (this: JAbsSubList, i: number) {
      if (i < 0 || i >= this.n) ioobe(i, this.n);
      return getAt(this.parent, this.off + i);
    },
    "set(ILjava/lang/Object;)Ljava/lang/Object;": function (this: JAbsSubList, i: number, v: unknown) {
      if (i < 0 || i >= this.n) ioobe(i, this.n);
      return vcall(this.parent, "set", "(ILjava/lang/Object;)Ljava/lang/Object;", this.off + i, v);
    },
    "add(ILjava/lang/Object;)V": async function (this: JAbsSubList, i: number, v: unknown) {
      if (i < 0 || i > this.n) ioobe(i, this.n);
      await vcall(this.parent, "add", "(ILjava/lang/Object;)V", this.off + i, v);
      this.n++;
      this.modCount = this.parent.modCount;
    },
    "remove(I)Ljava/lang/Object;": async function (this: JAbsSubList, i: number) {
      if (i < 0 || i >= this.n) ioobe(i, this.n);
      const v = await vcall(this.parent, "remove", "(I)Ljava/lang/Object;", this.off + i);
      this.n--;
      this.modCount = this.parent.modCount;
      return v;
    },
  },
});

// abstract bases apps extend: the JDK's default bodies, each a virtual call on `this`
const absCollection: Methods = {
  "<init>()V": function () {},
  "isEmpty()Z": async function (this: JObj) { return (await size(this)) === 0 ? 1 : 0; },
  "add(Ljava/lang/Object;)Z": uoe,
  "contains(Ljava/lang/Object;)Z": async function (this: JObj, o: unknown) {
    for (const x of await toJsArray(this)) if (await aeq(x, o)) return 1;
    return 0;
  },
  "containsAll(Ljava/util/Collection;)Z": async function (this: JObj, c: unknown) {
    for (const x of await toJsArray(c)) if (!(await vcall(this, "contains", "(Ljava/lang/Object;)Z", x))) return 0;
    return 1;
  },
  "addAll(Ljava/util/Collection;)Z": async function (this: JObj, c: unknown) {
    let ch = 0;
    for (const x of (await toJsArray(c)).slice()) if (await vcall(this, "add", "(Ljava/lang/Object;)Z", x)) ch = 1;
    return ch;
  },
  "remove(Ljava/lang/Object;)Z": async function (this: JObj, o: unknown) {
    const it = await iterOf(this);
    while (await vcall(it, "hasNext", "()Z")) {
      if (await aeq(await vcall(it, "next", "()Ljava/lang/Object;"), o)) { await vcall(it, "remove", "()V"); return 1; }
    }
    return 0;
  },
  "removeAll(Ljava/util/Collection;)Z": async function (this: JObj, c: unknown) { return bulkRemove(this, c, true); },
  "retainAll(Ljava/util/Collection;)Z": async function (this: JObj, c: unknown) { return bulkRemove(this, c, false); },
  "clear()V": async function (this: JObj) {
    const it = await iterOf(this);
    while (await vcall(it, "hasNext", "()Z")) { await vcall(it, "next", "()Ljava/lang/Object;"); await vcall(it, "remove", "()V"); }
  },
  "toArray()[Ljava/lang/Object;": async function (this: JObj) { return jarray((await toJsArray(this)).slice()); },
  "toArray([Ljava/lang/Object;)[Ljava/lang/Object;": async function (this: JObj, out: unknown[]) {
    return fillToArray(await toJsArray(this), out);
  },
  "toString()Ljava/lang/String;": async function (this: JObj) {
    const parts: string[] = [];
    for (const x of await toJsArray(this)) {
      parts.push(x === this ? "(this Collection)" : x === null ? "null" : String(await vcall(x, "toString", "()Ljava/lang/String;")));
    }
    return "[" + parts.join(", ") + "]";
  },
};
async function bulkRemove(self: unknown, c: unknown, when: boolean): Promise<number> {
  let ch = 0;
  const it = await iterOf(self);
  while (await vcall(it, "hasNext", "()Z")) {
    const x = await vcall(it, "next", "()Ljava/lang/Object;");
    if ((await vcall(c, "contains", "(Ljava/lang/Object;)Z", x)) !== 0 === when) { await vcall(it, "remove", "()V"); ch = 1; }
  }
  return ch;
}
const absList: Methods = {
  "add(Ljava/lang/Object;)Z": async function (this: JAbstractList, v: unknown) {
    await vcall(this, "add", "(ILjava/lang/Object;)V", await size(this), v);
    return 1;
  },
  "add(ILjava/lang/Object;)V": uoe,
  "set(ILjava/lang/Object;)Ljava/lang/Object;": uoe,
  "remove(I)Ljava/lang/Object;": uoe,
  "addAll(ILjava/util/Collection;)Z": async function (this: JAbstractList, at: number, c: unknown) {
    let ch = 0;
    for (const x of (await toJsArray(c)).slice()) { await vcall(this, "add", "(ILjava/lang/Object;)V", at++, x); ch = 1; }
    return ch;
  },
  "clear()V": async function (this: JAbstractList) { await vcall(this, "removeRange", "(II)V", 0, await size(this)); },
  "removeRange(II)V": async function (this: JAbstractList, from: number, to: number) {
    const it = await vcall(this, "listIterator", "(I)Ljava/util/ListIterator;", from);
    for (let i = 0; i < to - from; i++) { await vcall(it, "next", "()Ljava/lang/Object;"); await vcall(it, "remove", "()V"); }
  },
  "indexOf(Ljava/lang/Object;)I": async function (this: JAbstractList, o: unknown) {
    const it = await vcall(this, "listIterator", "()Ljava/util/ListIterator;");
    while (await vcall(it, "hasNext", "()Z")) {
      if (await aeq(await vcall(it, "next", "()Ljava/lang/Object;"), o)) return vcall(it, "previousIndex", "()I");
    }
    return -1;
  },
  "lastIndexOf(Ljava/lang/Object;)I": async function (this: JAbstractList, o: unknown) {
    const it = await vcall(this, "listIterator", "(I)Ljava/util/ListIterator;", await size(this));
    while (await vcall(it, "hasPrevious", "()Z")) {
      if (await aeq(await vcall(it, "previous", "()Ljava/lang/Object;"), o)) return vcall(it, "nextIndex", "()I");
    }
    return -1;
  },
  "iterator()Ljava/util/Iterator;": function (this: JAbstractList) { return new JAbsListIter(this, 0); },
  "listIterator()Ljava/util/ListIterator;": function (this: JAbstractList) { return new JAbsListIter(this, 0); },
  "listIterator(I)Ljava/util/ListIterator;": async function (this: JAbstractList, at: number) {
    const n = await size(this);
    if (at < 0 || at > n) ioobe(at, n);
    return new JAbsListIter(this, at);
  },
  "subList(II)Ljava/util/List;": async function (this: JAbstractList, from: number, to: number) {
    const n = await size(this);
    if (from < 0 || to > n || from > to) ioobe(from < 0 ? from : to, n);
    const s = new JAbsSubList();
    s.parent = this; s.off = from; s.n = to - from; s.modCount = this.modCount;
    return s;
  },
  "equals(Ljava/lang/Object;)Z": async function (this: JAbstractList, o: unknown) {
    if (o === this) return 1;
    if (!(o instanceof JObj) || !rt.iof(o, "java/util/List")) return 0;
    const a = await toJsArray(this), b = await toJsArray(o);
    if (a.length !== b.length) return 0;
    for (let i = 0; i < a.length; i++) if (!(await aeq(a[i], b[i]))) return 0;
    return 1;
  },
  "hashCode()I": async function (this: JAbstractList) {
    let h = 1;
    for (const x of await toJsArray(this)) { const r = jhash(x); h = (31 * h + (r instanceof Promise ? await r : r)) | 0; }
    return h;
  },
};
const absSet: Methods = {
  "equals(Ljava/lang/Object;)Z": async function (this: JObj, o: unknown) {
    if (o === this) return 1;
    if (!(o instanceof JObj) || !rt.iof(o, "java/util/Set")) return 0;
    if ((await size(o)) !== (await size(this))) return 0;
    return vcall(this, "containsAll", "(Ljava/util/Collection;)Z", o);
  },
  "hashCode()I": async function (this: JObj) {
    let h = 0;
    for (const x of await toJsArray(this)) { const r = jhash(x); h = (h + (r instanceof Promise ? await r : r)) | 0; }
    return h;
  },
  "removeAll(Ljava/util/Collection;)Z": async function (this: JObj, c: unknown) {
    let ch = 0;
    if ((await size(this)) > (await size(c))) {
      for (const x of (await toJsArray(c)).slice()) if (await vcall(this, "remove", "(Ljava/lang/Object;)Z", x)) ch = 1;
      return ch;
    }
    return bulkRemove(this, c, true);
  },
};
async function mapEntries(m: unknown): Promise<unknown[]> { return toJsArray(await vcall(m, "entrySet", "()Ljava/util/Set;")); }
const entryKey = (e: unknown) => vcall(e, "getKey", "()Ljava/lang/Object;");
const entryVal = (e: unknown) => vcall(e, "getValue", "()Ljava/lang/Object;");
async function findEntry(m: unknown, k: unknown): Promise<unknown> {
  for (const e of await mapEntries(m)) if (await aeq(await entryKey(e), k)) return e;
  return null;
}
const absMap: Methods = {
  "<init>()V": function () {},
  "size()I": async function (this: JObj) { return size(await vcall(this, "entrySet", "()Ljava/util/Set;")); },
  "isEmpty()Z": async function (this: JObj) { return (await size(this)) === 0 ? 1 : 0; },
  "get(Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JObj, k: unknown) {
    const e = await findEntry(this, k);
    return e ? entryVal(e) : null;
  },
  "getOrDefault(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JObj, k: unknown, d: unknown) {
    const e = await findEntry(this, k);
    return e ? entryVal(e) : d;
  },
  "containsKey(Ljava/lang/Object;)Z": async function (this: JObj, k: unknown) { return (await findEntry(this, k)) ? 1 : 0; },
  "containsValue(Ljava/lang/Object;)Z": async function (this: JObj, v: unknown) {
    for (const e of await mapEntries(this)) if (await aeq(await entryVal(e), v)) return 1;
    return 0;
  },
  "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": uoe,
  "putAll(Ljava/util/Map;)V": async function (this: JObj, m: unknown) {
    for (const e of await mapEntries(m)) {
      await vcall(this, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", await entryKey(e), await entryVal(e));
    }
  },
  "remove(Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JObj, k: unknown) {
    const it = await iterOf(await vcall(this, "entrySet", "()Ljava/util/Set;"));
    while (await vcall(it, "hasNext", "()Z")) {
      const e = await vcall(it, "next", "()Ljava/lang/Object;");
      if (await aeq(await entryKey(e), k)) { const v = await entryVal(e); await vcall(it, "remove", "()V"); return v; }
    }
    return null;
  },
  "clear()V": async function (this: JObj) { await vcall(await vcall(this, "entrySet", "()Ljava/util/Set;"), "clear", "()V"); },
  "keySet()Ljava/util/Set;": async function (this: JObj) {
    const out: unknown[] = [];
    for (const e of await mapEntries(this)) out.push(await entryKey(e));
    return newLinkedHashSet(out);
  },
  "values()Ljava/util/Collection;": async function (this: JObj) {
    const out: unknown[] = [];
    for (const e of await mapEntries(this)) out.push(await entryVal(e));
    return newArrayList(out);
  },
  "equals(Ljava/lang/Object;)Z": async function (this: JObj, o: unknown) {
    if (o === this) return 1;
    if (!(o instanceof JObj) || !rt.iof(o, "java/util/Map")) return 0;
    if ((await size(o)) !== (await size(this))) return 0;
    for (const e of await mapEntries(this)) {
      const k = await entryKey(e), v = await entryVal(e);
      if (v === null) {
        if (!(await vcall(o, "containsKey", "(Ljava/lang/Object;)Z", k)) || (await vcall(o, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", k)) !== null) return 0;
      } else if (!(await aeq(v, await vcall(o, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", k)))) return 0;
    }
    return 1;
  },
  "hashCode()I": async function (this: JObj) {
    let h = 0;
    for (const e of await mapEntries(this)) { const r = jhash(e); h = (h + (r instanceof Promise ? await r : r)) | 0; }
    return h;
  },
  "toString()Ljava/lang/String;": async function (this: JObj) {
    const s = async (x: unknown) => (x === this ? "(this Map)" : x === null ? "null" : String(await vcall(x, "toString", "()Ljava/lang/String;")));
    const parts: string[] = [];
    for (const e of await mapEntries(this)) parts.push(`${await s(await entryKey(e))}=${await s(await entryVal(e))}`);
    return "{" + parts.join(", ") + "}";
  },
};
rt.register({
  name: "java/util/AbstractCollection", ctor: JAbstractCollection,
  ifaces: ["java/util/Collection", "java/lang/Iterable"], methods: absCollection,
});
rt.register({
  name: "java/util/AbstractList", ctor: JAbstractList, sup: "java/util/AbstractCollection",
  ifaces: ["java/util/List"], fields: { modCount: "modCount" }, methods: absList,
});
rt.register({
  name: "java/util/AbstractSet", ctor: JAbstractSet, sup: "java/util/AbstractCollection",
  ifaces: ["java/util/Set"], methods: absSet,
});
rt.register({ name: "java/util/AbstractMap", ctor: class extends JObj {}, ifaces: ["java/util/Map"], methods: absMap });

// collection interfaces as markers — with their real extends-hierarchy so
// check-cast/instanceof through superinterfaces works (dex classes implementing
// java/util/Set must satisfy casts to java/util/Collection)
rt.register({ name: "java/util/Collection", ctor: class extends JObj {}, ifaces: ["java/lang/Iterable"] });
rt.register({ name: "java/util/List", ctor: class extends JObj {}, ifaces: ["java/util/Collection"] });
rt.register({ name: "java/util/Set", ctor: class extends JObj {}, ifaces: ["java/util/Collection"] });
rt.register({ name: "java/util/Queue", ctor: class extends JObj {}, ifaces: ["java/util/Collection"] });
rt.register({ name: "java/util/Deque", ctor: class extends JObj {}, ifaces: ["java/util/Queue"] });
rt.register({ name: "java/util/SortedSet", ctor: class extends JObj {}, ifaces: ["java/util/Set"] });
rt.register({ name: "java/util/NavigableSet", ctor: class extends JObj {}, ifaces: ["java/util/SortedSet"] });
rt.register({ name: "java/util/SortedMap", ctor: class extends JObj {}, ifaces: ["java/util/Map"] });
rt.register({ name: "java/util/NavigableMap", ctor: class extends JObj {}, ifaces: ["java/util/SortedMap"] });
rt.register({ name: "java/util/concurrent/ConcurrentMap", ctor: class extends JObj {}, ifaces: ["java/util/Map"] });
for (const i of ["java/util/Map", "java/util/RandomAccess", "java/util/Iterator",
  "java/util/Comparator", "java/util/Enumeration"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}
rt.register({ name: "java/util/ListIterator", ctor: class extends JObj {}, ifaces: ["java/util/Iterator"] });

// java.util.function.* — single-abstract-method interfaces. No dispatch logic
// lives here (same as java/lang/Runnable): a lambda/class implementing one
// compiles its own real method (get/apply/accept/test/...), so callers just
// vcall() the selector by name. Only the marker registration is needed.
rt.register({ name: "java/util/function/Supplier", ctor: class extends JObj {} });

// ── Arrays / Collections / Objects statics
class JArrays extends JObj {}
class JArraysList extends JList {}
rt.register({
  name: "webdroid/ArraysList", ctor: JArraysList,
  ifaces: ["java/util/List", "java/util/Collection", "java/lang/Iterable", "java/util/RandomAccess"],
  methods: listMethods(),
});
rt.register({
  name: "java/util/Arrays", ctor: JArrays,
  methods: {
    "static asList([Ljava/lang/Object;)Ljava/util/List;": (arr: unknown[]) => {
      const l = new JArraysList(); l.a = arr; return l;
    },
    "static sort([I)V": taSort,
    "static sort([J)V": taSort,
    "static sort([F)V": taSort,
    "static sort([D)V": taSort,
    "static sort([III)V": taSort,
    "static sort([JII)V": taSort,
    "static sort([FII)V": taSort,
    "static sort([Ljava/lang/Object;)V": (a: unknown[]) => sortInPlace(a, null),
    "static sort([Ljava/lang/Object;Ljava/util/Comparator;)V": (a: unknown[], cmp: unknown) => sortInPlace(a, cmp),
    "static sort([Ljava/lang/Object;IILjava/util/Comparator;)V": (a: unknown[], from: number, to: number, cmp: unknown) => sortInPlace(a, cmp, from, to),
    "static fill([II)V": (a: Int32Array, v: number) => a.fill(v),
    "static fill([BB)V": (a: Int8Array, v: number) => a.fill(v),
    "static fill([ZZ)V": (a: Uint8Array, v: number) => a.fill(v),
    "static fill([CC)V": (a: Uint16Array, v: number) => a.fill(v),
    "static fill([FF)V": (a: Float32Array, v: number) => a.fill(v),
    "static fill([DD)V": (a: Float64Array, v: number) => a.fill(v),
    "static fill([JJ)V": (a: BigInt64Array, v: bigint) => a.fill(v),
    "static fill([Ljava/lang/Object;Ljava/lang/Object;)V": (a: unknown[], v: unknown) => a.fill(v),
    "static fill([IIII)V": (a: Int32Array, f: number, t: number, v: number) => a.fill(v, f, t),
    "static fill([BIIB)V": (a: Int8Array, f: number, t: number, v: number) => a.fill(v, f, t),
    "static fill([JIIJ)V": (a: BigInt64Array, f: number, t: number, v: bigint) => a.fill(v, f, t),
    "static fill([FIIF)V": (a: Float32Array, f: number, t: number, v: number) => a.fill(v, f, t),
    "static fill([DIID)V": (a: Float64Array, f: number, t: number, v: number) => a.fill(v, f, t),
    "static fill([CIIC)V": (a: Uint16Array, f: number, t: number, v: number) => a.fill(v, f, t),
    "static fill([ZIIZ)V": (a: Uint8Array, f: number, t: number, v: number) => a.fill(v, f, t),
    "static fill([SIIS)V": (a: Int16Array, f: number, t: number, v: number) => a.fill(v, f, t),
    "static fill([SS)V": (a: Int16Array, v: number) => a.fill(v),
    "static fill([Ljava/lang/Object;IILjava/lang/Object;)V": (a: unknown[], f: number, t: number, v: unknown) => a.fill(v, f, t),
    "static copyOf([II)[I": taCopyOf,
    "static copyOf([BI)[B": taCopyOf,
    "static copyOf([CI)[C": taCopyOf,
    "static copyOf([JI)[J": taCopyOf,
    "static copyOf([FI)[F": taCopyOf,
    "static copyOf([DI)[D": taCopyOf,
    "static copyOf([Ljava/lang/Object;I)[Ljava/lang/Object;": (a: unknown[], n: number) => objCopyOf(a, n, elemOf(a)),
    "static copyOf([Ljava/lang/Object;ILjava/lang/Class;)[Ljava/lang/Object;": (a: unknown[], n: number, cls: { arrDesc?: string }) =>
      objCopyOf(a, n, cls?.arrDesc?.slice(1) ?? elemOf(a)),
    "static copyOf([ZI)[Z": taCopyOf,
    "static copyOf([SI)[S": taCopyOf,
    ...Object.fromEntries(["B", "I", "C", "J", "F", "D", "S", "Z"].map((t) => [`static copyOfRange([${t}II)[${t}`, taCopyOfRange])),
    "static copyOfRange([Ljava/lang/Object;II)[Ljava/lang/Object;": (a: unknown[], s: number, e: number) => objCopyOfRange(a, s, e, elemOf(a)),
    "static copyOfRange([Ljava/lang/Object;IILjava/lang/Class;)[Ljava/lang/Object;": (a: unknown[], s: number, e: number, cls: { arrDesc?: string }) =>
      objCopyOfRange(a, s, e, cls?.arrDesc?.slice(1) ?? elemOf(a)),
    ...Object.fromEntries(["B", "I", "C", "J", "F", "D", "S", "Z"].map((t) => [`static equals([${t}[${t})Z`, taEq])),
    "static hashCode([B)I": taHash,
    "static hashCode([C)I": taHash,
    "static hashCode([S)I": taHash,
    "static hashCode([Z)I": taHash,
    "static hashCode([F)I": (a: Float32Array | null) => {
      if (!a) return 0;
      const f = new Float32Array(1), i = new Int32Array(f.buffer);
      let h = 1;
      for (const e of a) { f[0] = e; h = (Math.imul(h, 31) + i[0]) | 0; }
      return h;
    },
    "static toString([F)Ljava/lang/String;": (a: Float32Array) => (a ? "[" + Array.from(a, fmtDouble).join(", ") + "]" : "null"),
    "static toString([J)Ljava/lang/String;": (a: BigInt64Array) => (a ? "[" + Array.from(a).join(", ") + "]" : "null"),
    "static toString([Z)Ljava/lang/String;": (a: Uint8Array) => (a ? "[" + Array.from(a, (v) => (v ? "true" : "false")).join(", ") + "]" : "null"),
    "static sort([C)V": taSort,
    "static sort([S)V": taSort,
    "static deepHashCode([Ljava/lang/Object;)I": (a: unknown[] | null) => (a ? hashSeq(a) : 0),
    "static equals([Ljava/lang/Object;[Ljava/lang/Object;)Z": async (a: unknown[], b: unknown[]) => {
      if (a === b) return 1;
      if (!a || !b || a.length !== b.length) return 0;
      for (let i = 0; i < a.length; i++) {
        const r = jeq(a[i], b[i]);
        if (!(r instanceof Promise ? await r : r)) return 0;
      }
      return 1;
    },
    "static hashCode([Ljava/lang/Object;)I": (a: unknown[] | null) => (a ? hashSeq(a) : 0),
    "static hashCode([I)I": (a: Int32Array) => {
      if (!a) return 0;
      let h = 1;
      for (const e of a) h = (Math.imul(h, 31) + e) | 0;
      return h;
    },
    "static toString([I)Ljava/lang/String;": (a: Int32Array) => (a ? "[" + a.join(", ") + "]" : "null"),
    "static toString([Ljava/lang/Object;)Ljava/lang/String;": (a: unknown[]) => (a ? "[" + a.map((x) => (x === null ? "null" : x)).join(", ") + "]" : "null"),
    "static binarySearch([II)I": taBinarySearch,
    "static binarySearch([CC)I": taBinarySearch,
    "static binarySearch([JJ)I": taBinarySearch,
    "static binarySearch([Ljava/lang/Object;Ljava/lang/Object;)I": async (a: unknown[], k: unknown) => {
      let lo = 0, hi = a.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = await jcmp(null, a[mid], k);
        if (c < 0) lo = mid + 1;
        else if (c > 0) hi = mid - 1;
        else return mid;
      }
      return -(lo + 1);
    },
  },
});
// The typed-array Arrays statics: one body per operation serves every element type, because
// the receiver's own constructor knows its element width.
type TA = { length: number; [i: number]: number | bigint; sort(): unknown; slice(s?: number, e?: number): TA; set(a: TA, o?: number): void; subarray(s: number, e?: number): TA; constructor: new (n: number) => TA };
function taSort(a: TA, from?: number, to?: number) {
  if (from === undefined) a.sort();
  else a.set(a.slice(from, to).sort() as TA, from);
}
function taCopyOf(a: TA, n: number): TA {
  const c = new a.constructor(n);
  c.set(a.subarray(0, Math.min(a.length, n)));
  return c;
}
function taHash(a: TA | null): number {
  if (!a) return 0;
  let h = 1;
  for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + Number(a[i])) | 0;
  return h;
}
// Arrays.copyOfRange: `to` may run past the end (zero/null padded); from > to or from > length throws
function rangeCheck(len: number, s: number, e: number) {
  if (s > e) throw rt.mkThrowable("java/lang/IllegalArgumentException", `${s} > ${e}`);
  if (s < 0 || s > len) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", `Array index out of range: ${s}`);
}
function taCopyOfRange(a: TA, s: number, e: number): TA {
  rangeCheck(a.length, s, e);
  const out = new a.constructor(e - s);
  out.set(a.subarray(s, Math.min(e, a.length)));
  return out;
}
function objCopyOfRange(a: unknown[], s: number, e: number, elem?: string): unknown[] {
  rangeCheck(a.length, s, e);
  const c = a.slice(s, e);
  while (c.length < e - s) c.push(null);
  return jarray(c, elem);
}
function taBinarySearch(a: TA, k: number | bigint): number {
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < k) lo = mid + 1;
    else if (a[mid] > k) hi = mid - 1;
    else return mid;
  }
  return -(lo + 1);
}
function taEq(a: TA | null, b: TA | null): number {
  if (a === b) return 1;
  if (!a || !b || a.length !== b.length) return 0;
  // Object.is is Java's bit comparison for float/double: NaN equals NaN, 0.0 differs from -0.0
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return 0;
  return 1;
}
function elemOf(a: unknown[]) { return (a as { $t?: string }).$t; }
function objCopyOf(a: unknown[], n: number, elem?: string): unknown[] {
  const c = a.slice(0, n);
  while (c.length < n) c.push(null);
  return jarray(c, elem);
}

class JCollections extends JObj {}
const emptyList = new JList();
rt.register({
  name: "java/util/Collections", ctor: JCollections,
  clinit: () => {
    const c = rt.link("java/util/Collections").ctor as any;
    c.s$EMPTY_LIST = emptyList;
    c.s$EMPTY_MAP = new (rt.link("java/util/HashMap").ctor)();
    c.s$EMPTY_SET = new (rt.link("java/util/HashSet").ctor)();
  },
  methods: {
    "static emptyList()Ljava/util/List;": () => newArrayList(),
    "static emptyMap()Ljava/util/Map;": () => new JMap(),
    "static emptySet()Ljava/util/Set;": () => new JSet(),
    "static singletonList(Ljava/lang/Object;)Ljava/util/List;": (v: unknown) => { const l = new JList(); l.a = [v]; return l; },
    "static singleton(Ljava/lang/Object;)Ljava/util/Set;": async (v: unknown) => { const s = new JSet(); await addToSet(s, v); return s; },
    "static singletonMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Map;": async (k: unknown, v: unknown) => {
      const m = new JMap();
      await vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", k, v);
      return m;
    },
    "static unmodifiableList(Ljava/util/List;)Ljava/util/List;": (l: unknown) => l,
    "static list(Ljava/util/Enumeration;)Ljava/util/ArrayList;": async (e: unknown) => {
      const out: unknown[] = [];
      while (await vcall(e, "hasMoreElements", "()Z")) out.push(await vcall(e, "nextElement", "()Ljava/lang/Object;"));
      return newArrayList(out);
    },
    "static enumeration(Ljava/util/Collection;)Ljava/util/Enumeration;": async (c: unknown) => mkIter(await toJsArray(c)),
    "static newSetFromMap(Ljava/util/Map;)Ljava/util/Set;": () => new (rt.link("java/util/HashSet").ctor)(),
    "static unmodifiableMap(Ljava/util/Map;)Ljava/util/Map;": (m: unknown) => m,
    "static unmodifiableSet(Ljava/util/Set;)Ljava/util/Set;": (s: unknown) => s,
    "static unmodifiableCollection(Ljava/util/Collection;)Ljava/util/Collection;": (c: unknown) => c,
    "static synchronizedList(Ljava/util/List;)Ljava/util/List;": (l: unknown) => l,
    "static synchronizedMap(Ljava/util/Map;)Ljava/util/Map;": (m: unknown) => m,
    "static synchronizedSet(Ljava/util/Set;)Ljava/util/Set;": (s: unknown) => s,
    "static sort(Ljava/util/List;)V": (l: JList) => sortInPlace(l.a, null),
    "static sort(Ljava/util/List;Ljava/util/Comparator;)V": (l: JList, c: unknown) => sortInPlace(l.a, c),
    "static binarySearch(Ljava/util/List;Ljava/lang/Object;)I": (l: unknown, k: unknown) => listBinarySearch(l, k, null),
    "static binarySearch(Ljava/util/List;Ljava/lang/Object;Ljava/util/Comparator;)I": listBinarySearch,
    "static reverse(Ljava/util/List;)V": (l: JList) => l.a.reverse(),
    "static shuffle(Ljava/util/List;)V": (l: JList) => {
      for (let i = l.a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [l.a[i], l.a[j]] = [l.a[j], l.a[i]];
      }
    },
    "static addAll(Ljava/util/Collection;[Ljava/lang/Object;)Z": async (c: unknown, arr: unknown[]) => {
      for (const v of arr) await vcall(c, "add", "(Ljava/lang/Object;)Z", v);
      return arr.length ? 1 : 0;
    },
    "static nCopies(ILjava/lang/Object;)Ljava/util/List;": (n: number, v: unknown) => {
      const l = new JList(); l.a = new Array(n).fill(v); return l;
    },
    "static max(Ljava/util/Collection;)Ljava/lang/Object;": async (c: unknown) => {
      const a = await toJsArray(c);
      let best = a[0];
      for (let i = 1; i < a.length; i++) if ((await jcmp(null, a[i], best)) > 0) best = a[i];
      return best;
    },
    "static min(Ljava/util/Collection;)Ljava/lang/Object;": async (c: unknown) => {
      const a = await toJsArray(c);
      let best = a[0];
      for (let i = 1; i < a.length; i++) if ((await jcmp(null, a[i], best)) < 0) best = a[i];
      return best;
    },
  },
});

class JObjects extends JObj {}
rt.register({
  name: "java/util/Objects", ctor: JObjects,
  methods: {
    "static equals(Ljava/lang/Object;Ljava/lang/Object;)Z": (a: unknown, b: unknown) => (a === b ? 1 : a === null || b === null ? 0 : jeq(a, b)),
    "static hashCode(Ljava/lang/Object;)I": (o: unknown) => (o === null ? 0 : jhash(o)),
    "static hash([Ljava/lang/Object;)I": hashSeq,
    "static requireNonNull(Ljava/lang/Object;)Ljava/lang/Object;": (o: unknown) => (o === null ? rt.npe() : o),
    "static requireNonNull(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/Object;": (o: unknown, m: string) => {
      if (o === null) throw rt.mkThrowable("java/lang/NullPointerException", m);
      return o;
    },
    "static toString(Ljava/lang/Object;)Ljava/lang/String;": (o: unknown) => (o === null ? "null" : vcall(o, "toString", "()Ljava/lang/String;")),
    "static isNull(Ljava/lang/Object;)Z": (o: unknown) => (o === null ? 1 : 0),
    "static nonNull(Ljava/lang/Object;)Z": (o: unknown) => (o !== null ? 1 : 0),
  },
});

// ── Random (faithful java.util.Random LCG)
/** a 48-bit seed from the platform CSPRNG, for the Random subclasses that must not be predictable */
export function randomSeed(): bigint {
  const w = new BigUint64Array(1);
  crypto.getRandomValues(w);
  return BigInt.asIntN(64, w[0]);
}
export class JRandom extends JObj {
  seed = 0n;
  haveNextG = false; nextG = 0;
  setSeed(s: bigint) { this.seed = (s ^ 0x5deece66dn) & 0xffffffffffffn; }
  next(bits: number): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & 0xffffffffffffn;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }
}
rt.register({
  name: "java/util/Random", ctor: JRandom,
  methods: {
    "<init>()V": function (this: JRandom) { this.setSeed(BigInt(Date.now()) ^ BigInt((Math.random() * 1e9) | 0)); },
    "<init>(J)V": function (this: JRandom, s: bigint) { this.setSeed(s); },
    "setSeed(J)V": function (this: JRandom, s: bigint) { this.setSeed(s); },
    "nextInt()I": function (this: JRandom) { return this.next(32); },
    "nextInt(I)I": function (this: JRandom, bound: number) {
      if (bound <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bound must be positive");
      if ((bound & -bound) === bound) return Number(BigInt(bound) * BigInt(this.next(31)) >> 31n);
      let bits: number, val: number;
      do { bits = this.next(31); val = bits % bound; } while (bits - val + (bound - 1) < 0);
      return val;
    },
    "nextLong()J": function (this: JRandom) {
      return BigInt.asIntN(64, (BigInt(this.next(32)) << 32n) + BigInt(this.next(32)));
    },
    "nextBoolean()Z": function (this: JRandom) { return this.next(1) ? 1 : 0; },
    "nextFloat()F": function (this: JRandom) { return this.next(24) / (1 << 24); },
    "nextDouble()D": function (this: JRandom) {
      return ((this.next(26) * 134217728) + this.next(27)) / 9007199254740992;
    },
    "nextGaussian()D": function (this: JRandom) {
      if (this.haveNextG) { this.haveNextG = false; return this.nextG; }
      let v1: number, v2: number, s: number;
      do {
        v1 = 2 * (((this.next(26) * 134217728) + this.next(27)) / 9007199254740992) - 1;
        v2 = 2 * (((this.next(26) * 134217728) + this.next(27)) / 9007199254740992) - 1;
        s = v1 * v1 + v2 * v2;
      } while (s >= 1 || s === 0);
      const mul = Math.sqrt(-2 * Math.log(s) / s);
      this.nextG = v2 * mul; this.haveNextG = true;
      return v1 * mul;
    },
  },
});

// ── misc
class JStringJoiner extends JObj { sep = ","; pre = ""; suf = ""; parts: string[] = []; }
rt.register({
  name: "java/util/StringJoiner", ctor: JStringJoiner,
  methods: {
    "<init>(Ljava/lang/CharSequence;)V": function (this: JStringJoiner, s: unknown) { this.sep = String(s); },
    "<init>(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/CharSequence;)V":
      function (this: JStringJoiner, s: unknown, p: unknown, u: unknown) { this.sep = String(s); this.pre = String(p); this.suf = String(u); },
    "add(Ljava/lang/CharSequence;)Ljava/util/StringJoiner;": function (this: JStringJoiner, s: unknown) {
      this.parts.push(s === null ? "null" : String(s)); return this;
    },
    "toString()Ljava/lang/String;": function (this: JStringJoiner) { return this.pre + this.parts.join(this.sep) + this.suf; },
  },
});

class JUUID extends JObj { hi = 0n; lo = 0n; }
rt.register({
  name: "java/util/UUID", ctor: JUUID, ifaces: ["java/io/Serializable", "java/lang/Comparable"],
  methods: {
    "<init>(JJ)V": function (this: JUUID, hi: bigint, lo: bigint) { this.hi = hi; this.lo = lo; },
    "static randomUUID()Ljava/util/UUID;": () => {
      const u = new JUUID();
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      let hi = 0n, lo = 0n;
      for (let i = 0; i < 8; i++) hi = (hi << 8n) | BigInt(b[i]);
      for (let i = 8; i < 16; i++) lo = (lo << 8n) | BigInt(b[i]);
      u.hi = BigInt.asIntN(64, hi); u.lo = BigInt.asIntN(64, lo);
      return u;
    },
    "toString()Ljava/lang/String;": function (this: JUUID) {
      const h = (v: bigint, n: number) => BigInt.asUintN(n * 4, v).toString(16).padStart(n, "0");
      return `${h(this.hi >> 32n, 8)}-${h(this.hi >> 16n, 4)}-${h(this.hi, 4)}-${h(this.lo >> 48n, 4)}-${h(this.lo, 12)}`;
    },
    "getMostSignificantBits()J": function (this: JUUID) { return this.hi; },
    "getLeastSignificantBits()J": function (this: JUUID) { return this.lo; },
  },
});

class JLocale extends JObj { lang = "en"; country = "US"; }
/** the one locale the device speaks; also the default */
export const usLocale = new JLocale();
rt.register({
  name: "java/util/Locale", ctor: JLocale,
  statics: { US: usLocale, ENGLISH: usLocale, ROOT: new JLocale() },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JLocale, l: string) { this.lang = l; },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JLocale, l: string, c: string) { this.lang = l; this.country = c; },
    "static getDefault()Ljava/util/Locale;": () => usLocale,
    "static setDefault(Ljava/util/Locale;)V": () => {},
    "getLanguage()Ljava/lang/String;": function (this: JLocale) { return this.lang; },
    "getCountry()Ljava/lang/String;": function (this: JLocale) { return this.country; },
    "toString()Ljava/lang/String;": function (this: JLocale) { return this.lang + "_" + this.country; },
    "toLanguageTag()Ljava/lang/String;": function (this: JLocale) { return this.lang + "-" + this.country; },
    "static forLanguageTag(Ljava/lang/String;)Ljava/util/Locale;": (t: string) => {
      const l = new JLocale();
      const [a, b] = t.split("-");
      l.lang = a ?? "en"; l.country = b ?? "";
      return l;
    },
  },
});

class JLogger extends JObj { lname = ""; }
rt.register({
  name: "java/util/logging/Logger", ctor: JLogger,
  methods: {
    "static getLogger(Ljava/lang/String;)Ljava/util/logging/Logger;": (n: string) => { const l = new JLogger(); l.lname = n; return l; },
    "log(Ljava/util/logging/Level;Ljava/lang/String;)V": () => {},
    "log(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/Throwable;)V": () => {},
    "info(Ljava/lang/String;)V": () => {},
    "warning(Ljava/lang/String;)V": () => {},
    "fine(Ljava/lang/String;)V": () => {},
    "isLoggable(Ljava/util/logging/Level;)Z": () => 0,
    "setLevel(Ljava/util/logging/Level;)V": () => {},
    "addHandler(Ljava/util/logging/Handler;)V": () => {},
    "setUseParentHandlers(Z)V": () => {},
  },
});
rt.register({ name: "java/util/logging/Level", ctor: class extends JObj {},
  clinit: () => { const c = rt.link("java/util/logging/Level").ctor as any; for (const n of ["OFF","SEVERE","WARNING","INFO","CONFIG","FINE","FINER","FINEST","ALL"]) c["s$"+n] = new c(); } });
rt.register({ name: "java/util/logging/Handler", ctor: class extends JObj {} });

// Properties: string-keyed map + load(InputStream) for .properties text
class JProps extends JMap {}
rt.register({
  name: "java/util/Properties", ctor: JProps, sup: "java/util/HashMap",
  methods: {
    "<init>()V": function () {},
    "getProperty(Ljava/lang/String;)Ljava/lang/String;": function (this: JProps, k: string) { return (this.m.get(k)?.v as string) ?? null; },
    "getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": function (this: JProps, k: string, d: string) { return (this.m.get(k)?.v as string) ?? d; },
    "setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/Object;": function (this: JProps, k: string, v: string) {
      const old = this.m.get(k)?.v ?? null; this.m.set(k, { k, v }); return old;
    },
    "load(Ljava/io/InputStream;)V": async function (this: JProps, s: unknown) {
      const bytes: Int8Array | undefined = (s as { buf?: Int8Array })?.buf;
      if (!bytes) return;
      const text = new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith("!")) continue;
        const eq = t.search(/[=:]/);
        if (eq < 0) continue;
        this.m.set(t.slice(0, eq).trim(), { k: t.slice(0, eq).trim(), v: t.slice(eq + 1).trim() });
      }
    },
  },
});

// java.util.Timer: one background timer thread per Timer in the JDK; here the tasks are host
// timers, cancelled together with the Timer that scheduled them.
class JTimerTask extends JObj { handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null; repeating = false; }
class JTimer extends JObj { tasks = new Set<JTimerTask>(); }
function timerCancel(t: JTimerTask) {
  if (t.handle === null) return;
  if (t.repeating) clearInterval(t.handle as ReturnType<typeof setInterval>); else clearTimeout(t.handle);
  t.handle = null;
}
function schedule(timer: JTimer, task: JTimerTask, delay: number, period = 0) {
  timer.tasks.add(task);
  task.repeating = period > 0;
  const run = () => { void vcall(task, "run", "()V").catch(() => {}); };
  task.handle = period > 0
    ? setTimeout(() => { run(); task.handle = setInterval(run, period); }, Math.max(0, delay))
    : setTimeout(() => { task.handle = null; timer.tasks.delete(task); run(); }, Math.max(0, delay));
}
rt.register({
  name: "java/util/TimerTask", ctor: JTimerTask, ifaces: ["java/lang/Runnable"],
  methods: {
    "<init>()V": function () {},
    "run()V": function () {},
    "cancel()Z": function (this: JTimerTask) { const live = this.handle !== null; timerCancel(this); return live ? 1 : 0; },
    "scheduledExecutionTime()J": () => BigInt(Date.now()),
  },
});
rt.register({
  name: "java/util/Timer", ctor: JTimer,
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function () {},
    "<init>(Ljava/lang/String;)V": function () {},
    "<init>(Ljava/lang/String;Z)V": function () {},
    "schedule(Ljava/util/TimerTask;J)V": function (this: JTimer, t: JTimerTask, d: bigint) { schedule(this, t, Number(d)); },
    "schedule(Ljava/util/TimerTask;JJ)V": function (this: JTimer, t: JTimerTask, d: bigint, p: bigint) { schedule(this, t, Number(d), Number(p)); },
    "schedule(Ljava/util/TimerTask;Ljava/util/Date;)V": function (this: JTimer, t: JTimerTask, when: { t?: number }) {
      schedule(this, t, (when?.t ?? Date.now()) - Date.now());
    },
    "scheduleAtFixedRate(Ljava/util/TimerTask;JJ)V": function (this: JTimer, t: JTimerTask, d: bigint, p: bigint) { schedule(this, t, Number(d), Number(p)); },
    "cancel()V": function (this: JTimer) { for (const t of this.tasks) timerCancel(t); this.tasks.clear(); },
    "purge()I": function (this: JTimer) { for (const t of [...this.tasks]) if (t.handle === null) this.tasks.delete(t); return 0; },
  },
});

// Universal toArray fallback: some dex collection classes (R8-pruned bridges)
// lack toArray; route through their iterator.
const TA_PLAIN = mangleMethod("toArray", "()[Ljava/lang/Object;");
const TA_TYPED = mangleMethod("toArray", "([Ljava/lang/Object;)[Ljava/lang/Object;");
for (const [key, fn] of [
  [TA_PLAIN, async function (this: unknown) { return jarray((await toJsArray(this)).slice()); }],
  [TA_TYPED, async function (this: unknown, out: unknown[]) { return fillToArray(await toJsArray(this), out); }],
] as [string, (...a: never[]) => unknown][]) {
  if (!(key in (JObj.prototype as object))) {
    Object.defineProperty(JObj.prototype, key, { value: fn, writable: true, configurable: true, enumerable: false });
  }
}
