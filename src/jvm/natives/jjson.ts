// org.json over plain JS objects/arrays.

import { rt, JObj } from "../runtime";
import { defineException, boxInt, box, JLong, JDouble, TRUE, FALSE } from "./jlang";
import { mkIter, newLinkedHashSet } from "./jutil";

class JJSONObject extends JObj { o: Record<string, unknown> = {}; }
class JJSONArray extends JObj { a: unknown[] = []; }
/** get()/opt() hand out Java objects: numbers box the way org.json parses them (Integer when it
 *  fits, else Long, else Double), booleans box, strings are already Java strings */
function jsonWrap(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if (Array.isArray(v)) { const a = new JJSONArray(); a.a = v; return a; }
    if (v instanceof JObj) return v;
    const o = new JJSONObject(); o.o = v as Record<string, unknown>; return o;
  }
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v >= -2147483648 && v <= 2147483647 ? boxInt(v) : box(JLong, BigInt(v));
    return box(JDouble, v);
  }
  if (typeof v === "bigint") return box(JLong, v);
  if (typeof v === "boolean") return v ? TRUE : FALSE;
  return v;
}
function jsonUnwrap(v: unknown): unknown {
  if (v instanceof JJSONObject) return v.o;
  if (v instanceof JJSONArray) return v.a;
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
      try { this.o = JSON.parse(s); }
      catch (e) { throw rt.mkThrowable("org/json/JSONException", String(e)); }
    },
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
      try { this.a = JSON.parse(s); }
      catch (e) { throw rt.mkThrowable("org/json/JSONException", String(e)); }
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
