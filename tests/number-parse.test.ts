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
