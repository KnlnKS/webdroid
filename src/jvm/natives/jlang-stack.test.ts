import { expect, test } from "bun:test";
import { newObj, vcall } from "./jlang";

test("stack frames report only the native line-number sentinel as native", async () => {
  for (const line of [-3, -2, -1, 0, 42]) {
    const frame = await newObj("java/lang/StackTraceElement", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)V", "example.Class", "method", null, line);
    expect(await vcall(frame, "isNativeMethod", "()Z")).toBe(line === -2 ? 1 : 0);
  }
});
