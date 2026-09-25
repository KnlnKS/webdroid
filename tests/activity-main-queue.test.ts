import { expect, test } from "bun:test";
import "../src/natives";
import { JActivity } from "../src/android/app";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";
import { onMain } from "../src/android/mainloop";

rt.linkNatives();

test("Activity.runOnUiThread runs inline in the main job", async () => {
  const events: string[] = [];
  const runnable = { [mangleMethod("run", "()V")]: () => { events.push("run"); } };
  await onMain(async () => {
    await vcall(new JActivity(), "runOnUiThread", "(Ljava/lang/Runnable;)V", runnable);
    events.push("after");
  });
  expect(events).toEqual(["run", "after"]);
});
