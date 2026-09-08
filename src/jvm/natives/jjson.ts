// org.json over plain JS objects/arrays.

import { rt, JObj } from "../runtime";
import { defineException, boxInt, box, JLong, JDouble, JBool, TRUE, FALSE } from "./jlang";
import { mkIter, newLinkedHashSet } from "./jutil";

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
function jsonWrap(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if (Array.isArray(v)) { rt.link("org/json/JSONArray"); const a = new JJSONArray(); a.a = v; return a; }
    if (v instanceof JObj) return v;
    rt.link("org/json/JSONObject"); const o = new JJSONObject(); o.o = v as Record<string, unknown>; return o;
  }
  if (typeof v === "number") {
    if (Number.isInteger(v)) {
      const small = v >= -2147483648 && v <= 2147483647;
      rt.link(small ? "java/lang/Integer" : "java/lang/Long");
      return small ? boxInt(v) : box(JLong, BigInt(v));
    }
    rt.link("java/lang/Double");
    return box(JDouble, v);
  }
  if (typeof v === "bigint") { rt.link("java/lang/Long"); return box(JLong, v); }
  if (typeof v === "boolean") { rt.link("java/lang/Boolean"); return v ? TRUE : FALSE; }
  return v;
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
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw rt.mkThrowable("org/json/JSONException", "Value is not an object");
      this.o = value as Record<string, unknown>;
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
    "opt(Ljava/lang/String;)Ljava/lang/Object;": function (this: JJSONObject, k: string) { return jsonWrap(this.o[k] ?? null); },
    "getString(Ljava/lang/String;)Ljava/lang/String;": function (this: JJSONObject, k: string) {
      if (!(k in this.o)) throw rt.mkThrowable("org/json/JSONException", "No value for " + k);
      return String(this.o[k]);
    },
    "optString(Ljava/lang/String;)Ljava/lang/String;": function (this: JJSONObject, k: string) { return this.o[k] === undefined ? "" : String(this.o[k]); },
    "optString(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": function (this: JJSONObject, k: string, d: string) {
      return this.o[k] === undefined ? d : String(this.o[k]);
    },
    "getInt(Ljava/lang/String;)I": function (this: JJSONObject, k: string) { return Math.trunc(Number(this.o[k])) | 0; },
    "optInt(Ljava/lang/String;)I": function (this: JJSONObject, k: string) { return Math.trunc(Number(this.o[k] ?? 0)) | 0; },
    "optInt(Ljava/lang/String;I)I": function (this: JJSONObject, k: string, d: number) {
      const v = Number(this.o[k]);
      return Number.isFinite(v) ? Math.trunc(v) | 0 : d;
    },
    "getLong(Ljava/lang/String;)J": function (this: JJSONObject, k: string) { return BigInt(Math.trunc(Number(this.o[k] ?? 0))); },
    "optLong(Ljava/lang/String;)J": function (this: JJSONObject, k: string) { return BigInt(Math.trunc(Number(this.o[k] ?? 0))); },
    "optLong(Ljava/lang/String;J)J": function (this: JJSONObject, k: string, d: bigint) {
      const v = Number(this.o[k]);
      return Number.isFinite(v) ? BigInt(Math.trunc(v)) : d;
    },
    "getDouble(Ljava/lang/String;)D": function (this: JJSONObject, k: string) { return Number(this.o[k] ?? 0); },
    "optDouble(Ljava/lang/String;D)D": function (this: JJSONObject, k: string, d: number) {
      const v = Number(this.o[k]);
      return Number.isFinite(v) ? v : d;
    },
    "getBoolean(Ljava/lang/String;)Z": function (this: JJSONObject, k: string) { return this.o[k] ? 1 : 0; },
    "optBoolean(Ljava/lang/String;)Z": function (this: JJSONObject, k: string) { return this.o[k] ? 1 : 0; },
    "optBoolean(Ljava/lang/String;Z)Z": function (this: JJSONObject, k: string, d: number) {
      return this.o[k] === undefined ? d : this.o[k] ? 1 : 0;
    },
    "optDouble(Ljava/lang/String;)D": function (this: JJSONObject, k: string) {
      const v = Number(this.o[k]);
      return Number.isFinite(v) ? v : Number.NaN;
    },
    "getJSONObject(Ljava/lang/String;)Lorg/json/JSONObject;": function (this: JJSONObject, k: string) {
      const v = this.o[k];
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw rt.mkThrowable("org/json/JSONException", k + " is not an object");
      return jsonWrap(v);
    },
    "optJSONObject(Ljava/lang/String;)Lorg/json/JSONObject;": function (this: JJSONObject, k: string) {
      const v = this.o[k];
      return typeof v === "object" && v !== null && !Array.isArray(v) ? jsonWrap(v) : null;
    },
    "getJSONArray(Ljava/lang/String;)Lorg/json/JSONArray;": function (this: JJSONObject, k: string) {
      const v = this.o[k];
      if (!Array.isArray(v)) throw rt.mkThrowable("org/json/JSONException", k + " is not an array");
      return jsonWrap(v);
    },
    "optJSONArray(Ljava/lang/String;)Lorg/json/JSONArray;": function (this: JJSONObject, k: string) {
      return Array.isArray(this.o[k]) ? jsonWrap(this.o[k]) : null;
    },
    "has(Ljava/lang/String;)Z": function (this: JJSONObject, k: string) { return k in this.o ? 1 : 0; },
    "isNull(Ljava/lang/String;)Z": function (this: JJSONObject, k: string) { return this.o[k] === null || this.o[k] === undefined ? 1 : 0; },
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
    "put(Ljava/lang/Object;)Lorg/json/JSONArray;": function (this: JJSONArray, v: unknown) { this.a.push(jsonUnwrap(v)); return this; },
    "put(I)Lorg/json/JSONArray;": function (this: JJSONArray, v: number) { this.a.push(v); return this; },
    "put(D)Lorg/json/JSONArray;": function (this: JJSONArray, v: number) { this.a.push(v); return this; },
    "put(Z)Lorg/json/JSONArray;": function (this: JJSONArray, v: number) { this.a.push(!!v); return this; },
    "length()I": function (this: JJSONArray) { return this.a.length; },
    "get(I)Ljava/lang/Object;": function (this: JJSONArray, i: number) { return jsonWrap(this.a[i] ?? null); },
    "opt(I)Ljava/lang/Object;": function (this: JJSONArray, i: number) { return jsonWrap(this.a[i] ?? null); },
    "getJSONObject(I)Lorg/json/JSONObject;": function (this: JJSONArray, i: number) { return jsonWrap(this.a[i]); },
    "optJSONObject(I)Lorg/json/JSONObject;": function (this: JJSONArray, i: number) {
      const v = this.a[i];
      return typeof v === "object" && v !== null && !Array.isArray(v) ? jsonWrap(v) : null;
    },
    "getString(I)Ljava/lang/String;": function (this: JJSONArray, i: number) { return String(this.a[i]); },
    "optString(I)Ljava/lang/String;": function (this: JJSONArray, i: number) { return this.a[i] === undefined ? "" : String(this.a[i]); },
    "getInt(I)I": function (this: JJSONArray, i: number) { return Math.trunc(Number(this.a[i])) | 0; },
    "getLong(I)J": function (this: JJSONArray, i: number) { return BigInt(Math.trunc(Number(this.a[i] ?? 0))); },
    "getDouble(I)D": function (this: JJSONArray, i: number) { return Number(this.a[i] ?? 0); },
    "getBoolean(I)Z": function (this: JJSONArray, i: number) { return this.a[i] ? 1 : 0; },
    "getJSONArray(I)Lorg/json/JSONArray;": function (this: JJSONArray, i: number) {
      if (!Array.isArray(this.a[i])) throw rt.mkThrowable("org/json/JSONException", i + " is not an array");
      return jsonWrap(this.a[i]);
    },
    "optJSONArray(I)Lorg/json/JSONArray;": function (this: JJSONArray, i: number) {
      return Array.isArray(this.a[i]) ? jsonWrap(this.a[i]) : null;
    },
    "optInt(I)I": function (this: JJSONArray, i: number) { return Math.trunc(Number(this.a[i] ?? 0)) | 0; },
    "optInt(II)I": function (this: JJSONArray, i: number, d: number) {
      const v = Number(this.a[i]);
      return Number.isFinite(v) ? Math.trunc(v) | 0 : d;
    },
    "optLong(I)J": function (this: JJSONArray, i: number) { return BigInt(Math.trunc(Number(this.a[i] ?? 0))); },
    "optDouble(I)D": function (this: JJSONArray, i: number) { const v = Number(this.a[i]); return Number.isFinite(v) ? v : Number.NaN; },
    "optBoolean(I)Z": function (this: JJSONArray, i: number) { return this.a[i] ? 1 : 0; },
    "optString(ILjava/lang/String;)Ljava/lang/String;": function (this: JJSONArray, i: number, d: string) {
      return this.a[i] === undefined ? d : String(this.a[i]);
    },
    "isNull(I)Z": function (this: JJSONArray, i: number) { return this.a[i] === null || this.a[i] === undefined ? 1 : 0; },
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
