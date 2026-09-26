// The isolated WebView renderer's document rewriting, history and location, in one browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { webDocument } from "../src/shell/webhtml";
import { webScript } from "../src/shell/webscript";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe("WebView generated documents", () => {
  const source = "https://upstream.example/dir/page?q=1&b=2";
  const cases = [
    { name: "absolute base", head: '<base href="https://cdn.example/assets/">', base: "https://cdn.example/assets/", count: 1 },
    { name: "relative base", head: '<BASE href="../assets/?a=1&amp;b=2">', base: "https://upstream.example/assets/?a=1&b=2", count: 1 },
    { name: "no base", head: "", base: source, count: 1 },
    { name: "target only", head: '<base target="_blank">', base: source, count: 1 },
    { name: "independent href and target", head: '<base target="_blank"><base href="/assets/">', base: "https://upstream.example/assets/", count: 2 },
    { name: "first href wins", head: '<base href="/first/"><base href="/second/">', base: "https://upstream.example/first/", count: 2 },
    { name: "empty href", head: '<base href="">', base: source, count: 1 },
    { name: "invalid href", head: '<base href="https://[">', base: source, count: 1 },
    { name: "forbidden base scheme", head: '<base href="javascript:void(0)">', base: source, count: 1 },
    { name: "inert tags", head: '<!-- <head><base href="/wrong/"> --><script>const tag = \'<base href="/wrong/">\';</script><template><base href="/wrong/"></template>', base: source, count: 1 },
  ];

  for (const fixture of cases) test.concurrent(`WebView preserves ${fixture.name}`, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = `<!doctype html><html><head>${fixture.head}<script>
      document.documentElement.dataset.baseCount = document.getElementsByTagName("BASE").length;
      document.documentElement.dataset.bridge = String(!Object.hasOwn(window, "__wdWebView"));
    </script></head><body><a href="child">child</a><form action="submit"></form></body></html>`;
    await page.route("https://renderer.example/**", async route => route.fulfill({ contentType: "text/html", body: await webDocument(html, source) }));
    await page.addInitScript(() => { Object.defineProperty(window, "__wdWebView", { value: {}, configurable: true }); });
    try {
      await page.goto("https://renderer.example/dir/page");
      expect(await page.evaluate(() => ({
        base: document.baseURI,
        count: Number(document.documentElement.dataset.baseCount),
        bridge: document.documentElement.dataset.bridge,
        link: document.querySelector("a")?.href,
        form: document.querySelector("form")?.action,
        mode: document.compatMode,
        source: document.querySelector('meta[name="wd-proxy-url"]')?.getAttribute("content"),
      }))).toEqual({ base: fixture.base, count: fixture.count, bridge: "true", link: new URL("child", fixture.base).href,
        form: new URL("submit", fixture.base).href, mode: "CSS1Compat", source });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  test.concurrent("WebView injects before scripts with an omitted head and preserves asset URLs", async () => {
    const page = await browser.newPage();
    const html = '<!doctype html><!-- <head> --><html><script>document.documentElement.dataset.bridge = String(!Object.hasOwn(window, "__wdWebView"));</script><a href="next">next</a></html>';
    await page.route("https://renderer.example/**", async route => route.fulfill({ contentType: "text/html", body: await webDocument(html) }));
    await page.addInitScript(() => { Object.defineProperty(window, "__wdWebView", { value: {}, configurable: true }); });
    try {
      await page.goto("https://renderer.example/asset/page");
      expect(await page.evaluate(() => [document.documentElement.dataset.bridge, document.compatMode, document.querySelector("a")?.href,
        document.getElementsByTagName("base").length])).toEqual(["true", "CSS1Compat", "https://renderer.example/asset/next", 0]);
    } finally { await page.close(); }
  });

  test.concurrent("WebView resolves resources before and after an upstream base", async () => {
    const page = await browser.newPage();
    const scripts: string[] = [];
    page.on("console", message => scripts.push(message.text()));
    await page.route("**/*", async route => {
      const url = route.request().url();
      if (url.endsWith(".js")) {
        return route.fulfill({ contentType: "text/javascript", body: "console.log(document.currentScript.src)" });
      }
      return route.fulfill({ contentType: "text/html", body: await webDocument(
        '<!doctype html><head><script src="before.js"></script><base target="_blank"><base href="/assets/"><script src="after.js"></script></head>', source) });
    });
    try {
      await page.goto("https://renderer.example/dir/page");
      expect(scripts).toEqual(["https://upstream.example/dir/before.js", "https://upstream.example/assets/after.js"]);
      expect(await page.evaluate(() => document.getElementsByTagName("base").length)).toBe(2);
    } finally { await page.close(); }
  });
});

describe("WebView history", () => {
  const source = "https://upstream.example/dir/page?initial=1";
  const renderer = "http://renderer.example:8443";

  async function fixture(enabled = true, base = '<base href="/app/">') {
    const page = await browser.newPage();
    await page.route(`${renderer}/**`, async route => new URL(route.request().url()).pathname === "/webview-call"
      ? route.fulfill({ json: { value: {} } })
      : route.fulfill({ contentType: "text/html", body: await webDocument(`<!doctype html>${base}<title>History probe</title>`, source) }));
    await page.addInitScript(({ enabled, source }) => {
      const context = { id: enabled ? "history-probe" : null, page: source };
      Object.defineProperty(window, "__wdWebView", { value: context, configurable: true });
      Object.defineProperty(window, "historyContext", { value: context });
    }, { enabled, source });
    await page.goto(`${renderer}/dir/page?initial=1`);
    return page;
  }

  for (const url of ["https://upstream.example/app/next?q=2#part", "next?q=2#part", "//upstream.example/app/next?q=2#part"]) {
    test.concurrent(`isolated WebView history accepts ${url}`, async () => {
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

  test.concurrent("native history rejects an upstream URL on the isolated renderer", async () => {
    const page = await fixture(false);
    try {
      expect(await page.evaluate(() => {
        try { history.pushState({}, "", "next"); } catch (error) { return error instanceof DOMException ? error.name : "other"; }
        return "accepted";
      })).toBe("SecurityError");
    } finally { await page.close(); }
  });

  for (const base of ["", '<base target="_blank">']) test.concurrent("generated document bases follow same-document history", async () => {
    const page = await fixture(true, base);
    try {
      expect(await page.evaluate(() => {
        history.pushState({}, "", "/branch/");
        history.pushState({}, "", "child");
        return { path: location.pathname, base: document.baseURI };
      })).toEqual({ path: "/branch/child", base: "https://upstream.example/branch/child" });
    } finally { await page.close(); }
  });

  test.concurrent("replaceState and browser back preserve entries and upstream context", async () => {
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

  test.concurrent("history keeps native URL, origin, cloning and argument errors", async () => {
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

  test.concurrent("history converts URL arguments once and leaves omitted URLs unchanged", async () => {
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

  for (const enabled of [false, true]) test.concurrent(`empty history URLs retain the document URL (${enabled ? "isolated" : "native"})`, async () => {
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
});

describe("WebView location", () => {
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

  test.concurrent("isolated scripts see the upstream location through globals and window aliases", async () => {
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

  test.concurrent("location rewriting preserves local bindings, application getters and method receivers", async () => {
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

  test.concurrent("location follows history changes without exposing renderer ports", async () => {
    const page = await fixture();
    try {
      expect(await evaluate(page, `(() => {
        history.pushState({}, "", "/next");
        return [location.href, document.URL, location.port, document.baseURI];
      })()`)).toEqual(["https://upstream.example:9443/next", "https://upstream.example:9443/next", "9443", "https://upstream.example:9443/next"]);
    } finally { await page.close(); }
  });

  test.concurrent("HTML transforms executable scripts and handlers while preserving data scripts", async () => {
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

  test.concurrent("location rewriting leaves comments, literals and local declarations intact", () => {
    const source = `// window.location\nconst text = "window.location"; const pattern = /window.location/;
      function value(location) { return location; } const object = { location: 2 };`;
    expect(webScript(source)).toBe(source);
  });

  test.concurrent("location setters resolve against the base and retain replacement intent", async () => {
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

  test.concurrent("fragment assignment and replacement preserve the document and native history", async () => {
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

  test.concurrent("location keeps illegal-receiver and missing-argument errors", async () => {
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

  test.concurrent("fragment navigation reports the upstream URL after native history commits", async () => {
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

  test.concurrent("document completion reports history changes made during parsing", async () => {
    const page = await fixture(`<script>
      addEventListener("message", event => { if (event.data?.kind === "loaded") document.documentElement.dataset.loaded = event.data.url; });
      history.replaceState(null, "", "/next");
    </script>`);
    try {
      await page.waitForFunction(() => !!document.documentElement.dataset.loaded);
      expect(await page.evaluate(() => document.documentElement.dataset.loaded)).toBe("https://upstream.example:9443/next");
    } finally { await page.close(); }
  });

  test.concurrent("location rewriting preserves constructors, destructuring and dynamic scopes", async () => {
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
});
