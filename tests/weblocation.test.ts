import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { webDocument } from "../src/shell/webhtml";
import { webScript } from "../src/shell/webscript";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
const upstream = "https://upstream.example:9443/dir/page?q=1#part";
const renderer = "http://renderer.example:8443";

async function fixture(html = "") {
  const page = await browser.newPage();
  await page.route(`${renderer}/**`, async route => new URL(route.request().url()).pathname === "/webview-call"
    ? route.fulfill({ json: { value: {} } })
    : route.fulfill({ contentType: "text/html", body: await webDocument(`<!doctype html>${html}`, upstream, true) }));
  await page.addInitScript(page => Object.defineProperty(window, "__wdWebView", { configurable: true, value: { id: "location-probe", page } }), upstream);
  await page.goto(`${renderer}/dir/page?q=1#part`);
  return page;
}

const evaluate = (page: Page, source: string) => page.evaluate(source => (0, eval)(source), webScript(source));

test("isolated scripts see the upstream location through globals and window aliases", async () => {
  const page = await fixture();
  try {
    expect(await evaluate(page, `(() => {
      const saved = window, holder = { window: self };
      return [location.href, saved.location.href, holder.window.location.href, document.location.href,
        window["location"].href, ({location}).location.href, document.URL, document.documentURI,
        String(location), location.origin, location.host, location.port, window.location === location,
        location instanceof Location];
    })()`)).toEqual([...Array(9).fill(upstream), "https://upstream.example:9443", "upstream.example:9443", "9443", true, true]);
    expect(await page.evaluate(() => location.origin)).toBe(renderer);
  } finally { await page.close(); }
});

test("location rewriting preserves local bindings, application getters and method receivers", async () => {
  const page = await fixture();
  try {
    expect(await evaluate(page, `(() => {
      const local = (location) => ({location}).location;
      const object = { value: 5, get location() { return this.value; }, set location(value) { this.value = value; } };
      object.location = 7;
      const method = { value: 9, location() { return this.value; } };
      class Base { get location() { return 11; } }
      class Child extends Base { get value() { return super.location; } }
      let count = 0;
      const get = () => { count++; return object; };
      return [local(3), get().location, count, method.location(), new Child().value, null?.location,
        ({location: {href: "custom"}})?.location.href];
    })()`)).toEqual([3, 7, 1, 9, 11, undefined, "custom"]);
    expect(await evaluate(page, `(() => { try { return undefined.location; } catch (e) { return e.name; } })()`)).toBe("TypeError");
  } finally { await page.close(); }
});

test("location follows history changes without exposing renderer ports", async () => {
  const page = await fixture();
  try {
    expect(await evaluate(page, `(() => {
      history.pushState({}, "", "/next");
      return [location.href, document.URL, location.port, document.baseURI];
    })()`)).toEqual(["https://upstream.example:9443/next", "https://upstream.example:9443/next", "9443", "https://upstream.example:9443/next"]);
  } finally { await page.close(); }
});

test("HTML transforms executable scripts and handlers while preserving data scripts", async () => {
  const page = await fixture(`<script>document.documentElement.dataset.initial = location.hostname;</script>
    <script type="application/json" id="data">{"location":"window.location"}</script>
    <button onclick="this.textContent = window.location.hostname">Read</button>`);
  try {
    expect(await page.evaluate(() => document.documentElement.dataset.initial)).toBe("upstream.example");
    expect(await page.locator("#data").textContent()).toBe('{"location":"window.location"}');
    await page.getByRole("button", { name: "Read" }).click();
    expect(await page.locator("button").textContent()).toBe("upstream.example");
  } finally { await page.close(); }
});

test("location rewriting leaves comments, literals and local declarations intact", () => {
  const source = `// window.location\nconst text = "window.location"; const pattern = /window.location/;
    function value(location) { return location; } const object = { location: 2 };`;
  expect(webScript(source)).toBe(source);
});

test("location setters resolve against the base and retain replacement intent", async () => {
  const page = await fixture('<base href="/app/">');
  try {
    expect(await evaluate(page, `(async () => {
      const request = new Promise(resolve => addEventListener("message", event => {
        if (event.data?.kind === "navigate") resolve([event.data.url, event.data.replace]);
      }, {once: true}));
      location.replace("next");
      return await request;
    })()`)).toEqual(["https://upstream.example:9443/app/next", true]);
  } finally { await page.close(); }
});

test("fragment assignment and replacement preserve the document and native history", async () => {
  const page = await fixture();
  try {
    expect(await evaluate(page, `(async () => {
      const length = history.length;
      let changed = new Promise(resolve => addEventListener("hashchange", resolve, {once: true}));
      location.hash = "next"; await changed;
      const pushed = history.length - length;
      changed = new Promise(resolve => addEventListener("hashchange", resolve, {once: true}));
      location.replace("#last"); await changed;
      return [location.href, document.URL, pushed, history.length - length];
    })()`)).toEqual(["https://upstream.example:9443/dir/page?q=1#last", "https://upstream.example:9443/dir/page?q=1#last", 1, 1]);
  } finally { await page.close(); }
});

test("location keeps illegal-receiver and missing-argument errors", async () => {
  const page = await fixture();
  const source = `(() => {
    const calls = [() => location.assign(), () => location.replace(),
      () => location.assign.call({}, "next"), () => location.toString.call({}),
      () => Object.getOwnPropertyDescriptor(location, "href").get.call({})];
    return calls.map(call => { try { call(); return "accepted"; } catch (e) { return e.name; } });
  })()`;
  try {
    expect(await evaluate(page, source)).toEqual(await page.evaluate(source => (0, eval)(source), source));
  } finally { await page.close(); }
});

test("fragment navigation reports the upstream URL after native history commits", async () => {
  const page = await fixture();
  try {
    expect(await evaluate(page, `(async () => {
      const reported = new Promise(resolve => addEventListener("message", event => {
        if (event.data?.kind === "fragment") resolve(event.data.url);
      }));
      location.hash = "section";
      return await reported;
    })()`)).toBe("https://upstream.example:9443/dir/page?q=1#section");
  } finally { await page.close(); }
});

test("document completion reports history changes made during parsing", async () => {
  const page = await fixture(`<script>
    addEventListener("message", event => { if (event.data?.kind === "loaded") document.documentElement.dataset.loaded = event.data.url; });
    history.replaceState(null, "", "/next");
  </script>`);
  try {
    await page.waitForFunction(() => !!document.documentElement.dataset.loaded);
    expect(await page.evaluate(() => document.documentElement.dataset.loaded)).toBe("https://upstream.example:9443/next");
  } finally { await page.close(); }
});

test("location rewriting preserves constructors, destructuring and dynamic scopes", async () => {
  const page = await fixture();
  try {
    expect(await evaluate(page, `(() => {
      const object = { location: class { constructor(value) { this.value = value; } } };
      const { location: saved, document: doc } = window;
      const local = Function("object", "with (object) { return location; }")({location: 12});
      return [new object.location(4).value, saved.hostname, doc === document, local];
    })()`)).toEqual([4, "upstream.example", true, 12]);
    expect(await evaluate(page, `with ({location: 12}) { location; }`)).toBe(12);
  } finally { await page.close(); }
});
