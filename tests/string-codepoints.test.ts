import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("String streams distinguish UTF-16 units from Unicode code points", async () => {
  const value = "A😀B";
  const call = (name: string) => (String.prototype as any)[mangleMethod(name, "()Ljava/util/stream/IntStream;")].call(value);
  expect(Array.from(await vcall(call("chars"), "toArray", "()[I"))).toEqual([65, 0xd83d, 0xde00, 66]);
  expect(Array.from(await vcall(call("codePoints"), "toArray", "()[I"))).toEqual([65, 0x1f600, 66]);
});

test("String.valueOf(Object) accepts Webdroid primitive values", async () => {
  const valueOf = (rt.link("java/lang/String").ctor as any)[mangleMethod("valueOf", "(Ljava/lang/Object;)Ljava/lang/String;")];
  expect(await valueOf(1)).toBe("1");
  expect(await valueOf(42n)).toBe("42");
});
