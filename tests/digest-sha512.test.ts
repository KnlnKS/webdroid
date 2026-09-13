import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("SHA-512 and SHA-384 accept incremental input and reset after digest", async () => {
  for (const [algorithm, expected, empty] of [
    ["SHA-512", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"],
    ["SHA384", "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7", "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b"],
  ]) {
    const digest = await vcall(rt.link("java/security/MessageDigest").ctor, "getInstance", "(Ljava/lang/String;)Ljava/security/MessageDigest;", algorithm);
    await vcall(digest, "update", "(B)V", 97);
    const value: Int8Array = await vcall(digest, "digest", "([B)[B", new Int8Array([98, 99]));
    expect(Buffer.from(value).toString("hex")).toBe(expected);
    expect(await vcall(digest, "getDigestLength", "()I")).toBe(expected.length / 2);
    expect(Buffer.from(await vcall(digest, "digest", "()[B")).toString("hex")).toBe(empty);
  }
});
