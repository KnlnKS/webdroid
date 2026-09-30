import { expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { ldp, lookupHost, PTR } from "./host";
import { libcInit } from "./libc";
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
  for (const a64 of [false, true]) {
    setA64(a64); libcInit(); netInit();
    const cpu = new Cpu(mainThread, "ifaddrs-test"), result = mem.malloc(PTR);
    const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
    try {
      expect(await call("getifaddrs", result)).toBe(0);
      const entry = ldp(result), address = ldp(entry + (a64 ? 24 : 12));
      expect(mem.cstr(ldp(entry + PTR))).toBe("lo");
      expect(mem.ld16u(address)).toBe(2);
      expect([...mem.bytes(address + 4, 4)]).toEqual([127, 0, 0, 1]);
      await call("freeifaddrs", entry);
    } finally { mem.free(result); cpu.dispose(); }
  }
  setA64(false);
});
