import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JWebView } from "../src/android/webkit";

class KeyClient extends JObj { events: unknown[] = []; }
rt.register({ name: "test/WebKeyClient", ctor: KeyClient, sup: "android/webkit/WebViewClient", methods: {
  "shouldOverrideKeyEvent(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z": function (this: KeyClient, _view: unknown, event: unknown) {
    this.events.push(event); return 1;
  },
} });
rt.register({ name: "test/WebKeyListener", ctor: class extends JObj {}, ifaces: ["android/view/View$OnKeyListener"], methods: {
  "onKey(Landroid/view/View;ILandroid/view/KeyEvent;)Z": () => 1,
} });
rt.linkNatives();

test("WebView key dispatch preserves listener interception and client overrides for both actions", async () => {
  const view = new JWebView(), client = new KeyClient();
  const down = await newObj("android/view/KeyEvent", "(II)V", 0, 111);
  const up = await newObj("android/view/KeyEvent", "(II)V", 1, 111);
  expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", down)).toBe(0);
  await vcall(view, "setWebViewClient", "(Landroid/webkit/WebViewClient;)V", client);
  expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", down)).toBe(1);
  expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", up)).toBe(1);
  expect(client.events).toEqual([down, up]);
  await vcall(view, "setOnKeyListener", "(Landroid/view/View$OnKeyListener;)V", rt.make("test/WebKeyListener"));
  expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", down)).toBe(1);
  expect(client.events).toEqual([down, up]);
});
