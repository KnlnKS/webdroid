import { expect, test } from "bun:test";
import { setA64 } from "../src/native/cpu";
import { vaList } from "../src/native/host";
import { mem } from "../src/native/mem";

test("an AAPCS64 va_list serves stack arguments without touching a register-area pointer it never uses", () => {
  setA64(true);
  const list = mem.reserve(4096, 4096), stack = list + 256;
  mem.st32(stack, 42); mem.st32(stack + 4, 0);
  mem.st64(stack + 8, 0x1122334455667788n);
  mem.st32(list, stack); mem.st32(list + 4, 0);          // __stack
  // no register argument was saved, so clang built __gr_top and __vr_top from whatever the
  // slots held: a value that is not an address must not be translated
  mem.st32(list + 8, 0); mem.st32(list + 12, 0xffffff80 | 0);
  mem.st32(list + 16, 0); mem.st32(list + 20, 0xffffff80 | 0);
  mem.st32(list + 24, 0); mem.st32(list + 28, -128);     // __gr_offs exhausted, __vr_offs untouched
  const args = vaList(list);
  expect(args.i()).toBe(42);
  expect(args.l()).toBe(0x1122334455667788n);
});
