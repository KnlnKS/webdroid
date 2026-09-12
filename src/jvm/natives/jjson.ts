// org.json over plain JS objects/arrays.

import { rt, JObj, type NativeSpec } from "../runtime";
import { defineException, boxInt, box, JLong, JDouble, JBool, TRUE, FALSE, vcall } from "./jlang";
import { mkIter, newLinkedHashSet, toJsArray } from "./jutil";

class JJSONObject extends JObj { o: Record<string, unknown> = Object.create(null); }
class JJSONArray extends JObj { a: unknown[] = []; }
class JJSONTokener extends JObj {
  source = ""; pos = 0;
  init(source: string) { this.source = source?.charCodeAt(0) === 0xfeff ? source.slice(1) : source; this.pos = 0; }
  error(message: string): never { throw rt.mkThrowable("org/json/JSONException", `${message} at character ${this.pos} of ${this.source}`); }
  clean(): string {
    while (this.pos < this.source.length) {
      const c = this.source[this.pos++], next = this.source[this.pos];
      if (" \t\r\n".includes(c)) continue;
      if (c === "/" && next === "*") {
        const end = this.source.indexOf("*/", this.pos + 1);
        if (end < 0) this.error("Unterminated comment");
        this.pos = end + 2; continue;
      }
      if (c === "#" || c === "/" && next === "/") {
        while (this.pos < this.source.length && !"\r\n".includes(this.source[this.pos])) this.pos++;
        continue;
      }
      return c;
    }
    return "";
  }
  string(quote: string): string {
    let out = "", start = this.pos;
    while (this.pos < this.source.length) {
      const c = this.source[this.pos++];
      if (c === quote) return out + this.source.slice(start, this.pos - 1);
      if (c !== "\\") continue;
      out += this.source.slice(start, this.pos - 1);
      if (this.pos === this.source.length) this.error("Unterminated escape sequence");
      const e = this.source[this.pos++];
      if (e === "u") {
        const hex = this.source.slice(this.pos, this.pos + 4);
        if (!/^[\da-f]{4}$/i.test(hex)) this.error("Invalid unicode escape");
        out += String.fromCharCode(parseInt(hex, 16)); this.pos += 4;
      } else out += e === "b" ? "\b" : e === "f" ? "\f" : e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e;
      start = this.pos;
    }
    return this.error("Unterminated string");
  }
  value(): unknown {
    const c = this.clean();
    if (!c) this.error("End of input");
    if (c === '"' || c === "'") return this.string(c);
    if (c === "{") {
      const o: Record<string, unknown> = Object.create(null);
      const first = this.clean();
      if (first === "}") return o;
      if (!first) this.error("Unterminated object");
      this.pos--;
      for (;;) {
        const name = this.value();
        if (typeof name !== "string") this.error("Names must be strings");
        const separator = this.clean();
        if (separator !== ":" && separator !== "=") this.error("Expected ':' after " + name);
        if (this.source[this.pos] === ">") this.pos++;
        o[name] = this.value();
        const end = this.clean();
        if (end === "}") return o;
        if (end !== "," && end !== ";") this.error("Unterminated object");
      }
    }
    if (c === "[") {
      const a: unknown[] = [];
      let trailing = false;
      for (;;) {
        const next = this.clean();
        if (!next) this.error("Unterminated array");
        if (next === "]") { if (trailing) a.push(null); return a; }
        if (next === "," || next === ";") { a.push(null); trailing = true; continue; }
        this.pos--; a.push(this.value());
        const end = this.clean();
        if (end === "]") return a;
        if (end !== "," && end !== ";") this.error("Unterminated array");
        trailing = true;
      }
    }
    const start = --this.pos;
    while (this.pos < this.source.length && !"{}[]/\\:,=;# \t\f\r\n".includes(this.source[this.pos])) this.pos++;
    const literal = this.source.slice(start, this.pos), lower = literal.toLowerCase();
    if (!literal) this.error("Expected literal value");
    if (lower === "null") return null;
    if (lower === "true" || lower === "false") return lower === "true";
    if (/^0x[\da-f]+$/i.test(literal)) return parseInt(literal.slice(2), 16);
    if (/^0[0-7]+$/.test(literal)) return parseInt(literal, 8);
    const n = Number(literal);
    return Number.isNaN(n) ? literal : n;
  }
}
function parseJSON(source: string): unknown { const t = new JJSONTokener(); t.init(source); return t.value(); }
rt.register({
  name: "org/json/JSONTokener", ctor: JJSONTokener,
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JJSONTokener, source: string) { this.init(source); },
    "nextValue()Ljava/lang/Object;": function (this: JJSONTokener) { return jsonWrap(this.value()); },
    "more()Z": function (this: JJSONTokener) { return this.pos < this.source.length ? 1 : 0; },
  },
});
/** get()/opt() hand out Java objects: numbers box the way org.json parses them (Integer when it
 *  fits, else Long, else Double), booleans box, strings are already Java strings */
let wrapLinked = false;
function jsonWrap(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (!wrapLinked) {
    for (const n of ["org/json/JSONArray", "org/json/JSONObject", "java/lang/Integer", "java/lang/Long", "java/lang/Double", "java/lang/Boolean"]) rt.link(n);
    wrapLinked = true;
  }
  if (typeof v === "object") {
    if (Array.isArray(v)) { const a = new JJSONArray(); a.a = v; return a; }
    if (v instanceof JObj) return v;
    const o = new JJSONObject(); o.o = v as Record<string, unknown>; return o;
  }
  if (typeof v === "number") {
    if (!Number.isInteger(v)) return box(JDouble, v);
    return v >= -2147483648 && v <= 2147483647 ? boxInt(v) : box(JLong, BigInt(v));
  }
  if (typeof v === "bigint") return box(JLong, v);
  if (typeof v === "boolean") return v ? TRUE : FALSE;
  return v;
}
const isObj = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
/** the typed get/opt family both containers answer, keyed by name on an object and by index on an array */
function accessors<S>(K: string, read: (self: S, k: never) => unknown): NonNullable<NativeSpec["methods"]> {
  const num = (self: S, k: never) => Number(read(self, k));
  const O = "Lorg/json/JSONObject;", A = "Lorg/json/JSONArray;";
  return {
    [`opt(${K})Ljava/lang/Object;`]: function (this: S, k: never) { return jsonWrap(read(this, k) ?? null); },
    [`optString(${K})Ljava/lang/String;`]: function (this: S, k: never) { const v = read(this, k); return v === undefined ? "" : String(v); },
    [`optString(${K}Ljava/lang/String;)Ljava/lang/String;`]: function (this: S, k: never, d: string) { const v = read(this, k); return v === undefined ? d : String(v); },
    [`getInt(${K})I`]: function (this: S, k: never) { return Math.trunc(num(this, k)) | 0; },
    [`optInt(${K})I`]: function (this: S, k: never) { return Math.trunc(Number(read(this, k) ?? 0)) | 0; },
    [`optInt(${K}I)I`]: function (this: S, k: never, d: number) { const v = num(this, k); return Number.isFinite(v) ? Math.trunc(v) | 0 : d; },
    [`getLong(${K})J`]: function (this: S, k: never) { return BigInt(Math.trunc(Number(read(this, k) ?? 0))); },
    [`optLong(${K})J`]: function (this: S, k: never) { return BigInt(Math.trunc(Number(read(this, k) ?? 0))); },
    [`optLong(${K}J)J`]: function (this: S, k: never, d: bigint) { const v = num(this, k); return Number.isFinite(v) ? BigInt(Math.trunc(v)) : d; },
    [`getDouble(${K})D`]: function (this: S, k: never) { return Number(read(this, k) ?? 0); },
    [`optDouble(${K})D`]: function (this: S, k: never) { const v = num(this, k); return Number.isFinite(v) ? v : Number.NaN; },
    [`optDouble(${K}D)D`]: function (this: S, k: never, d: number) { const v = num(this, k); return Number.isFinite(v) ? v : d; },
    [`getBoolean(${K})Z`]: function (this: S, k: never) { return read(this, k) ? 1 : 0; },
    [`optBoolean(${K})Z`]: function (this: S, k: never) { return read(this, k) ? 1 : 0; },
    [`optBoolean(${K}Z)Z`]: function (this: S, k: never, d: number) { const v = read(this, k); return v === undefined ? d : v ? 1 : 0; },
    [`optJSONObject(${K})${O}`]: function (this: S, k: never) { const v = read(this, k); return isObj(v) ? jsonWrap(v) : null; },
    [`getJSONArray(${K})${A}`]: function (this: S, k: never) {
      const v = read(this, k);
      if (!Array.isArray(v)) throw rt.mkThrowable("org/json/JSONException", k + " is not an array");
      return jsonWrap(v);
    },
    [`optJSONArray(${K})${A}`]: function (this: S, k: never) { const v = read(this, k); return Array.isArray(v) ? jsonWrap(v) : null; },
    [`isNull(${K})Z`]: function (this: S, k: never) { const v = read(this, k); return v === null || v === undefined ? 1 : 0; },
  };
}
function jsonUnwrap(v: unknown): unknown {
  if (v instanceof JJSONObject) return v.o;
  if (v instanceof JJSONArray) return v.a;
  if (v instanceof JBool) return !!v.v;
  if (typeof v === "object" && v !== null && "v" in v) return jsonUnwrap((v as { v: unknown }).v);
  // a boxed Long arrives as a bigint, which JSON.stringify refuses; org.json stores the value,
  // and every read path (getLong/optLong) boxes it back
  if (typeof v === "bigint") return Number(v);
  return v;
}
rt.register({
  name: "org/json/JSONObject", ctor: JJSONObject,
  statics: { NULL: null },
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: JJSONObject, s: string) {
      const value = parseJSON(s);
      if (!isObj(value)) throw rt.mkThrowable("org/json/JSONException", "Value is not an object");
      this.o = value as Record<string, unknown>;
    },
    "<init>(Lorg/json/JSONObject;[Ljava/lang/String;)V": function (this: JJSONObject, src: JJSONObject, names: string[]) {
      for (const k of names) if (k in src.o) this.o[k] = src.o[k];
    },
    "<init>(Ljava/util/Map;)V": async function (this: JJSONObject, m: unknown) {
      for (const e of await toJsArray(await vcall(m, "entrySet", "()Ljava/util/Set;"))) {
        this.o[String(await vcall(e, "getKey", "()Ljava/lang/Object;"))] = jsonUnwrap(await vcall(e, "getValue", "()Ljava/lang/Object;"));
      }
    },
    "static quote(Ljava/lang/String;)Ljava/lang/String;": (s: string | null) => JSON.stringify(s ?? "").replaceAll("/", "\\/"),
    "put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;": function (this: JJSONObject, k: string, v: unknown) {
      this.o[k] = jsonUnwrap(v);
      return this;
    },
    "putOpt(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;": function (this: JJSONObject, k: string, v: unknown) {
      if (k !== null && v !== null && v !== undefined) this.o[k] = jsonUnwrap(v);
      return this;
    },
    "put(Ljava/lang/String;I)Lorg/json/JSONObject;": function (this: JJSONObject, k: string, v: number) { this.o[k] = v; return this; },
    "put(Ljava/lang/String;J)Lorg/json/JSONObject;": function (this: JJSONObject, k: string, v: bigint) { this.o[k] = Number(v); return this; },
    "put(Ljava/lang/String;D)Lorg/json/JSONObject;": function (this: JJSONObject, k: string, v: number) { this.o[k] = v; return this; },
    "put(Ljava/lang/String;Z)Lorg/json/JSONObject;": function (this: JJSONObject, k: string, v: number) { this.o[k] = !!v; return this; },
    "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JJSONObject, k: string) {
      if (!(k in this.o)) throw rt.mkThrowable("org/json/JSONException", "No value for " + k);
      return jsonWrap(this.o[k]);
    },
    ...accessors("Ljava/lang/String;", (self: JJSONObject, k: string) => self.o[k]),
    "getString(Ljava/lang/String;)Ljava/lang/String;": function (this: JJSONObject, k: string) {
      if (!(k in this.o)) throw rt.mkThrowable("org/json/JSONException", "No value for " + k);
      return String(this.o[k]);
    },
    "getJSONObject(Ljava/lang/String;)Lorg/json/JSONObject;": function (this: JJSONObject, k: string) {
      if (!isObj(this.o[k])) throw rt.mkThrowable("org/json/JSONException", k + " is not an object");
      return jsonWrap(this.o[k]);
    },
    "has(Ljava/lang/String;)Z": function (this: JJSONObject, k: string) { return k in this.o ? 1 : 0; },
    "remove(Ljava/lang/String;)Ljava/lang/Object;": function (this: JJSONObject, k: string) {
      const v = jsonWrap(this.o[k] ?? null);
      delete this.o[k];
      return v;
    },
    "length()I": function (this: JJSONObject) { return Object.keys(this.o).length; },
    "keys()Ljava/util/Iterator;": function (this: JJSONObject) { return mkIter(Object.keys(this.o)); },
    "keySet()Ljava/util/Set;": function (this: JJSONObject) { return newLinkedHashSet(Object.keys(this.o)); },
    "names()Lorg/json/JSONArray;": function (this: JJSONObject) {
      const ks = Object.keys(this.o);
      return ks.length ? jsonWrap(ks) : null;
    },
    "toString()Ljava/lang/String;": function (this: JJSONObject) { return JSON.stringify(this.o); },
    "toString(I)Ljava/lang/String;": function (this: JJSONObject, indent: number) { return JSON.stringify(this.o, null, indent); },
  },
});
rt.register({
  name: "org/json/JSONArray", ctor: JJSONArray,
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: JJSONArray, s: string) {
      const value = parseJSON(s);
      if (!Array.isArray(value)) throw rt.mkThrowable("org/json/JSONException", "Value is not an array");
      this.a = value;
    },
    "<init>(Ljava/util/Collection;)V": async function (this: JJSONArray, c: unknown) { this.a = c === null ? [] : (await toJsArray(c)).map(jsonUnwrap); },
    "put(Ljava/lang/Object;)Lorg/json/JSONArray;": function (this: JJSONArray, v: unknown) { this.a.push(jsonUnwrap(v)); return this; },
    "put(I)Lorg/json/JSONArray;": function (this: JJSONArray, v: number) { this.a.push(v); return this; },
    "put(D)Lorg/json/JSONArray;": function (this: JJSONArray, v: number) { this.a.push(v); return this; },
    "put(Z)Lorg/json/JSONArray;": function (this: JJSONArray, v: number) { this.a.push(!!v); return this; },
    "length()I": function (this: JJSONArray) { return this.a.length; },
    "get(I)Ljava/lang/Object;": function (this: JJSONArray, i: number) { return jsonWrap(this.a[i] ?? null); },
    ...accessors("I", (self: JJSONArray, i: number) => self.a[i]),
    "getJSONObject(I)Lorg/json/JSONObject;": function (this: JJSONArray, i: number) { return jsonWrap(this.a[i]); },
    "getString(I)Ljava/lang/String;": function (this: JJSONArray, i: number) { return String(this.a[i]); },
    "remove(I)Ljava/lang/Object;": function (this: JJSONArray, i: number) { return jsonWrap(this.a.splice(i, 1)[0] ?? null); },
    "put(ILjava/lang/Object;)Lorg/json/JSONArray;": function (this: JJSONArray, i: number, v: unknown) {
      while (this.a.length < i) this.a.push(null);
      this.a[i] = jsonUnwrap(v);
      return this;
    },
    "put(J)Lorg/json/JSONArray;": function (this: JJSONArray, v: bigint) { this.a.push(Number(v)); return this; },
    "toString()Ljava/lang/String;": function (this: JJSONArray) { return JSON.stringify(this.a); },
    "toString(I)Ljava/lang/String;": function (this: JJSONArray, indent: number) { return JSON.stringify(this.a, null, indent); },
  },
});
defineException("org/json/JSONException", "java/lang/Exception");
