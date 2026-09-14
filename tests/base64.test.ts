import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";

rt.linkNatives();

test("Base64 encoding preserves signed bytes, slices, padding and 76-character line boundaries", () => {
  const ctor = rt.link("android/util/Base64").ctor;
  const encode = Reflect.get(ctor, mangleMethod("encode", "([BIII)[B"));
  const encodeString = Reflect.get(ctor, mangleMethod("encodeToString", "([BIII)Ljava/lang/String;"));
  if (typeof encode !== "function" || typeof encodeString !== "function") throw new Error("Missing Base64 encoders");
  const input = Int8Array.from({ length: 130 }, (_, i) => i * 79);
  for (let flags = 0; flags < 16; flags++) {
    for (const length of [0, 1, 2, 3, 56, 57, 58, 114]) {
      let expected = Buffer.from(input.subarray(5, 5 + length)).toString("base64");
      if (flags & 8) expected = expected.replaceAll("+", "-").replaceAll("/", "_");
      if (flags & 1) expected = expected.replace(/=+$/, "");
      if (!(flags & 2)) expected = expected.replace(/.{1,76}/g, "$&" + (flags & 4 ? "\r\n" : "\n"));
      expect(encode(input, 5, length, flags)).toEqual(new Int8Array(Buffer.from(expected)));
      expect(encodeString(input, 5, length, flags)).toBe(expected);
    }
  }
});
