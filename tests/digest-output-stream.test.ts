import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("DigestOutputStream forwards all writes and hashes only while enabled", async () => {
  const digest = (rt.link("java/security/MessageDigest").ctor as any)
    [mangleMethod("getInstance", "(Ljava/lang/String;)Ljava/security/MessageDigest;")]("SHA-256");
  const out = await newObj("java/io/ByteArrayOutputStream", "()V");
  const stream = await newObj("java/security/DigestOutputStream", "(Ljava/io/OutputStream;Ljava/security/MessageDigest;)V", out, digest);
  await vcall(stream, "write", "([B)V", Int8Array.of(2, 3));
  await vcall(stream, "on", "(Z)V", 0);
  await vcall(stream, "write", "(I)V", 4);
  await vcall(stream, "on", "(Z)V", 1);
  await vcall(stream, "write", "(I)V", 5);
  expect(await vcall(out, "toByteArray", "()[B")).toEqual(Int8Array.of(2, 3, 4, 5));
  const expected = new Int8Array(await crypto.subtle.digest("SHA-256", Uint8Array.of(2, 3, 5)));
  expect(await vcall(digest, "digest", "()[B")).toEqual(expected);
});
