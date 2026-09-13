import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

test("Double.valueOf(String) and Float.valueOf(String) box the parsed value", async () => {
  const d = scall("java/lang/Double", "valueOf", "(Ljava/lang/String;)Ljava/lang/Double;", " -73.98563 ");
  expect(await vcall(d, "doubleValue", "()D")).toBe(-73.98563);
  const f = scall("java/lang/Float", "valueOf", "(Ljava/lang/String;)Ljava/lang/Float;", "1.5f");
  expect(await vcall(f, "floatValue", "()F")).toBe(1.5);
  expect(() => scall("java/lang/Double", "valueOf", "(Ljava/lang/String;)Ljava/lang/Double;", "40.7,-74")).toThrow();
});

test("Integer.decode recognizes Java decimal, hexadecimal, and octal syntax", async () => {
  const decode = (s: string) => scall("java/lang/Integer", "decode", "(Ljava/lang/String;)Ljava/lang/Integer;", s);
  expect(await vcall(decode("42"), "intValue", "()I")).toBe(42);
  expect(await vcall(decode("-0x80000000"), "intValue", "()I")).toBe(-2147483648);
  expect(await vcall(decode("+077"), "intValue", "()I")).toBe(63);
  expect(await vcall(decode("#7fffffff"), "intValue", "()I")).toBe(2147483647);
  expect(() => decode("0x-1")).toThrow();
  expect(() => decode("09")).toThrow();
});
