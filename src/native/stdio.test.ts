import { expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { vfs } from "../jvm/natives/jio";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { mem } from "./mem";
import { javaCloseFd, javaOpenFd, stdioInit } from "./stdio";

test("record-lock queries report no conflicting process lock through the guest pointer", async () => {
  setA64(true);
  stdioInit();
  const cpu = new Cpu(mainThread, "fcntl-test");
  const path = "/fcntl-test";
  vfs.write(path, new Uint8Array(0));
  const fd = javaOpenFd(path, 2);
  const lock = mem.hostAlloc(32);
  const fcntl = lookupHost("fcntl", "libc.so");
  if (fcntl === undefined) throw new Error("fcntl was not registered");
  try {
    for (const cmd of [5, 12]) {
      mem.memset(lock, 0, 32);
      mem.st16(lock, 1);
      mem.st64(lock + 8, 128n);
      mem.st64(lock + 16, 1n);
      expect(await cpu.call(fcntl, [fd, cmd, lock])).toBe(0);
      expect(mem.ld16u(lock)).toBe(2);
      expect(mem.ld64(lock + 8)).toBe(128n);
      expect(mem.ld64(lock + 16)).toBe(1n);
    }
  } finally { javaCloseFd(fd); vfs.delete(path); cpu.dispose(); }
});
