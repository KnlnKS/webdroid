import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JView, JViewGroup, JLayoutParams, attachView, detachView } from "../src/android/view";

class Group extends JViewGroup { events: string[] = []; }
class Listener extends JObj {}
rt.register({ name: "test/HierarchyGroup", ctor: Group, sup: "android/view/ViewGroup", methods: {
  "onViewAdded(Landroid/view/View;)V": async function (this: Group, child: JView) {
    expect(child.parent).toBe(this);
    await Promise.resolve();
    this.events.push(`added:${child.idNum}`);
  },
  "onViewRemoved(Landroid/view/View;)V": async function (this: Group, child: JView) {
    expect(this.children).not.toContain(child);
    await Promise.resolve();
    this.events.push(`removed:${child.idNum}`);
  },
} });
rt.register({ name: "test/HierarchyListener", ctor: Listener, ifaces: ["android/view/ViewGroup$OnHierarchyChangeListener"], methods: {
  "onChildViewAdded(Landroid/view/View;Landroid/view/View;)V": (parent: Group, child: JView) => { parent.events.push(`listener-added:${child.idNum}`); },
  "onChildViewRemoved(Landroid/view/View;Landroid/view/View;)V": (parent: Group, child: JView) => { parent.events.push(`listener-removed:${child.idNum}`); },
} });
rt.linkNatives();

test("view mutations await overrides before hierarchy listeners, including in-layout additions and range removal", async () => {
  const parent = new Group(); parent.hierarchyChangeL = new Listener();
  const first = new JView(), second = new JView(); first.idNum = 1; second.idNum = 2;
  await vcall(parent, "addView", "(Landroid/view/View;)V", first);
  await vcall(parent, "addViewInLayout", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)Z", second, -1, new JLayoutParams());
  await vcall(parent, "removeAllViews", "()V");
  expect(parent.events).toEqual(["added:1", "listener-added:1", "added:2", "listener-added:2", "removed:1", "listener-removed:1", "removed:2", "listener-removed:2"]);
  expect(parent.children).toEqual([]);
});

test("native view mutations complete with default callbacks", async () => {
  const parent = new JViewGroup(), child = new JView();
  await attachView(parent, child);
  expect(child.parent).toBe(parent);
  await detachView(parent, child);
  expect(child.parent).toBeNull();
});
