import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { Resources } from "../src/android/res";
import { JTheme } from "../src/android/res";

const changes: string[] = [];
class Factory extends JObj { made: unknown[] = []; }
rt.register({ name: "test/TabFactory", ctor: Factory, ifaces: ["android/widget/TabHost$TabContentFactory"], methods: {
  "createTabContent(Ljava/lang/String;)Landroid/view/View;": async function (this: Factory, tag: string) {
    const v = await newObj("android/view/View", "(Landroid/content/Context;)V", ctx());
    await vcall(v, "setTag", "(Ljava/lang/Object;)V", tag);
    this.made.push(v);
    return v;
  } } });
rt.register({ name: "test/TabListener", ctor: class extends JObj {}, ifaces: ["android/widget/TabHost$OnTabChangeListener"], methods: {
  "onTabChanged(Ljava/lang/String;)V": (tag: string) => { changes.push(tag); } } });
rt.linkNatives();

let context: unknown;
function ctx(): unknown {
  if (context) return context;
  const c = rt.make("android/content/ContextWrapper") as JObj & { $host: unknown };
  const res = new Resources(null, {}), theme = new JTheme(); theme.res = res;
  c.$host = { res, theme, pkg: "test" };
  return context = c;
}

test("TabHost finds its widget and content by the android ids, swaps content and reports tab changes", async () => {
  const host = await newObj("android/widget/TabHost", "(Landroid/content/Context;)V", ctx());
  const column = await newObj("android/widget/LinearLayout", "(Landroid/content/Context;)V", ctx());
  const tabs = await newObj("android/widget/TabWidget", "(Landroid/content/Context;)V", ctx());
  const content = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", ctx());
  await vcall(tabs, "setId", "(I)V", 0x01020013);
  await vcall(content, "setId", "(I)V", 0x01020011);
  await vcall(column, "addView", "(Landroid/view/View;)V", tabs);
  await vcall(column, "addView", "(Landroid/view/View;)V", content);
  await vcall(host, "addView", "(Landroid/view/View;)V", column);
  await vcall(host, "setup", "()V");
  await vcall(host, "setOnTabChangedListener", "(Landroid/widget/TabHost$OnTabChangeListener;)V", rt.make("test/TabListener"));
  const factory = rt.make("test/TabFactory") as Factory;
  for (const tag of ["a", "b"]) {
    const spec = await vcall(host, "newTabSpec", "(Ljava/lang/String;)Landroid/widget/TabHost$TabSpec;", tag);
    await vcall(spec, "setIndicator", "(Landroid/view/View;)Landroid/widget/TabHost$TabSpec;", await newObj("android/view/View", "(Landroid/content/Context;)V", ctx()));
    await vcall(spec, "setContent", "(Landroid/widget/TabHost$TabContentFactory;)Landroid/widget/TabHost$TabSpec;", factory);
    await vcall(host, "addTab", "(Landroid/widget/TabHost$TabSpec;)V", spec);
  }
  expect(await vcall(host, "getCurrentTab", "()I")).toBe(0);
  expect(await vcall(host, "getCurrentTabTag", "()Ljava/lang/String;")).toBe("a");
  expect(changes).toEqual(["a"]);
  expect(await vcall(tabs, "getTabCount", "()I")).toBe(2);
  expect(factory.made.length).toBe(1);
  await vcall(host, "setCurrentTabByTag", "(Ljava/lang/String;)V", "b");
  expect(changes).toEqual(["a", "b"]);
  expect(factory.made.length).toBe(2);
  expect(await vcall(factory.made[0], "getVisibility", "()I")).toBe(8);
  expect(await vcall(factory.made[1], "getVisibility", "()I")).toBe(0);
  expect(await vcall(content, "getChildCount", "()I")).toBe(2);
  expect((await vcall(tabs, "getChildTabViewAt", "(I)Landroid/view/View;", 1)).selected).toBe(true);
  await vcall(await vcall(tabs, "getChildTabViewAt", "(I)Landroid/view/View;", 0), "performClick", "()Z");
  expect(await vcall(host, "getCurrentTab", "()I")).toBe(0);
  expect(changes).toEqual(["a", "b", "a"]);
  const bad = await newObj("android/widget/TabHost", "(Landroid/content/Context;)V", ctx());
  await expect(vcallAsync(bad, "setup", "()V")).rejects.toMatchObject({ constructor: rt.link("java/lang/RuntimeException").ctor });
});
