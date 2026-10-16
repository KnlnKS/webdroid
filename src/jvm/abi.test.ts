import { expect, test } from "vite-plus/test";
import { charsToString, decodeModifiedUtf8, demangle, mangleField, mangleMethod, mangleStaticField } from "./abi.ts";

test("Unicode Java members and literal escape-like names retain distinct JS properties", () => {
  const names = ["ﻏ", "ﻐ", "ﾒ", "_", "$fecf$", "😀", "😁"];
  for (const key of [
    (name: string) => mangleField("test/Owner", name),
    (name: string) => mangleStaticField(name),
    (name: string) => mangleMethod(name, "()I"),
  ]) {
    const props = names.map(key);
    expect(new Set(props).size).toBe(names.length);
    const object = new Function("return {" + props.map((prop, i) => `${prop}:${i}`).join(",") + "}")();
    expect(props.map((prop) => object[prop])).toEqual(names.map((_, i) => i));
  }
  for (const name of names) expect(demangle(mangleMethod(name, "()I"))).toEqual([name, "()I"]);
});

test("modified UTF-8 decodes a two-byte NUL and both supplementary forms", () => {
  // "a", NUL, U+1F600 as two three-byte surrogate halves, then as one four-byte sequence (ART JNI)
  const bytes = Uint8Array.of(0x61, 0xc0, 0x80, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0xf0, 0x9f, 0x98, 0x80);
  expect(decodeModifiedUtf8(bytes)).toBe("a\0😀😀");
});

test("UTF-16 slices preserve code units across reused short and decoded long strings", () => {
  const chars = Uint16Array.from({ length: 260 }, (_, i) => [0xfeff, 0, 0xd800, 0x61, 0xdc00, 0xd83d, 0xde00][i % 7]);
  const bytes = Uint8Array.from(chars);
  for (const length of [0, 1, 8, 24, 127, 128, 129, 200, 127, 24, 1, 0]) {
    for (const input of [chars, bytes]) for (const offset of [0, 3]) {
      const result = charsToString(input, offset, length);
      expect(result).toBe(String.fromCharCode(...input.slice(offset, offset + length)));
    }
  }
});
