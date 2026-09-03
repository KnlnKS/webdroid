import { expect, test } from "bun:test";
import { diffTrees } from "./tree";
import type { UiNode } from "../types";

const n = (o: Partial<UiNode> & { bounds: UiNode["bounds"] }): UiNode =>
  ({ text: "", desc: "", cls: "", resId: "", clickable: false, ...o });

test("a view in the same place is placed", () => {
  const t = [n({ resId: "a:id/title", bounds: [0, 0, 100, 50] })];
  const d = diffTrees(t, [n({ resId: "a:id/title", bounds: [0, 0, 100, 50] })]);
  expect(d).toMatchObject({ comparable: 1, matched: 1, placed: 1, diffPct: 0, meanOff: 0 });
});

test("a view off by more than the tolerance is matched but not placed", () => {
  const g = [n({ resId: "a:id/row", bounds: [0, 100, 100, 150] })];
  const d = diffTrees(g, [n({ resId: "a:id/row", bounds: [0, 114, 100, 164] })]);
  expect(d.matched).toBe(1);
  expect(d.placed).toBe(0);
  expect(d.diffPct).toBe(100);
  expect(d.worst[0]).toMatchObject({ key: "#a:id/row", off: 14 });
});

test("sub-pixel drift inside the tolerance still counts as placed", () => {
  const g = [n({ resId: "a:id/row", bounds: [0, 100, 100, 150] })];
  expect(diffTrees(g, [n({ resId: "a:id/row", bounds: [1, 101, 100, 152] })]).placed).toBe(1);
});

test("identity falls back to text then content-description", () => {
  const g = [n({ text: "SAVE", bounds: [0, 0, 10, 10] }), n({ desc: "More options", bounds: [90, 0, 100, 10] })];
  const d = diffTrees(g, [n({ text: "SAVE", bounds: [0, 0, 10, 10] }), n({ desc: "More options", bounds: [90, 0, 100, 10] })]);
  expect(d).toMatchObject({ comparable: 2, placed: 2 });
});

test("a resource id wins over text, so a relabelled view still pairs up", () => {
  const g = [n({ resId: "a:id/t", text: "Top Stories", bounds: [0, 0, 100, 20] })];
  const d = diffTrees(g, [n({ resId: "a:id/t", text: "New Stories", bounds: [0, 0, 100, 20] })]);
  expect(d.placed).toBe(1);
});

test("a view the device had and we do not is missing, not misplaced", () => {
  const d = diffTrees([n({ resId: "a:id/gone", bounds: [0, 0, 1, 1] })], []);
  expect(d).toMatchObject({ comparable: 1, matched: 0, placed: 0, diffPct: 100 });
  expect(d.missing).toEqual(["#a:id/gone"]);
});

test("anonymous containers are not comparable either way", () => {
  const d = diffTrees([n({ cls: "android.widget.FrameLayout", bounds: [0, 0, 720, 1280] })], []);
  expect(d).toMatchObject({ comparable: 0, diffPct: 0 });
});

test("system chrome is not the app's hierarchy", () => {
  const g = [
    n({ resId: "com.android.systemui:id/clock", text: "12:00", bounds: [0, 0, 100, 48] }),
    n({ resId: "android:id/statusBarBackground", bounds: [0, 0, 720, 48] }),
  ];
  // the clock still has text, so it stays comparable by text — the id must not make it so
  expect(diffTrees(g, []).comparable).toBe(1);
});

test("repeated keys pair in document order", () => {
  const rows = (ys: number[]) => ys.map((y) => n({ resId: "a:id/row", bounds: [0, y, 100, y + 40] }));
  const d = diffTrees(rows([0, 40, 80]), rows([0, 40, 200]));
  expect(d).toMatchObject({ comparable: 3, matched: 3, placed: 2 });
  expect(d.worst[0].off).toBe(120);
});

test("extra views on our side are not counted against us here", () => {
  const d = diffTrees([n({ resId: "a:id/x", bounds: [0, 0, 1, 1] })],
    [n({ resId: "a:id/x", bounds: [0, 0, 1, 1] }), n({ resId: "a:id/spurious", bounds: [5, 5, 6, 6] })]);
  expect(d).toMatchObject({ comparable: 1, placed: 1, diffPct: 0 });
});
