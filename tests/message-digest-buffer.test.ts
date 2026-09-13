import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

function staticMethod(cls: string, name: string, descriptor: string): (...args: unknown[]) => unknown {
  const method: unknown = Reflect.get(rt.link(cls).ctor, mangleMethod(name, descriptor));
  if (typeof method !== "function") throw new Error(`Missing ${cls}.${name}${descriptor}`);
  return (...args) => Reflect.apply(method, null, args);
}

test("MessageDigest consumes only the remaining ByteBuffer bytes", async () => {
  const wrap = staticMethod("java/nio/ByteBuffer", "wrap", "([BII)Ljava/nio/ByteBuffer;");
  const getDigest = staticMethod("java/security/MessageDigest", "getInstance", "(Ljava/lang/String;)Ljava/security/MessageDigest;");
  const buffer = wrap(new Int8Array([1, 2, 3, 4]), 1, 2);
  const digest = getDigest("SHA-256");
  await vcall(digest, "update", "(Ljava/nio/ByteBuffer;)V", buffer);
  expect(await vcall(buffer, "position", "()I")).toBe(3);
  const actual = await vcall(digest, "digest", "()[B");
  const expected = getDigest("SHA-256");
  await vcall(expected, "update", "([B)V", new Int8Array([2, 3]));
  expect([...actual]).toEqual([...(await vcall(expected, "digest", "()[B"))]);
});
