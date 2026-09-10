import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";

test("ErrnoException exposes the numeric cause and preserves it when rethrowing", async () => {
  rt.link("java/lang/reflect/Field");
  const error = await newObj("android/system/ErrnoException", "(Ljava/lang/String;I)V", "open", 2);
  const field = await vcall(rt.classFor("android/system/ErrnoException"), "getField", "(Ljava/lang/String;)Ljava/lang/reflect/Field;", "errno");
  expect(await vcall(field, "getInt", "(Ljava/lang/Object;)I", error)).toBe(2);
  expect(await vcall(error, "getMessage", "()Ljava/lang/String;")).toBe("open failed: ENOENT (No such file or directory)");
  expect(rt.iof(error, "java/lang/Exception")).toBe(1);
  try {
    await vcall(error, "rethrowAsIOException", "()Ljava/io/IOException;");
    throw new Error("rethrow returned");
  } catch (e) {
    expect(rt.iof(e, "java/io/IOException")).toBe(1);
    expect(await vcall(e, "getCause", "()Ljava/lang/Throwable;")).toBe(error);
  }
});
