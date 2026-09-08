import { afterEach, beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Relay, type RelayTransport } from "../shell/relay";
import { Cpu } from "./cpu";
import { ldp } from "./host";
import { mem } from "./mem";
import {
  nativeBind, nativeConnect, nativeFreeaddrinfo, nativeGetaddrinfo, nativeGetnameinfo, nativeGetpeername, nativeGetsockname, nativeGetsockopt, nativePoll,
  nativeReceiveFrom, nativeSelect, nativeSend, nativeSendTo, nativeSocket, nativeSocketClose, nativeSocketDup, nativeSocketRead, nativeSocketWrite,
  resetNativeNetworkForTest, setNativePollProvider, setNativeRelayTransportFactoryForTest,
} from "./net";

class FakeWebSocket implements RelayTransport {
  binaryType: BinaryType = "blob";
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;

  send(data: Uint8Array): void { this.sent.push(data.slice()); }
  close(): void { this.closeCalls++; this.readyState = 3; }
  connect(endpoint?: { family: "IPv4" | "IPv6"; address: string; port: number }): void {
    this.readyState = 1;
    const data = endpoint ? JSON.stringify({
      type: "ready", localFamily: endpoint.family,
      localAddress: endpoint.address, localPort: endpoint.port,
    }) : "ok";
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  receive(data: Uint8Array): void {
    this.onmessage?.(new MessageEvent("message", { data: data.buffer }));
  }
  fail(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

let cpu: Cpu;
let transports: FakeWebSocket[];

beforeAll(() => { cpu = new Cpu(mainThread, "native network test"); });
afterEach(() => resetNativeNetworkForTest());

test("closing sockets reuses the lowest available descriptor", () => {
  const first = nativeSocket(cpu, 2, 1, 6), second = nativeSocket(cpu, 2, 1, 6);
  nativeSocketClose(cpu, first);
  expect(nativeSocket(cpu, 2, 1, 6)).toBe(first);
  nativeSocketClose(cpu, second);
  expect(nativeSocket(cpu, 2, 1, 6)).toBe(second);
});

function installFakeTransport(): void {
  transports = [];
  setNativeRelayTransportFactoryForTest(() => {
    const transport = new FakeWebSocket();
    transports.push(transport);
    return transport;
  });
}

function resolvedAddress(host: string, port: string): { root: number; sockaddr: number } {
  const node = mem.hostStr(host), service = mem.hostStr(port), hints = mem.hostAlloc(16), result = mem.hostAlloc(8);
  mem.memset(hints, 0, 16);
  mem.st32(hints + 4, 2);
  mem.st32(hints + 8, 1);
  expect(nativeGetaddrinfo(cpu, node, service, hints, result)).toBe(0);
  const root = ldp(result);
  return { root, sockaddr: ldp(root + 24) };
}

function sockaddr(address: [number, number, number, number], port: number): number {
  const result = mem.hostAlloc(16);
  mem.memset(result, 0, 16);
  mem.st16(result, 2);
  mem.u8[result + 2] = port >>> 8;
  mem.u8[result + 3] = port & 255;
  mem.u8.set(address, result + 4);
  return result;
}

test("getaddrinfo builds a Bionic IPv4 stream result", () => {
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  expect(mem.ld32(root + 4)).toBe(2);
  expect(mem.ld32(root + 8)).toBe(1);
  expect(mem.ld32(root + 12)).toBe(6);
  expect(mem.ld32(root + 16)).toBe(16);
  expect(mem.ld16u(sockaddr)).toBe(2);
  expect([...mem.u8.subarray(sockaddr + 2, sockaddr + 4)]).toEqual([1, 187]);
  nativeFreeaddrinfo(root);
});

test("getaddrinfo and socket preserve UDP type and protocol", () => {
  const node = mem.hostStr("127.0.0.1"), service = mem.hostStr("9000"), hints = mem.hostAlloc(16), result = mem.hostAlloc(8);
  mem.memset(hints, 0, 16);
  mem.st32(hints + 4, 2);
  mem.st32(hints + 8, 2);
  mem.st32(hints + 12, 17);
  expect(nativeGetaddrinfo(cpu, node, service, hints, result)).toBe(0);
  const root = ldp(result);
  expect(mem.ld32(root + 8)).toBe(2);
  expect(mem.ld32(root + 12)).toBe(17);
  nativeFreeaddrinfo(root);

  const fd = nativeSocket(cpu, 2, 2, 17);
  expect(fd).toBeGreaterThanOrEqual(0);
  expect(nativeSocket(cpu, 2, 2, 1)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(93);
  nativeSocketClose(cpu, fd);
});

test("UDP bind, sendto, poll, and recvfrom preserve datagram boundaries and source", () => {
  const receiver = nativeSocket(cpu, 2, 2 | 0x800, 17);
  const sender = nativeSocket(cpu, 2, 2, 17);
  const destination = sockaddr([127, 0, 0, 1], 19_001);
  expect(nativeBind(cpu, receiver, destination, 16)).toBe(0);

  const duplicate = nativeSocket(cpu, 2, 2, 17);
  expect(nativeBind(cpu, duplicate, destination, 16)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(98);
  nativeSocketClose(cpu, duplicate);

  const outgoing = mem.hostAlloc(5);
  mem.u8.set([1, 2, 3, 4, 5], outgoing);
  expect(nativeSendTo(cpu, sender, outgoing, 5, destination, 16)).toBe(5);

  const pollfds = mem.hostAlloc(16);
  mem.st32(pollfds, receiver); mem.st16(pollfds + 4, 1);
  mem.st32(pollfds + 8, sender); mem.st16(pollfds + 12, 4);
  expect(nativePoll(cpu, pollfds, 2, 0)).toBe(2);
  expect(mem.ld16u(pollfds + 6)).toBe(1);
  expect(mem.ld16u(pollfds + 14)).toBe(4);

  const readSet = mem.hostAlloc(128), writeSet = mem.hostAlloc(128), timeout = mem.hostAlloc(16);
  mem.memset(readSet, 0, 128); mem.memset(writeSet, 0, 128); mem.memset(timeout, 0, 16);
  mem.u8[readSet + (receiver >>> 3)] |= 1 << (receiver & 7);
  mem.u8[writeSet + (receiver >>> 3)] |= 1 << (receiver & 7);
  expect(nativeSelect(cpu, receiver + 1, readSet, writeSet, 0, timeout)).toBe(2);
  expect(mem.u8[readSet + (receiver >>> 3)] & (1 << (receiver & 7))).not.toBe(0);
  expect(mem.u8[writeSet + (receiver >>> 3)] & (1 << (receiver & 7))).not.toBe(0);

  const peek = mem.hostAlloc(1);
  expect(nativeReceiveFrom(cpu, receiver, peek, 1, 0x2, 0, 0)).toBe(1);
  expect(mem.u8[peek]).toBe(1);
  expect(nativePoll(cpu, pollfds, 1, 0)).toBe(1);

  const incoming = mem.hostAlloc(3), source = mem.hostAlloc(16), sourceLength = mem.hostAlloc(4);
  mem.st32(sourceLength, 16);
  expect(nativeReceiveFrom(cpu, receiver, incoming, 3, 0, source, sourceLength)).toBe(3);
  expect([...mem.u8.subarray(incoming, incoming + 3)]).toEqual([1, 2, 3]);
  expect([...mem.u8.subarray(source + 4, source + 8)]).toEqual([127, 0, 0, 1]);
  const senderPort = (mem.u8[source + 2] << 8) | mem.u8[source + 3];
  expect(senderPort).toBeGreaterThanOrEqual(49_152);
  expect(mem.ld32(sourceLength)).toBe(16);
  expect(nativeReceiveFrom(cpu, receiver, incoming, 3, 0x40, 0, 0)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(11);

  const senderName = mem.hostAlloc(16), senderNameLength = mem.hostAlloc(4);
  mem.st32(senderNameLength, 16);
  expect(nativeGetsockname(cpu, sender, senderName, senderNameLength)).toBe(0);
  expect((mem.u8[senderName + 2] << 8) | mem.u8[senderName + 3]).toBe(senderPort);
  nativeSocketClose(cpu, receiver);
  nativeSocketClose(cpu, sender);
});

test("connected UDP is writable, reports its peer, and rejects unrelayed external sends", () => {
  const fd = nativeSocket(cpu, 2, 2, 17);
  const external = sockaddr([203, 0, 113, 10], 7777);
  expect(nativeConnect(cpu, fd, external, 16)).toBe(0);
  const peer = mem.hostAlloc(16), peerLength = mem.hostAlloc(4);
  mem.st32(peerLength, 16);
  expect(nativeGetpeername(cpu, fd, peer, peerLength)).toBe(0);
  expect([...mem.u8.subarray(peer + 2, peer + 8)]).toEqual([0x1e, 0x61, 203, 0, 113, 10]);
  const byte = mem.hostAlloc(1);
  mem.st8(byte, 9);
  expect(nativeSocketWrite(cpu, fd, byte, 1)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(101);
  nativeSocketClose(cpu, fd);
});

test("UDP recvfrom waits for a complete zero-length datagram", async () => {
  const receiver = nativeSocket(cpu, 2, 2, 17);
  const sender = nativeSocket(cpu, 2, 2, 17);
  const destination = sockaddr([127, 0, 0, 1], 19_002);
  expect(nativeBind(cpu, receiver, destination, 16)).toBe(0);
  const waiting = nativeReceiveFrom(cpu, receiver, 0, 0, 0, 0, 0);
  expect(waiting).toBeInstanceOf(Promise);
  expect(nativeSendTo(cpu, sender, 0, 0, destination, 16)).toBe(0);
  expect(await waiting).toBe(0);
  nativeSocketClose(cpu, receiver);
  nativeSocketClose(cpu, sender);
});

test("one UDP datagram wakes one blocked receiver and leaves the other armed", async () => {
  const receiver = nativeSocket(cpu, 2, 2, 17);
  const sender = nativeSocket(cpu, 2, 2, 17);
  const destination = sockaddr([127, 0, 0, 1], 19_003);
  expect(nativeBind(cpu, receiver, destination, 16)).toBe(0);
  const firstByte = mem.hostAlloc(1), secondByte = mem.hostAlloc(1), outgoing = mem.hostAlloc(1);
  const first = nativeReceiveFrom(cpu, receiver, firstByte, 1, 0, 0, 0);
  const second = nativeReceiveFrom(cpu, receiver, secondByte, 1, 0, 0, 0);
  mem.st8(outgoing, 7);
  expect(nativeSendTo(cpu, sender, outgoing, 1, destination, 16)).toBe(1);
  expect(await first).toBe(1);
  let secondFinished = false;
  void Promise.resolve(second).then(() => { secondFinished = true; });
  await Promise.resolve();
  expect(secondFinished).toBe(false);
  mem.st8(outgoing, 8);
  expect(nativeSendTo(cpu, sender, outgoing, 1, destination, 16)).toBe(1);
  expect(await second).toBe(1);
  expect(mem.u8[firstByte]).toBe(7);
  expect(mem.u8[secondByte]).toBe(8);
  nativeSocketClose(cpu, receiver);
  nativeSocketClose(cpu, sender);
});

test("a nonblocking socket connects, polls, sends, and receives through one relay", async () => {
  installFakeTransport();
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  const fd = nativeSocket(cpu, 2, 1 | 0x800, 6);
  expect(nativeConnect(cpu, fd, sockaddr, 16)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(115);

  const pollfd = mem.hostAlloc(8);
  mem.st32(pollfd, fd);
  mem.st16(pollfd + 4, 1 | 4);
  expect(nativePoll(cpu, pollfd, 1, 0)).toBe(0);

  transports[0].connect();
  await Promise.resolve();
  expect(nativePoll(cpu, pollfd, 1, 0)).toBe(1);
  expect(mem.ld16u(pollfd + 6) & 4).toBe(4);

  const outgoing = mem.hostAlloc(3);
  mem.u8.set([1, 2, 3], outgoing);
  expect(nativeSocketWrite(cpu, fd, outgoing, 3)).toBe(3);
  expect([...transports[0].sent[0]]).toEqual([1, 2, 3]);

  transports[0].receive(new Uint8Array([4, 5]));
  expect(nativePoll(cpu, pollfd, 1, 0)).toBe(1);
  expect(mem.ld16u(pollfd + 6) & 1).toBe(1);
  const incoming = mem.hostAlloc(2);
  expect(await nativeSocketRead(cpu, fd, incoming, 2)).toBe(2);
  expect([...mem.u8.subarray(incoming, incoming + 2)]).toEqual([4, 5]);

  expect(nativeSocketClose(cpu, fd)).toBe(0);
  nativeFreeaddrinfo(root);
});

test("socket names report the virtual peer and relay's real IPv4 local endpoint", async () => {
  installFakeTransport();
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  const fd = nativeSocket(cpu, 2, 1 | 0x800, 6);
  const name = mem.hostAlloc(16), length = mem.hostAlloc(4);

  mem.st32(length, 16);
  expect(nativeGetsockname(cpu, fd, name, length)).toBe(0);
  expect([...mem.u8.subarray(name, name + 8)]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
  expect(mem.ld32(length)).toBe(16);
  expect(nativeGetpeername(cpu, fd, name, length)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(107);
  mem.st32(length, 0);
  expect(nativeGetsockname(cpu, fd, 0, length)).toBe(0);
  expect(mem.ld32(length)).toBe(16);
  mem.st32(length, -1);
  expect(nativeGetsockname(cpu, fd, name, length)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(22);
  mem.st32(length, 1);
  expect(nativeGetsockname(cpu, fd, 0, length)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(14);

  expect(nativeConnect(cpu, fd, sockaddr, 16)).toBe(-1);
  transports[0].connect({ family: "IPv4", address: "10.20.30.40", port: 54321 });
  await Promise.resolve();

  mem.u8.fill(0xcc, name, name + 16);
  mem.st32(length, 4);
  expect(nativeGetpeername(cpu, fd, name, length)).toBe(0);
  expect([...mem.u8.subarray(name, name + 4)]).toEqual([2, 0, 1, 187]);
  expect([...mem.u8.subarray(name + 4, name + 8)]).toEqual([0xcc, 0xcc, 0xcc, 0xcc]);
  expect(mem.ld32(length)).toBe(16);

  mem.st32(length, 16);
  expect(nativeGetsockname(cpu, fd, name, length)).toBe(0);
  expect([...mem.u8.subarray(name, name + 8)]).toEqual([2, 0, 0xd4, 0x31, 10, 20, 30, 40]);
  expect(mem.ld32(length)).toBe(16);
  nativeSocketClose(cpu, fd);
  nativeFreeaddrinfo(root);
});

test("getsockname rejects an incompatible IPv6 relay endpoint", async () => {
  installFakeTransport();
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  const fd = nativeSocket(cpu, 2, 1 | 0x800, 6);
  nativeConnect(cpu, fd, sockaddr, 16);
  transports[0].connect({ family: "IPv6", address: "2001:db8::1", port: 54321 });
  await Promise.resolve();
  const name = mem.hostAlloc(16), length = mem.hostAlloc(4);
  mem.st32(length, 16);
  expect(nativeGetsockname(cpu, fd, name, length)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(97);
  nativeSocketClose(cpu, fd);
  nativeFreeaddrinfo(root);
});

test("failed connect is reported through poll and SO_ERROR", async () => {
  installFakeTransport();
  const { root, sockaddr } = resolvedAddress("unreachable.example", "443");
  const fd = nativeSocket(cpu, 2, 1 | 0x800, 6);
  expect(nativeConnect(cpu, fd, sockaddr, 16)).toBe(-1);
  transports[0].fail();
  await Promise.resolve();
  expect(mem.ld32(cpu.errnoAddr)).toBe(115);

  const pollfd = mem.hostAlloc(8);
  mem.st32(pollfd, fd);
  mem.st16(pollfd + 4, 4);
  expect(nativePoll(cpu, pollfd, 1, 0)).toBe(1);
  expect(mem.ld16u(pollfd + 6) & 8).toBe(8);

  const value = mem.hostAlloc(4), length = mem.hostAlloc(4);
  mem.st32(length, 4);
  expect(nativeGetsockopt(cpu, fd, 1, 4, value, length)).toBe(0);
  expect(mem.ld32(value)).toBe(111);
  expect(nativeGetsockopt(cpu, fd, 1, 4, value, length)).toBe(0);
  expect(mem.ld32(value)).toBe(0);
  nativeFreeaddrinfo(root);
});

test("SO_TYPE reports the socket kind", () => {
  const value = mem.hostAlloc(4), length = mem.hostAlloc(4);
  for (const [type, protocol] of [[1, 6], [2, 17]]) {
    const fd = nativeSocket(cpu, 2, type, protocol);
    mem.st32(length, 4);
    expect(nativeGetsockopt(cpu, fd, 1, 3, value, length)).toBe(0);
    expect(mem.ld32(value)).toBe(type);
    expect(mem.ld32(length)).toBe(4);
    nativeSocketClose(cpu, fd);
  }
});

test("duplicated socket descriptors keep the relay until the last close", async () => {
  installFakeTransport();
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  const fd = nativeSocket(cpu, 2, 1 | 0x800, 6);
  expect(nativeConnect(cpu, fd, sockaddr, 16)).toBe(-1);
  transports[0].connect();
  await Promise.resolve();
  const duplicate = nativeSocketDup(cpu, fd);
  expect(nativeSocketClose(cpu, fd)).toBe(0);
  expect(transports[0].closeCalls).toBe(0);
  expect(nativeSocketClose(cpu, duplicate)).toBe(0);
  expect(transports[0].closeCalls).toBe(1);
  nativeFreeaddrinfo(root);
});

test("poll combines native sockets with local descriptor readiness", () => {
  const restore = setNativePollProvider({
    query: (fd, events) => fd === 77 ? events & 1 : null,
    subscribe: () => () => {},
    read: () => null,
    write: () => null,
  });
  try {
    const socket = nativeSocket(cpu, 2, 1 | 0x800, 6);
    const pollfds = mem.hostAlloc(16);
    mem.st32(pollfds, socket); mem.st16(pollfds + 4, 4);
    mem.st32(pollfds + 8, 77); mem.st16(pollfds + 12, 1);
    expect(nativePoll(cpu, pollfds, 2, 0)).toBe(1);
    expect(mem.ld16u(pollfds + 6)).toBe(0);
    expect(mem.ld16u(pollfds + 14)).toBe(1);
  } finally {
    restore();
  }
});

test("poll ignores negative descriptors", () => {
  const pollfd = mem.hostAlloc(8);
  mem.st32(pollfd, -1); mem.st16(pollfd + 4, 1); mem.st16(pollfd + 6, 0x7fff);
  expect(nativePoll(cpu, pollfd, 1, 0)).toBe(0);
  expect(mem.ld16u(pollfd + 6)).toBe(0);
});

test("select reports connected sockets as writable and clears unready sets", async () => {
  installFakeTransport();
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  const fd = nativeSocket(cpu, 2, 1 | 0x800, 6);
  expect(nativeConnect(cpu, fd, sockaddr, 16)).toBe(-1);
  const readSet = mem.hostAlloc(128), writeSet = mem.hostAlloc(128), timeout = mem.hostAlloc(16);
  mem.memset(readSet, 0, 128); mem.memset(writeSet, 0, 128); mem.memset(timeout, 0, 16);
  mem.u8[readSet + (fd >>> 3)] |= 1 << (fd & 7);
  mem.u8[writeSet + (fd >>> 3)] |= 1 << (fd & 7);
  expect(nativeSelect(cpu, fd + 1, readSet, writeSet, 0, timeout)).toBe(0);
  expect(mem.u8[readSet + (fd >>> 3)] & (1 << (fd & 7))).toBe(0);
  expect(mem.u8[writeSet + (fd >>> 3)] & (1 << (fd & 7))).toBe(0);

  transports[0].connect();
  await Promise.resolve();
  mem.u8[writeSet + (fd >>> 3)] |= 1 << (fd & 7);
  expect(nativeSelect(cpu, fd + 1, 0, writeSet, 0, timeout)).toBe(1);
  expect(mem.u8[writeSet + (fd >>> 3)] & (1 << (fd & 7))).not.toBe(0);
  nativeSocketClose(cpu, fd);
  nativeFreeaddrinfo(root);
});

test("select waits for socket read readiness", async () => {
  installFakeTransport();
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  const fd = nativeSocket(cpu, 2, 1 | 0x800, 6);
  nativeConnect(cpu, fd, sockaddr, 16);
  transports[0].connect();
  await Promise.resolve();
  const readSet = mem.hostAlloc(128);
  mem.memset(readSet, 0, 128);
  mem.u8[readSet + (fd >>> 3)] |= 1 << (fd & 7);
  const waiting = nativeSelect(cpu, fd + 1, readSet, 0, 0, 0);
  expect(waiting).toBeInstanceOf(Promise);
  transports[0].receive(new Uint8Array([9]));
  expect(await waiting).toBe(1);
  expect(mem.u8[readSet + (fd >>> 3)] & (1 << (fd & 7))).not.toBe(0);
  nativeSocketClose(cpu, fd);
  nativeFreeaddrinfo(root);
});

test("getnameinfo honors Bionic NI_NUMERICHOST", () => {
  const { root, sockaddr } = resolvedAddress("services.example", "443");
  const host = mem.hostAlloc(64), service = mem.hostAlloc(16);
  expect(nativeGetnameinfo(sockaddr, 16, host, 64, service, 16, 2)).toBe(0);
  expect(mem.cstr(host)).toMatch(/^198\.18\./);
  expect(mem.cstr(service)).toBe("443");
  nativeFreeaddrinfo(root);
});

test("stream send delegates to a local socketpair descriptor", () => {
  const source = mem.hostAlloc(1);
  mem.st8(source, 7);
  let received = -1;
  const restore = setNativePollProvider({
    query: () => null,
    subscribe: () => () => {},
    read: () => null,
    write: (_cpu, fd, address, length) => {
      if (fd !== 77) return null;
      received = mem.u8[address];
      return length;
    },
  });
  try {
    expect(nativeSend(cpu, 77, source, 1)).toBe(1);
    expect(received).toBe(7);
  } finally {
    restore();
  }
});

test("relay reads retain partial chunks across compaction and drain before EOF", async () => {
  const transport = new FakeWebSocket();
  const relay = new Relay("services.example", 443, false, () => transport);
  transport.connect();
  await relay.ready;
  for (let i = 0; i < 3000; i++) transport.receive(Uint8Array.of(i & 255, (i + 1) & 255));
  const out = new Uint8Array(6002).fill(255);
  expect(await relay.read(out, 1, 1)).toBe(1);
  expect(await relay.read(out, 2, 3500)).toBe(3500);
  transport.fail();
  expect(await relay.read(out, 3502, 2500)).toBe(2499);
  expect(relay.available()).toBe(0);
  expect(out[0]).toBe(255);
  expect(out[6001]).toBe(255);
  for (let i = 0; i < 3000; i++) {
    expect(out[1 + i * 2]).toBe(i & 255);
    expect(out[2 + i * 2]).toBe((i + 1) & 255);
  }
  expect(await relay.read(out, 0, 0)).toBe(0);
  expect(await relay.read(out, 0, 1)).toBe(-1);
});

test("closing a relay wakes its pending reader and one-shot subscribers", async () => {
  const transport = new FakeWebSocket();
  const relay = new Relay("services.example", 443, false, () => transport);
  transport.connect();
  await relay.ready;
  const pending = relay.read(new Uint8Array(1), 0, 1);
  let wakes = 0;
  relay.subscribe(() => wakes++);
  const unsubscribe = relay.subscribe(() => wakes += 10);
  unsubscribe();
  relay.close();
  expect(await pending).toBe(-1);
  expect(wakes).toBe(1);
  relay.close();
  expect(wakes).toBe(1);
});
