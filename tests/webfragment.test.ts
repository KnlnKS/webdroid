import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { JWebView } from "../src/android/webkit";
import { onMain } from "../src/android/mainloop";

class FragmentClient extends JObj {
  events: unknown[][] = [];
  visited: (() => void | Promise<void>) | null = null;
}
rt.register({
  name: "test/FragmentClient", ctor: FragmentClient, sup: "android/webkit/WebViewClient",
  methods: {
    "doUpdateVisitedHistory(Landroid/webkit/WebView;Ljava/lang/String;Z)V": async function (this: FragmentClient, view: JWebView, url: string, reload: number) {
      this.events.push(["visited", url, reload, view.url]); await this.visited?.();
    },
    "onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient, _view: JWebView, url: string) { this.events.push(["finished", url]); },
    "onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V": function (this: FragmentClient, _view: JWebView, url: string) { this.events.push(["started", url]); },
    "onPageCommitVisible(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient) { this.events.push(["commit"]); },
  },
});
rt.linkNatives();

test("fragment navigation updates the URL and finishes without starting or committing a document", async () => {
  const view = new JWebView(), client = new FragmentClient();
  view.client = client; view.loaded = true; view.progress = 100;
  const url = "https://example.org/page#section";
  view.fragmentNavigated(url);
  await onMain(() => {});
  expect(client.events).toEqual([["visited", url, 0, url], ["finished", url]]);
  expect([view.loaded, view.progress]).toEqual([true, 100]);
});

test("a suspended visited-history callback can cancel the old fragment completion", async () => {
  const view = new JWebView(), client = new FragmentClient();
  view.client = client;
  client.visited = async () => { await Promise.resolve(); view.gen++; };
  const url = "https://example.org/page#section";
  view.fragmentNavigated(url);
  await onMain(() => {});
  expect(client.events).toEqual([["visited", url, 0, url]]);
});

test("a queued page-start callback retains its URL when a fragment commits", async () => {
  const view = new JWebView(), client = new FragmentClient();
  view.client = client;
  const url = "https://example.org/page";
  await onMain(() => { view.loadUrl(url); view.fragmentNavigated(url + "#section"); });
  await onMain(() => {});
  expect(client.events).toEqual([["started", url], ["visited", url + "#section", 0, url + "#section"], ["finished", url + "#section"]]);
});
