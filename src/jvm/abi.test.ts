import { expect, test } from "bun:test";
import { demangle, mangleField, mangleMethod, mangleStaticField } from "./abi";

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
