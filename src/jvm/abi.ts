// Name mangling + descriptor utilities. One canonical scheme for compiled & native code.
//
// Java values in JS:
//   int/short/byte/char/float/double → number (booleans are 0/1 numbers, NEVER JS true/false)
//   long → BigInt   |   String → JS string primitive   |   null → null
//   prim arrays → TypedArrays (byte=Int8, bool=Uint8, char=Uint16, short=Int16,
//     int=Int32, long=BigInt64, float=Float32, double=Float64)
//   object arrays → JS Array with $t = element descriptor tag
//   objects → JS class instances (unified hierarchy: dex + native classes)
//
// Methods:      proto[`m$name$H` ] where H = hash(fullMethodDescriptor)
// Constructors: proto[`i$H`]
// Static via ctor: Ctor[`m$...`], Ctor[`s$fieldName`]
// Instance fields: `f$name$H2` where H2 = hash(declaringClass + name) — avoids R8 shadowing collisions

function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const nameRe = /[^A-Za-z0-9_$]/g;
function safeName(n: string): string {
  return n.replace(nameRe, "_");
}

// Two-level memo (name → desc → mangled). vcall mangles on every dynamic dispatch — per
// text line per frame, per view per draw — and the uncached path is a char loop over the
// descriptor plus a regex plus two concats. Nested maps so a lookup allocates nothing.
const mangleMemo = new Map<string, Map<string, string>>();
/** mangle method: name + full descriptor like "(ILjava/lang/String;)V" */
export function mangleMethod(name: string, desc: string): string {
  let byDesc = mangleMemo.get(name);
  if (byDesc === undefined) mangleMemo.set(name, (byDesc = new Map()));
  const hit = byDesc.get(desc);
  if (hit !== undefined) return hit;
  const m = name === "<init>" ? "i$" + hash36(desc)
    : name === "<clinit>" ? "$clinit"
    : "m$" + safeName(name) + "$" + hash36(desc);
  byDesc.set(desc, m);
  demangled.set(m, [name, desc]);
  return m;
}
const demangled = new Map<string, [string, string]>();
export const demangle = (mangled: string): [string, string] | undefined => demangled.get(mangled);
/** a reflect.Proxy materialises a method on first use; set by jreflect, consulted by jmethod */
export const lateMethod = { find: null as ((o: unknown, name: string, desc: string) => JMethod | undefined) | null };

/** mangle instance field. declCls = "java/lang/Object" form */
export function mangleField(declCls: string, name: string): string {
  return "f$" + safeName(name) + "$" + hash36(declCls);
}

export function mangleStaticField(name: string, desc?: string): string {
  return "s$" + safeName(name) + (desc ? "$" + hash36(desc) : "");
}

/** "(ILjava/lang/String;[J)V" → { params: ["I","Ljava/lang/String;","[J"], ret: "V" } */
const descMemo = new Map<string, { params: string[]; ret: string }>();
export function parseMethodDesc(desc: string): { params: string[]; ret: string } {
  let hit = descMemo.get(desc);
  if (hit) return hit;
  const params: string[] = [];
  let i = 1;
  while (desc[i] !== ")") {
    const start = i;
    while (desc[i] === "[") i++;
    if (desc[i] === "L") { while (desc[i] !== ";") i++; }
    i++;
    params.push(desc.slice(start, i));
  }
  descMemo.set(desc, (hit = { params, ret: desc.slice(i + 1) }));
  return hit;
}

export const dotName = (internal: string) => internal.replace(/\//g, ".");
export const slashName = (binary: string) => binary.replace(/\./g, "/");
export const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

export function isWide(desc: string): boolean { return desc === "J" || desc === "D"; }

/** default value of a field of the given type descriptor */
export function defaultValue(desc: string): 0 | 0n | null {
  return desc[0] === "J" ? 0n : desc[0] === "L" || desc[0] === "[" ? null : 0;
}
/** the same, as a JS source literal */
export function defaultVal(desc: string): string {
  const v = defaultValue(desc);
  return typeof v === "bigint" ? "0n" : String(v);
}

/** "Ljava/lang/String;" → "java/lang/String"; passthrough for already-plain names */
export function descToName(desc: string): string {
  return desc[0] === "L" ? desc.slice(1, -1) : desc;
}

/** primitive descriptor ↔ Java type name */
export const PRIM_NAME: Record<string, string> = { I: "int", J: "long", F: "float", D: "double", Z: "boolean", B: "byte", C: "char", S: "short", V: "void" };
export const PRIM_DESC: Record<string, string> = Object.fromEntries(Object.entries(PRIM_NAME).map(([d, n]) => [n, d]));

/** a primitive array of `n` elements, by type descriptor — the one mapping of Java's element
 *  types onto TypedArrays (byte=Int8, boolean=Uint8, char=Uint16, long=BigInt64). */
export const newPrimArray: Record<string, (n: number) => unknown> = {
  Z: (n) => new Uint8Array(n), B: (n) => new Int8Array(n), C: (n) => new Uint16Array(n), S: (n) => new Int16Array(n),
  I: (n) => new Int32Array(n), J: (n) => new BigInt64Array(n), F: (n) => new Float32Array(n), D: (n) => new Float64Array(n),
};

/** tag a JS array as a Java `elem[]` for compiled code (in place, returns the same array) */
export function jarray<T>(items: T[], elem = "Ljava/lang/Object;"): T[] {
  (items as { $t?: string }).$t = elem;
  return items;
}
export const strArray = (a: readonly string[]) => jarray([...a], "Ljava/lang/String;");

/** code units → string, chunked to stay under the spread argument limit */
export function charsToString(chars: Uint16Array | Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i += 1024) {
    s += String.fromCharCode(...chars.subarray(off + i, off + Math.min(len, i + 1024)));
  }
  return s;
}

export type JMethod = (this: unknown, ...a: unknown[]) => unknown;
export function jmethod(o: unknown, mangled: string): JMethod | undefined {
  const f = (o as Record<string, JMethod | undefined> | null)?.[mangled];
  if (f !== undefined || !lateMethod.find) return f;
  const nd = demangled.get(mangled);
  return nd ? lateMethod.find(o, nd[0], nd[1]) : undefined;
}

const bits = new DataView(new ArrayBuffer(8));
export function intBitsToFloat(i: number): number { bits.setInt32(0, i | 0); return bits.getFloat32(0); }
export function floatToIntBits(f: number): number { bits.setFloat32(0, f); return bits.getInt32(0); }
export function longBitsToDouble(l: bigint): number { bits.setBigInt64(0, l); return bits.getFloat64(0); }
export function doubleToLongBits(d: number): bigint { bits.setFloat64(0, d); return bits.getBigInt64(0); }
