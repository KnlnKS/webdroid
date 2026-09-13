import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JMotionEvent } from "../src/android/motionevent";

rt.linkNatives();

test("indexed raw coordinates use the tracked pointer", async () => {
  const event = Object.assign(new JMotionEvent(), { rawX: 12.5, rawY: 34.5 });
  expect(await vcall(event, "getRawX", "(I)F", 0)).toBe(12.5);
  expect(await vcall(event, "getRawY", "(I)F", 0)).toBe(34.5);
});
