import { expect, test } from "vite-plus/test";
import { mainThread } from "../jvm/natives/jentry.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { ldp } from "./host.ts";
import { libcInit } from "./libc32/libc.ts";
import { kernelInit } from "./syscall.ts";
import { mem } from "./mem.ts";
import { socketCreate } from "./socket/syscalls.ts";
import type { Socket, Accepted } from "./socket/core.ts";
import { SOL_SOCKET, type SocketAddress } from "./socket/abi.ts";
import { E } from "./abi.ts";
import { closeFd } from "./fd.ts";
import { readSocket, socketOf } from "./socket/core.ts";
import { AF_INET, AF_INET6, guestEndpoint, type Endpoint } from "./net-address.ts";
import { loopbackFetch } from "../shell/devicefetch.ts";
import { kernelCalls, libCalls } from "./calls.testkit.ts";


const sock = (fd: number) => socketOf(fd) as Socket;
const inet = (address: number[], port: number): SocketAddress => ({ family: address.length === 4 ? AF_INET : AF_INET6, ep: { address, port } });
const endpoint = (fd: number) => (sock(fd).name(false) as { ep: Endpoint }).ep;

test("a loopback TCP connection stays in the process, with Linux's errors", async () => {
  const SOCK_STREAM = 1, SOCK_NONBLOCK = 0x800, SO_ERROR = 4, any6 = new Array(16).fill(0);
  const server = socketCreate(AF_INET6, SOCK_STREAM, 0);
  expect(sock(server).bind(inet(any6, 0))).toBe(0);
  expect(sock(server).listen()).toBe(0);
  const { port } = endpoint(server);
  const refused = socketCreate(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
  expect(sock(refused).connect(inet([127, 0, 0, 1], port === 1 ? 2 : 1))).toBe(-E.INPROGRESS);
  expect(sock(refused).getOption(SOL_SOCKET, SO_ERROR)).toBe(E.CONNREFUSED);

  const client = socketCreate(AF_INET, SOCK_STREAM, 0);
  expect(sock(client).connect(inet([127, 0, 0, 1], port))).toBe(0);
  const accepted = await sock(server).accept(server, 0) as Accepted;
  expect((accepted.peer as { ep: Endpoint }).ep).toEqual(endpoint(client));
  const buffer = new Uint8Array(8);
  const pending = readSocket(accepted.fd, buffer);
  expect(pending).toBeInstanceOf(Promise);
  expect(sock(client).send(Uint8Array.of(1, 2, 3), null, null)).toBe(3);
  expect(await pending).toBe(3);
  expect(sock(client).shutdown(1)).toBe(0);
  expect(readSocket(accepted.fd, buffer)).toBe(0);
  expect(sock(client).send(Uint8Array.of(4), null, null)).toBe(-E.PIPE);
  expect(sock(accepted.fd).send(Uint8Array.of(5), null, null)).toBe(1);
  expect(readSocket(client, buffer)).toBe(1);
  for (const fd of [client, accepted.fd, server, refused]) expect(closeFd(fd)).toBe(0);
  expect(readSocket(client, buffer)).toBe(-E.BADF);
});

test("getifaddrs exposes the same loopback interface as Java networking", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(mainThread, "ifaddrs-test"), result = mem.malloc(4);
  const call = libCalls(cpu, "libc.so");
  try {
    expect(await call("getifaddrs", result)).toBe(0);
    const entry = ldp(result), address = ldp(entry + 12);
    expect(mem.cstr(ldp(entry + 4))).toBe("lo");
    expect(mem.ld16u(address)).toBe(2);
    expect([...mem.bytes(address + 4, 4)]).toEqual([127, 0, 0, 1]);
    await call("freeifaddrs", entry);
  } finally { mem.free(result); cpu.dispose(); }
});

test("the ARM32 libc reads IPv4 text as inet_pton does and answers gethostby* from the resolver", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(mainThread, "hostent-test"), text = mem.malloc(32), out = mem.malloc(4);
  const call = libCalls(cpu, "libc.so"), str = (s: string) => { mem.putCstr(text, s, 32); return text; };
  const addresses = (entry: number) => [ldp(ldp(entry + 16)), ldp(ldp(entry + 16) + 4)];
  try {
    expect(await call("inet_aton", str("256.1.1.1"), out)).toBe(0);
    expect(await call("inet_aton", str("10.0.0.1"), out)).toBe(1);
    expect([...mem.bytes(out, 4)]).toEqual([10, 0, 0, 1]);
    expect((await call("inet_addr", str("1.2.3.4"))) >>> 0).toBe(0x04030201);
    mem.u8.set([127, 0, 0, 1], out);
    const byAddress = await call("gethostbyaddr", out, 4, AF_INET);
    expect([mem.cstr(ldp(byAddress)), mem.ld32(byAddress + 8), mem.ld32(byAddress + 12)]).toEqual(["localhost", AF_INET, 4]);
    expect(addresses(byAddress)[1]).toBe(0);
    const byName = await call("gethostbyname", str("localhost"));
    expect([...mem.bytes(addresses(byName)[0], 4)]).toEqual([127, 0, 0, 1]);
    expect(await call("gethostbyname", str("256.0.0.1"))).toBe(0);
    expect(mem.ld32(await call("__get_h_errno"))).toBe(1);
  } finally { mem.free(text); mem.free(out); cpu.dispose(); }
});

test("native AF_INET6 sockets take IPv4-mapped peers, and recvmsg keeps a seqpacket message whole", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(mainThread, "inet6-test"), scratch = mem.malloc(256);
  const call = libCalls(cpu, "libc.so");
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

test("an LP64 msghdr carries a UDP datagram and its sender through sendmsg and recvmsg", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(mainThread, "msghdr-test"), scratch = mem.malloc(512);
  const call = kernelCalls(cpu);
  const sockaddr = scratch, length = scratch + 32, msg = scratch + 64, iov = scratch + 128, data = scratch + 160, from = scratch + 224;
  const message = (name: number, nameLength: number, base: number, size: number) => {
    mem.memset(msg, 0, 56);
    mem.st64(msg, BigInt(name)); mem.st32(msg + 8, nameLength); mem.st64(msg + 16, BigInt(iov)); mem.st64(msg + 24, 1n);
    mem.st64(iov, BigInt(base)); mem.st64(iov + 8, BigInt(size));
  };
  try {
    const receiver = await call("socket", AF_INET, 2 | 0x800, 0), sender = await call("socket", AF_INET, 2, 0);
    mem.memset(sockaddr, 0, 16); mem.st16(sockaddr, AF_INET); mem.write(sockaddr + 4, [127, 0, 0, 1]);
    expect(await call("bind", receiver, sockaddr, 16)).toBe(0);
    mem.st32(length, 16);
    expect(await call("getsockname", receiver, sockaddr, length)).toBe(0);
    message(0, 0, data, 4);
    expect(await call("recvmsg", receiver, msg, 0)).toBe(-E.AGAIN);
    mem.write(data, [9, 8, 7, 6]);
    message(sockaddr, 16, data, 4);
    expect(await call("sendmsg", sender, msg, 0)).toBe(4);
    message(from, 16, data + 8, 8);
    expect(await call("recvmsg", receiver, msg, 0)).toBe(4);
    expect([...mem.bytes(data + 8, 4), mem.ld32(msg + 8), mem.ld16u(from)]).toEqual([9, 8, 7, 6, 16, AF_INET]);
    for (const fd of [receiver, sender]) expect(await call("close", fd)).toBe(0);
  } finally { mem.free(scratch); cpu.dispose(); setA64(false); }
});

test("AF_UNIX passes descriptors and credentials, times out receives and breaks pipes as Linux does", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(mainThread, "scm-test"), scratch = mem.malloc(512);
  const call = kernelCalls(cpu);
  const pair = scratch, msg = scratch + 16, iov = scratch + 80, data = scratch + 96, control = scratch + 128, option = scratch + 256, pipe = scratch + 288;
  const message = (controlLength: number) => {
    mem.memset(msg, 0, 56);
    mem.st64(msg + 16, BigInt(iov)); mem.st64(msg + 24, 1n); mem.st64(msg + 32, BigInt(control)); mem.st64(msg + 40, BigInt(controlLength));
    mem.st64(iov, BigInt(data)); mem.st64(iov + 8, 4n);
  };
  try {
    expect(await call("socketpair", 1, 1, 0, pair)).toBe(0);
    const a = mem.ld32(pair), b = mem.ld32(pair + 4);
    expect(await call("pipe2", pipe, 0)).toBe(0);
    const [readEnd, writeEnd] = [mem.ld32(pipe), mem.ld32(pipe + 4)];
    // SCM_RIGHTS: the write end travels, and outlives the sender's descriptor
    mem.write(data, [1, 2, 3, 4]);
    message(24);
    mem.st64(control, 20n); mem.st32(control + 8, 1); mem.st32(control + 12, 1); mem.st32(control + 16, writeEnd);
    expect(await call("sendmsg", a, msg, 0)).toBe(4);
    expect(await call("close", writeEnd)).toBe(0);
    mem.st32(option, 1);
    expect(await call("setsockopt", b, 1, 16 /* SO_PASSCRED */, option, 4)).toBe(0);
    message(64);
    expect(await call("recvmsg", b, msg, 0x40000000 /* MSG_CMSG_CLOEXEC */)).toBe(4);
    expect(Number(mem.ld64(msg + 40))).toBe(32 + 24);
    expect([Number(mem.ld64(control)), mem.ld32(control + 8), mem.ld32(control + 12), Number(mem.ld64(control + 32)), mem.ld32(control + 44)]).toEqual([28, 1, 2, 20, 1]);
    const received = mem.ld32(control + 48);
    expect(await call("write", received, data, 2)).toBe(2);
    expect(await call("read", readEnd, data + 8, 4)).toBe(2);
    // SO_RCVTIMEO: EAGAIN once it passes
    mem.st64(option, 0n); mem.st64(option + 8, 20_000n);
    expect(await call("setsockopt", b, 1, 20 /* SO_RCVTIMEO */, option, 16)).toBe(0);
    expect(await call("read", b, data, 4)).toBe(-E.AGAIN);
    // EPIPE once the reader is gone, raising SIGPIPE (blocked, so pending) unless MSG_NOSIGNAL
    expect(await call("close", b)).toBe(0);
    expect(await call("sendto", a, data, 1, 0x4000 /* MSG_NOSIGNAL */, 0, 0)).toBe(-E.PIPE);
    expect(cpu.signals.has(13)).toBe(false);
    expect(await call("write", a, data, 1)).toBe(-E.PIPE);
    expect(cpu.signals.has(13)).toBe(true);
    for (const fd of [a, readEnd, received]) expect(await call("close", fd)).toBe(0);
  } finally { mem.free(scratch); cpu.dispose(); setA64(false); }
});

test("host HTTP to a loopback URL reaches this process's listener", async () => {
  expect(["http://0.0.0.0/", "http://[::1]:8/", "http://127.0.0.2/", "https://localhost/"].map((url) => guestEndpoint(url)))
    .toEqual([{ address: [127, 0, 0, 1], port: 80 }, { address: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], port: 8 },
      { address: [127, 0, 0, 2], port: 80 }, { address: [127, 0, 0, 1], port: 443 }]);
  expect(guestEndpoint("http://example.com/")).toBeNull();
  const server = socketCreate(AF_INET, 1, 0);
  expect(sock(server).bind(inet([0, 0, 0, 0], 0))).toBe(0);
  expect(sock(server).listen()).toBe(0);
  const { port } = endpoint(server);
  expect(await loopbackFetch(`http://localhost:${port + 1}/`)).toBeNull();
  const response = loopbackFetch(`http://localhost:${port}/exocache?v=1`, { method: "POST", headers: new Headers({ "x-test": "1" }), body: Uint8Array.of(104, 105) });
  const accepted = await sock(server).accept(server, 0) as Accepted, buffer = new Uint8Array(4096);
  let request = "";
  while (!request.endsWith("hi")) {
    const n = await readSocket(accepted.fd, buffer);
    request += new TextDecoder().decode(buffer.subarray(0, n as number));
  }
  expect(request).toBe(`POST /exocache?v=1 HTTP/1.1\r\nHost: localhost:${port}\r\nx-test: 1\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi`);
  sock(accepted.fd).send(new TextEncoder().encode("HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"), null, null);
  const answer = (await response)!;
  expect([answer.status, answer.headers.get("x-wd-set-cookie"), await answer.text()]).toEqual([200, '["a=1"]', "abcde"]);
  for (const fd of [accepted.fd, server]) closeFd(fd);
});
