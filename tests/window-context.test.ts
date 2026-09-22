import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JContext, JContextWrapper, display } from "../src/android/context";
import { addOverlay, overlays, detachContextOverlays, removeOverlay } from "../src/android/popup";
import { JView, dispatchAttached, uiState } from "../src/android/view";

rt.linkNatives();

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
