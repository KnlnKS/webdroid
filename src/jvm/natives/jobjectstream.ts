import { encodeModifiedUtf8, decodeModifiedUtf8 } from "../charset";
import { streamClass, streamClassAny, type StreamClass } from "../serial-descriptor";
import { rt, ClassInfo, driven, type Gen } from "../runtime";
import { i8, jmethod, mangleMethod, jarray, primElem, PRIM_ARRAYS, type PrimElem } from "../abi";
import { vcall, vcallOn, callOn, curThread, type JThread, newObj, JClass } from "./jlang";
import { JInputStream, JOutputStream, dataBytes, readers, writers } from "./jio";

const STREAM_MAGIC = 0xaced, STREAM_VERSION = 5, TC_BLOCKDATA = 0x77, TC_BLOCKDATALONG = 0x7a;
type FieldContext = { value: object; desc: StreamClass };
class JObjectIn extends JInputStream {
  blockEnd = 0; handles: unknown[] = []; descriptors = new Map<unknown, StreamClass>(); context: FieldContext | null = null; resolve = false;
}
/** `n` bytes of block data, crossing record boundaries the way a long writeUTF body does */
async function blockBytes(thread: JThread, s: JObjectIn, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  for (let got = 0; got < n;) {
    while (s.blockEnd <= s.pos) {
      const tag = (await dataBytes(s, 1, thread))[0];
      if (tag === TC_BLOCKDATA) { const length = (await dataBytes(s, 1, thread))[0]; s.blockEnd = s.pos + length; }
      else if (tag === TC_BLOCKDATALONG) {
        const len = await dataBytes(s, 4, thread);
        s.blockEnd = s.pos + new DataView(len.buffer, len.byteOffset, 4).getUint32(0);
      }
      else throw rt.mkThrowable("java/io/StreamCorruptedException", "unsupported serialization tag 0x" + tag.toString(16));
    }
    const take = Math.min(n - got, s.blockEnd - s.pos);
    out.set(await dataBytes(s, take, thread), got);
    got += take;
  }
  return out;
}
const blockRead = (n: number, decode: (v: DataView) => unknown) =>
  async function (this: JObjectIn) {
    const b = await blockBytes(curThread, this, n);
    return decode(new DataView(b.buffer, b.byteOffset, n));
  };
const inactive = (): never => { throw rt.mkThrowable("java/io/NotActiveException", "not in a serialization callback"); };
rt.register({
  name: "java/io/ObjectInputStream", ctor: JObjectIn, sup: "java/io/InputStream",
  ifaces: ["java/io/ObjectInput", "java/io/DataInput"],
  methods: {
    "<init>(Ljava/io/InputStream;)V": driven(function* (this: JObjectIn, src: JInputStream): Gen {
      this.wrapped = src;
      const head = yield dataBytes(this, 4);
      const magic = (head[0] << 8) | head[1], version = (head[2] << 8) | head[3];
      if (magic !== STREAM_MAGIC || version !== STREAM_VERSION) {
        throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid stream header");
      }
    }),
    ...readers(blockRead),
    "readUTF()Ljava/lang/String;": driven(function* (this: JObjectIn): Gen {
      const thread = curThread;
      const head = yield blockBytes(thread, this, 2);
      return decodeModifiedUtf8(yield blockBytes(thread, this, (head[0] << 8) | head[1]));
    }),
    "readFully([B)V": driven(function* (this: JObjectIn, out: Int8Array): Gen {
      const b = yield blockBytes(curThread, this, out.length);
      out.set(i8(b));
    }),
    "readObject()Ljava/lang/Object;": function (this: JObjectIn) { return readObject(curThread, this); },
    "enableResolveObject(Z)Z": function (this: JObjectIn, enabled: number) { const old = this.resolve; this.resolve = !!enabled; return +old; },
    "resolveObject(Ljava/lang/Object;)Ljava/lang/Object;": (value: unknown) => value,
    "defaultReadObject()V": function (this: JObjectIn) { return this.context ? readFields(curThread, this, this.context) : inactive(); },
    "close()V": function () {},
  },
});
class JObjectOut extends JOutputStream {
  target: unknown = null;
  handles = new Map<unknown, number>();
  replacements = new Map<unknown, unknown>();
  replace = false;
  context: FieldContext | null = null;
  writeDepth = 0;
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
    "writeObject(Ljava/lang/Object;)V": driven(function* (this: JObjectOut, value: unknown): Gen {
      this.writeDepth++;
      try { yield writeObject(curThread, this, value); }
      finally { this.writeDepth--; }
      if (this.writeDepth === 0) yield vcall(this, "flush", "()V");
    }),
    "enableReplaceObject(Z)Z": function (this: JObjectOut, enabled: number) { const old = this.replace; this.replace = !!enabled; return +old; },
    "replaceObject(Ljava/lang/Object;)Ljava/lang/Object;": (value: unknown) => value,
    "defaultWriteObject()V": function (this: JObjectOut) { return this.context ? writeFields(curThread, this, this.context) : inactive(); },
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

const TC_NULL = 0x70, TC_REFERENCE = 0x71, TC_CLASSDESC = 0x72, TC_OBJECT = 0x73, TC_CLASS = 0x76,
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
async function writeDescriptor(thread: JThread, o: JObjectOut, desc: StreamClass | null): Promise<void> {
  if (!desc) { o.chunks.push(TC_NULL); return; }
  if (reference(o, desc)) return;
  o.chunks.push(TC_CLASSDESC); rawUtf(o, desc.name); rawLong(o, desc.uid);
  o.handles.set(desc, BASE_HANDLE + o.handles.size);
  o.chunks.push(desc.flags, desc.fields.length >> 8, desc.fields.length & 255);
  for (const field of desc.fields) {
    o.chunks.push(field.desc.charCodeAt(0)); rawUtf(o, field.name);
    if (field.desc.length > 1) await writeObject(thread, o, field.desc);
  }
  o.chunks.push(TC_ENDBLOCKDATA);
  await writeDescriptor(thread, o, desc.parent);
}
async function writeObject(thread: JThread, o: JObjectOut, value: unknown): Promise<void> {
  const original = value;
  if (o.replacements.has(value)) value = o.replacements.get(value);
  if (value == null || value === 0) { o.chunks.push(TC_NULL); return; }
  if (reference(o, value)) return;
  if (!o.replacements.has(original)) {
    while (value !== null && typeof value === "object" && rt.iof(value, "java/io/Serializable")) {
      const hook = jmethod(value, mangleMethod("writeReplace", "()Ljava/lang/Object;"));
      if (!hook) break;
      const replaced = await callOn(thread, () => hook.call(value));
      const sameClass = replaced != null && typeof replaced === "object" && replaced.constructor === value.constructor;
      value = replaced;
      if (sameClass) break;
    }
    if (o.replace) value = await vcallOn(thread, o, "replaceObject", "(Ljava/lang/Object;)Ljava/lang/Object;", value);
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
  if (value instanceof JClass) {
    const type = value.ci ?? value.arrDesc ?? value.primName;
    if (!type) throw rt.mkThrowable("java/io/NotSerializableException", "Class has no type");
    o.chunks.push(TC_CLASS);
    await writeDescriptor(thread, o, await streamClassAny(type, thread));
    o.handles.set(value, BASE_HANDLE + o.handles.size);
    return;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const element = Array.isArray(value) ? ("$t" in value && typeof value.$t === "string" ? value.$t : "Ljava/lang/Object;") : primElem(value);
    if (!element || value instanceof DataView) throw rt.mkThrowable("java/io/NotSerializableException", "Unsupported array");
    const desc = await streamClass("[" + element, thread);
    o.chunks.push(TC_ARRAY); await writeDescriptor(thread, o, desc); o.handles.set(value, BASE_HANDLE + o.handles.size);
    const array = value as ArrayLike<unknown>; rawInt(o, array.length);
    if (element.length === 1) {
      const bytes = new Uint8Array(array.length * primitiveSizes[element]), view = new DataView(bytes.buffer);
      for (let i = 0; i < array.length; i++) putPrimitive(view, i * primitiveSizes[element], element, array[i]);
      for (const b of bytes) o.chunks.push(b);
    } else for (let i = 0; i < array.length; i++) await writeObject(thread, o, array[i]);
    return;
  }
  let info = objectInfo(value);
  while (info.types.has("java/lang/Enum") && info.superInfo && info.superInfo.name !== "java/lang/Enum") info = info.superInfo;
  const desc = await streamClass(info, thread);
  o.chunks.push(desc.flags & 16 ? TC_ENUM : TC_OBJECT); await writeDescriptor(thread, o, desc);
  o.handles.set(value, BASE_HANDLE + o.handles.size);
  if (desc.flags & 16) { await writeObject(thread, o, await vcallOn(thread, value, "name", "()Ljava/lang/String;")); return; }
  if (desc.flags & 4) {
    await vcallOn(thread, value, "writeExternal", "(Ljava/io/ObjectOutput;)V", o); o.chunks.push(TC_ENDBLOCKDATA);
  } else {
    const hierarchy: StreamClass[] = [];
    for (let c: StreamClass | null = desc; c; c = c.parent) hierarchy.unshift(c);
    for (const c of hierarchy) {
      const previous = o.context;
      o.context = { value: value as object, desc: c };
      try {
        if (c.flags & 1) {
          await callOn(thread, () => jmethod(c.info!.ctor.prototype, mangleMethod("writeObject", "(Ljava/io/ObjectOutputStream;)V"))!.call(value, o));
          o.chunks.push(TC_ENDBLOCKDATA);
        } else await writeFields(thread, o, o.context);
      } finally { o.context = previous; }
    }
  }
}
const primitiveSizes: Record<string, number> = { Z: 1, B: 1, C: 2, S: 2, I: 4, F: 4, J: 8, D: 8 };
async function writeField(thread: JThread, o: JObjectOut, type: string, value: unknown): Promise<void> {
  if (type.length > 1) return writeObject(thread, o, value);
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

async function writeFields(thread: JThread, o: JObjectOut, { value, desc }: FieldContext): Promise<void> {
  for (const field of desc.fields) await writeField(thread, o, field.desc, Reflect.get(value, field.prop));
}
async function readField(thread: JThread, s: JObjectIn, type: string): Promise<unknown> {
  if (type.length > 1) return readObject(thread, s);
  const view = await rawView(thread, s, primitiveSizes[type]);
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
async function readFields(thread: JThread, s: JObjectIn, { value, desc }: FieldContext): Promise<void> {
  const local = await streamClass(desc.info!, thread);
  for (const field of desc.fields) {
    const data = await readField(thread, s, field.desc);
    const target = local.fields.find(f => f.name === field.name && f.desc === field.desc);
    if (target) Reflect.set(value, target.prop, data);
  }
}

async function rawView(thread: JThread, s: JObjectIn, size: number): Promise<DataView> {
  const bytes = await dataBytes(s, size, thread); return new DataView(bytes.buffer, bytes.byteOffset, size);
}
async function readUtf(thread: JThread, s: JObjectIn): Promise<string> {
  return decodeModifiedUtf8(await dataBytes(s, (await rawView(thread, s, 2)).getUint16(0), thread));
}
async function skipAnnotation(thread: JThread, s: JObjectIn): Promise<void> {
  if (s.blockEnd > s.pos) await dataBytes(s, s.blockEnd - s.pos, thread);
  for (;;) {
    const tag = (await dataBytes(s, 1, thread))[0];
    if (tag === TC_ENDBLOCKDATA) return;
    if (tag === TC_BLOCKDATA || tag === TC_BLOCKDATALONG) {
      const length = tag === TC_BLOCKDATA ? (await dataBytes(s, 1, thread))[0] : (await rawView(thread, s, 4)).getUint32(0);
      await dataBytes(s, length, thread);
    } else await readObject(thread, s, tag);
  }
}
async function readObject(thread: JThread, s: JObjectIn, tag?: number): Promise<unknown> {
  tag ??= (await dataBytes(s, 1, thread))[0];
  switch (tag) {
    case TC_NULL: return null;
    case TC_REFERENCE: {
      const handle = (await rawView(thread, s, 4)).getInt32(0) - BASE_HANDLE;
      if (handle < 0 || handle >= s.handles.length) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid handle");
      return s.handles[handle];
    }
    case TC_RESET: s.handles = []; return readObject(thread, s);
    case TC_STRING:
    case TC_LONGSTRING: {
      const length = tag === TC_STRING ? (await rawView(thread, s, 2)).getUint16(0) : Number((await rawView(thread, s, 8)).getBigInt64(0));
      if (!Number.isSafeInteger(length) || length < 0) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid string length");
      const value = decodeModifiedUtf8(await dataBytes(s, length, thread)), handle = s.handles.length; s.handles.push(value); return resolveRead(thread, s, value, handle);
    }
    case TC_CLASSDESC: {
      const name = await readUtf(thread, s), uid = (await rawView(thread, s, 8)).getBigInt64(0);
      const type = name.replaceAll(".", "/");
      const primitive = ["boolean", "byte", "char", "short", "int", "long", "float", "double", "void"].includes(type);
      const info = name.startsWith("[") || primitive ? null : rt.link(type);
      const local = await streamClassAny(info ?? type, thread);
      if (info && local.uid !== uid) throw rt.mkThrowable("java/io/InvalidClassException", "serialVersionUID mismatch: " + name);
      const desc: StreamClass = { name, uid, flags: 0, fields: [], parent: null, info };
      s.handles.push(desc); s.descriptors.set(desc, desc);
      desc.flags = (await dataBytes(s, 1, thread))[0];
      if (desc.flags !== local.flags) throw rt.mkThrowable("java/io/InvalidClassException", "Incompatible class descriptor: " + name);
      const count = (await rawView(thread, s, 2)).getUint16(0);
      for (let i = 0; i < count; i++) {
        const code = String.fromCharCode((await dataBytes(s, 1, thread))[0]), name = await readUtf(thread, s);
        const type = code === "L" || code === "[" ? await readObject(thread, s) : code;
        if (typeof type !== "string" || !(type.length > 1 || primitiveSizes[type])) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid field type");
        desc.fields.push({ name, desc: type, prop: "" });
      }
      await skipAnnotation(thread, s);
      const parent = await readObject(thread, s);
      if (parent !== null) {
        const found = s.descriptors.get(parent);
        if (!found) throw rt.mkThrowable("java/io/StreamCorruptedException", "expected superclass descriptor");
        desc.parent = found;
      }
      return desc;
    }
    case TC_CLASS: {
      const desc = s.descriptors.get(await readObject(thread, s));
      if (!desc) throw rt.mkThrowable("java/io/StreamCorruptedException", "expected class descriptor");
      const value = rt.classFor(desc.name.replaceAll(".", "/"));
      const handle = s.handles.length;
      s.handles.push(value);
      return resolveRead(thread, s, value, handle);
    }
    case TC_ARRAY:
    case TC_ENUM:
    case TC_OBJECT: {
      const desc = s.descriptors.get(await readObject(thread, s));
      if (!desc) throw rt.mkThrowable("java/io/StreamCorruptedException", "expected class descriptor");
      const handle = s.handles.length;
      if (tag === TC_ARRAY) {
        const count = (await rawView(thread, s, 4)).getInt32(0), element = desc.name.slice(1).replaceAll(".", "/");
        if (!desc.name.startsWith("[") || count < 0) throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid array");
        const array = element.length === 1 ? new PRIM_ARRAYS[element as PrimElem](count) : jarray(Array(count).fill(null), element);
        s.handles.push(array);
        if (element.length === 1) {
          const view = await rawView(thread, s, count * primitiveSizes[element]);
          for (let i = 0; i < count; i++) Reflect.set(array, i, getPrimitive(view, i * primitiveSizes[element], element));
        } else for (let i = 0; i < count; i++) Reflect.set(array, i, await readObject(thread, s));
        return resolveRead(thread, s, array, handle);
      }
      if (!desc.info) throw rt.mkThrowable("java/io/StreamCorruptedException", "expected object class");
      if (tag === TC_ENUM) {
        s.handles.push(null);
        const name = await readObject(thread, s);
        if (typeof name !== "string") throw rt.mkThrowable("java/io/StreamCorruptedException", "expected enum name");
        return resolveRead(thread, s, await vcallOn(thread, rt.link("java/lang/Enum").ctor, "valueOf", "(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;", rt.classFor(desc.info.name), name), handle);
      }
      const value = await callOn(thread, () => newObj(desc.info!.name, desc.flags & 4 ? "()V" : null));
      s.handles.push(value);
      if (desc.flags & 4) {
        await vcallOn(thread, value, "readExternal", "(Ljava/io/ObjectInput;)V", s); await skipAnnotation(thread, s);
      } else {
        const hierarchy: StreamClass[] = [];
        for (let c: StreamClass | null = desc; c; c = c.parent) hierarchy.unshift(c);
        const base = hierarchy[0].info?.superInfo;
        if (base) await callOn(thread, () => jmethod(base.ctor.prototype, mangleMethod("<init>", "()V"))?.call(value));
        for (const c of hierarchy) {
          const previous = s.context; s.context = { value, desc: c };
          try {
            const method = mangleMethod("readObject", "(Ljava/io/ObjectInputStream;)V");
            const hook = Object.hasOwn(c.info!.ctor.prototype, method) ? jmethod(c.info!.ctor.prototype, method) : undefined;
            if (hook) await callOn(thread, () => hook.call(value, s)); else await readFields(thread, s, s.context);
            if (c.flags & 1) await skipAnnotation(thread, s);
          } finally { s.context = previous; }
        }
      }
      const hook = jmethod(value, mangleMethod("readResolve", "()Ljava/lang/Object;"));
      return resolveRead(thread, s, hook ? await callOn(thread, () => hook.call(value)) : value, handle);
    }
    default: throw rt.mkThrowable("java/io/StreamCorruptedException", "unsupported serialization tag 0x" + tag.toString(16));
  }
}

async function resolveRead(thread: JThread, s: JObjectIn, value: unknown, handle: number): Promise<unknown> {
  return s.handles[handle] = s.resolve ? await vcallOn(thread, s, "resolveObject", "(Ljava/lang/Object;)Ljava/lang/Object;", value) : value;
}
