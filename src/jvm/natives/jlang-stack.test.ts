import { expect, test } from "bun:test";
import { newObj, vcall } from "./jlang";
import { rt } from "../runtime";
import "./jreflect";

test("IOException exposes its message and cause constructor to reflection", async () => {
  const cls = rt.classFor("java/io/IOException");
  const ctor = await vcall(cls, "getConstructor", "([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;",
    [rt.classFor("java/lang/String"), rt.classFor("java/lang/Throwable")]);
  const cause = await newObj("java/lang/Exception", "(Ljava/lang/String;)V", "underlying");
  const exception = await vcall(ctor, "newInstance", "([Ljava/lang/Object;)Ljava/lang/Object;", ["read failed", cause]);
  expect(await vcall(exception, "getMessage", "()Ljava/lang/String;")).toBe("read failed");
  expect(await vcall(exception, "getCause", "()Ljava/lang/Throwable;")).toBe(cause);
});

test("stack frames report only the native line-number sentinel as native", async () => {
  for (const line of [-3, -2, -1, 0, 42]) {
    const frame = await newObj("java/lang/StackTraceElement", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)V", "example.Class", "method", null, line);
    expect(await vcall(frame, "isNativeMethod", "()Z")).toBe(line === -2 ? 1 : 0);
  }
});
