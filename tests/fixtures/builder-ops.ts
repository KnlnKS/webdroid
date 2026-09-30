// bun tests/fixtures/builder-ops.ts: outcomes of generated StringBuilder/StringBuffer operations, one JSON line each.
// Run with WEBDROID_BYTECODE=java/lang/StringBuilder$,java/lang/StringBuffer$ for libcore's.
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { rt } = await import(W + "/src/jvm/runtime");
await import(W + "/src/natives");
const { loadLibcore, mountApexData } = await import(W + "/tests/java");
const { vcall, newObj } = await import(W + "/src/jvm/natives/jlang");
const { boxInt } = await import(W + "/src/jvm/natives/jbox");
await loadLibcore();
await mountApexData();
rt.linkNatives();
console.warn = () => {};
let s = 7;
const rnd = (n: number) => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) % n;
const TEXTS = ["", "a", "héllo", "😀", "x\ud800y", "\udc00z", "abcabc", "ÿĀ", "longer text with spaces"];
const text = () => TEXTS[rnd(TEXTS.length)];
const chars = (t: string) => Uint16Array.from(t, (_, i) => t.charCodeAt(i));
const index = (len: number) => rnd(len + 4) - 2;
const INTS = [0, 1, -1, 127, 128, -128, 255, 1000, -32768, 65535, 2147483647, -2147483648, 123456789, -987654];
const LONGS = [...INTS.map(BigInt), 9007199254740993n, -9223372036854775808n, 9223372036854775807n];
const DOUBLES = [0, -0, 0.1, 1.5, -2.25, 1e7, 1.0e-5, 123456.789, NaN, Infinity, -Infinity, 1e300, 5e-324];
for (const name of ["StringBuilder", "StringBuffer"]) {
  const cls = "java/lang/" + name, L = `L${cls};`;
  const ops: [string, string, (len: number) => unknown[]][] = [
    ["append", `(Ljava/lang/String;)${L}`, () => [rnd(8) ? text() : null]],
    ["append", `(Ljava/lang/CharSequence;)${L}`, () => [rnd(8) ? text() : null]],
    ["append", `(Ljava/lang/CharSequence;II)${L}`, () => { const t = text(); return [t, index(t.length), index(t.length)]; }],
    ["append", `([C)${L}`, () => [chars(text())]],
    ["append", `([CII)${L}`, () => { const t = text(); return [chars(t), index(t.length), rnd(4)]; }],
    ["append", `(Z)${L}`, () => [rnd(2)]], ["append", `(C)${L}`, () => [text().charCodeAt(0) || 0x41]],
    ["append", `(I)${L}`, () => [INTS[rnd(INTS.length)]]], ["append", `(J)${L}`, () => [LONGS[rnd(LONGS.length)]]],
    ["append", `(F)${L}`, () => [Math.fround(DOUBLES[rnd(DOUBLES.length)])]], ["append", `(D)${L}`, () => [DOUBLES[rnd(DOUBLES.length)]]],
    ["append", `(Ljava/lang/Object;)${L}`, () => [rnd(3) ? boxInt(INTS[rnd(INTS.length)]) : null]],
    ["appendCodePoint", `(I)${L}`, () => [[0x41, 0xe9, 0x1f600, 0x10ffff, 0xd800, -1, 0x110000][rnd(7)]]],
    ["insert", `(ILjava/lang/String;)${L}`, (n) => [index(n), rnd(8) ? text() : null]],
    ["insert", `(IC)${L}`, (n) => [index(n), 0x263a]], ["insert", `(II)${L}`, (n) => [index(n), INTS[rnd(INTS.length)]]],
    ["insert", `(IJ)${L}`, (n) => [index(n), LONGS[rnd(LONGS.length)]]], ["insert", `(IZ)${L}`, (n) => [index(n), rnd(2)]],
    ["insert", `(ID)${L}`, (n) => [index(n), DOUBLES[rnd(DOUBLES.length)]]], ["insert", `(IF)${L}`, (n) => [index(n), Math.fround(2.5)]],
    ["insert", `(I[C)${L}`, (n) => [index(n), chars(text())]],
    ["insert", `(I[CII)${L}`, (n) => { const t = text(); return [index(n), chars(t), index(t.length), rnd(4)]; }],
    ["insert", `(ILjava/lang/CharSequence;II)${L}`, (n) => { const t = text(); return [index(n), t, index(t.length), index(t.length)]; }],
    ["insert", `(ILjava/lang/Object;)${L}`, (n) => [index(n), rnd(3) ? boxInt(7) : null]],
    ["delete", `(II)${L}`, (n) => [index(n), index(n)]], ["deleteCharAt", `(I)${L}`, (n) => [index(n)]],
    ["replace", `(IILjava/lang/String;)${L}`, (n) => [index(n), index(n), text()]],
    ["reverse", `()${L}`, () => []], ["setCharAt", "(IC)V", (n) => [index(n), 0xd83d]],
    ["setLength", "(I)V", (n) => [index(n)]], ["charAt", "(I)C", (n) => [index(n)]],
    ["codePointAt", "(I)I", (n) => [index(n)]], ["codePointBefore", "(I)I", (n) => [index(n)]],
    ["codePointCount", "(II)I", (n) => [index(n), index(n)]], ["offsetByCodePoints", "(II)I", (n) => [index(n), rnd(5) - 2]],
    ["indexOf", "(Ljava/lang/String;I)I", (n) => [text().slice(0, 2), index(n)]], ["lastIndexOf", "(Ljava/lang/String;I)I", (n) => [text().slice(0, 2), index(n)]],
    ["indexOf", "(Ljava/lang/String;)I", () => [text().slice(1, 3)]], ["lastIndexOf", "(Ljava/lang/String;)I", () => [text().slice(1, 3)]],
    ["substring", "(I)Ljava/lang/String;", (n) => [index(n)]], ["substring", "(II)Ljava/lang/String;", (n) => [index(n), index(n)]],
    ["subSequence", "(II)Ljava/lang/CharSequence;", (n) => [index(n), index(n)]],
    ["length", "()I", () => []], ["capacity", "()I", () => []], ["ensureCapacity", "(I)V", () => [rnd(100) - 10]], ["trimToSize", "()V", () => []],
    ["getChars", "(II[CI)V", (n) => [index(n), index(n), new Uint16Array(6), rnd(3)]],
    ["compareTo", `(${L})I`, () => []],
  ];
  const inits: [string, () => unknown[]][] = [["()V", () => []], ["(I)V", () => [rnd(20)]], ["(Ljava/lang/String;)V", () => [text()]], ["(Ljava/lang/CharSequence;)V", () => [text()]]];
  for (let k = 0; k < 1500; k++) {
    const [idesc, iargs] = inits[rnd(inits.length)], ia = iargs();
    const sb = await newObj(cls, idesc, ...ia);
    for (let j = rnd(4); j > 0; j--) await vcall(sb, "append", `(Ljava/lang/String;)${L}`, text());
    const [op, desc, args] = ops[rnd(ops.length)];
    const a = op === "compareTo" ? [await newObj(cls, "(Ljava/lang/String;)V", text())] : args(await vcall(sb, "length", "()I"));
    let out: unknown;
    try { const v = await vcall(sb, op, desc, ...a); out = { value: v === sb ? "this" : typeof v === "bigint" ? String(v) : v }; }
    catch (e) { const t = rt.jx(e); out = { threw: t.constructor.$i.name, msg: t.constructor.$i.name === "java/lang/NullPointerException" ? "" : t.msg }; }
    const shown = a.map((x) => (x instanceof Uint16Array ? [...x] : typeof x === "bigint" ? String(x) : typeof x === "object" && x !== null ? "obj" : x));
    console.log(JSON.stringify([k, name, idesc, op, desc, shown, out, await vcall(sb, "toString", "()Ljava/lang/String;")]));
  }
}
process.exit(0);
