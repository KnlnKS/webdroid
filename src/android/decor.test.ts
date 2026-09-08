import { expect, test } from "bun:test";
import "../natives";
import { vcall } from "../jvm/natives/jlang";
import { callSelf } from "../jvm/runtime";
import { JActivity, activityMethods } from "./app";
import { Resources, JTheme } from "./res";
import { JResources } from "./resnative";
import { JView } from "./view";

test("ActionBar configuration before setContentView survives decor installation", async () => {
  const res = new Resources(null, {}), theme = new JTheme(), jresources = new JResources();
  theme.res = res; jresources.host = res;
  const act = new JActivity(), unused = () => { throw new Error("unexpected lifecycle call"); };
  act.$host = { res, theme, jresources, pkg: "test.decor", apkFile: "", appLabel: "App", themeResId: 0, iconRes: 0,
    zip: {}, splits: [], application: null, statusBarColor: 0, navBarColor: 0, launch: unused, finishActivity: unused,
    recreateActivity: unused, setRequestedOrientation: unused, currentActivity: () => act, invalidateOptionsMenu: unused };
  act.window.activity = act;
  expect(act.window.decor).toBeNull();
  const actionBar = await callSelf(activityMethods, "getActionBar()Landroid/app/ActionBar;", act);
  await vcall(actionBar, "setTitle", "(Ljava/lang/CharSequence;)V", "All Exercises");
  await vcall(actionBar, "setDisplayHomeAsUpEnabled", "(Z)V", 1);
  await vcall(actionBar, "setNavigationMode", "(I)V", 1);
  const bar = act.window.actionBarView;
  expect(bar).not.toBeNull();
  expect(bar?.titleStr).toBe("All Exercises");
  expect(bar?.showUp).toBe(true);
  expect(bar?.navMode).toBe(1);
  await callSelf(activityMethods, "setContentView(Landroid/view/View;)V", act, new JView());
  expect(act.window.actionBarView).toBe(bar);
  expect(bar?.titleStr).toBe("All Exercises");
  expect(bar?.showUp).toBe(true);
  expect(bar?.navMode).toBe(1);
  expect(await callSelf(activityMethods, "getActionBar()Landroid/app/ActionBar;", act)).toBe(actionBar);
});
