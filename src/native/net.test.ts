import { afterEach, beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import type { RelayTransport } from "../shell/relay";
import { Cpu } from "./cpu";
import { ldp } from "./host";
import { mem } from "./mem";
import {
  nativeConnect, nativeFreeaddrinfo, nativeGetaddrinfo, nativeGetnameinfo, nativeGetsockopt, nativePoll,
  nativeSend, nativeSocket, nativeSocketClose, nativeSocketDup, nativeSocketRead, nativeSocketWrite,
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
  connect(): void {
    this.readyState = 1;
    this.onmessage?.(new MessageEvent("message", { data: "ok" }));
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
