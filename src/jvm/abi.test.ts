import { expect, test } from "bun:test";
import { decodeModifiedUtf8, demangle, mangleField, mangleMethod, mangleStaticField } from "./abi";

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
