import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JView, JViewGroup } from "../src/android/view";
import { ST } from "../src/android/drawable";

rt.linkNatives();
test("a group can aggregate child drawable states and receive subsequent changes", async () => {
  const parent = rt.make("android/view/ViewGroup") as JViewGroup;
  const child = rt.make("android/view/View") as JView;
  parent.children.push(child); child.parent = parent;
  expect(await vcall(parent, "addStatesFromChildren", "()Z")).toBe(0);
  await vcall(parent, "setAddStatesFromChildren", "(Z)V", 1);
  child.pressed = true;
  await vcall(child, "refreshDrawableState", "()V");
  expect(Array.from(await vcall(parent, "getDrawableState", "()[I"))).toContain(ST.pressed);
  await vcall(parent, "setAddStatesFromChildren", "(Z)V", 0);
  expect(Array.from(await vcall(parent, "getDrawableState", "()[I"))).not.toContain(ST.pressed);
});
