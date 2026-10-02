import { expect, test, describe, beforeAll } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { mangleStaticField } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { glSurfaces } from "../src/native/egl-current";
import type { WebViewChromium } from "../src/android/webkit";
import { loadFrameworkJar } from "./java";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);

describe("egl10", () => {
  rt.linkNatives();
  test("EGL10 returns configurations with their declared Java type", async () => {
    const egl = rt.make("javax/microedition/khronos/egl/EGL10"), configs = [null], count = new Int32Array(1);
    const display = await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null);
    expect(await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null)).toBe(display);
    expect(rt.iof(display, "javax/microedition/khronos/egl/EGLDisplay")).toBe(1);
    expect(await vcall(egl, "eglChooseConfig", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z", display, new Int32Array([0x3038]), configs, 1, count)).toBe(1);
    expect(count[0]).toBe(1);
    expect(rt.iof(configs[0], "javax/microedition/khronos/egl/EGLConfig")).toBe(1);
  });

  test("EGL11 rejects the no-display handle", async () => {
    const egl = rt.make("javax/microedition/khronos/egl/EGL11");
    const noDisplay = rt.link("javax/microedition/khronos/egl/EGL10").ctor[mangleStaticField("EGL_NO_DISPLAY")];
    const configs = [null], count = new Int32Array([-1]);
    expect(await vcall(egl, "eglChooseConfig", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z", noDisplay, new Int32Array([0x3038]), configs, 1, count)).toBe(0);
    expect([configs[0], count[0]]).toEqual([null, -1]);
    expect(await vcall(egl, "eglGetError", "()I")).toBe(0x3008);
    expect(await vcall(egl, "eglSwapInterval", "(Ljavax/microedition/khronos/egl/EGLDisplay;I)Z", noDisplay, 0)).toBe(0);
    expect(await vcall(egl, "eglGetError", "()I")).toBe(0x3008);
  });

  test("EGL10 reports its no-context handle until a context is bound", async () => {
    const egl = rt.make("javax/microedition/khronos/egl/EGL10");
    const none = rt.link("javax/microedition/khronos/egl/EGL10").ctor[mangleStaticField("EGL_NO_CONTEXT")];
    const display = await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null);
    expect(none).not.toBeNull();
    expect(rt.iof(none, "javax/microedition/khronos/egl/EGLContext")).toBe(1);
    expect(await vcall(egl, "eglGetCurrentContext", "()Ljavax/microedition/khronos/egl/EGLContext;")).toBe(none);
    expect(glSurfaces.current).toBeNull();
    expect(await vcall(egl, "eglMakeCurrent", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z", display, null, null, none)).toBe(1);
    expect(glSurfaces.current).toBeNull();
  });
});

describe("webfragment", () => {
  class FragmentClient extends JObj {
    events: unknown[][] = [];
    visited: (() => void | Promise<void>) | null = null;
    provider: WebViewChromium | null = null;
  }
  /** a WebView's provider, its view a stand-in: these exercise the provider's navigation alone */
  const webView = (client: FragmentClient | null = null) => {
    const p = rt.make("webdroid/WebViewProvider") as WebViewChromium;
    p.view = new JObj(); p.settings = rt.make("webdroid/WebSettings");
    if (client) { p.client = client; client.provider = p; }
    return p;
  };
  rt.register({
    name: "test/FragmentClient", ctor: FragmentClient, sup: "android/webkit/WebViewClient",
    methods: {
      "doUpdateVisitedHistory(Landroid/webkit/WebView;Ljava/lang/String;Z)V": async function (this: FragmentClient, _view: unknown, url: string, reload: number) {
        this.events.push(["visited", url, reload, this.provider!.url]); await this.visited?.();
      },
      "onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient, _view: unknown, url: string) { this.events.push(["finished", url]); },
      "onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V": function (this: FragmentClient, _view: unknown, url: string) { this.events.push(["started", url]); },
      "onPageCommitVisible(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient) { this.events.push(["commit"]); },
    },
  });
  rt.linkNatives();

  test("fragment navigation updates the URL and finishes without starting or committing a document", async () => {
    const client = new FragmentClient(), view = webView(client);
    view.loaded = true; view.progress = 100;
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url], ["finished", url]]);
    expect([view.loaded, view.progress]).toEqual([true, 100]);
  });

  test("a suspended visited-history callback can cancel the old fragment completion", async () => {
    const client = new FragmentClient(), view = webView(client);
    client.visited = async () => { await Promise.resolve(); view.gen++; };
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url]]);
  });

  test("a queued page-start callback retains its URL when a fragment commits", async () => {
    const client = new FragmentClient(), view = webView(client);
    const url = "https://example.org/page";
    await onMain(() => { view.loadUrl(url); view.fragmentNavigated(url + "#section"); });
    await onMain(() => {});
    expect(client.events).toEqual([["started", url], ["visited", url + "#section", 0, url + "#section"], ["finished", url + "#section"]]);
  });

  test("a WebView history copy is an independent snapshot", async () => {
    const view = webView();
    view.go({ url: "https://example.org/one" });
    view.go({ url: "https://example.org/two" });
    const history = await vcall(view, "copyBackForwardList", "()Landroid/webkit/WebBackForwardList;");
    await vcall(view, "clearHistory", "()V");
    expect(await vcall(history, "getSize", "()I")).toBe(2);
  });
});
