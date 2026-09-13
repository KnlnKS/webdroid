import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";
import { JView, measureView, layoutView } from "../src/android/view";

rt.linkNatives();
test("a required layout notifies listeners even when its bounds stay unchanged", async () => {
  const view = rt.make("android/view/View") as JView;
  const events: number[][] = [];
  const listener = {
    [mangleMethod("onLayoutChange", "(Landroid/view/View;IIIIIIII)V")]: async (_view: JView, ...bounds: number[]) => {
      await Promise.resolve();
      events.push(bounds);
    },
  };
  await vcall(view, "addOnLayoutChangeListener", "(Landroid/view/View$OnLayoutChangeListener;)V", listener);
  const exact = 0x40000000 | 100;
  await measureView(view, exact, exact);
  await layoutView(view, 0, 0, 100, 100);
  events.length = 0;
  await vcall(view, "requestLayout", "()V");
  await measureView(view, exact, exact);
  await layoutView(view, 0, 0, 100, 100);
  expect(events).toEqual([[0, 0, 100, 100, 0, 0, 100, 100]]);
  await layoutView(view, 0, 0, 100, 100);
  expect(events).toHaveLength(1);
});
