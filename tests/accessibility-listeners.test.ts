import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("accessibility listeners deduplicate registrations and report removal per manager", async () => {
  const first = rt.make("android/view/accessibility/AccessibilityManager");
  const second = rt.make("android/view/accessibility/AccessibilityManager");
  const listener = new JObj();
  for (const kind of ["AccessibilityState", "TouchExplorationState", "AccessibilityServicesState"]) {
    const arg = `(Landroid/view/accessibility/AccessibilityManager$${kind}ChangeListener;)`;
    const add = `add${kind}ChangeListener`, remove = `remove${kind}ChangeListener`;
    await vcall(first, add, arg + (kind === "AccessibilityServicesState" ? "V" : "Z"), listener);
    await vcall(first, add, arg + (kind === "AccessibilityServicesState" ? "V" : "Z"), listener);
    expect(await vcall(second, remove, arg + "Z", listener)).toBe(0);
    expect(await vcall(first, remove, arg + "Z", listener)).toBe(1);
    expect(await vcall(first, remove, arg + "Z", listener)).toBe(0);
  }
});
