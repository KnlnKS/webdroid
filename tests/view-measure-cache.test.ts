import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { attachView, JView, JViewGroup, layoutView, layoutRoot, replayLayoutRequests, makeSpec, measureView, MS_EXACTLY, requestLayout } from "../src/android/view";

rt.linkNatives();

class CountingView extends JView {
  measures = 0;

  [mangleMethod("onMeasure", "(II)V")](widthSpec: number, heightSpec: number) {
    this.measures++;
    this.measuredW = widthSpec & 0x3fffffff;
    this.measuredH = heightSpec & 0x3fffffff;
  }

  [mangleMethod("onLayout", "(ZIIII)V")]() {}
}

class CountingGroup extends JViewGroup {
  measures = 0;

  [mangleMethod("onMeasure", "(II)V")](widthSpec: number, heightSpec: number) {
    this.measures++;
    this.measuredW = widthSpec & 0x3fffffff;
    this.measuredH = heightSpec & 0x3fffffff;
  }
}

test("a fresh measure cache entry is reused while layout remains requested", async () => {
  const view = new CountingView();
  const widthSpec = makeSpec(320, MS_EXACTLY);
  const heightSpec = makeSpec(180, MS_EXACTLY);

  await measureView(view, widthSpec, heightSpec);
  await measureView(view, widthSpec, heightSpec);
  expect(view.measures).toBe(1);

  await layoutView(view, 0, 0, 320, 180);
  expect(view.measures).toBe(2);

  requestLayout(view);
  await measureView(view, widthSpec, heightSpec);
  expect(view.measures).toBe(3);
});

test("an in-layout hierarchy mutation invalidates the parent's measure cache", async () => {
  const view = new CountingGroup();
  const widthSpec = makeSpec(320, MS_EXACTLY);
  const heightSpec = makeSpec(180, MS_EXACTLY);

  await measureView(view, widthSpec, heightSpec);
  await attachView(view, new JView(), -1, false);
  await measureView(view, widthSpec, heightSpec);

  expect(view.measures).toBe(2);
});

test("a child request crosses a flagged parent and invalidates the root measure", async () => {
  const root = new CountingGroup(), parent = new JViewGroup(), child = new JView();
  parent.parent = root;
  child.parent = parent;
  const spec = makeSpec(100, MS_EXACTLY);
  await measureView(root, spec, spec);
  root.layoutRequested = false;
  parent.layoutRequested = true;
  requestLayout(child);
  await measureView(root, spec, spec);
  expect(root.measures).toBe(2);
});

test("a request cleared by layout is not replayed into another measure", async () => {
  class RequestingView extends CountingView {
    [mangleMethod("onLayout", "(ZIIII)V")]() { requestLayout(this); }
  }
  const view = new RequestingView();
  view.attached = true;
  const spec = makeSpec(100, MS_EXACTLY);
  await measureView(view, spec, spec);
  await layoutRoot(view, 0, 0, 100, 100);
  replayLayoutRequests();
  await measureView(view, spec, spec);
  expect(view.measures).toBe(1);
});
