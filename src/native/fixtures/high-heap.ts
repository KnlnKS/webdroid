import { strict as assert } from "node:assert";
import { Cpu, setA64 } from "../cpu";
import { JThread } from "../../jvm/natives/jlang";
import { libcInit } from "../libc";
import { lookupHost } from "../host";
import { mem } from "../mem";

setA64(true); libcInit();
// Touch only allocator headers while advancing beyond the signed-pointer boundary.
for (let p = 0; p < 0x80000000;) { p = mem.malloc(0x40000); assert.notEqual(p, 0); }
const cpu = new Cpu(new JThread(), "high heap");
const malloc = lookupHost("malloc", "libc.so")!;
for (const size of [64, 2048]) {
  const first = mem.malloc(size), second = mem.malloc(size);
  assert.ok(first >= 0x80000000);
  mem.free(first); mem.free(second);
  for (const expected of [second, first]) {
    const got = (await cpu.call(malloc, [size])) >>> 0;
    assert.equal(got, expected);
    assert.equal(cpu.ret1, 0, "malloc pointers must be zero-extended in X0");
  }
  mem.memset(first, 0xa5, size); mem.free(first);
  const zeroed = mem.calloc(1, size);
  assert.equal(zeroed, first);
  assert.ok(mem.bytes(zeroed, size).every((b) => b === 0));
  mem.free(zeroed); mem.free(second);
}
const source = mem.malloc(64), spare = mem.malloc(128);
mem.memset(source, 0x5a, 64); mem.free(spare);
const grown = mem.realloc(source, 128);
assert.equal(grown, spare);
assert.ok(mem.bytes(grown, 64).every((b) => b === 0x5a));
mem.free(grown);
const before = mem.stats();
const aligned = mem.memalign(256, 100);
assert.ok(aligned >= 0x80000000); assert.equal(aligned % 256, 0);
const owner = mem.u32[(aligned - 8) >>> 2];
assert.ok(owner >= 0x80000000);
mem.free(aligned);
const reused = mem.malloc(372);
assert.equal(reused, owner);
mem.free(reused);
assert.equal(mem.stats().used, before.used);
assert.equal(mem.stats().blocks, before.blocks);
cpu.dispose();
