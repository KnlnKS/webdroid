import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall, vcallAsync } from "../src/jvm/natives/jlang";

rt.linkNatives();
const unit = rt.link("java/util/concurrent/TimeUnit").ctor;

test("TimeUnit enum lookup preserves constant identity and returns independent arrays", async () => {
  const values = await vcall(unit, "values", "()[Ljava/util/concurrent/TimeUnit;");
  expect(values.length).toBe(7);
  const days = await vcall(unit, "valueOf", "(Ljava/lang/String;)Ljava/util/concurrent/TimeUnit;", "DAYS");
  expect(values[6]).toBe(days);
  expect(await vcall(days, "toHours", "(J)J", 2n)).toBe(48n);
  values[6] = null;
  expect((await vcall(unit, "values", "()[Ljava/util/concurrent/TimeUnit;"))[6]).toBe(days);
  for (const [name, exception] of [[null, "NullPointerException"], ["day", "IllegalArgumentException"]]) {
    const error = await vcallAsync(unit, "valueOf", "(Ljava/lang/String;)Ljava/util/concurrent/TimeUnit;", name).then(() => null, e => e);
    expect(rt.iof(error, `java/lang/${exception}`)).toBeTruthy();
  }
});
