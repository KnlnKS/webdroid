import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { Resources, JTheme } from "../src/android/res";
import type { JView } from "../src/android/view";

rt.linkNatives();

let context: unknown;
function ctx(): unknown {
  if (context) return context;
  const wrapper = rt.make("android/content/ContextWrapper") as JObj & { $host: unknown };
  const resources = new Resources(null, {});
  const theme = new JTheme();
  theme.res = resources;
  wrapper.$host = { res: resources, theme, pkg: "test" };
  return context = wrapper;
}

test("addView lets a transient-state query replace a lazy placeholder", async () => {
  let queried = false;
  const addedAfterQuery: boolean[] = [];
  rt.register({
    name: "test/Parent",
    ctor: class extends (rt.link("android/widget/FrameLayout").ctor as typeof JObj) {},
    sup: "android/widget/FrameLayout",
    methods: {
      "onViewAdded(Landroid/view/View;)V": function () {
        addedAfterQuery.push(queried);
      },
    },
  });
  rt.register({
    name: "test/Placeholder",
    ctor: class extends (rt.link("android/view/View").ctor as typeof JObj) {},
    sup: "android/view/View",
    methods: {
      "hasTransientState()Z": async function (this: JView & { real?: unknown }) {
        queried = true;
        const parent = this.parent as JView | null;
        if (parent && !this.real) {
          this.real = true;
          const real = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", ctx());
          await vcall(real, "setId", "(I)V", 0x7f0a0001);
          const index = await vcall(parent, "indexOfChild", "(Landroid/view/View;)I", this);
          await vcall(parent, "removeViewInLayout", "(Landroid/view/View;)V", this);
          await vcall(parent, "addView", "(Landroid/view/View;I)V", real, index);
          this.real = real;
        }
        return 0;
      },
    },
  });
  const parent = await newObj("test/Parent", "(Landroid/content/Context;)V", ctx());
  const placeholder = await newObj("test/Placeholder", "(Landroid/content/Context;)V", ctx());
  await vcall(placeholder, "setId", "(I)V", 0x7f0a0001);
  await vcall(parent, "addView", "(Landroid/view/View;)V", placeholder);
  const found = await vcall(parent, "findViewById", "(I)Landroid/view/View;", 0x7f0a0001);
  expect(rt.iof(found, "android/widget/FrameLayout")).toBeTruthy();
  expect(await vcall(parent, "getChildCount", "()I")).toBe(1);
  expect(addedAfterQuery.length).toBeGreaterThan(0);
  expect(addedAfterQuery.every(Boolean)).toBe(true);
});

test("a view group's transient-state count follows child removal", async () => {
  const parent = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", ctx());
  const child = await newObj("android/view/View", "(Landroid/content/Context;)V", ctx());
  await vcall(child, "setHasTransientState", "(Z)V", 1);
  await vcall(parent, "addView", "(Landroid/view/View;)V", child);
  expect(await vcall(parent, "hasTransientState", "()Z")).toBe(1);
  await vcall(parent, "removeView", "(Landroid/view/View;)V", child);
  expect(await vcall(parent, "hasTransientState", "()Z")).toBe(0);
});
