import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Instant adds a Duration through TemporalAmount", async () => {
  const instant = await vcall(rt.link("java/time/Instant").ctor, "ofEpochMilli", "(J)Ljava/time/Instant;", 1000n);
  const duration = await vcall(rt.link("java/time/Duration").ctor, "ofMillis", "(J)Ljava/time/Duration;", 2500n);
  const result = await vcall(instant, "plus", "(Ljava/time/temporal/TemporalAmount;)Ljava/time/Instant;", duration);
  expect(await vcall(result, "toEpochMilli", "()J")).toBe(3500n);
  expect(await vcall(instant, "toEpochMilli", "()J")).toBe(1000n);
});
