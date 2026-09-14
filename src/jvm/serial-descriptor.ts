import { rt, type ClassInfo } from "./runtime";
import { mangleMethod, mangleStaticField } from "./abi";
import { encodeModifiedUtf8 } from "./charset";

export type StreamField = { name: string; desc: string; prop: string };
export type StreamClass = { name: string; uid: bigint; flags: number; fields: StreamField[]; parent: StreamClass | null; info: ClassInfo | null };
const cache = new Map<ClassInfo | string, Promise<StreamClass>>();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function streamClass(type: ClassInfo | string): Promise<StreamClass> {
  let found = cache.get(type);
  if (!found) { found = descriptor(type); cache.set(type, found); }
  return found;
}
async function descriptor(type: ClassInfo | string): Promise<StreamClass> {
  if (typeof type === "string") return { name: type.replaceAll("/", "."), uid: await computedUid(type), flags: 2, fields: [], parent: null, info: null };
  const info = type;
  await rt.initClass(info);
  if (!info.types.has("java/io/Serializable")) throw rt.mkThrowable("java/io/NotSerializableException", info.name);
  const external = info.types.has("java/io/Externalizable"), isEnum = info.types.has("java/lang/Enum");
  const native = rt.natives.get(info.name)?.serialization;
  if (info.native && !native && !external && !isEnum) throw rt.mkThrowable("java/io/NotSerializableException", "Native serialized form is unavailable: " + info.name);
  const fields = native?.fields ?? (external || isEnum ? [] : info.def!.instanceFields.filter(f => !(f.flags & 0x80)).map(f => {
    const field = info.dex!.field(f.fieldIdx);
    return { name: field.name, desc: info.dex!.type(field.type), prop: info.fieldTable.get(field.name)! };
  }));
  fields.sort((a, b) => +(a.desc.length > 1) - +(b.desc.length > 1) || compare(a.name, b.name));
  const uidProp = info.staticFieldTable.get("serialVersionUID:J") ?? mangleStaticField("serialVersionUID");
  const uid = native?.uid ?? (Object.hasOwn(info.ctor, uidProp) ? info.ctor[uidProp] : undefined);
  return { name: info.name.replaceAll("/", "."), uid: isEnum ? 0n : typeof uid === "bigint" ? uid : await computedUid(info),
    flags: isEnum ? 18 : external ? 12 : Object.hasOwn(info.ctor.prototype, mangleMethod("writeObject", "(Ljava/io/ObjectOutputStream;)V")) ? 3 : 2,
    fields, parent: info.superInfo?.types.has("java/io/Serializable") ? await streamClass(info.superInfo) : null, info };
}
async function computedUid(type: ClassInfo | string): Promise<bigint> {
  const bytes: number[] = [];
  const int = (n: number) => { bytes.push(n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255); };
  const utf = (s: string) => { const b = encodeModifiedUtf8(s); bytes.push(b.length >> 8, b.length & 255); for (const v of b) bytes.push(v); };
  if (typeof type === "string") { utf(type.replaceAll("/", ".")); int(0x411); }
  else {
    const { dex, def } = type;
    if (!dex || !def) throw rt.mkThrowable("java/io/InvalidClassException", "Class metadata is unavailable: " + type.name);
    utf(type.name.replaceAll("/", "."));
    const methods = [...def.directMethods, ...def.virtualMethods].map(m => ({ name: dex.method(m.methodIdx).name, desc: dex.methodDesc(m.methodIdx), flags: m.flags }));
    let flags = def.flags & 0x611;
    if (flags & 0x200) flags = methods.some(m => !m.name.startsWith("<")) ? flags | 0x400 : flags & ~0x400;
    int(flags);
    for (const name of type.interfaces.map(i => i.name.replaceAll("/", ".")).sort()) utf(name);
    const fields = [...def.instanceFields, ...def.staticFields].map(f => ({ ...dex.field(f.fieldIdx), flags: f.flags }));
    for (const f of fields.sort((a, b) => compare(a.name, b.name))) {
      if ((f.flags & 2) && (f.flags & 0x88)) continue;
      utf(f.name); int(f.flags & 0xdf); utf(dex.type(f.type));
    }
    if (methods.some(m => m.name === "<clinit>")) { utf("<clinit>"); int(8); utf("()V"); }
    for (const m of methods.filter(m => m.name === "<init>" && !(m.flags & 2)).sort((a, b) => compare(a.desc, b.desc))) {
      utf(m.name); int(m.flags & 0xd3f); utf(m.desc.replaceAll("/", "."));
    }
    for (const m of methods.filter(m => !m.name.startsWith("<") && !(m.flags & 2)).sort((a, b) => compare(a.name, b.name) || compare(a.desc, b.desc))) {
      utf(m.name); int((m.flags | (m.flags & 0x20000 ? 0x20 : 0)) & 0xd3f); utf(m.desc.replaceAll("/", "."));
    }
  }
  const hash = await crypto.subtle.digest("SHA-1", Uint8Array.from(bytes));
  return new DataView(hash).getBigInt64(0, true);
}
