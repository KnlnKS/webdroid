import { JObj, rt, driven, type Gen } from "../runtime";
import { vcall, checkFromIndexSize } from "./jlang";
import { JInputStream, JOutputStream, skipStream, noMark } from "./jio";
import { remainingBytes, resident, type JBuffer } from "./jnio";

class JStreamChannel extends JObj { stream: unknown = null; open = true; }
const channelMethods = {
  "isOpen()Z": function (this: JStreamChannel) { return +this.open; },
  "close()V": function (this: JStreamChannel) { if (this.open) { this.open = false; return vcall(this.stream, "close", "()V"); } },
};
rt.register({ name: "webdroid/InputStreamChannel", ctor: class extends JStreamChannel {}, ifaces: ["java/nio/channels/ReadableByteChannel", "java/nio/channels/Channel"], methods: {
  ...channelMethods,
  "read(Ljava/nio/ByteBuffer;)I": driven(function* (this: JStreamChannel, buffer: JBuffer): Gen {
    if (!this.open) throw rt.mkThrowable("java/nio/channels/ClosedChannelException", null);
    buffer.clampPut(0); const count = buffer.lim - buffer.pos;
    if (!count) return 0;
    const native = buffer.backing.storage.kind === "native", bytes = native ? new Int8Array(count) : remainingBytes(buffer);
    const n = yield vcall(this.stream, "read", "([BII)I", bytes, 0, count);
    if (n > 0) { if (native) remainingBytes(buffer).set(bytes.subarray(0, n)); buffer.pos += n; } return n;
  }),
} });
rt.register({ name: "webdroid/OutputStreamChannel", ctor: class extends JStreamChannel {}, ifaces: ["java/nio/channels/WritableByteChannel", "java/nio/channels/Channel"], methods: {
  ...channelMethods,
  "write(Ljava/nio/ByteBuffer;)I": driven(function* (this: JStreamChannel, buffer: JBuffer): Gen {
    if (!this.open) throw rt.mkThrowable("java/nio/channels/ClosedChannelException", null);
    yield resident(buffer);
    const bytes = remainingBytes(buffer), count = bytes.length;
    yield vcall(this.stream, "write", "([BII)V", buffer.backing.storage.kind === "native" ? bytes.slice() : bytes, 0, count);
    buffer.pos += count; return count;
  }),
} });
class JChannelInput extends JInputStream { channel: unknown = null; }
class JChannelOutput extends JOutputStream { channel: unknown = null; }
function wrap(bytes: Int8Array, offset: number, count: number): JBuffer | Promise<JBuffer> {
  if (!bytes) throw rt.mkThrowable("java/lang/NullPointerException", null);
  checkFromIndexSize(offset, count, bytes.length);
  return vcall(rt.link("java/nio/ByteBuffer").ctor, "wrap", "([BII)Ljava/nio/ByteBuffer;", bytes, offset, count);
}
rt.register({ name: "webdroid/ChannelInputStream", ctor: JChannelInput, sup: "java/io/InputStream", methods: {
  "read()I": driven(function* (this: JChannelInput): Gen { const bytes = new Int8Array(1); return (yield vcall(this, "read", "([BII)I", bytes, 0, 1)) === 1 ? bytes[0] & 255 : -1; }),
  "read([BII)I": driven(function* (this: JChannelInput, bytes: Int8Array, offset: number, count: number): Gen {
    const buffer = yield wrap(bytes, offset, count); return count ? vcall(this.channel, "read", "(Ljava/nio/ByteBuffer;)I", buffer) : 0;
  }),
  "close()V": function (this: JChannelInput) { return vcall(this.channel, "close", "()V"); },
  "available()I": () => 0,
  "skip(J)J": skipStream,
  ...noMark,
} });
rt.register({ name: "webdroid/ChannelOutputStream", ctor: JChannelOutput, sup: "java/io/OutputStream", methods: {
  "write(I)V": function (this: JChannelOutput, value: number) { return vcall(this, "write", "([BII)V", Int8Array.of(value), 0, 1); },
  "write([BII)V": driven(function* (this: JChannelOutput, bytes: Int8Array, offset: number, count: number): Gen {
    const buffer = yield wrap(bytes, offset, count);
    while (buffer.pos < buffer.lim) if ((yield vcall(this.channel, "write", "(Ljava/nio/ByteBuffer;)I", buffer)) <= 0) throw rt.mkThrowable("java/io/IOException", "Channel made no progress");
  }),
  "close()V": function (this: JChannelOutput) { return vcall(this.channel, "close", "()V"); },
} });
function adapter(type: string, field: string, value: unknown): JObj {
  if (!value) throw rt.mkThrowable("java/lang/NullPointerException", null);
  return Object.assign(rt.make(type), { [field]: value });
}
rt.register({ name: "java/nio/channels/Channels", ctor: class extends JObj {}, methods: {
  "static newChannel(Ljava/io/InputStream;)Ljava/nio/channels/ReadableByteChannel;": (stream: unknown) => adapter("webdroid/InputStreamChannel", "stream", stream),
  "static newChannel(Ljava/io/OutputStream;)Ljava/nio/channels/WritableByteChannel;": (stream: unknown) => adapter("webdroid/OutputStreamChannel", "stream", stream),
  "static newInputStream(Ljava/nio/channels/ReadableByteChannel;)Ljava/io/InputStream;": (channel: unknown) => adapter("webdroid/ChannelInputStream", "channel", channel),
  "static newOutputStream(Ljava/nio/channels/WritableByteChannel;)Ljava/io/OutputStream;": (channel: unknown) => adapter("webdroid/ChannelOutputStream", "channel", channel),
} });
