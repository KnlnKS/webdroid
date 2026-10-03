import { expect, test, describe, beforeAll } from "bun:test";
import "../src/natives";
import { rt, JObj, getDeclared } from "../src/jvm/runtime";
import { vcall, newObj } from "../src/jvm/natives/jlang";
import { canvasOver, canvasOf } from "../src/android/canvas";
import type { WebViewChromium } from "../src/android/webkit";
import { scall, loadLibcore, loadFrameworkJar, preloadTextPaint } from "./java";
import { UNAME } from "../src/shell/device-properties";

// framework drawables construct Paints, which take the device's languages
beforeAll(preloadTextPaint);

describe("android-surface-state", () => {
  rt.linkNatives();

  test("uname reports the reference kernel", async () => {
    await loadLibcore();
    const uts = await scall("android/system/Os", "uname", "()Landroid/system/StructUtsname;");
    const field = (name: string) => getDeclared<string>(uts, "android/system/StructUtsname", name);
    expect(field("sysname")).toBe("Linux");
    expect(field("release")).toBe(UNAME.release);
    expect(field("machine")).toBe("aarch64");
  });
});

describe("canvas-state", () => {
  rt.linkNatives();
  beforeAll(loadFrameworkJar);

  test("canvas root state rejects unmatched restores", async () => {
    let restores = 0;
    const context = {
      restore() { restores++; },
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = canvasOver(context, 100, 100);
    const thrown = async (f: () => unknown) => { try { await f(); } catch (e) { return rt.jx(e).msg; } return null; };

    expect(await thrown(() => vcall(canvas, "restore", "()V"))).toBe("Underflow in restore - more restores than saves");
    expect(await thrown(() => vcall(canvas, "restoreToCount", "(I)V", 0))).toBe("Underflow in restoreToCount - more restores than saves");
    expect(canvasOf(canvas).saveCount).toBe(1);
    expect(restores).toBe(0);
  });
});

describe("webview-keys", () => {
  class KeyClient extends JObj { events: unknown[] = []; }
  rt.register({ name: "test/WebKeyClient", ctor: KeyClient, sup: "android/webkit/WebViewClient", methods: {
    "shouldOverrideKeyEvent(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z": function (this: KeyClient, _view: unknown, event: unknown) {
      this.events.push(event); return 1;
    },
  } });
  class Access extends JObj { events: unknown[] = []; }
  rt.register({ name: "test/WebAccess", ctor: Access, methods: {
    "super_dispatchKeyEvent(Landroid/view/KeyEvent;)Z": function (this: Access, event: unknown) { this.events.push(event); return 1; },
  } });
  rt.linkNatives();

  test("WebView keys the client claims, and keys the page cannot take, go through View's dispatch", async () => {
    const view = rt.make("webdroid/WebViewProvider") as WebViewChromium, client = new KeyClient(), access = new Access();
    view.view = new JObj(); view.access = access;
    const back = await newObj("android/view/KeyEvent", "(II)V", 0, 4);
    const escape = await newObj("android/view/KeyEvent", "(II)V", 1, 111);
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", back)).toBe(1);
    expect(access.events).toEqual([back]);
    await vcall(view, "setWebViewClient", "(Landroid/webkit/WebViewClient;)V", client);
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", escape)).toBe(1);
    expect(client.events).toEqual([escape]);
    expect(access.events).toEqual([back, escape]);
  });
});
