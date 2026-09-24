import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JContext, JContextWrapper, display } from "../src/android/context";
import { JTheme, Resources, T_STR, themeOf } from "../src/android/res";
import { getInflater } from "../src/android/inflate";
import { JFrameLayout } from "../src/android/layouts";
import { JWindow } from "../src/android/window";
import { resolveSystemBars } from "../src/shell/systembars";
import { device } from "../src/shell/config";
import { JView, dispatchAttached, uiState } from "../src/android/view";
import { addOverlay, overlays, detachContextOverlays, removeOverlay } from "../src/android/popup";
import { JActivity } from "../src/android/app";

rt.linkNatives();

test("finding an activity content view installs its decor before setContentView", async () => {
  const activity = new JActivity(), res = new Resources(null, {}), theme = new JTheme();
  theme.res = res;
  Reflect.set(activity, "$host", { res, theme, pkg: "test" });
  activity.window.activity = activity;
  expect(activity.window.decor).toBeNull();
  const content = await vcall(activity, "findViewById", "(I)Landroid/view/View;", 0x01020002);
  expect(content).not.toBeNull();
  expect(content).toBe(activity.window.contentParent);
  expect(await vcall(activity.window, "findViewById", "(I)Landroid/view/View;", 0x01020002)).toBe(content);
});

test("display and window contexts retain display identity and own their window service", async () => {
  const source = new JContext(), screen = await display();
  const displayContext = await vcall(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", screen);
  expect(await vcall(displayContext, "getDisplay", "()Landroid/view/Display;")).toBe(screen);
  expect(await vcall(displayContext, "isUiContext", "()Z")).toBe(0);
  const window = await vcall(displayContext, "createWindowContext", "(ILandroid/os/Bundle;)Landroid/content/Context;", 2038, null);
  expect(rt.iof(window, "android/content/ContextWrapper")).toBeTruthy();
  expect(await vcall(window, "getDisplay", "()Landroid/view/Display;")).toBe(screen);
  expect(await vcall(window, "isUiContext", "()Z")).toBe(1);
  const manager = await vcall(window, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window");
  expect(await vcall(window, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", rt.classFor("android/view/WindowManager"))).toBe(manager);
  const second = await vcall(source, "createWindowContext", "(Landroid/view/Display;ILandroid/os/Bundle;)Landroid/content/Context;", screen, 2038, null);
  expect(await vcall(second, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window")).not.toBe(manager);
  const error = await vcall(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", null).then(() => null, e => e);
  expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBeTruthy();
});

test("unchanged window attributes do not restart inset dispatch", async () => {
  const window = rt.make("android/view/Window");
  const attrs = await vcall(window, "getAttributes", "()Landroid/view/WindowManager$LayoutParams;");
  const pending = uiState.needsInsets;
  try {
    uiState.needsInsets = false;
    await vcall(attrs, "setFitInsetsTypes", "(I)V", 0);
    await vcall(window, "setAttributes", "(Landroid/view/WindowManager$LayoutParams;)V", attrs);
    expect(uiState.needsInsets).toBe(true);
    uiState.needsInsets = false;
    await vcall(window, "setAttributes", "(Landroid/view/WindowManager$LayoutParams;)V", attrs);
    expect(uiState.needsInsets).toBe(false);
  } finally { uiState.needsInsets = pending; }
});

test("destroyed context windows detach without dismissing dialogs or other activities", async () => {
  const owner = new JContext(), other = new JContext();
  const themed = new JContextWrapper();
  themed.base = owner;
  const ownedView = new JView(), otherView = new JView();
  ownedView.ctx = themed; otherView.ctx = other;
  let dismissed = false;
  addOverlay(ownedView, 0, 0, false, undefined, () => { dismissed = true; });
  addOverlay(otherView);
  await dispatchAttached(ownedView);
  await dispatchAttached(otherView);
  try {
    await detachContextOverlays(owner);
    expect(ownedView.attached).toBe(false);
    expect(overlays.some(o => o.view === ownedView)).toBe(false);
    expect(otherView.attached).toBe(true);
    expect(overlays.some(o => o.view === otherView)).toBe(true);
    expect(dismissed).toBe(false);
  } finally {
    await detachContextOverlays(other);
    removeOverlay(ownedView);
  }
});

test("Dialog exposes its overlay theme through its context and inflater without changing its owner", async () => {
  const res = new Resources(null, {}), theme = new JTheme();
  theme.res = res; theme.styles = [100];
  res.bagCache.set(100, { parent: 0, map: new Map([[1, { t: T_STR, d: 0, s: "base" }]]) });
  res.bagCache.set(101, { parent: 0, map: new Map([[1, { t: T_STR, d: 0, s: "dialog" }]]) });
  const context = Object.assign(rt.make("android/content/Context"), { $host: { res, theme } });
  const dialog = await newObj("android/app/Dialog", "(Landroid/content/Context;I)V", context, 101);
  const themed = await vcall(dialog, "getContext", "()Landroid/content/Context;");
  expect(themed).not.toBe(context);
  expect(themeOf(themed)?.lookup(1)?.s).toBe("dialog");
  expect(themeOf(getInflater(themed).jctx)?.lookup(1)?.s).toBe("dialog");
  expect(theme.lookup(1)?.s).toBe("base");
  expect(await vcall(dialog, "getOwnerActivity", "()Landroid/app/Activity;")).toBeNull();
  const owner = rt.make("android/app/Activity");
  await vcall(dialog, "setOwnerActivity", "(Landroid/app/Activity;)V", owner);
  expect(await vcall(dialog, "getOwnerActivity", "()Landroid/app/Activity;")).toBe(owner);
});


test("full-screen windows own their system bars and hiding restores the underlying window", async () => {
  const activity = new JFrameLayout(), dialog = new JFrameLayout();
  const underneath = activity.windowOwner = new JWindow(), above = dialog.windowOwner = new JWindow();
  underneath.decor = activity; above.decor = dialog;
  above.layoutW = above.layoutH = -1;
  dialog.right = device.width; dialog.bottom = device.height;
  const overlays = [{ view: dialog, x: 0, y: 0, dismissOnOutside: false }];
  await vcall(underneath, "setStatusBarColor", "(I)V", 0xff112233);
  await vcall(underneath, "setNavigationBarColor", "(I)V", 0xff223344);
  await vcall(above, "setStatusBarColor", "(I)V", 0xffeeeeee);
  await vcall(above, "setNavigationBarColor", "(I)V", 0xffdddddd);
  const controller = await vcall(above, "getInsetsController", "()Landroid/view/WindowInsetsController;");
  await vcall(controller, "setSystemBarsAppearance", "(II)V", 24, 24);
  expect(await vcall(controller, "getSystemBarsAppearance", "()I")).toBe(24);
  await vcall(controller, "hide", "(I)V", 1);
  const bars = resolveSystemBars(activity, overlays);
  expect(bars.root).toBe(dialog);
  expect([bars.status, bars.navigation, bars.visible & 3]).toEqual([0xffeeeeee, 0xffdddddd, 2]);
  above.layoutW = device.width; above.layoutH = device.height;
  expect(resolveSystemBars(activity, overlays)).toEqual(bars);
  above.flags |= 8;
  expect(resolveSystemBars(activity, overlays).root).toBe(activity);
  above.flags &= ~8;
  dialog.right--;
  expect(resolveSystemBars(activity, overlays).root).toBe(activity);
  dialog.right++;
  dialog.visibility = 4;
  const restored = resolveSystemBars(activity, overlays);
  expect(restored.root).toBe(activity);
  expect([restored.status, restored.navigation, restored.visible & 3]).toEqual([0xff112233, 0xff223344, 2]);
  expect(await vcall(underneath, "getNavigationBarColor", "()I")).toBe(0xff223344);
});
