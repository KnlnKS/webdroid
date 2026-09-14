import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
rt.linkNatives();

test("RunnableFuture exposes both parent interfaces to application implementations", () => {
  rt.register({ name: "test/RunnableFutureImpl", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/RunnableFuture"] });
  const task = rt.make("test/RunnableFutureImpl");
  expect(rt.iof(task, "java/lang/Runnable")).toBe(1);
  expect(rt.iof(task, "java/util/concurrent/Future")).toBe(1);
});
