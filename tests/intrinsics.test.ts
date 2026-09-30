// §4.7: every intrinsic gives the AOSP body's results, exceptions and receiver state.
import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { boxInt, newObj, vcall } from "../src/jvm/natives/jlang";
import { jarray, mangleField, mangleMethod, splitSig } from "../src/jvm/abi";
import { loadLibcore } from "./java";

rt.linkNatives();
await loadLibcore();

/** the intrinsic and the AOSP body of `cls.sig` */
async function pair(cls: string, sig: string): Promise<[Function, Function]> {
  const info = rt.link(cls);
  await rt.initClass(info);
  const mangled = mangleMethod(...splitSig(sig.replace(/^static /, "")));
  const rec = info.lazy!.find((r) => r.mangled === mangled)!;
  expect(rec?.intrinsic).toBeFunction();
  return [rec.intrinsic!, rec.stub];
}
/** a call's value, or the class and message of what it threw */
async function outcome(fn: Function, self: unknown, args: unknown[]): Promise<unknown> {
  try { return { value: await fn.apply(self, args) }; } catch (e) { const t = rt.jx(e); return { threw: t.constructor.$i.name, msg: t.msg }; }
}
let seed = 20260929;
const random = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
const fields = (o: any, cls: string, ...names: string[]) => names.map((n) => { const v = o[mangleField(cls, n)]; return Array.isArray(v) ? [...v] : v; });

test("ArrayList's intrinsics match its AOSP bodies", async () => {
  const sigs = ["get(I)Ljava/lang/Object;", "set(ILjava/lang/Object;)Ljava/lang/Object;", "add(Ljava/lang/Object;)Z", "size()I", "isEmpty()Z"];
  const pairs = await Promise.all(sigs.map((sig) => pair("java/util/ArrayList", sig)));
  const lists = [await newObj("java/util/ArrayList", "(I)V", 2), await newObj("java/util/ArrayList", "(I)V", 2)];
  for (let step = 0; step < 400; step++) {
    const k = random(sigs.length), index = random(12) - 2, value = random(3) ? "v" + step : null;
    const args = k === 0 ? [index] : k === 1 ? [index, value] : k === 2 ? [value] : [];
    expect(await outcome(pairs[k][0], lists[0], args)).toEqual(await outcome(pairs[k][1], lists[1], args));
    expect(fields(lists[0], "java/util/ArrayList", "size", "elementData")).toEqual(fields(lists[1], "java/util/ArrayList", "size", "elementData"));
    expect(fields(lists[0], "java/util/AbstractList", "modCount")).toEqual(fields(lists[1], "java/util/AbstractList", "modCount"));
  }
});

test("ArrayList iteration's intrinsics match, including concurrent modification", async () => {
  const [[hasNext, hasNextBase], [next, nextBase]] = await Promise.all(["hasNext()Z", "next()Ljava/lang/Object;"].map((sig) => pair("java/util/ArrayList$Itr", sig)));
  for (const modifyAt of [-1, 0, 2]) {
    const lists = [await newObj("java/util/ArrayList"), await newObj("java/util/ArrayList")];
    for (const l of lists) for (const v of ["a", "b", "c", "d"]) await vcall(l, "add", "(Ljava/lang/Object;)Z", v);
    const its = await Promise.all(lists.map((l) => vcall(l, "iterator", "()Ljava/util/Iterator;")));
    for (let i = 0; i < 6; i++) {
      if (i === modifyAt) for (const l of lists) await vcall(l, "add", "(Ljava/lang/Object;)Z", "x");
      expect(await outcome(hasNext, its[0], [])).toEqual(await outcome(hasNextBase, its[1], []));
      expect(await outcome(next, its[0], [])).toEqual(await outcome(nextBase, its[1], []));
      expect(fields(its[0], "java/util/ArrayList$Itr", "cursor", "lastRet")).toEqual(fields(its[1], "java/util/ArrayList$Itr", "cursor", "lastRet"));
    }
  }
});

test("HashMap lookups match for String and Integer keys, collisions and tree bins", async () => {
  const sigs = ["get(Ljava/lang/Object;)Ljava/lang/Object;", "containsKey(Ljava/lang/Object;)Z", "getNode(Ljava/lang/Object;)Ljava/util/HashMap$Node;"];
  const pairs = await Promise.all(sigs.map((sig) => pair("java/util/HashMap", sig)));
  // "Aa" and "BB" hash alike, so strings built from them share a bin; 64 of them treeify it
  const colliding = Array.from({ length: 64 }, (_, i) => [...i.toString(2).padStart(6, "0")].map((b) => (b === "0" ? "Aa" : "BB")).join(""));
  const put = (m: unknown, k: unknown, v: unknown) => vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", k, v);
  const small = await newObj("java/util/HashMap"), tree = await newObj("java/util/HashMap");
  for (let i = 0; i < 40; i++) { await put(small, "k" + i, boxInt(i)); await put(small, boxInt(i * 7), "i" + i); }
  await put(small, null, "null key");
  for (const k of colliding) await put(tree, k, boxInt(k.length));
  const probes = [..."k0 k7 k39 k40 missing".split(" "), boxInt(0), boxInt(7 * 39), boxInt(-1), null, ...colliding.slice(0, 8), "AaAaAaAaAaBB"];
  for (const map of [small, tree, await newObj("java/util/HashMap")])
    for (const key of probes) for (const [fn, base] of pairs) expect(await outcome(fn, map, [key])).toEqual(await outcome(base, map, [key]));
});

test("Arrays.copyOf keeps the original's array class, pads with null and fails as AOSP does", async () => {
  const [copyOf, base] = await pair("java/util/Arrays", "static copyOf([Ljava/lang/Object;I)[Ljava/lang/Object;");
  const strings = jarray(["a", "b", "c"], "Ljava/lang/String;");
  for (const [array, n] of [[strings, 2], [strings, 5], [strings, 0], [jarray([], "Ljava/lang/Object;"), 3], [strings, -1], [null, 1]] as const) {
    const [mine, theirs] = [await outcome(copyOf, null, [array, n]), await outcome(base, null, [array, n])] as { value?: unknown[] }[];
    expect(mine).toEqual(theirs);
    if (mine.value) expect((mine.value as { $t?: string }).$t).toBe((theirs.value as { $t?: string }).$t);
  }
});

test("Random's step matches its AOSP body for every width and many seeds", async () => {
  const [next, base] = await pair("java/util/Random", "next(I)I");
  for (const seed of [0n, 1n, -1n, 42n, 0x5deece66dn, -9223372036854775808n, 9223372036854775807n, 123456789012345n]) {
    const randoms = [await newObj("java/util/Random", "(J)V", seed), await newObj("java/util/Random", "(J)V", seed)];
    for (let i = 0; i < 200; i++) {
      const bits = [1, 7, 16, 31, 32, 33, 48, 0][i % 8];
      expect(await outcome(next, randoms[0], [bits])).toEqual(await outcome(base, randoms[1], [bits]));
    }
  }
});

test("ConcurrentHashMap's bin accessors match their Unsafe bodies", async () => {
  const N = "Ljava/util/concurrent/ConcurrentHashMap$Node;";
  const [[tabAt, tabAtBase], [cas, casBase], [set, setBase]] = await Promise.all(
    [`static tabAt([${N}I)${N}`, `static casTabAt([${N}I${N}${N})Z`, `static setTabAt([${N}I${N})V`].map((sig) => pair("java/util/concurrent/ConcurrentHashMap", sig)));
  const node = rt.make("java/util/concurrent/ConcurrentHashMap$Node"), other = rt.make("java/util/concurrent/ConcurrentHashMap$Node"), tabs = [0, 1].map(() => jarray([null, node, null, null], N));
  for (const [i, c, v] of [[1, node, other], [1, node, node], [0, null, node], [2, other, node]] as const) {
    expect(cas(tabs[0], i, c, v)).toBe(casBase(tabs[1], i, c, v));
    expect(tabs[0]).toEqual(tabs[1]);
  }
  set(tabs[0], 3, other); setBase(tabs[1], 3, other);
  for (let i = 0; i < 4; i++) expect(tabAt(tabs[0], i)).toBe(tabAtBase(tabs[1], i));
});
