import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("AssertionError retains a throwable detail as its cause", async () => {
  const detail = rt.mkThrowable("java/lang/IllegalStateException", "failure");
  const error = rt.make("java/lang/AssertionError");
  await vcall(error, "<init>", "(Ljava/lang/Object;)V", detail);
  expect(await vcall(error, "getCause", "()Ljava/lang/Throwable;")).toBe(detail);
  expect(await vcall(error, "getMessage", "()Ljava/lang/String;")).toBe("java.lang.IllegalStateException: failure");
});
