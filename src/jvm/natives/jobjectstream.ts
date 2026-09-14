import { encodeModifiedUtf8, decodeModifiedUtf8 } from "../charset";
import { streamClass, type StreamClass } from "../serial-descriptor";
import { rt, ClassInfo } from "../runtime";
import { i8, jmethod, mangleMethod, jarray, primElem, PRIM_ARRAYS, type PrimElem } from "../abi";
import { vcall, newObj } from "./jlang";
import { JInputStream, JOutputStream, dataBytes, readers, writers } from "./jio";

const STREAM_MAGIC = 0xaced, STREAM_VERSION = 5, TC_BLOCKDATA = 0x77, TC_BLOCKDATALONG = 0x7a;
type FieldContext = { value: object; desc: StreamClass };
class JObjectIn extends JInputStream {
  blockEnd = 0; handles: unknown[] = []; descriptors = new Map<unknown, StreamClass>(); context: FieldContext | null = null; resolve = false;
}
/** `n` bytes of block data, crossing record boundaries the way a long writeUTF body does */
async function blockBytes(s: JObjectIn, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  for (let got = 0; got < n;) {
    while (s.blockEnd <= s.pos) {
      const tag = (await dataBytes(s, 1))[0];
      if (tag === TC_BLOCKDATA) { const length = (await dataBytes(s, 1))[0]; s.blockEnd = s.pos + length; }
      else if (tag === TC_BLOCKDATALONG) {
        const len = await dataBytes(s, 4);
        s.blockEnd = s.pos + new DataView(len.buffer, len.byteOffset, 4).getUint32(0);
      }
      else throw rt.mkThrowable("java/io/StreamCorruptedException", "unsupported serialization tag 0x" + tag.toString(16));
    }
    const take = Math.min(n - got, s.blockEnd - s.pos);
    out.set(await dataBytes(s, take), got);
    got += take;
  }
  return out;
}
const blockRead = (n: number, decode: (v: DataView) => unknown) =>
  async function (this: JObjectIn) {
    const b = await blockBytes(this, n);
    return decode(new DataView(b.buffer, b.byteOffset, n));
  };
const inactive = (): never => { throw rt.mkThrowable("java/io/NotActiveException", "not in a serialization callback"); };
rt.register({
  name: "java/io/ObjectInputStream", ctor: JObjectIn, sup: "java/io/InputStream",
  ifaces: ["java/io/ObjectInput", "java/io/DataInput"],
  methods: {
    "<init>(Ljava/io/InputStream;)V": async function (this: JObjectIn, src: JInputStream) {
      this.wrapped = src;
      const head = await dataBytes(this, 4);
      const magic = (head[0] << 8) | head[1], version = (head[2] << 8) | head[3];
      if (magic !== STREAM_MAGIC || version !== STREAM_VERSION) {
        throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid stream header");
      }
    },
    ...readers(blockRead),
    "readUTF()Ljava/lang/String;": async function (this: JObjectIn) {
      const head = await blockBytes(this, 2);
      return decodeModifiedUtf8(await blockBytes(this, (head[0] << 8) | head[1]));
    },
    "readFully([B)V": async function (this: JObjectIn, out: Int8Array) {
      const b = await blockBytes(this, out.length);
      out.set(i8(b));
    },
    "readObject()Ljava/lang/Object;": function (this: JObjectIn) { return readObject(this); },
    "enableResolveObject(Z)Z": function (this: JObjectIn, enabled: number) { const old = this.resolve; this.resolve = !!enabled; return +old; },
    "resolveObject(Ljava/lang/Object;)Ljava/lang/Object;": (value: unknown) => value,
    "defaultReadObject()V": function (this: JObjectIn) { return this.context ? readFields(this, this.context) : inactive(); },
    "close()V": function () {},
  },
});
class JObjectOut extends JOutputStream {
  target: unknown = null;
  handles = new Map<unknown, number>();
  replacements = new Map<unknown, unknown>();
  replace = false;
  context: FieldContext | null = null;
}
/** every primitive write is its own TC_BLOCKDATA record, which reads back identically */
function blockWrite(o: JObjectOut, bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    const chunk = bytes.subarray(offset, offset + 1024);
    if (chunk.length < 256) o.chunks.push(TC_BLOCKDATA, chunk.length);
    else { o.chunks.push(TC_BLOCKDATALONG); rawInt(o, chunk.length); }
    for (const b of chunk) o.chunks.push(b);
  }
}
const blockPut = (n: number, encode: (v: DataView, x: never) => void) =>
  function (this: JObjectOut, x: never) {
    const b = new Uint8Array(n);
    encode(new DataView(b.buffer), x);
    blockWrite(this, b);
  };
rt.register({
  name: "java/io/ObjectOutputStream", ctor: JObjectOut, sup: "java/io/OutputStream",
  ifaces: ["java/io/ObjectOutput", "java/io/DataOutput"],
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: JObjectOut, out: JOutputStream) {
      this.target = out;
      this.chunks.push(STREAM_MAGIC >> 8, STREAM_MAGIC & 0xff, 0, STREAM_VERSION);
    },
    ...writers(blockPut),
    "writeUTF(Ljava/lang/String;)V": function (this: JObjectOut, str: string) {
      const body = encodeModifiedUtf8(str);
      if (body.length > 65535) throw rt.mkThrowable("java/io/UTFDataFormatException", "encoded string too long");
      const b = new Uint8Array(body.length + 2);
      b[0] = body.length >> 8; b[1] = body.length & 0xff;
      b.set(body, 2);
      blockWrite(this, b);
    },
    "writeObject(Ljava/lang/Object;)V": function (this: JObjectOut, value: unknown) { return writeObject(this, value); },
    "enableReplaceObject(Z)Z": function (this: JObjectOut, enabled: number) { const old = this.replace; this.replace = !!enabled; return +old; },
    "replaceObject(Ljava/lang/Object;)Ljava/lang/Object;": (value: unknown) => value,
    "defaultWriteObject()V": function (this: JObjectOut) { return this.context ? writeFields(this, this.context) : inactive(); },
    "write(I)V": function (this: JObjectOut, value: number) { blockWrite(this, Uint8Array.of(value)); },
    "write([BII)V": function (this: JObjectOut, bytes: Int8Array, offset: number, length: number) {
      if (!bytes) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (offset < 0 || length < 0 || offset > bytes.length - length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      blockWrite(this, new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length));
    },
    "flush()V": function (this: JObjectOut) {
      const target = this.target;
      const bytes = Int8Array.from(this.chunks);
      this.chunks = [];
      return target ? vcall(target, "write", "([BII)V", bytes, 0, bytes.length) : undefined;
    },
    "close()V": function (this: JObjectOut) { return vcall(this, "flush", "()V"); },
  },
});

const TC_NULL = 0x70, TC_REFERENCE = 0x71, TC_CLASSDESC = 0x72, TC_OBJECT = 0x73,
  TC_STRING = 0x74, TC_ARRAY = 0x75, TC_ENUM = 0x7e, TC_ENDBLOCKDATA = 0x78, TC_RESET = 0x79, TC_LONGSTRING = 0x7c;
const BASE_HANDLE = 0x7e0000;
function rawInt(o: JObjectOut, value: number) { o.chunks.push(value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255); }
function rawLong(o: JObjectOut, value: bigint) { rawInt(o, Number(value >> 32n)); rawInt(o, Number(value & 0xffffffffn)); }
function rawUtf(o: JObjectOut, value: string) {
  const bytes = encodeModifiedUtf8(value);
  if (bytes.length > 65535) throw rt.mkThrowable("java/io/UTFDataFormatException", "encoded string too long");
  o.chunks.push(bytes.length >> 8, bytes.length & 255);
  for (const b of bytes) o.chunks.push(b);
}
function reference(o: JObjectOut, value: unknown): boolean {
  const handle = o.handles.get(value);
  if (handle === undefined) return false;
  o.chunks.push(TC_REFERENCE); rawInt(o, handle); return true;
}
function objectInfo(value: unknown): ClassInfo {
  if (typeof value === "object" && value !== null && "$i" in value.constructor && value.constructor.$i instanceof ClassInfo)
    return value.constructor.$i;
  throw rt.mkThrowable("java/io/NotSerializableException", "Unsupported object representation");
}
async function writeDescriptor(o: JObjectOut, desc: StreamClass | null): Promise<void> {
  if (!desc) { o.chunks.push(TC_NULL); return; }
  if (reference(o, desc)) return;
  o.chunks.push(TC_CLASSDESC); rawUtf(o, desc.name); rawLong(o, desc.uid);
  o.handles.set(desc, BASE_HANDLE + o.handles.size);
  o.chunks.push(desc.flags, desc.fields.length >> 8, desc.fields.length & 255);
  for (const field of desc.fields) {
    o.chunks.push(field.desc.charCodeAt(0)); rawUtf(o, field.name);
    if (field.desc.length > 1) await writeObject(o, field.desc);
  }
  o.chunks.push(TC_ENDBLOCKDATA);
  await writeDescriptor(o, desc.parent);
}
async function writeObject(o: JObjectOut, value: unknown): Promise<void> {
  const original = value;
  if (o.replacements.has(value)) value = o.replacements.get(value);
  if (value == null || value === 0) { o.chunks.push(TC_NULL); return; }
  if (reference(o, value)) return;
  if (!o.replacements.has(original)) {
    while (value !== null && typeof value === "object" && rt.iof(value, "java/io/Serializable")) {
      const hook = jmethod(value, mangleMethod("writeReplace", "()Ljava/lang/Object;"));
      if (!hook) break;
      const replaced = await hook.call(value);
      const sameClass = replaced != null && typeof replaced === "object" && replaced.constructor === value.constructor;
      value = replaced;
      if (sameClass) break;
    }
    if (o.replace) value = await vcall(o, "replaceObject", "(Ljava/lang/Object;)Ljava/lang/Object;", value);
    if (value !== original) o.replacements.set(original, value);
  }
  if (value == null || value === 0) { o.chunks.push(TC_NULL); return; }
  if (reference(o, value)) return;
  if (typeof value === "string") {
    const bytes = encodeModifiedUtf8(value);
    o.chunks.push(bytes.length < 65536 ? TC_STRING : TC_LONGSTRING);
    if (bytes.length < 65536) o.chunks.push(bytes.length >> 8, bytes.length & 255);
    else rawLong(o, BigInt(bytes.length));
    for (const b of bytes) o.chunks.push(b);
    o.handles.set(value, BASE_HANDLE + o.handles.size); return;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const element = Array.isArray(value) ? ("$t" in value && typeof value.$t === "string" ? value.$t : "Ljava/lang/Object;") : primElem(value);
    if (!element || value instanceof DataView) throw rt.mkThrowable("java/io/NotSerializableException", "Unsupported array");
    const desc = await streamClass("[" + element);
    o.chunks.push(TC_ARRAY); await writeDescriptor(o, desc); o.handles.set(value, BASE_HANDLE + o.handles.size);
    const array = value as ArrayLike<unknown>; rawInt(o, array.length);
    if (element.length === 1) {
      const bytes = new Uint8Array(array.length * primitiveSizes[element]), view = new DataView(bytes.buffer);
      for (let i = 0; i < array.length; i++) putPrimitive(view, i * primitiveSizes[element], element, array[i]);
      for (const b of bytes) o.chunks.push(b);
    } else for (let i = 0; i < array.length; i++) await writeObject(o, array[i]);
    return;
  }
  let info = objectInfo(value);
  while (info.types.has("java/lang/Enum") && info.superInfo && info.superInfo.name !== "java/lang/Enum") info = info.superInfo;
  const desc = await streamClass(info);
  o.chunks.push(desc.flags & 16 ? TC_ENUM : TC_OBJECT); await writeDescriptor(o, desc);
  o.handles.set(value, BASE_HANDLE + o.handles.size);
  if (desc.flags & 16) { await writeObject(o, await vcall(value, "name", "()Ljava/lang/String;")); return; }
  if (desc.flags & 4) {
    await vcall(value, "writeExternal", "(Ljava/io/ObjectOutput;)V", o); o.chunks.push(TC_ENDBLOCKDATA);
  } else {
    const hierarchy: StreamClass[] = [];
    for (let c: StreamClass | null = desc; c; c = c.parent) hierarchy.unshift(c);
    for (const c of hierarchy) {
      const previous = o.context;
      o.context = { value: value as object, desc: c };
      try {
        if (c.flags & 1) {
          await jmethod(c.info!.ctor.prototype, mangleMethod("writeObject", "(Ljava/io/ObjectOutputStream;)V"))!.call(value, o);
          o.chunks.push(TC_ENDBLOCKDATA);
        } else await writeFields(o, o.context);
      } finally { o.context = previous; }
    }
  }
}
const primitiveSizes: Record<string, number> = { Z: 1, B: 1, C: 2, S: 2, I: 4, F: 4, J: 8, D: 8 };
async function writeField(o: JObjectOut, type: string, value: unknown): Promise<void> {
  if (type.length > 1) return writeObject(o, value);
  const bytes = new Uint8Array(primitiveSizes[type]), view = new DataView(bytes.buffer);
  putPrimitive(view, 0, type, value);
  for (const b of bytes) o.chunks.push(b);
}
function putPrimitive(view: DataView, offset: number, type: string, value: unknown): void {
  switch (type) {
    case "J": view.setBigInt64(offset, typeof value === "bigint" ? value : 0n); break;
    case "D": view.setFloat64(offset, Number(value)); break;
    case "F": view.setFloat32(offset, Number(value)); break;
    case "I": view.setInt32(offset, Number(value)); break;
    case "S": case "C": view.setInt16(offset, Number(value)); break;
    case "B": case "Z": view.setInt8(offset, Number(value)); break;
    default: throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid field type: " + type);
  }
}

async function writeFields(o: JObjectOut, { value, desc }: FieldContext): Promise<void> {
  for (const field of desc.fields) await writeField(o, field.desc, Reflect.get(value, field.prop));
}
async function readField(s: JObjectIn, type: string): Promise<unknown> {
  if (type.length > 1) return readObject(s);
  const view = await rawView(s, primitiveSizes[type]);
  return getPrimitive(view, 0, type);
}
function getPrimitive(view: DataView, offset: number, type: string): number | bigint {
  switch (type) {
    case "J": return view.getBigInt64(offset);
    case "D": return view.getFloat64(offset);
    case "F": return view.getFloat32(offset);
    case "I": return view.getInt32(offset);
    case "S": return view.getInt16(offset);
    case "C": return view.getUint16(offset);
    case "B": return view.getInt8(offset);
    case "Z": return +!!view.getUint8(offset);
    default: throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid field type: " + type);
  }
}
async function readFields(s: JObjectIn, { value, desc }: FieldContext): Promise<void> {
  const local = await streamClass(desc.info!);
  for (const field of desc.fields) {
    const data = await readField(s, field.desc);
    const target = local.fields.find(f => f.name === field.name && f.desc === field.desc);
    if (target) Reflect.set(value, target.prop, data);
  }
}

async function rawView(s: JObjectIn, size: number): Promise<DataView> {
  const bytes = await dataBytes(s, size); return new DataView(bytes.buffer, bytes.byteOffset, size);
}
async function readUtf(s: JObjectIn): Promise<string> {
  return decodeModifiedUtf8(await dataBytes(s, (await rawView(s, 2)).getUint16(0)));
}
async function skipAnnotation(s: JObjectIn): Promise<void> {
  if (s.blockEnd > s.pos) await dataBytes(s, s.blockEnd - s.pos);
  for (;;) {
    const tag = (await dataBytes(s, 1))[0];
    if (tag === TC_ENDBLOCKDATA) return;
    if (tag === TC_BLOCKDATA || tag === TC_BLOCKDATALONG) {
      const length = tag === TC_BLOCKDATA ? (await dataBytes(s, 1))[0] : (await rawView(s, 4)).getUint32(0);
      await dataBytes(s, length);
    } else await readObject(s, tag);
  }
}
async function readObject(s: JObjectIn, tag?: number): Promise<unknown> {
  tag ??= (await dataBytes(s, 1))[0];
  switch (tag) {
    case TC_NULL: return null;
    case TC_REFERENCE: {
      const handle = (await rawView(s, 4)).getInt32(0) - BASE_HANDLE;
      if (handle < 0 || handle >= s.handles.length) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid handle");
      return s.handles[handle];
    }
    case TC_RESET: s.handles = []; return readObject(s);
    case TC_STRING:
    case TC_LONGSTRING: {
      const length = tag === TC_STRING ? (await rawView(s, 2)).getUint16(0) : Number((await rawView(s, 8)).getBigInt64(0));
      if (!Number.isSafeInteger(length) || length < 0) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid string length");
      const value = decodeModifiedUtf8(await dataBytes(s, length)), handle = s.handles.length; s.handles.push(value); return resolveRead(s, value, handle);
    }
    case TC_CLASSDESC: {
      const name = await readUtf(s), uid = (await rawView(s, 8)).getBigInt64(0);
      const info = name.startsWith("[") ? null : rt.link(name.replaceAll(".", "/"));
      const local = await streamClass(info ?? name.replaceAll(".", "/"));
      if (info && local.uid !== uid) throw rt.mkThrowable("java/io/InvalidClassException", "serialVersionUID mismatch: " + name);
      const desc: StreamClass = { name, uid, flags: 0, fields: [], parent: null, info };
      s.handles.push(desc); s.descriptors.set(desc, desc);
      desc.flags = (await dataBytes(s, 1))[0];
      if (desc.flags !== local.flags) throw rt.mkThrowable("java/io/InvalidClassException", "Incompatible class descriptor: " + name);
      const count = (await rawView(s, 2)).getUint16(0);
      for (let i = 0; i < count; i++) {
        const code = String.fromCharCode((await dataBytes(s, 1))[0]), name = await readUtf(s);
        const type = code === "L" || code === "[" ? await readObject(s) : code;
        if (typeof type !== "string" || !(type.length > 1 || primitiveSizes[type])) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid field type");
        desc.fields.push({ name, desc: type, prop: "" });
      }
      await skipAnnotation(s);
      const parent = await readObject(s);
      if (parent !== null) {
        const found = s.descriptors.get(parent);
        if (!found) throw rt.mkThrowable("java/io/StreamCorruptedException", "expected superclass descriptor");
        desc.parent = found;
      }
      return desc;
    }
    case TC_ARRAY:
    case TC_ENUM:
    case TC_OBJECT: {
      const desc = s.descriptors.get(await readObject(s));
      if (!desc) throw rt.mkThrowable("java/io/StreamCorruptedException", "expected class descriptor");
      const handle = s.handles.length;
      if (tag === TC_ARRAY) {
        const count = (await rawView(s, 4)).getInt32(0), element = desc.name.slice(1).replaceAll(".", "/");
        if (!desc.name.startsWith("[") || count < 0) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid array");
        const array = element.length === 1 ? new PRIM_ARRAYS[element as PrimElem](count) : jarray(Array(count).fill(null), element);
        s.handles.push(array);
        if (element.length === 1) {
          const view = await rawView(s, count * primitiveSizes[element]);
          for (let i = 0; i < count; i++) Reflect.set(array, i, getPrimitive(view, i * primitiveSizes[element], element));
        } else for (let i = 0; i < count; i++) Reflect.set(array, i, await readObject(s));
        return resolveRead(s, array, handle);
      }
      if (!desc.info) throw rt.mkThrowable("java/io/StreamCorruptedException", "expected object class");
      if (tag === TC_ENUM) {
        s.handles.push(null);
        const name = await readObject(s);
        if (typeof name !== "string") throw rt.mkThrowable("java/io/StreamCorruptedException", "expected enum name");
        return resolveRead(s, await vcall(rt.link("java/lang/Enum").ctor, "valueOf", "(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;", rt.classFor(desc.info.name), name), handle);
      }
      const value = await newObj(desc.info.name, desc.flags & 4 ? "()V" : null);
      s.handles.push(value);
      if (desc.flags & 4) {
        await vcall(value, "readExternal", "(Ljava/io/ObjectInput;)V", s); await skipAnnotation(s);
      } else {
        const hierarchy: StreamClass[] = [];
        for (let c: StreamClass | null = desc; c; c = c.parent) hierarchy.unshift(c);
        const base = hierarchy[0].info?.superInfo;
        if (base) await jmethod(base.ctor.prototype, mangleMethod("<init>", "()V"))?.call(value);
        for (const c of hierarchy) {
          const previous = s.context; s.context = { value, desc: c };
          try {
            const method = mangleMethod("readObject", "(Ljava/io/ObjectInputStream;)V");
            const hook = Object.hasOwn(c.info!.ctor.prototype, method) ? jmethod(c.info!.ctor.prototype, method) : undefined;
            if (hook) await hook.call(value, s); else await readFields(s, s.context);
            if (c.flags & 1) await skipAnnotation(s);
          } finally { s.context = previous; }
        }
      }
      const hook = jmethod(value, mangleMethod("readResolve", "()Ljava/lang/Object;"));
      return resolveRead(s, hook ? await hook.call(value) : value, handle);
    }
    default: throw rt.mkThrowable("java/io/StreamCorruptedException", "unsupported serialization tag 0x" + tag.toString(16));
  }
}

async function resolveRead(s: JObjectIn, value: unknown, handle: number): Promise<unknown> {
  return s.handles[handle] = s.resolve ? await vcall(s, "resolveObject", "(Ljava/lang/Object;)Ljava/lang/Object;", value) : value;
}
