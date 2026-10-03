import { expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { ldp, lookupHost } from "./host";
import { libcInit } from "./libc";
import { kernelInit } from "./syscall";
import { mem } from "./mem";
import { netInit, socketCreate, socketBind, socketListen, socketConnect, socketAccept, socketSend, socketReceive, socketShutdown, socketName, socketOption, socketClose, AF_INET, AF_INET6, SOL_SOCKET } from "./net";
import { E } from "./abi";

test("a loopback TCP connection stays in the process, with Linux's errors", async () => {
  const SOCK_STREAM = 1, SOCK_NONBLOCK = 0x800, SO_ERROR = 4, any6 = new Array(16).fill(0);
  const server = socketCreate(AF_INET6, SOCK_STREAM, 0);
  expect(socketBind(server, { address: any6, port: 0 })).toBe(0);
  expect(socketListen(server)).toBe(0);
  const { port } = socketName(server, false) as { port: number };
  const refused = socketCreate(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
  expect(socketConnect(refused, { address: [127, 0, 0, 1], port: port === 1 ? 2 : 1 })).toBe(-E.INPROGRESS);
  expect(socketOption(refused, SOL_SOCKET, SO_ERROR)).toBe(E.CONNREFUSED);

  const client = socketCreate(AF_INET, SOCK_STREAM, 0);
  expect(socketConnect(client, { address: [127, 0, 0, 1], port })).toBe(0);
  const accepted = await socketAccept(server) as { fd: number; peer: { address: number[]; port: number } };
  expect(accepted.peer).toEqual(socketName(client, false) as { address: number[]; port: number });
  const buffer = new Uint8Array(8);
  const pending = socketReceive(accepted.fd, buffer);
  expect(pending).toBeInstanceOf(Promise);
  expect(socketSend(client, Uint8Array.of(1, 2, 3))).toBe(3);
  expect(await pending).toBe(3);
  expect(socketShutdown(client, 1)).toBe(0);
  expect(socketReceive(accepted.fd, buffer)).toBe(0);
  expect(socketSend(client, Uint8Array.of(4))).toBe(-E.PIPE);
  expect(socketSend(accepted.fd, Uint8Array.of(5))).toBe(1);
  expect(socketReceive(client, buffer)).toBe(1);
  for (const fd of [client, accepted.fd, server, refused]) expect(socketClose(fd)).toBe(0);
  expect(socketReceive(client, buffer)).toBe(-E.BADF);
});

test("getifaddrs exposes the same loopback interface as Java networking", async () => {
  setA64(false); kernelInit(); libcInit(); netInit();
  const cpu = new Cpu(mainThread, "ifaddrs-test"), result = mem.malloc(4);
  const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  try {
    expect(await call("getifaddrs", result)).toBe(0);
    const entry = ldp(result), address = ldp(entry + 12);
    expect(mem.cstr(ldp(entry + 4))).toBe("lo");
    expect(mem.ld16u(address)).toBe(2);
    expect([...mem.bytes(address + 4, 4)]).toEqual([127, 0, 0, 1]);
    await call("freeifaddrs", entry);
  } finally { mem.free(result); cpu.dispose(); }
});

test("native AF_INET6 sockets take IPv4-mapped peers, and recvmsg keeps a seqpacket message whole", async () => {
  setA64(false); kernelInit(); libcInit(); netInit();
  const cpu = new Cpu(mainThread, "inet6-test"), scratch = mem.malloc(256);
  const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  const sockaddr = scratch, length = scratch + 32, pair = scratch + 40, msg = scratch + 64, iov = scratch + 96, data = scratch + 128;
  try {
    const server = await call("socket", AF_INET6, 1, 0);
    mem.memset(sockaddr, 0, 28); mem.st16(sockaddr, AF_INET6);
    expect(await call("bind", server, sockaddr, 28)).toBe(0);
    expect(await call("listen", server, 1)).toBe(0);
    mem.st32(length, 28);
    expect(await call("getsockname", server, sockaddr, length)).toBe(0);
    expect([mem.ld32(length), mem.ld16u(sockaddr)]).toEqual([28, AF_INET6]);
    const port = mem.bytes(sockaddr + 2, 2).slice();
    const client = await call("socket", AF_INET, 1, 0);
    mem.memset(sockaddr, 0, 16); mem.st16(sockaddr, AF_INET); mem.write(sockaddr + 2, port); mem.write(sockaddr + 4, [127, 0, 0, 1]);
    expect(await call("connect", client, sockaddr, 16)).toBe(0);
    mem.st32(length, 28);
    const accepted = await call("accept", server, sockaddr, length);
    expect(accepted).toBeGreaterThan(0);
    expect(mem.ld32(length)).toBe(28);
    expect([...mem.bytes(sockaddr + 8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 127, 0, 0, 1]);

    expect(await call("socketpair", 1, 5 /* SOCK_SEQPACKET */, 0, pair)).toBe(0);
    mem.write(data, [1, 2, 3, 4, 5]);
    expect(await call("send", mem.ld32(pair), data, 5, 0)).toBe(5);
    mem.memset(msg, 0, 28); mem.st32(msg + 8, iov); mem.st32(msg + 12, 1);
    mem.st32(iov, data + 16); mem.st32(iov + 4, 3);
    expect(await call("recvmsg", mem.ld32(pair + 4), msg, 0)).toBe(3);
    expect([...mem.bytes(data + 16, 3), mem.ld32(msg + 24)]).toEqual([1, 2, 3, 0x20 /* MSG_TRUNC */]);
    for (const fd of [client, accepted, server, mem.ld32(pair), mem.ld32(pair + 4)]) expect(await call("close", fd)).toBe(0);
  } finally { mem.free(scratch); cpu.dispose(); }
});
