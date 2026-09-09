import { expect, test } from "bun:test";
import { linkInit, newObj, vcall } from "./jlang";
import "./jconc";

test("every BlockingQueue insert hands the element to a parked taker", async () => {
  await linkInit("java/lang/Class");
  for (const [method, desc] of [["add", "(Ljava/lang/Object;)Z"], ["offer", "(Ljava/lang/Object;)Z"], ["put", "(Ljava/lang/Object;)V"], ["offer", "(Ljava/lang/Object;JLjava/util/concurrent/TimeUnit;)Z"]]) {
    const q = await newObj("java/util/concurrent/ArrayBlockingQueue", "(I)V", 2);
    const unit = (await linkInit("java/util/concurrent/TimeUnit")).ctor.s$MILLISECONDS;
    const polled = vcall(q, "poll", "(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;", 5000n, unit);
    await vcall(q, method, desc, "value", 1n, unit);
    expect(await polled).toBe("value");
    expect(await vcall(q, "size", "()I")).toBe(0);
  }
});
