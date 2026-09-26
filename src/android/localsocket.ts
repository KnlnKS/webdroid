// android.net.LocalSocket / LocalServerSocket / LocalSocketAddress: AF_UNIX sockets within this
// process. A server owns a name in the abstract namespace; a client's connect pairs it with a
// socket the server's accept() hands out, and each side's streams are the other's queue.
import { rt, JObj, noops, driven, type Gen } from "../jvm/runtime";
import { JInputStream, JOutputStream } from "../jvm/natives/jio";
import { mkEnumSet } from "../jvm/natives/jlang";
import { u8 } from "../jvm/abi";

const namespaces = mkEnumSet("android/net/LocalSocketAddress$Namespace", ["ABSTRACT", "RESERVED", "FILESYSTEM"]);
class JLocalSocketAddress extends JObj { name = ""; ns: unknown = namespaces[0]; }
rt.register({
  name: "android/net/LocalSocketAddress", ctor: JLocalSocketAddress,
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JLocalSocketAddress, name: string) { this.name = name; },
    "<init>(Ljava/lang/String;Landroid/net/LocalSocketAddress$Namespace;)V": function (this: JLocalSocketAddress, name: string, ns: unknown) { this.name = name; this.ns = ns; },
    "getName()Ljava/lang/String;": function (this: JLocalSocketAddress) { return this.name; },
    "getNamespace()Landroid/net/LocalSocketAddress$Namespace;": function (this: JLocalSocketAddress) { return this.ns; },
  },
});

/** one direction of a connection: bytes queued by the peer, readers parked until some arrive or the peer closes */
class Queue {
  chunks: Uint8Array[] = [];
  closed = false;
  waiters: (() => void)[] = [];
  push(b: Uint8Array): void { this.chunks.push(b); this.wake(); }
  close(): void { this.closed = true; this.wake(); }
  private wake(): void { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  available(): number { return this.chunks.reduce((n, c) => n + c.length, 0); }
  async read(out: Int8Array, off: number, len: number): Promise<number> {
    while (!this.chunks.length) {
      if (this.closed) return -1;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const c = this.chunks[0], n = Math.min(len, c.length);
    u8(out, off, n).set(c.subarray(0, n));
    if (n === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(n);
    return n;
  }
}
class JLocalSocketIn extends JInputStream { q!: Queue; }
class JLocalSocketOut extends JOutputStream {
  peer!: Queue;
  send(bytes: Uint8Array): void {
    if (this.peer.closed) throw rt.mkThrowable("java/io/IOException", "Broken pipe");
    this.peer.push(bytes);
  }
}
rt.register({
  name: "webdroid/LocalSocketInputStream", ctor: JLocalSocketIn, sup: "java/io/InputStream",
  methods: {
    "read()I": driven(function* (this: JLocalSocketIn): Gen { const b = new Int8Array(1); return (yield this.q.read(b, 0, 1)) < 0 ? -1 : b[0] & 0xff; }),
    "read([BII)I": function (this: JLocalSocketIn, out: Int8Array, off: number, len: number) { return len === 0 ? 0 : this.q.read(out, off, len); },
    "read([B)I": function (this: JLocalSocketIn, out: Int8Array) { return out.length === 0 ? 0 : this.q.read(out, 0, out.length); },
    "available()I": function (this: JLocalSocketIn) { return this.q.available(); },
    "close()V": function (this: JLocalSocketIn) { this.q.close(); },
  },
});
rt.register({
  name: "webdroid/LocalSocketOutputStream", ctor: JLocalSocketOut, sup: "java/io/OutputStream",
  methods: {
    "write(I)V": function (this: JLocalSocketOut, b: number) { this.send(Uint8Array.of(b & 0xff)); },
    "write([BII)V": function (this: JLocalSocketOut, b: Int8Array, off: number, len: number) { this.send(u8(b, off, len).slice()); },
    "write([B)V": function (this: JLocalSocketOut, b: Int8Array) { this.send(u8(b).slice()); },
    "flush()V": function () {},
    "close()V": function (this: JLocalSocketOut) { this.peer.close(); },
  },
});

class JLocalSocket extends JObj {
  connected = false;
  closed = false;
  inbox = new Queue();
  peer: JLocalSocket | null = null;
  address: JLocalSocketAddress | null = null;
  in: JLocalSocketIn | null = null;
  out: JLocalSocketOut | null = null;
  timeoutMs = 0;
}
class JLocalServerSocket extends JObj {
  name = "";
  closed = false;
  backlog: JLocalSocket[] = [];
  acceptors: ((s: JLocalSocket | null) => void)[] = [];
}
const servers = new Map<string, JLocalServerSocket>();
const bound = (s: JLocalSocket) => { if (s.closed) throw rt.mkThrowable("java/io/IOException", "socket closed"); if (!s.connected) throw rt.mkThrowable("java/io/IOException", "socket not connected"); return s; };
function pair(client: JLocalSocket, server: JLocalServerSocket): void {
  const peer = new JLocalSocket();
  peer.peer = client; client.peer = peer;
  peer.connected = client.connected = true;
  server.backlog.push(peer);
  const acceptor = server.acceptors.shift();
  if (acceptor) acceptor(server.backlog.shift()!);
}
function connect(this: JLocalSocket, addr: JLocalSocketAddress): void {
  if (this.closed) throw rt.mkThrowable("java/io/IOException", "socket closed");
  if (this.connected) throw rt.mkThrowable("java/io/IOException", "already connected");
  const server = servers.get(addr.name);
  if (!server || server.closed) throw rt.mkThrowable("java/io/IOException", "Connection refused");
  this.address = addr;
  pair(this, server);
}
function closeSocket(s: JLocalSocket): void {
  if (s.closed) return;
  s.closed = true;
  s.inbox.close();
  if (s.peer && !s.peer.closed) s.peer.inbox.close();
}
rt.register({
  name: "android/net/LocalSocket", ctor: JLocalSocket, ifaces: ["java/io/Closeable"],
  statics: { SOCKET_DGRAM: 1, SOCKET_STREAM: 2, SOCKET_SEQPACKET: 3 },
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "connect(Landroid/net/LocalSocketAddress;)V": connect,
    "connect(Landroid/net/LocalSocketAddress;I)V": connect,
    "isConnected()Z": function (this: JLocalSocket) { return this.connected && !this.closed ? 1 : 0; },
    "isClosed()Z": function (this: JLocalSocket) { return this.closed ? 1 : 0; },
    "isBound()Z": function (this: JLocalSocket) { return this.address ? 1 : 0; },
    "getInputStream()Ljava/io/InputStream;": function (this: JLocalSocket) {
      bound(this);
      if (!this.in) { rt.link("webdroid/LocalSocketInputStream"); this.in = new JLocalSocketIn(); this.in.q = this.inbox; }
      return this.in;
    },
    "getOutputStream()Ljava/io/OutputStream;": function (this: JLocalSocket) {
      bound(this);
      if (!this.out) { rt.link("webdroid/LocalSocketOutputStream"); this.out = new JLocalSocketOut(); this.out.peer = this.peer!.inbox; }
      return this.out;
    },
    "close()V": function (this: JLocalSocket) { closeSocket(this); },
    "shutdownInput()V": function (this: JLocalSocket) { this.inbox.close(); },
    "shutdownOutput()V": function (this: JLocalSocket) { this.peer?.inbox.close(); },
    "setSoTimeout(I)V": function (this: JLocalSocket, ms: number) { this.timeoutMs = ms; },
    "getSoTimeout()I": function (this: JLocalSocket) { return this.timeoutMs; },
    "getLocalSocketAddress()Landroid/net/LocalSocketAddress;": function (this: JLocalSocket) { return this.address; },
    "getRemoteSocketAddress()Landroid/net/LocalSocketAddress;": function (this: JLocalSocket) { return this.peer?.address ?? null; },
    // no descriptor stands behind an in-process pair: AOSP answers null for an unconnected socket, and so does this
    "getFileDescriptor()Ljava/io/FileDescriptor;": () => null,
    ...noops("setReceiveBufferSize(I)V", "setSendBufferSize(I)V"),
    "getReceiveBufferSize()I": () => 65536, "getSendBufferSize()I": () => 65536,
    "toString()Ljava/lang/String;": function (this: JLocalSocket) { return "LocalSocket[" + (this.address?.name ?? "") + "]"; },
  },
});
rt.register({
  name: "android/net/LocalServerSocket", ctor: JLocalServerSocket, ifaces: ["java/io/Closeable"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JLocalServerSocket, name: string) {
      if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", "name");
      if (servers.has(name)) throw rt.mkThrowable("java/io/IOException", "Address already in use");
      this.name = name;
      servers.set(name, this);
    },
    "accept()Landroid/net/LocalSocket;": function (this: JLocalServerSocket) {
      if (this.closed) throw rt.mkThrowable("java/io/IOException", "socket closed");
      const ready = this.backlog.shift();
      if (ready) return ready;
      return new Promise<JLocalSocket | null>((r) => this.acceptors.push(r)).then((s) => {
        if (!s) throw rt.mkThrowable("java/io/IOException", "socket closed");
        return s;
      });
    },
    "getLocalSocketAddress()Landroid/net/LocalSocketAddress;": function (this: JLocalServerSocket) {
      const a = new JLocalSocketAddress(); a.name = this.name; return a;
    },
    "getFileDescriptor()Ljava/io/FileDescriptor;": () => null,
    "close()V": function (this: JLocalServerSocket) {
      if (this.closed) return;
      this.closed = true;
      if (servers.get(this.name) === this) servers.delete(this.name);
      for (const a of this.acceptors.splice(0)) a(null);
    },
  },
});
