import { rt, JObj, type ClassInfo } from "./runtime";
import { jarray } from "./abi";
import { defineException } from "./natives/jlang";
defineException("java/io/ObjectStreamException", "java/io/IOException");
defineException("java/io/NotSerializableException", "java/io/ObjectStreamException");
defineException("java/io/InvalidClassException", "java/io/ObjectStreamException");

type Value = null | string | number | bigint | { ref: number };
type Node = { kind: "object"; type: string; fields: [string, string, string, Value][] }
  | { kind: "array"; type: string; values: Value[] };
export type Serialized = { serialized: Node[]; value: Value };
function fields(info: ClassInfo): [string, string, string, string][] {
  const result: [string, string, string, string][] = [];
  for (let c: ClassInfo | null = info; c && c.name !== "java/lang/Object"; c = c.superInfo) {
    if (!c.types.has("java/io/Serializable")) throw rt.mkThrowable("java/io/NotSerializableException", "Non-serializable superclass: " + c.name);
    if (!c.dex || !c.def || [...c.def.directMethods, ...c.def.virtualMethods].some((m) => ["writeObject", "readObject", "writeReplace", "readResolve"].includes(c!.dex!.method(m.methodIdx).name)))
      throw rt.mkThrowable("java/io/NotSerializableException", "Custom serialization is unavailable: " + c.name);
    for (const field of c.def.instanceFields) {
      if (field.flags & 0x80) continue;
      const f = c.dex.field(field.fieldIdx);
      result.push([c.name, f.name, c.dex.type(f.type), c.fieldTable.get(f.name)!]);
    }
  }
  return result;
}
export function serialize(value: unknown): Serialized {
  const nodes: Node[] = [], seen = new Map<object, number>();
  const encode = (v: unknown): Value => {
    if (v == null || v === 0) return v === 0 ? 0 : null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
    if (typeof v !== "object") throw rt.mkThrowable("java/io/NotSerializableException", typeof v);
    const old = seen.get(v); if (old !== undefined) return { ref: old };
    const ref = nodes.length; seen.set(v, ref);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const type = Array.isArray(v) ? ("$t" in v && typeof v.$t === "string" ? v.$t : "Ljava/lang/Object;")
        : v instanceof Uint8Array ? "Z" : v instanceof Int8Array ? "B" : v instanceof Int16Array ? "S" : v instanceof Uint16Array ? "C" : v instanceof Int32Array ? "I"
          : v instanceof BigInt64Array ? "J" : v instanceof Float32Array ? "F" : v instanceof Float64Array ? "D" : "";
      if (!type || v instanceof DataView) throw rt.mkThrowable("java/io/NotSerializableException", "Unsupported array");
      const node: Node = { kind: "array", type, values: [] }; nodes.push(node);
      node.values = Array.from(v as ArrayLike<unknown>, encode); return { ref };
    }
    if (!(v instanceof JObj) || !rt.iof(v, "java/io/Serializable")) throw rt.mkThrowable("java/io/NotSerializableException", "Not serializable");
    const info = (v.constructor as { $i?: ClassInfo }).$i;
    if (!info) throw rt.mkThrowable("java/io/NotSerializableException", "Class metadata unavailable");
    const node: Node = { kind: "object", type: info.name, fields: [] }; nodes.push(node);
    node.fields = fields(info).map(([owner, name, desc, prop]) => [owner, name, desc, encode(Reflect.get(v, prop))]);
    return { ref };
  };
  return { serialized: nodes, value: encode(value) };
}
export async function deserialize(data: Serialized): Promise<unknown> {
  const values: unknown[] = [], infos = new Map<string, ClassInfo>();
  for (const node of data.serialized) {
    if (node.kind === "array") {
      const n = node.values.length;
      values.push(node.type === "Z" ? new Uint8Array(n) : node.type === "B" ? new Int8Array(n) : node.type === "S" ? new Int16Array(n) : node.type === "C" ? new Uint16Array(n)
        : node.type === "I" ? new Int32Array(n) : node.type === "J" ? new BigInt64Array(n) : node.type === "F" ? new Float32Array(n)
          : node.type === "D" ? new Float64Array(n) : jarray(Array(n).fill(null), node.type));
    } else {
      const info = rt.link(node.type); await rt.initClass(info); fields(info); infos.set(node.type, info); values.push(new info.ctor());
    }
  }
  const decode = (v: Value): unknown => typeof v === "object" && v !== null ? values[v.ref] : v;
  for (let i = 0; i < data.serialized.length; i++) {
    const node = data.serialized[i], target = values[i] as Record<string | number, unknown>;
    if (node.kind === "array") node.values.forEach((v, index) => { target[index] = decode(v); });
    else {
      const declared = fields(infos.get(node.type)!);
      for (const [owner, name, desc, value] of node.fields) {
        const field = declared.find((f) => f[0] === owner && f[1] === name && f[2] === desc);
        if (!field) throw rt.mkThrowable("java/io/InvalidClassException", node.type + "." + name);
        target[field[3]] = decode(value);
      }
    }
  }
  return decode(data.value);
}
