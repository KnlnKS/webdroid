import { expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { ldp, lookupHost, PTR } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";
import { netInit } from "./net";

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
