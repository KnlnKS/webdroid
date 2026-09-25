import { JObj, rt } from "../jvm/runtime";
import { JBuffer, mkByteBuffer } from "../jvm/natives/jnio";
import { vcall } from "../jvm/natives/jlang";
import { errno } from "./os";
import { JParcel, parcelCreator } from "./parcel";

class JSharedMemory extends JObj {
  bytes: Uint8Array;
  protect = 7;
  closed = false;
  constructor(size: number) { super(); this.bytes = new Uint8Array(size); }
  mapping(protect: number, offset = 0, length = this.bytes.length): JBuffer {
    if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
    if (offset < 0 || length <= 0 || offset + length > this.bytes.length) throw errno("mmap", 22);
    if ((protect & this.protect) !== protect) throw errno("mmap", 13);
    const buffer = mkByteBuffer(length, true);
    buffer.backing.storage = { kind: "direct", ab: this.bytes.buffer as ArrayBuffer };
    buffer.byteOffset = offset;
    buffer.readOnly = !(protect & 2);
    return buffer;
  }
}

rt.register({ name: "android/os/SharedMemory", ctor: JSharedMemory, ifaces: ["android/os/Parcelable", "java/lang/AutoCloseable"],
  statics: { get CREATOR() { return parcelCreator("android/os/SharedMemory", async parcel => {
    const bytes = await vcall(parcel, "createByteArray", "()[B") as Int8Array | null;
    if (!bytes) throw rt.mkThrowable("android/os/BadParcelableException", "Missing shared memory bytes");
    const memory = new JSharedMemory(bytes.length);
    memory.bytes.set(bytes);
    memory.protect = await vcall(parcel, "readInt", "()I") as number;
    return memory;
  }); } }, methods: {
    "static create(Ljava/lang/String;I)Landroid/os/SharedMemory;": (_name: string | null, size: number) => {
      if (size <= 0) throw errno("ashmem_create_region", 22);
      return new JSharedMemory(size);
    },
    "getSize()I": function (this: JSharedMemory) { return this.bytes.length; },
    "mapReadWrite()Ljava/nio/ByteBuffer;": function (this: JSharedMemory) { return this.mapping(3); },
    "mapReadOnly()Ljava/nio/ByteBuffer;": function (this: JSharedMemory) { return this.mapping(1); },
    "map(III)Ljava/nio/ByteBuffer;": function (this: JSharedMemory, protect: number, offset: number, length: number) {
      return this.mapping(protect, offset, length);
    },
    "setProtect(I)Z": function (this: JSharedMemory, protect: number) {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      if (protect & ~this.protect) return 0;
      this.protect = protect;
      return 1;
    },
    "static unmap(Ljava/nio/ByteBuffer;)V": (buffer: JBuffer | null) => {
      if (!buffer) throw rt.mkThrowable("java/lang/IllegalArgumentException", "buffer is null");
      buffer.backing.storage = { kind: "direct", ab: new ArrayBuffer(0) };
    },
    "close()V": function (this: JSharedMemory) { this.closed = true; },
    "describeContents()I": () => 1,
    "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JSharedMemory, parcel: JParcel) {
      await vcall(parcel, "writeByteArray", "([B)V", new Int8Array(this.bytes.buffer));
      await vcall(parcel, "writeInt", "(I)V", this.protect);
    },
  },
});
