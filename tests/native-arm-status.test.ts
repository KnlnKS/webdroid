import { expect, test } from "bun:test";
import { Cpu, setA64 } from "../src/native/cpu";
import { mem } from "../src/native/mem";
import { mainThread } from "../src/jvm/natives/jlang";
import { RET_SENTINEL } from "../src/native/abi";

test("Thumb APSR transfer preserves condition flags", () => {
  setA64(false);
  const address = mem.malloc(32);
  const code = [0x2000, 0x2800, 0xf3ef, 0x8300, 0x2001, 0xf383, 0x8800, 0xf3ef, 0x8200, 0x4770];
  code.forEach((word, i) => mem.st16(address + i * 2, word));
  const cpu = new Cpu(mainThread, "apsr-test");
  cpu.w[28] = RET_SENTINEL;
  cpu.setPc(address | 1);
  expect(cpu.runSlice(32)).toBe(2);
  expect(cpu.w[4] & 0xf0000000).toBe(0x60000000);
});
