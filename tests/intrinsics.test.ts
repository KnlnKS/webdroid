// §4.7: every intrinsic gives the AOSP body's results, exceptions and receiver state.
import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { boxInt, newObj, scall, vcall } from "../src/jvm/natives/jlang";
import { bufferBytes, limit, position } from "../src/jvm/natives/jnio";
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

// java.nio: twin buffers take the same random steps, one through each intrinsic and one through
// its AOSP body, over direct and heap memory, both byte orders, slices at odd offsets, read-only
// and inaccessible buffers, and indices on and past each bound
const ELEMENTS = [["", "B", Int8Array], ["Short", "S", Int16Array], ["Char", "C", Uint16Array], ["Int", "I", Int32Array],
  ["Long", "J", BigInt64Array], ["Float", "F", Float32Array], ["Double", "D", Float64Array]] as const;
const word = () => (random(65536) << 16) | random(65536);
function value(d: string): unknown {
  switch (d) {
    case "B": return random(256) - 128;
    case "S": return random(65536) - 32768;
    case "C": return random(65536);
    case "I": return word();
    case "J": return BigInt.asIntN(64, (BigInt(word()) << 32n) | BigInt(word() >>> 0));
    case "F": return [0, -0, 1.5, -2.25, Infinity, NaN, Math.fround(word() / 7)][random(7)];
    default: return [0, -0, 1e300, -Infinity, NaN, word() / 3][random(6)];
  }
}
interface Variant { direct: boolean; little: boolean; slice: boolean; readOnly: boolean; inaccessible: boolean }
const VARIANTS: Variant[] = [];
for (const direct of [true, false]) for (const little of [false, true]) for (const slice of [false, true]) for (const readOnly of [false, true])
  VARIANTS.push({ direct, little, slice, readOnly, inaccessible: false });
VARIANTS.push({ direct: true, little: true, slice: false, readOnly: false, inaccessible: true });
async function byteBuffer(v: Variant): Promise<unknown> {
  let b = await scall("java/nio/ByteBuffer", v.direct ? "allocateDirect" : "allocate", "(I)Ljava/nio/ByteBuffer;", 48);
  for (let i = 0; i < 48; i++) await vcall(b, "put", "(IB)Ljava/nio/ByteBuffer;", i, ((i * 37) & 0xff) << 24 >> 24);
  if (v.slice) { await vcall(b, "position", "(I)Ljava/nio/Buffer;", 3); b = await vcall(b, "slice", "()Ljava/nio/ByteBuffer;"); }
  if (v.readOnly) b = await vcall(b, "asReadOnlyBuffer", "()Ljava/nio/ByteBuffer;");
  if (v.little) b = await vcall(b, "order", "(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;", await scall("java/nio/ByteOrder", "nativeOrder", "()Ljava/nio/ByteOrder;"));
  if (v.inaccessible) await vcall(b, "setAccessible", "(Z)V", 0);
  return b;
}
/** a call's outcome, with the receiver itself as "this" */
async function step(fn: Function, self: unknown, args: unknown[]): Promise<unknown> {
  const o = await outcome(fn, self, args) as { value?: unknown };
  return o.value === self ? { value: "this" } : o;
}
const state = (b: unknown) => [position(b as never), limit(b as never), [...bufferBytes(b as never)]];
interface Case { sig: string; args: (cap: number) => unknown[] }
/** random steps through each case's (intrinsic, AOSP body) pair on twin buffers, their arguments
 *  drawn alike for both, and now and then a new position for both */
async function differential(twins: unknown[], cases: Case[], cls: string, steps: number, arrays: unknown[] = []) {
  const pairs = await Promise.all(cases.map((c) => pair(cls, c.sig)));
  const cap = await vcall(twins[0], "capacity", "()I") as number;
  for (let s = 0; s < steps; s++) {
    if (random(6) === 0) {
      const p = random(cap + 2);
      for (const b of twins) await outcome(() => vcall(b, "position", "(I)Ljava/nio/Buffer;", p), null, []);
    }
    const k = random(cases.length), from = seed, results: unknown[] = [];
    for (const t of [0, 1]) {
      seed = from;
      // each twin copies with its own array
      const args = cases[k].args(cap).map((a) => (a === arrays[0] ? arrays[t] : a));
      results.push([cases[k].sig, await step(pairs[k][t], twins[t], args)]);
    }
    expect(results[0]).toEqual(results[1]);
    expect(state(twins[0])).toEqual(state(twins[1]));
    for (const a of arrays.slice(1)) expect([...a as Int8Array]).toEqual([...arrays[0] as Int8Array]);
  }
}
const index = (cap: number) => random(cap + 4) - 2;
/** two equal arrays of six random elements */
function twinArrays(Elements: (typeof ELEMENTS)[number][2], d: string): unknown[] {
  const a = new Elements(6) as unknown as unknown[];
  for (let i = 0; i < a.length; i++) a[i] = value(d);
  return [a, (a as unknown as Int8Array).slice()];
}

test("ByteBuffer element intrinsics match their AOSP bodies", async () => {
  for (const [cls, direct] of [["java/nio/DirectByteBuffer", true], ["java/nio/HeapByteBuffer", false]] as const) {
    const cases: Case[] = ELEMENTS.flatMap(([name, d, array]) => {
      const n = array.BYTES_PER_ELEMENT;
      // an unchecked index past a direct buffer's end reads memory the twins do not share
      const unchecked = (cap: number) => (direct ? random(cap - n + 1) : index(cap));
      return [
        ...(direct && d === "C" ? [] : [
          { sig: `get${name}()${d}`, args: () => [] },
          { sig: `get${name}(I)${d}`, args: (cap: number) => [index(cap)] },
          { sig: `put${name}(${d})Ljava/nio/ByteBuffer;`, args: () => [value(d)] },
          { sig: `put${name}(I${d})Ljava/nio/ByteBuffer;`, args: (cap: number) => [index(cap), value(d)] },
        ]),
        ...(d === "B" ? [] : [
          { sig: `get${name}Unchecked(I)${d}`, args: (cap: number) => [unchecked(cap)] },
          { sig: `put${name}Unchecked(I${d})V`, args: (cap: number) => [unchecked(cap), value(d)] },
        ]),
      ];
    });
    for (const v of VARIANTS.filter((v) => v.direct === direct)) await differential([await byteBuffer(v), await byteBuffer(v)], cases, cls, 200);
  }
});

test("a direct buffer's bulk array copies match their AOSP bodies", async () => {
  for (const [, d, Elements] of ELEMENTS.slice(1)) {
    const arrays = twinArrays(Elements, d);
    // the copy stays within the buffer, whose neighbours the twins do not share
    const args = (cap: number) => {
      const length = random(8) - 1, offset = random(8) - 1;
      return [random(Math.max(1, cap - Math.max(length, 0) * Elements.BYTES_PER_ELEMENT + 1)), random(20) ? arrays[0] : null, offset, length];
    };
    const cases = [{ sig: `putUnchecked(I[${d}II)V`, args }, { sig: `getUnchecked(I[${d}II)V`, args }];
    for (const v of VARIANTS.filter((v) => v.direct && !v.readOnly))
      await differential([await byteBuffer(v), await byteBuffer(v)], cases, "java/nio/DirectByteBuffer", 40, arrays);
  }
});

test("typed views' element and bulk intrinsics match their AOSP bodies", async () => {
  for (const [name, d, Elements] of ELEMENTS.slice(1)) {
    const ret = `Ljava/nio/${name}Buffer;`, arrays = twinArrays(Elements, d);
    const bulk = () => [random(20) ? arrays[0] : null, random(8) - 1, random(8) - 1];
    const cases: Case[] = [
      { sig: `get()${d}`, args: () => [] },
      { sig: `get(I)${d}`, args: (cap) => [index(cap)] },
      { sig: `put(${d})${ret}`, args: () => [value(d)] },
      { sig: `put(I${d})${ret}`, args: (cap) => [index(cap), value(d)] },
      { sig: `get([${d}II)${ret}`, args: bulk },
      { sig: `put([${d}II)${ret}`, args: bulk },
    ];
    for (const v of VARIANTS) {
      const twins = await Promise.all([0, 1].map(async () => vcall(await byteBuffer(v), `as${name}Buffer`, `()${ret}`)));
      await differential(twins, cases, `java/nio/ByteBufferAs${name}Buffer`, 120, arrays);
    }
  }
});
