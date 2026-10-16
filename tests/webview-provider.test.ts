import { expect, test, describe, beforeAll } from "vite-plus/test";
import "../src/natives.ts";
import { rt, JObj } from "../src/jvm/runtime.ts";
import { vcall, newObj } from "../src/jvm/natives/jentry.ts";
import { onMain } from "../src/android/mainloop.ts";
import type { WebViewChromium } from "../src/android/webkit.ts";
import { loadFrameworkJar } from "./java.ts";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);

describe("webfragment", () => {
  class FragmentClient extends JObj {
    events: unknown[][] = [];
    visited: (() => void | Promise<void>) | null = null;
    provider: WebViewChromium | null = null;
  }
  /** a WebView's provider without its view: these exercise the provider's navigation alone */
  const webView = async (client: FragmentClient | null = null) => {
    const p = rt.make("webdroid/WebViewProvider") as WebViewChromium;
    p.view = null as never; p.settings = rt.make("webdroid/WebSettings");
    p.client = client ?? await newObj("android/webkit/WebViewClient");
    if (client) client.provider = p;
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

  test("fragment navigation updates the URL and finishes without starting or committing a document", async () => {
    const client = new FragmentClient(), view = await webView(client);
    view.loaded = true; view.progress = 100;
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url], ["finished", url]]);
    expect([view.loaded, view.progress]).toEqual([true, 100]);
  });

  test("a suspended visited-history callback can cancel the old fragment completion", async () => {
    const client = new FragmentClient(), view = await webView(client);
    client.visited = async () => { await Promise.resolve(); view.gen++; };
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url]]);
  });

  test("a queued page-start callback retains its URL when a fragment commits", async () => {
    const client = new FragmentClient(), view = await webView(client);
    const url = "https://example.org/page";
    await onMain(() => { view.loadUrl(url); view.fragmentNavigated(url + "#section"); });
    await onMain(() => {});
    expect(client.events).toEqual([["started", url], ["visited", url + "#section", 0, url + "#section"], ["finished", url + "#section"]]);
  });

  test("a WebView history copy is an independent snapshot", async () => {
    const view = await webView();
    view.loadUrl("https://example.org/one");
    view.loadUrl("https://example.org/two");
    const history = await vcall(view, "copyBackForwardList", "()Landroid/webkit/WebBackForwardList;");
    await vcall(view, "clearHistory", "()V");
    expect(await vcall(history, "getSize", "()I")).toBe(2);
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

  test("WebView keys the client claims, and keys the page cannot take, go through View's dispatch", async () => {
    const view = rt.make("webdroid/WebViewProvider") as WebViewChromium, client = new KeyClient(), access = new Access();
    view.view = null as never; view.access = access; view.client = await newObj("android/webkit/WebViewClient");
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

test("WebView's default user agent is Android WebView's, the one a new WebSettings holds", async () => {
  const statics = rt.make("webdroid/WebViewStatics"), settings = rt.make("webdroid/WebSettings");
  const ua = await vcall(statics, "getDefaultUserAgent", "(Landroid/content/Context;)Ljava/lang/String;", null) as string;
  expect(ua).toMatch(/^Mozilla\/5\.0 \(Linux; Android \d+; [^;]+ Build\/[\w.]+; wv\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Version\/4\.0 Chrome\/\d+\.\d+\.\d+\.\d+ Mobile Safari\/537\.36$/);
  expect(await vcall(settings, "getUserAgentString", "()Ljava/lang/String;")).toBe(ua);
});
