import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView, JViewGroup, makeSpec, MS_EXACTLY } from "../src/android/view";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
  (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

test("GridLayout places explicit specs into distinct cells", async () => {
  const grid = new (rt.link("android/widget/GridLayout").ctor as new () => JViewGroup)();
  await vcall(grid, "setColumnCount", "(I)V", 2);
  const first = new JView(), second = new JView();
  const row = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 0);
  const col0 = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 0);
  const col1 = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 1);
  const firstLp = await newObj("android/widget/GridLayout$LayoutParams", "(Landroid/widget/GridLayout$Spec;Landroid/widget/GridLayout$Spec;)V", row, col0);
  const secondLp = await newObj("android/widget/GridLayout$LayoutParams", "(Landroid/widget/GridLayout$Spec;Landroid/widget/GridLayout$Spec;)V", row, col1);
  firstLp.width = 40; firstLp.height = 30; secondLp.width = 60; secondLp.height = 20;
  first.lp = firstLp; second.lp = secondLp;
  for (const child of [first, second]) { child.parent = grid; grid.children.push(child); }
  await vcall(grid, "onMeasure", "(II)V", makeSpec(100, MS_EXACTLY), makeSpec(30, MS_EXACTLY));
  await vcall(grid, "onLayout", "(ZIIII)V", 1, 0, 0, 100, 30);
  expect([first.left, first.top, first.right, first.bottom]).toEqual([0, 0, 40, 30]);
  expect([second.left, second.top, second.right, second.bottom]).toEqual([40, 0, 100, 20]);
});

test("GridLayout fill alignment sizes a child to its spanned cell", async () => {
  const grid = new (rt.link("android/widget/GridLayout").ctor as new () => JViewGroup)();
  await vcall(grid, "setColumnCount", "(I)V", 2);
  const ctor = rt.link("android/widget/GridLayout").ctor as { [key: string]: unknown };
  const makeGridSpec = ctor[mangleMethod("spec", "(IILandroid/widget/GridLayout$Alignment;F)Landroid/widget/GridLayout$Spec;")];
  const alignment = ctor[mangleStaticField("FILL")];
  const spec = await (makeGridSpec as (start: number, size: number, alignment: unknown, weight: number) => unknown)(0, 2, alignment, 1);
  const row = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 0);
  const child = new JView();
  const lp = await newObj("android/widget/GridLayout$LayoutParams", "(Landroid/widget/GridLayout$Spec;Landroid/widget/GridLayout$Spec;)V", row, spec);
  lp.width = 20; lp.height = 10; child.lp = lp; child.parent = grid; grid.children.push(child);
  await vcall(grid, "onMeasure", "(II)V", makeSpec(80, MS_EXACTLY), makeSpec(10, MS_EXACTLY));
  await vcall(grid, "onLayout", "(ZIIII)V", 1, 0, 0, 80, 10);
  expect(child.measuredW).toBe(80);
});
