// §4.7: every intrinsic gives the AOSP body's results, exceptions and receiver state.
import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, scall, vcall } from "../src/jvm/natives/jlang";
import { boxDesc, boxInt } from "../src/jvm/natives/jbox";
import { bufferBytes, limit, position } from "../src/jvm/natives/jnio";
import { jarray, mangleField, mangleMethod, splitSig } from "../src/jvm/abi";
import { loadLibcore, mountApexData } from "./java";

rt.linkNatives();
await loadLibcore();
await mountApexData();

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

test("Matcher.usePattern's kept MatcherNatives answer as new ones do", async () => {
  const [use, useBase] = await pair("java/util/regex/Matcher", "usePattern(Ljava/util/regex/Pattern;)Ljava/util/regex/Matcher;");
  const patterns = await Promise.all(["[ ]+", "[0-9]+", "(a+)(b*)", "$", "x?", "[0-9]+$"].map((p) => scall("java/util/regex/Pattern", "compile", "(Ljava/lang/String;)Ljava/util/regex/Pattern;", p)));
  const text = "12 aab ab  7x a 99", matchers = await Promise.all([0, 1].map(() => vcall(patterns[0], "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", text)));
  const ops: [string, string, () => unknown[]][] = [
    ["find", "()Z", () => []], ["lookingAt", "()Z", () => []], ["matches", "()Z", () => []], ["hitEnd", "()Z", () => []], ["requireEnd", "()Z", () => []],
    ["group", "()Ljava/lang/String;", () => []], ["group", "(I)Ljava/lang/String;", () => [random(4) - 1]], ["start", "()I", () => []], ["end", "()I", () => []],
    ["groupCount", "()I", () => []], ["reset", "()Ljava/util/regex/Matcher;", () => []],
    ["region", "(II)Ljava/util/regex/Matcher;", () => { const a = random(text.length + 1); return [a, a + random(text.length + 1 - a)]; }],
  ];
  for (let s = 0; s < 500; s++) {
    if (random(3) === 0) {
      const p = patterns[random(patterns.length)];
      expect(await step(use, matchers[0], [p])).toEqual(await step(useBase, matchers[1], [p]));
      continue;
    }
    const [name, desc, args] = ops[random(ops.length)], a = args(), results: unknown[] = [];
    for (const m of matchers) results.push([name, desc, await step((...x: unknown[]) => vcall(m, name, desc, ...x), m, a)]);
    expect(results[0]).toEqual(results[1]);
  }
});
test("BigInteger's intrinsics match its AOSP bodies over signs, zero, powers of two and 1-4096-bit values", async () => {
  await mountApexData(); // Character.digit's ICU data, for the non-ASCII digits the AOSP parser accepts
  const BI = "java/math/BigInteger", B = "Ljava/math/BigInteger;", C = rt.link(BI).ctor as new () => any;
  const pairs = new Map<string, [Function, Function]>();
  const get = async (sig: string) => pairs.get(sig) ?? (pairs.set(sig, await pair(BI, sig)), pairs.get(sig)!);
  // operands the AOSP constructor built, so an intrinsic reads them from their words
  const [, parseBase] = await get("<init>(Ljava/lang/String;I)V");
  const aosp = async (v: bigint) => { const b = new C(); await parseBase.call(b, v.toString(16), 16); return b; };
  const randomBits = (bits: number) => { let v = 1n; for (let i = 1; i < bits; i++) v = v << 1n | BigInt(random(2)); return v; };
  const values = [0n, 1n, -1n, 2n, 16n, -17n, 0xffffffffn, 0x100000000n, -0x7fffffffffffffffn - 1n, 0xffffffffffffffffn];
  for (const k of [31, 32, 33, 63, 64, 65, 127, 128, 1000]) values.push(1n << BigInt(k), (1n << BigInt(k)) - 1n, -(1n << BigInt(k)));
  for (const bits of [1, 5, 31, 32, 33, 64, 65, 96, 128, 255, 256, 512, 1024, 2048, 4096]) for (let i = 0; i < 2; i++) values.push(randomBits(bits) * (random(2) ? 1n : -1n));
  const operands = await Promise.all(values.map(aosp));
  /** a result as plain data, BigIntegers by their words */
  const plain = (v: unknown): unknown => v instanceof C ? { signum: (v as any)[mangleField(BI, "signum")], mag: [...(v as any)[mangleField(BI, "mag")]] }
    : Array.isArray(v) || v instanceof Int8Array ? [...v].map(plain) : v;
  const name = (a: unknown) => a instanceof C ? String(values[operands.indexOf(a)] ?? "new") : String(a);
  const thrown = new Map<string, number>();
  const same = async (sig: string, self: unknown, args: unknown[]) => {
    const [fn, base] = await get(sig);
    const [mine, theirs] = [await outcome(fn, self, args), await outcome(base, self, args)] as { value?: unknown }[];
    if ("value" in mine) mine.value = plain(mine.value);
    if ("value" in theirs) theirs.value = plain(theirs.value);
    const threw = (theirs as { threw?: string }).threw ?? "value";
    thrown.set(threw, (thrown.get(threw) ?? 0) + 1);
    if (!Bun.deepEquals(mine, theirs)) throw new Error(`${sig} on ${name(self)} (${args.map(name)}): ${JSON.stringify(mine, (_, v) => typeof v === "bigint" ? String(v) : v)} vs ${JSON.stringify(theirs, (_, v) => typeof v === "bigint" ? String(v) : v)}`);
  };
  const modest = (i: number) => values[i] >= -(1n << 520n) && values[i] <= 1n << 520n;
  for (let i = 0; i < operands.length; i++) {
    const x = operands[i];
    for (const sig of ["toString()Ljava/lang/String;", "intValue()I", "longValue()J", "bitLength()I", "hashCode()I", "toByteArray()[B"]) await same(sig, x, []);
    for (const r of [2, 8, 10, 16, 36, 1, 37]) await same("toString(I)Ljava/lang/String;", x, [r]);
    for (const n of [-1, 0, 5, 31, 63, 64, 100, 5000]) await same("testBit(I)Z", x, [n]);
    for (const n of [-70, -33, -1, 0, 1, 31, 32, 33, 100, -2147483648]) { await same(`shiftLeft(I)${B}`, x, [n]); await same(`shiftRight(I)${B}`, x, [n]); }
    for (const e of [-1, 0, 1, 2, 5]) if (modest(i) || e < 2) await same(`pow(I)${B}`, x, [e]);
    for (const sig of [`add(${B})${B}`, `subtract(${B})${B}`, `multiply(${B})${B}`, `compareTo(${B})I`, "equals(Ljava/lang/Object;)Z"]) await same(sig, x, [null]);
    await same("equals(Ljava/lang/Object;)Z", x, ["1"]);
    for (let j = 0; j < operands.length; j++) {
      const y = operands[j];
      for (const sig of [`add(${B})${B}`, `subtract(${B})${B}`, `multiply(${B})${B}`, `divide(${B})${B}`, `remainder(${B})${B}`, `mod(${B})${B}`,
        `divideAndRemainder(${B})[${B}`, `compareTo(${B})I`, "equals(Ljava/lang/Object;)Z"]) await same(sig, x, [y]);
      if (modest(i) && modest(j)) {
        await same(`gcd(${B})${B}`, x, [y]);
        await same(`modInverse(${B})${B}`, x, [y]);
        await same(`modPow(${B}${B})${B}`, x, [operands[(i + j) % operands.length], y]);
      }
    }
  }
  // parsing: radixes, signs, and what only the AOSP parser judges (non-ASCII digits, malformed text)
  for (const [s, r] of [["0", 10], ["-0", 10], ["+12", 10], ["-ff", 16], ["FF", 16], ["zz", 36], ["102", 2], ["777", 8], ["", 10], ["-", 10], ["+-1", 10],
    [" 1", 10], ["1_0", 10], ["١٢", 10], ["１", 10], ["12", 1], ["12", 37], ["123456789012345678901234567890123456789", 10], ["-" + "f".repeat(300), 16]] as const) {
    const cases: [string, unknown[]][] = [["<init>(Ljava/lang/String;I)V", [s, r]]];
    if (r === 10) cases.push(["<init>(Ljava/lang/String;)V", [s]]);
    for (const [sig, args] of cases) {
      const [fn, base] = await get(sig), objs = [new C(), new C()];
      const [mine, theirs] = [await outcome(fn, objs[0], args), await outcome(base, objs[1], args)];
      expect(JSON.stringify(mine)).toBe(JSON.stringify(theirs));
      if (!("threw" in (mine as object))) expect(plain(objs[0])).toEqual(plain(objs[1]));
    }
  }
  for (const bytes of [[], [0], [-1], [0, -1], [-1, 0], [-128, 0, 0, 0, 0, 0, 0, 0, 1], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]]) {
    const [fn, base] = await get("<init>([B)V"), objs = [new C(), new C()];
    const [mine, theirs] = [await outcome(fn, objs[0], [Int8Array.from(bytes)]), await outcome(base, objs[1], [Int8Array.from(bytes)])];
    expect(JSON.stringify(mine)).toBe(JSON.stringify(theirs));
    if (!("threw" in (mine as object))) expect(plain(objs[0])).toEqual(plain(objs[1]));
  }
  for (const v of [0n, 16n, -16n, 17n, -17n, 1n << 40n, -(1n << 63n), (1n << 63n) - 1n]) await same(`static valueOf(J)${B}`, null, [v]);
  expect(thrown.get("value")).toBeGreaterThan(40000);
  expect(thrown.get("java/lang/ArithmeticException")).toBeGreaterThan(500);
  expect(thrown.get("java/lang/NullPointerException")).toBeGreaterThan(100);
}, 600_000);

/** a call's outcome as `outcome` gives it, an NPE by class alone (its message is the engine's text) */
async function result(fn: Function, self: unknown, args: unknown[]): Promise<unknown> {
  const r = await outcome(fn, self, args) as { threw?: string; msg?: string };
  return r.threw === "java/lang/NullPointerException" ? { threw: r.threw } : r;
}
const INTS = [0, 1, -1, 127, 128, -128, -129, 255, 256, 1000, -32768, 32767, 65535, 2147483647, -2147483648,
  ...Array.from({ length: 40 }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >> (i % 24))];
const LONGS = [...INTS.map(BigInt), 9007199254740993n, -9223372036854775808n, 9223372036854775807n, 1n << 40n, -(1n << 53n) - 1n];
const BOX_VALUES: Record<string, unknown[]> = {
  I: INTS, J: LONGS, S: INTS.map((v) => (v << 16) >> 16), B: INTS.map((v) => (v << 24) >> 24), C: INTS.map((v) => v & 0xffff),
  F: [0, -0, 1.5, -2.25, NaN, Infinity, 3.4028234663852886e38, 1.401298464324817e-45], D: [0, -0, 0.1, -1e300, NaN, -Infinity, 5e-324, 2 ** 53], Z: [0, 1],
};
const BOXES: Record<string, string> = { I: "Integer", J: "Long", S: "Short", B: "Byte", C: "Character", F: "Float", D: "Double", Z: "Boolean" };

test("boxing and unboxing intrinsics match their AOSP bodies, cache identity included", async () => {
  for (const [d, name] of Object.entries(BOXES)) {
    const cls = "java/lang/" + name;
    const [valueOf, base] = await pair(cls, `static valueOf(${d})L${cls};`);
    const getter = ({ I: "intValue()I", J: "longValue()J", C: "charValue()C", F: "floatValue()F", D: "doubleValue()D", Z: "booleanValue()Z" } as Record<string, string>)[d];
    const get = getter ? await pair(cls, getter) : null;
    for (const v of BOX_VALUES[d]) {
      const mine = await valueOf(v), theirs = await base(v);
      expect(mine.constructor).toBe(theirs.constructor);
      expect(mine === theirs).toBe(theirs === await base(v));
      if (get) expect(Object.is(get[0].call(mine), get[1].call(theirs))).toBe(true);
    }
  }
});

test("box equality, hashing and ordering intrinsics match their AOSP bodies", async () => {
  const others = [null, boxInt(5), await scall("java/lang/Long", "valueOf", "(J)Ljava/lang/Long;", 5n), "5", jarray([], "Ljava/lang/Object;")];
  for (const [d, sigs] of [["I", ["equals(Ljava/lang/Object;)Z", "hashCode()I", "compareTo(Ljava/lang/Integer;)I"]],
    ["J", ["equals(Ljava/lang/Object;)Z"]], ["C", ["equals(Ljava/lang/Object;)Z"]]] as const) {
    const cls = "java/lang/" + BOXES[d];
    const valueOf = (await pair(cls, `static valueOf(${d})L${cls};`))[1];
    const boxes = BOX_VALUES[d].slice(0, 20).map((v) => valueOf(v));
    for (const sig of sigs) {
      const [fn, base] = await pair(cls, sig);
      for (const self of boxes) for (const o of [...boxes.slice(0, 8), valueOf(BOX_VALUES[d][3]), ...others]) {
        if (sig.startsWith("compareTo") && o !== null && boxDesc(o) !== d) continue;
        expect(await result(fn, self, [o])).toEqual(await result(base, self, [o]));
      }
    }
  }
});

test("integer formatting and parsing intrinsics match their AOSP bodies", async () => {
  const I = "java/lang/Integer", J = "java/lang/Long";
  const radices = [-1, 0, 1, 2, 8, 10, 16, 36, 37];
  const cases: [string, string, unknown[][]][] = [
    [I, "static toString(I)Ljava/lang/String;", INTS.map((v) => [v])],
    [I, "static toString(II)Ljava/lang/String;", INTS.flatMap((v) => radices.map((r) => [v, r]))],
    [I, "static toHexString(I)Ljava/lang/String;", INTS.map((v) => [v])],
    [I, "static toOctalString(I)Ljava/lang/String;", INTS.map((v) => [v])],
    [I, "static toBinaryString(I)Ljava/lang/String;", INTS.map((v) => [v])],
    [J, "static toString(J)Ljava/lang/String;", LONGS.map((v) => [v])],
    [J, "static toString(JI)Ljava/lang/String;", LONGS.flatMap((v) => radices.map((r) => [v, r]))],
    [J, "static toHexString(J)Ljava/lang/String;", LONGS.map((v) => [v])],
  ];
  const texts = [...INTS.map(String), ...LONGS.map(String), ...INTS.map((v) => v.toString(16)), "", "-", "+", "+0", "-0", "007", " 1", "1 ",
    "2147483648", "-2147483649", "9223372036854775808", "-9223372036854775809", "99999999999999999999", "0x10", "1_000", "12z",
    "١٢٣", "１２", "-٤", "zz", "ZZ", "1e3", "1.0", null];
  for (const [cls, sig] of [[I, "static parseInt(Ljava/lang/String;I)I"], [J, "static parseLong(Ljava/lang/String;I)J"]] as const)
    cases.push([cls, sig, texts.flatMap((s) => radices.map((r) => [s, r]))]);
  for (const [cls, sig, inputs] of cases) {
    const [fn, base] = await pair(cls, sig);
    for (const args of inputs) expect(await result(fn, null, args)).toEqual(await result(base, null, args));
  }
});

test("Math's intrinsics match their AOSP bodies", async () => {
  const D = [0, -0, 0.5, -0.5, 1.5, -2.5, 0.49999999999999994, -0.49999999999999994, 2 ** 52 + 1, -(2 ** 53), 1e300, -1e-300,
    5e-324, 2147483647.5, -2147483648.5, 9.3e18, -9.3e18, Infinity, -Infinity, NaN, ...INTS.map((v) => v / 7)];
  const F = D.map(Math.fround);
  const cases: [string, unknown[][]][] = [
    ["static abs(I)I", INTS.map((v) => [v])], ["static abs(J)J", LONGS.map((v) => [v])],
    ["static abs(F)F", F.map((v) => [v])], ["static abs(D)D", D.map((v) => [v])],
    ["static round(F)I", F.map((v) => [v])], ["static round(D)J", D.map((v) => [v])],
    ["static signum(F)F", F.map((v) => [v])], ["static signum(D)D", D.map((v) => [v])],
  ];
  for (const t of ["max", "min"]) {
    cases.push([`static ${t}(II)I`, INTS.map((v, i) => [v, INTS[(i * 7) % INTS.length]])]);
    cases.push([`static ${t}(JJ)J`, LONGS.map((v, i) => [v, LONGS[(i * 7) % LONGS.length]])]);
    cases.push([`static ${t}(FF)F`, F.flatMap((v) => [[v, 0], [v, -0], [v, NaN], [0, v], [v, 1.5]])]);
    cases.push([`static ${t}(DD)D`, D.flatMap((v) => [[v, 0], [v, -0], [v, NaN], [0, v], [v, 1.5]])]);
  }
  for (const t of ["floorDiv", "floorMod"]) cases.push([`static ${t}(II)I`, INTS.flatMap((v) => [0, 1, -1, 3, -7, 2147483647, -2147483648].map((d) => [v, d]))]);
  for (const [sig, inputs] of cases) {
    const [fn, base] = await pair("java/lang/Math", sig);
    for (const args of inputs) {
      const [mine, theirs] = [await result(fn, null, args), await result(base, null, args)] as { value?: unknown }[];
      if (typeof mine.value === "number" && Number.isNaN(mine.value)) expect(theirs.value).toBeNaN();
      else expect(mine).toEqual(theirs);
    }
  }
});

test("Enum's intrinsics match their AOSP bodies", async () => {
  const [[cmp, cmpBase], [shared, sharedBase], [valueOf, valueOfBase]] = await Promise.all(["compareTo(Ljava/lang/Enum;)I",
    "static getSharedConstants(Ljava/lang/Class;)[Ljava/lang/Enum;", "static valueOf(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;"]
    .map((sig) => pair("java/lang/Enum", sig)));
  const classes = ["java/lang/Thread$State", "java/util/concurrent/TimeUnit"].map((c) => rt.classFor(c));
  const constants = (await Promise.all(classes.map((c) => sharedBase(c)))).flat();
  for (const a of constants) for (const b of [...constants, null]) expect(await result(cmp, a, [b])).toEqual(await result(cmpBase, a, [b]));
  for (const c of [...classes, rt.classFor("java/lang/String"), null]) {
    expect(await result(shared, null, [c])).toEqual(await result(sharedBase, null, [c]));
    for (const name of ["NEW", "SECONDS", "TERMINATED", "new", "", null]) expect(await result(valueOf, null, [c, name])).toEqual(await result(valueOfBase, null, [c, name]));
  }
});

// The TS builders stand for libcore's whole StringBuilder and StringBuffer, so libcore's run in a
// process that serves them from bytecode; both take the same generated operations.
test("StringBuilder and StringBuffer match libcore's over generated operation sequences", async () => {
  const run = (env: Record<string, string>) => new Response(Bun.spawn(["bun", new URL("fixtures/builder-ops.ts", import.meta.url).pathname],
    { env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore" }).stdout).text();
  const [mine, theirs] = await Promise.all([run({}), run({ WEBDROID_BYTECODE: "java/lang/StringBuilder$,java/lang/StringBuffer$" })]);
  const [a, b] = [mine.trim().split("\n"), theirs.trim().split("\n")];
  expect(a.length).toBe(3000);
  expect(a.filter((line, i) => line !== b[i]).slice(0, 5)).toEqual([]);
}, 120_000);
