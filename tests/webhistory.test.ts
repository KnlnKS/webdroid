import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { webDocument } from "../src/shell/webhtml";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
const source = "https://upstream.example/dir/page?initial=1";
const renderer = "http://renderer.example:8443";

async function fixture(enabled = true, base = '<base href="/app/">') {
  const page = await browser.newPage();
  await page.route(`${renderer}/**`, route => new URL(route.request().url()).pathname === "/webview-call"
    ? route.fulfill({ json: { value: {} } })
    : route.fulfill({ contentType: "text/html", body: webDocument(`<!doctype html>${base}<title>History probe</title>`, source) }));
  await page.addInitScript(({ enabled, source }) => {
    const context = { id: enabled ? "history-probe" : null, page: source };
    Object.defineProperty(window, "__wdWebView", { value: context, configurable: true });
    Object.defineProperty(window, "historyContext", { value: context });
  }, { enabled, source });
  await page.goto(`${renderer}/dir/page?initial=1`);
  return page;
}

for (const url of ["https://upstream.example/app/next?q=2#part", "next?q=2#part", "//upstream.example/app/next?q=2#part"]) {
  test(`isolated WebView history accepts ${url}`, async () => {
    const page = await fixture();
    try {
      expect(await page.evaluate(url => {
        const length = history.length;
        history.pushState({ step: 2 }, "", url);
        const context = Object.getOwnPropertyDescriptor(window, "historyContext")?.value;
        return { url: location.href, page: context.page, state: history.state, added: history.length - length };
      }, url)).toEqual({ url: `${renderer}/app/next?q=2#part`, page: "https://upstream.example/app/next?q=2#part", state: { step: 2 }, added: 1 });
    } finally { await page.close(); }
  });
}

test("native history rejects an upstream URL on the isolated renderer", async () => {
  const page = await fixture(false);
  try {
    expect(await page.evaluate(() => {
      try { history.pushState({}, "", "next"); } catch (error) { return error instanceof DOMException ? error.name : "other"; }
      return "accepted";
    })).toBe("SecurityError");
  } finally { await page.close(); }
});

for (const base of ["", '<base target="_blank">']) test("generated document bases follow same-document history", async () => {
  const page = await fixture(true, base);
  try {
    expect(await page.evaluate(() => {
      history.pushState({}, "", "/branch/");
      history.pushState({}, "", "child");
      return { path: location.pathname, base: document.baseURI };
    })).toEqual({ path: "/branch/child", base: "https://upstream.example/branch/child" });
  } finally { await page.close(); }
});

test("replaceState and browser back preserve entries and upstream context", async () => {
  const page = await fixture();
  try {
    expect(await page.evaluate(async () => {
      const length = history.length;
      history.pushState({ step: 1 }, "", "one");
      history.replaceState({ step: 2 }, "", "two");
      const replaced = [location.pathname, history.state.step, history.length - length];
      const popped = new Promise<void>(resolve => addEventListener("popstate", () => resolve(), { once: true }));
      history.back(); await popped;
      const context = Object.getOwnPropertyDescriptor(window, "historyContext")?.value;
      return { replaced, url: location.href, page: context.page };
    })).toEqual({ replaced: ["/app/two", 2, 1], url: `${renderer}/dir/page?initial=1`, page: source });
  } finally { await page.close(); }
});

test("history keeps native URL, origin, cloning and argument errors", async () => {
  const page = await fixture();
  try {
    expect(await page.evaluate(() => {
      const calls = [
        () => history.pushState({}, "", "https://other.example/path"),
        () => history.pushState({}, "", "https://["),
        () => history.pushState(() => {}, "", "next"),
        () => Reflect.apply(history.pushState, history, [{}]),
        () => Reflect.apply(history.pushState, history, [{}, "", Symbol()]),
      ];
      const errors = calls.map(call => { try { call(); return "accepted"; } catch (error) { return error instanceof Error ? error.name : "other"; } });
      return { errors, url: location.href, page: Object.getOwnPropertyDescriptor(window, "historyContext")?.value.page };
    })).toEqual({ errors: ["SecurityError", "SecurityError", "DataCloneError", "TypeError", "TypeError"], url: `${renderer}/dir/page?initial=1`, page: source });
  } finally { await page.close(); }
});

test("history converts URL arguments once and leaves omitted URLs unchanged", async () => {
  const page = await fixture();
  try {
    expect(await page.evaluate(() => {
      let conversions = 0;
      Reflect.apply(history.pushState, history, [{}, "", { toString() { conversions++; return "next"; } }]);
      history.replaceState({ step: 2 }, "");
      return { conversions, path: location.pathname, state: history.state };
    })).toEqual({ conversions: 1, path: "/app/next", state: { step: 2 } });
  } finally { await page.close(); }
});

for (const enabled of [false, true]) test(`empty history URLs retain the document URL (${enabled ? "isolated" : "native"})`, async () => {
  const page = await fixture(enabled);
  try {
    expect(await page.evaluate(() => {
      history.pushState({ step: 1 }, "", "");
      history.replaceState({ step: 2 }, "", null);
      Reflect.apply(history.pushState, history, [{ step: 3 }, "", { toString: () => "" }]);
      return { path: location.pathname + location.search, state: history.state };
    })).toEqual({ path: "/dir/page?initial=1", state: { step: 3 } });
  } finally { await page.close(); }
});
