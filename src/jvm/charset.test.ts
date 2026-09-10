import { expect, test } from "bun:test";
import "../natives";
import { rt } from "./runtime";
import { encodeString, decodeString } from "./charset";
import { vcall } from "./natives/jlang";

test("Latin-1 preserves every byte through Java String charset overloads", async () => {
  const bytes = Int8Array.from({ length: 256 }, (_, i) => i);
  const charset = rt.link("java/nio/charset/StandardCharsets").ctor.s$ISO_8859_1;
  const text = rt.newStr("([BLjava/nio/charset/Charset;)V", [bytes, charset]);
  expect(text.charCodeAt(0x80)).toBe(0x80);
  expect(await vcall(text, "getBytes", "(Ljava/nio/charset/Charset;)[B", charset)).toEqual(bytes);
  expect(await vcall(text, "getBytes", "(Ljava/lang/String;)[B", "ISO_8859_1")).toEqual(bytes);
  expect(rt.newStr("([BIILjava/lang/String;)V", [bytes, 128, 4, "latin1"])).toBe("\x80\x81\x82\x83");
});

test("standard charsets retain byte order, BOMs and replacement semantics", () => {
  expect([...encodeString("A😀", "US-ASCII")]).toEqual([65, 63]);
  expect(decodeString(Int8Array.of(65, -128), "US-ASCII")).toBe("A\ufffd");
  for (const charset of ["UTF-8", "UTF-16", "UTF-16BE", "UTF-16LE"]) {
    expect(decodeString(encodeString("A😀אב", charset), charset)).toBe("A😀אב");
  }
  expect([...encodeString("A", "UTF-16")]).toEqual([-2, -1, 0, 65]);
  expect([...encodeString("A", "UTF-16LE")]).toEqual([65, 0]);
  expect([...encodeString("\ud800x", "UTF-8")]).toEqual([63, 120]);
  expect(() => encodeString("x", "not-a-charset")).toThrow();
});
