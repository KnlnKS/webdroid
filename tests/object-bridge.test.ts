import { expect, test } from "bun:test";
import "../src/natives";
import { vcall } from "../src/jvm/natives/jlang";

test("host objects retain java.lang.Object.getClass", async () => {
  const cls = await vcall({}, "getClass", "()Ljava/lang/Class;");
  expect(await vcall(cls, "getName", "()Ljava/lang/String;")).toBe("java.lang.Object");
});
