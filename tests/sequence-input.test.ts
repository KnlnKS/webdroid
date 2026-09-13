import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JInputStream } from "../src/jvm/natives/jio";
import { mkIter } from "../src/jvm/natives/jutil";
class ClosingStream extends JInputStream { closed = false; }
rt.register({ name: "test/ClosingStream", ctor: ClosingStream, sup: "java/io/InputStream", methods: {
  "close()V": function (this: ClosingStream) { this.closed = true; },
} });
rt.linkNatives();
test("SequenceInputStream advances lazily and closes exhausted and remaining streams", async () => {
  const streams = [new Uint8Array(0), Uint8Array.of(1, 2), Uint8Array.of(3)].map(buf => Object.assign(rt.make("test/ClosingStream"), { buf }));
  const sequence = await newObj("java/io/SequenceInputStream", "(Ljava/util/Enumeration;)V", mkIter(streams));
  const bytes = new Int8Array(4);
  expect(await vcall(sequence, "read", "([BII)I", bytes, 1, 3)).toBe(2);
  expect([...bytes]).toEqual([0, 1, 2, 0]);
  expect(streams[0].closed).toBe(true);
  expect(streams[1].closed).toBe(false);
  expect(await vcall(sequence, "read", "()I")).toBe(3);
  expect(streams[1].closed).toBe(true);
  await vcall(sequence, "close", "()V");
  expect(streams[2].closed).toBe(true);
  expect(await vcall(sequence, "read", "()I")).toBe(-1);
});
