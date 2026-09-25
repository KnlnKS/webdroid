import { expect, test } from "bun:test";
import { setA64 } from "../src/native/cpu";
import { Cpu } from "../src/native/cpu";
import { mainThread } from "../src/jvm/natives/jlang";
import { hostLib, lookupHost } from "../src/native/host";
import { mem } from "../src/native/mem";
import { PAGE_SIZE, STACK_SIZE } from "../src/native/abi";

test("reserved native mappings become resident on commit and disappear on unmap", () => {
  setA64(true);
  const base = BigInt(mem.mapVa(STACK_SIZE, true));
  expect(base).not.toBe(0n);
  try {
    expect(mem.residentVa(base)).toBe(0);
    expect(mem.commitVa(base, PAGE_SIZE)).toBe(true);
    expect(mem.residentVa(base)).toBe(1);
    expect(mem.residentVa(base + BigInt(PAGE_SIZE))).toBe(0);
  } finally {
    expect(mem.unmapVa(base, STACK_SIZE)).toBe(true);
    expect(mem.residentVa(base)).toBe(-1);
    setA64(false);
  }
});

test("nested native calls keep the high half of a mapped stack pointer", async () => {
  setA64(true);
  const base = BigInt(mem.mapVa(STACK_SIZE, false));
  const cpu = new Cpu(mainThread, "high-stack-callback");
  const guestSp = base + 0x8000n;
  let observed = 0n;
  hostLib("libc.so", {
    webdroid_test_inner_stack: c => {
      observed = (BigInt(c.w[63] >>> 0) << 32n) | BigInt(c.w[62] >>> 0);
      return 0;
    },
    webdroid_test_outer_stack: async c => {
      c.w[62] = Number(guestSp & 0xffffffffn); c.w[63] = Number(guestSp >> 32n);
      await c.call(lookupHost("webdroid_test_inner_stack", "libc.so")!);
      return 0;
    },
  });
  try {
    await cpu.call(lookupHost("webdroid_test_outer_stack", "libc.so")!);
    expect(observed).toBe(guestSp - 64n);
    expect(mem.txVa(observed)).toBe(mem.txVa(guestSp) - 64);
  } finally {
    cpu.dispose(); mem.unmapVa(base, STACK_SIZE); setA64(false);
  }
});
