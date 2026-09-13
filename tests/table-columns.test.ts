import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall, newObj } from "../src/jvm/natives/jlang";
import { JView, measureView, makeSpec, MS_EXACTLY, MS_UNSPEC } from "../src/android/view";

rt.linkNatives();
test("table column shrinking and stretching keep rows aligned and can be disabled", async () => {
  const table = rt.make("android/widget/TableLayout") as JView;
  const rows: JView[][] = [];
  for (const widths of [[120, 80], [100, 60]]) {
    const row = rt.make("android/widget/TableRow");
    const cells: JView[] = [];
    for (const width of widths) {
      const cell = rt.make("android/view/View") as JView;
      await vcall(cell, "setMinimumWidth", "(I)V", width);
      const lp = await newObj("android/widget/TableRow$LayoutParams", "(II)V", -2, 20);
      await vcall(row, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", cell, lp);
      cells.push(cell);
    }
    const lp = await newObj("android/widget/TableLayout$LayoutParams", "(II)V", -1, -2);
    await vcall(table, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", row, lp);
    rows.push(cells);
  }
  const widths = () => rows.map(row => row.map(cell => cell.measuredW));
  const measure = async (width: number) => {
    await vcall(table, "requestLayout", "()V");
    await measureView(table, makeSpec(width, MS_EXACTLY), makeSpec(0, MS_UNSPEC));
  };
  await vcall(table, "setColumnShrinkable", "(IZ)V", 0, 1);
  await measure(160);
  expect(widths()).toEqual([[80, 80], [80, 80]]);
  await vcall(table, "setColumnShrinkable", "(IZ)V", 0, 0);
  await measure(160);
  expect(widths()).toEqual([[120, 80], [120, 80]]);
  await vcall(table, "setColumnStretchable", "(IZ)V", 1, 1);
  await measure(240);
  expect(widths()).toEqual([[120, 120], [120, 120]]);
  await vcall(table, "setColumnStretchable", "(IZ)V", 1, 0);
  await measure(240);
  expect(widths()).toEqual([[120, 80], [120, 80]]);
});
