// The isolated WebView renderer's document rewriting, history and location, in one browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { webDocument } from "../src/shell/webhtml";
import { webScript } from "../src/shell/webscript";
import { proxyRequest } from "../src/shell/proxy";
import { WEB_FRAME, WEB_FRAME_SANDBOX, WEB_PROXY_WORKER, holdFrames, routeSubframes, webFormRequest, webViewBrands } from "../src/shell/webinject";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

const renderer = "http://renderer.example:8443";

/** A renderer page serving `html` as webdroid rewrites it for `upstream`, with the bridge context the
 *  shell injects. The bridge hides `__wdWebView`, so tests read the same object as `probeContext`. */
async function rendererPage(path: string, html: string, upstream: string, context: { id: string | null; page: string; [key: string]: unknown }, isolated = false): Promise<Page> {
  const page = await browser.newPage();
  await page.route(`${renderer}/**`, async route => new URL(route.request().url()).pathname === "/webview-call"
    ? route.fulfill({ json: { value: {} } })
    : route.fulfill({ contentType: "text/html", body: await webDocument(html, upstream, isolated) }));
  await page.addInitScript((context) => {
    Object.defineProperty(window, "__wdWebView", { value: context, configurable: true });
    Object.defineProperty(window, "probeContext", { value: context });
  }, context);
  await page.goto(renderer + path);
  return page;
}

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
  const fixture = (enabled = true, base = '<base href="/app/">') => rendererPage("/dir/page?initial=1",
    `<!doctype html>${base}<title>History probe</title>`, source, { id: enabled ? "history-probe" : null, page: source });

  for (const url of ["https://upstream.example/app/next?q=2#part", "next?q=2#part", "//upstream.example/app/next?q=2#part"]) {
    test.concurrent(`isolated WebView history accepts ${url}`, async () => {
      const page = await fixture();
      try {
        expect(await page.evaluate(url => {
          const length = history.length;
          history.pushState({ step: 2 }, "", url);
          const context = Object.getOwnPropertyDescriptor(window, "probeContext")?.value;
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
        const context = Object.getOwnPropertyDescriptor(window, "probeContext")?.value;
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
        return { errors, url: location.href, page: Object.getOwnPropertyDescriptor(window, "probeContext")?.value.page };
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
  const fixture = (html = "") => rendererPage("/dir/page?q=1#part", `<!doctype html>${html}`, upstream, { id: "location-probe", page: upstream }, true);

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

describe("WebView client hints", () => {
  const upstream = "https://upstream.example/dir/page";
  const hints = { brands: webViewBrands("131.0.6778.200", false), fullVersionList: webViewBrands("131.0.6778.200", true), uaFullVersion: "131.0.6778.200",
    model: "Pixel 9", platformVersion: "15.0.0", architecture: "", bitness: "", wow64: false, formFactors: ["Mobile"] };

  test.concurrent("navigator.userAgentData is Android WebView's", async () => {
    const page = await rendererPage("/dir/page", "<!doctype html><p>page</p>", upstream, { id: "hints-probe", page: upstream, clientHints: hints }, true);
    try {
      expect(await page.evaluate(async () => {
        const data = (navigator as unknown as { userAgentData: { brands: unknown; mobile: boolean; platform: string; getHighEntropyValues(h: string[]): Promise<unknown> } }).userAgentData;
        return [data.brands, data.mobile, data.platform, await data.getHighEntropyValues(["model", "platformVersion", "fullVersionList"])];
      })).toEqual([
        [{ brand: "Android WebView", version: "131" }, { brand: "Chromium", version: "131" }, { brand: "Not_A Brand", version: "24" }], true, "Android",
        { brands: hints.brands, mobile: true, platform: "Android", model: "Pixel 9", platformVersion: "15.0.0", fullVersionList: hints.fullVersionList },
      ]);
    } finally { await page.close(); }
  });
});

describe("WebView cookies", () => {
  const upstream = "https://upstream.example/dir/page";

  test.concurrent("document.cookie reads the app's cookies and applies the page's writes until the jar answers", async () => {
    const page = await rendererPage("/dir/page", "<!doctype html><p>page</p>", upstream,
      { id: "cookie-probe", page: upstream, cookies: [{ text: "a=1", expires: 0 }, { text: "gone=1", expires: 1 }] }, true);
    try {
      expect(await page.evaluate(() => {
        const posted: unknown[] = [];
        addEventListener("message", (event) => { if (event.data?.kind === "cookie") posted.push(event.data.seq); });
        const before = document.cookie;
        for (const value of ["b=2; Path=/dir", "a=; Max-Age=0", "c=3; Path=/other", "d=4; Domain=elsewhere.example", "e=5; HttpOnly"]) document.cookie = value;
        const written = document.cookie;
        // the jar's answer to an earlier write is not the cookies the page has since written
        postMessage({ bridge: "cookie-probe", kind: "cookies", ack: 1, list: [{ text: "x=1", expires: 0 }] }, "*");
        postMessage({ bridge: "cookie-probe", kind: "cookies", ack: 5, list: [{ text: "b=2", expires: 0 }, { text: "z=9", expires: 0 }] }, "*");
        return new Promise<unknown>((resolve) => setTimeout(() => resolve([before, written, document.cookie, posted]), 50));
      })).toEqual(["a=1", "b=2", "b=2; z=9", [1, 2, 3, 4, 5]]);
    } finally { await page.close(); }
  });
});

describe("WebView frame holding", () => {
  test("document.write's chunks hold a frame however they split its tag", () => {
    const html = '<p a="<iframe src=x>">t</p><!-- <iframe src=c> --><script>var s = "<iframe src=s>";</script><IFRAME id=f SRC="https://a/" name=n></IFRAME>'
      + "<iframe src='about:blank'></iframe><iframe src=gmsg://m/x>";
    const whole = holdFrames(html);
    expect(whole.match(/data-wd-frame-src/g)).toHaveLength(2);
    for (let i = 0; i <= html.length; i++) for (let j = i; j <= html.length; j += 7) {
      const carry = { raw: "", tail: "" };
      expect(holdFrames(html.slice(0, i), carry) + holdFrames(html.slice(i, j), carry) + holdFrames(html.slice(j), carry) + carry.tail).toBe(whole);
    }
  });
});

describe("WebView isolation", () => {
  // the app's page and a renderer frame on a *.localhost site of its own, as the dev server serves them
  test("a WebView page reaches neither the app page's storage, cookies and window nor a frame of the app's origin", async () => {
    const id = crypto.randomUUID(), html = { "content-type": "text/html" };
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/webview-worker.js") return new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/webview") return new Response(WEB_FRAME, { headers: html });
      if (url.pathname === "/proxy") return proxyRequest(req, { bridgeCall: async () => new Response(null, { status: 503 }), fetchUpstream: async () => new Response(
        "<script>parent.postMessage({kind: 'upstream', storage: (() => { try { return top.localStorage.getItem('secret'); } catch (e) { return e.name; } })()}, '*')</script>", { headers: html }) });
      return new Response("<!doctype html><body>app", { headers: html });
    } });
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${server.port}/`);
      // the page writes its findings where the app would read them: postMessage to its parent
      const probe = `<script>(async () => {
        const out = {}, id = window.__wdWebView.id, attempt = f => { try { return f(); } catch (e) { return e.name; } };
        out.storage = localStorage.getItem("secret");
        out.cookie = document.cookie;
        out.parentStorage = attempt(() => parent.localStorage.getItem("secret"));
        out.topDocument = attempt(() => typeof top.document);
        // a frame of the app's own origin is no renderer: it never takes a document from this page
        const child = document.createElement("iframe");
        child.src = "http://localhost:${server.port}/webview?__wd_bridge=" + id;
        const answer = frame => new Promise(resolve => {
          addEventListener("message", event => { if (event.source === frame.contentWindow) resolve(event.data.storage ?? event.data.kind); });
          frame.onload = () => setTimeout(() => resolve("silent"), 300);
          document.body.append(frame);
        });
        out.appFrame = await answer(child);
        // nor does the app's origin serve it an upstream document
        const proxied = document.createElement("iframe");
        proxied.src = "http://localhost:${server.port}/proxy?url=" + encodeURIComponent("https://upstream.example/");
        out.proxiedFrame = await answer(proxied);
        // nor does another app's or site's renderer, framed by this page, take a document from it
        const sibling = document.createElement("iframe");
        sibling.src = "http://other.localhost:${server.port}/webview?__wd_bridge=" + id;
        out.siblingFrame = await new Promise(resolve => {
          addEventListener("message", event => { if (event.source === sibling.contentWindow) resolve(event.data.kind); });
          sibling.onload = () => {
            sibling.contentWindow.postMessage({bridge: id, kind: "load", doc: "<script>parent.postMessage({kind: 'forged'}, '*')<\\/script>"}, "*", [new MessageChannel().port2]);
            setTimeout(() => resolve("silent"), 300);
          };
          document.body.append(sibling);
        });
        out.topNavigation = attempt(() => { top.location.href = "about:blank"; return "navigated"; });
        parent.postMessage({bridge: id, kind: "probe", ...out}, "*");
      })()</script>`;
      expect(await page.evaluate(async ({ id, port, sandbox, probe }) => {
        localStorage.setItem("secret", "app");
        document.cookie = "secret=app; path=/";
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", sandbox);
        frame.src = `http://partition.localhost:${port}/webview?__wd_bridge=${id}&__wd_url=about:blank`;
        const result = new Promise((resolve) => addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow || event.data?.bridge !== id) return;
          if (event.data.kind === "ready") frame.contentWindow!.postMessage({ bridge: id, kind: "load", doc: "<!doctype html><body>" + probe }, event.origin, [new MessageChannel().port2]);
          else if (event.data.kind === "probe") resolve({ ...event.data, bridge: undefined, kind: undefined, location: location.href });
        }));
        document.body.append(frame);
        return result;
      }, { id, port: server.port, sandbox: WEB_FRAME_SANDBOX, probe })).toEqual({ storage: null, cookie: "", parentStorage: "SecurityError", topDocument: "SecurityError",
        appFrame: "silent", proxiedFrame: "SecurityError", siblingFrame: "silent", topNavigation: "SecurityError", location: `http://localhost:${server.port}/`, bridge: undefined, kind: undefined });
    } finally { await page.close(); await server.stop(true); }
  });

  test("a renderer origin's storage frame reports and deletes what the origin holds", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/webview-worker.js") return new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript" } });
      return new Response(path === "/webview" ? WEB_FRAME : "<!doctype html><body>app", { headers: { "content-type": "text/html" } });
    } });
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${server.port}/`);
      expect(await page.evaluate(async ({ origin, sandbox }) => {
        // the app drives a frame on the origin: a document it loads, or a storage op
        const drive = (message: Record<string, unknown>) => new Promise<unknown>((resolve) => {
          const id = crypto.randomUUID(), frame = document.createElement("iframe"), channel = new MessageChannel();
          frame.setAttribute("sandbox", sandbox);
          frame.src = `${origin}/webview?__wd_bridge=${id}`;
          channel.port1.onmessage = ({ data }) => { frame.remove(); resolve(data); };
          addEventListener("message", (event) => {
            if (event.source !== frame.contentWindow || event.data?.bridge !== id) return;
            if (event.data.kind === "ready") frame.contentWindow!.postMessage({ bridge: id, ...message }, origin, [channel.port2]);
            else if (event.data.kind === "found") { frame.remove(); resolve(event.data.found); }
          });
          document.body.append(frame);
        });
        const read = (write: boolean) => drive({ kind: "load", doc: `<script>(async () => {
          if (${write}) { localStorage.setItem("k", "v"); await new Promise(r => { const q = indexedDB.open("db"); q.onupgradeneeded = () => q.result.createObjectStore("s");
            q.onsuccess = () => { const t = q.result.transaction("s", "readwrite"); t.objectStore("s").put(new Uint8Array(1 << 16), 1); t.oncomplete = () => { q.result.close(); r(); }; }; }); }
          parent.postMessage({bridge: new URL(location.href).searchParams.get("__wd_bridge"), kind: "found",
            found: [localStorage.getItem("k"), (await indexedDB.databases()).map(d => d.name)]}, "*");
        })()</script>` });
        const written = await read(true), usage = (await drive({ kind: "storage", op: "usage" }) as { usage: number }).usage > 0;
        await drive({ kind: "storage", op: "origin" });
        const afterOrigin = await read(false);
        await drive({ kind: "storage", op: "data" });
        return [written, usage, afterOrigin, await read(false), await drive({ kind: "storage", op: "usage" })];
      }, { origin: `http://store.localhost:${server.port}`, sandbox: WEB_FRAME_SANDBOX })).toEqual([["v", ["db"]], true, ["v", []], [null, []], { usage: 0, quota: expect.any(Number) }]);
    } finally { await page.close(); await server.stop(true); }
  });

  test("a page's subframes load where the app routes them, never straight from their site", async () => {
    const hits: string[] = [];
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const url = new URL(req.url);
      hits.push(url.host + url.pathname);
      return new Response(url.pathname === "/" ? "<!doctype html><head></head><body>page" : "frame", { headers: { "content-type": "text/html" } });
    } });
    const page = await browser.newPage(), errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    try {
      await page.goto(`http://page.localhost:${server.port}/`);
      const routed = (url: string) => `http://routed.localhost:${server.port}/frame?for=` + encodeURIComponent(url);
      const direct = `http://127.0.0.1:${server.port}`;
      expect(await page.evaluate(async ({ direct, port, route, hold, form }) => {
        const asked: string[] = [];
        (0, eval)(`(${route})`)(`http://routed.localhost:${port}`, (url: string) => {
          asked.push(url);
          return Promise.resolve(url.startsWith("http") ? `http://routed.localhost:${port}/frame?for=` + encodeURIComponent(url) : url.startsWith("data:") ? url : null);
        }, (0, eval)(`(${hold})`), (0, eval)(`(${form})`));
        document.body.insertAdjacentHTML("beforeend", `<iframe src="${direct}/direct"></iframe>`);
        const made = document.createElement("iframe");
        made.src = `${direct}/made`;
        document.body.append(made);
        // a scheme the client handles never loads; frames that need no request load as they are
        const message = document.createElement("iframe");
        message.src = "gmsg://mobileads.google.com/x";
        document.body.append(message);
        message.remove();
        const kept = document.createElement("iframe");
        kept.src = "gmsg://mobileads.google.com/kept";
        document.body.append(kept);
        const srcdoc = document.createElement("iframe");
        srcdoc.srcdoc = `<p>doc</p><iframe src="${direct}/in-srcdoc"></iframe>`;
        document.body.append(srcdoc);
        const blank = document.createElement("iframe");
        document.body.append(blank);
        blank.contentDocument!.write(`<iframe src="${direct}/in-blank"></iframe>`);
        const data = document.createElement("iframe");
        data.setAttribute("src", "data:text/html,<p>data</p>");
        document.body.append(data);
        await new Promise((resolve) => setTimeout(resolve, 500));
        // the page reads the src it set; the attribute the frame loads is the app's
        const frames = (doc: Document) => [...doc.querySelectorAll("iframe")].map((f) => [f.src, Element.prototype.getAttribute.call(f, "src")]);
        return [asked.sort(), frames(document), frames(srcdoc.contentDocument!), frames(blank.contentDocument!), srcdoc.contentDocument!.body.firstChild!.textContent];
      }, { direct, port: server.port, route: routeSubframes.toString(), hold: holdFrames.toString(), form: webFormRequest.toString() })).toEqual([
        [`${direct}/direct`, `${direct}/made`, "gmsg://mobileads.google.com/x", "gmsg://mobileads.google.com/kept", "data:text/html,<p>data</p>", `${direct}/in-blank`, `${direct}/in-srcdoc`].sort(),
        [[`${direct}/direct`, routed(`${direct}/direct`)], [`${direct}/made`, routed(`${direct}/made`)], ["gmsg://mobileads.google.com/kept", null],
          ["", null], ["", null], ["data:text/html,<p>data</p>", "data:text/html,<p>data</p>"]],
        [[`${direct}/in-srcdoc`, routed(`${direct}/in-srcdoc`)]],
        [[`${direct}/in-blank`, routed(`${direct}/in-blank`)]],
        "doc",
      ]);
      expect(hits.filter((h) => !h.startsWith("page.localhost"))).toEqual(Array(4).fill(`routed.localhost:${server.port}/frame`));
      expect(errors).toEqual([]);
    } finally { await page.close(); await server.stop(true); }
  });

  test("a page's frames reach the app however the page sets or navigates them, and fire only their routed load", async () => {
    const hits: string[] = [];
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const url = new URL(req.url);
      hits.push(url.host + url.pathname + url.search);
      // a routed frame's renderer document announces itself, then writes the page, as WEB_FRAME does
      return new Response(url.pathname === "/" ? "<!doctype html><head></head><body>page" : `<script>parent.postMessage({wdFrame: "bootstrap"}, "*");
        setTimeout(() => { document.open(); document.write("frame"); document.close(); }, 20)</script>`, { headers: { "content-type": "text/html" } });
    } });
    const page = await browser.newPage(), errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    try {
      await page.goto(`http://page.localhost:${server.port}/`);
      const direct = `http://127.0.0.1:${server.port}`;
      const result = await page.evaluate(async ({ direct, port, route, hold, form }) => {
        const asked: string[] = [];
        // the client claims URLs naming "override"; data: and blob: load as they are
        (0, eval)(`(${route})`)(`http://routed.localhost:${port}`, (url: string, init?: { method?: string }) => {
          asked.push(url.startsWith("blob:") ? "blob" : url + (init?.method ? " " + init.method : ""));
          return Promise.resolve(/override/.test(url) ? null : url.startsWith("http") ? `http://routed.localhost:${port}/frame?for=` + encodeURIComponent(url) : url);
        }, (0, eval)(`(${hold})`), (0, eval)(`(${form})`));
        const loads: Record<string, number> = {};
        const frame = (label: string, setup: (f: HTMLIFrameElement) => void) => {
          const f = document.createElement("iframe");
          f.addEventListener("load", () => { loads[label] = (loads[label] ?? 0) + 1; });
          setup(f);
          document.body.append(f);
          return f;
        };
        const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
        frame("routed", (f) => { f.src = `${direct}/routed`; });
        frame("overridden", (f) => { f.src = "gmsg://override/x"; });
        frame("data", (f) => { f.src = "data:text/html,<p>data"; });
        // a blob: URL revoked as soon as it is set still loads, as it would
        const url = URL.createObjectURL(new Blob(["<p>blob</p>"], { type: "text/html" }));
        const blob = frame("blob", (f) => { f.src = url; });
        URL.revokeObjectURL(url);
        const attr = document.createAttribute("src");
        attr.value = `${direct}/attr-node`;
        frame("attr", (f) => { f.setAttributeNode(attr); });
        frame("named-item", (f) => {
          const item = document.createAttribute("src");
          item.value = `${direct}/named-item`;
          f.attributes.setNamedItem(item);
        });
        frame("attr-value", (f) => { f.setAttribute("src", "about:blank"); f.getAttributeNode("src")!.value = `${direct}/attr-value`; });
        document.body.insertAdjacentHTML("beforeend", `<iframe id=static srcdoc="<p>static</p><iframe src=&quot;${direct}/static-srcdoc&quot;></iframe>"></iframe>`);
        const parsed = new DOMParser().parseFromString(`<iframe src="${direct}/parsed"></iframe>`, "text/html").querySelector("iframe")!;
        const parsedSrc = [parsed.src, parsed.getAttribute("src")];
        document.body.append(parsed);
        // document.write's chunks split a frame's tag, and a script's string that looks like one
        const written = frame("written", () => {});
        const doc = written.contentDocument!;
        doc.open();
        doc.write("<p>w</p><ifr");
        doc.write(`ame src="${direct}/split"></iframe><script>var s = "<ifr`);
        doc.write(`ame src='${direct}/in-script'>";</scr`);
        doc.write("ipt>");
        doc.close();
        frame("opened", (f) => { f.name = "t"; f.src = `${direct}/target`; });
        frame("clicked", (f) => { f.name = "u"; });
        const child = frame("child", (f) => { f.srcdoc = `<a target=u href="${direct}/clicked">x</a><form target=v method=post action="${direct}/posted"><input name=a value=1></form>`; });
        frame("posted", (f) => { f.name = "v"; });
        const pushed = frame("pushed", (f) => { f.srcdoc = "<p>pushed"; });
        await settle();
        const opened = window.open(`${direct}/opened`, "t") === document.querySelector<HTMLIFrameElement>("iframe[name=t]")!.contentWindow;
        child.contentDocument!.querySelector("a")!.click();
        child.contentDocument!.querySelector("form")!.requestSubmit();
        (child.contentWindow as unknown as { eval(code: string): void }).eval(`location.href = "${direct}/self"`);
        pushed.contentWindow!.location.href = `${direct}/pushed`;
        await settle();
        return { asked: asked.sort(), loads, opened, parsedSrc, blob: blob.contentDocument?.body.textContent, script: (written.contentWindow as unknown as { s: string }).s,
          written: [...doc.querySelectorAll("iframe")].map((f) => f.src) };
      }, { direct, port: server.port, route: routeSubframes.toString(), hold: holdFrames.toString(), form: webFormRequest.toString() });
      const paths = ["attr-node", "attr-value", "clicked", "named-item", "opened", "parsed", "pushed", "routed", "self", "split", "static-srcdoc", "target"];
      expect(result).toEqual({
        asked: [...paths.map((p) => `${direct}/${p}`), `${direct}/posted POST`, "blob", "data:text/html,<p>data", "gmsg://override/x"].sort(),
        // the overridden frame keeps its initial document without a load event, as Chromium's does
        loads: { routed: 1, data: 1, blob: 1, attr: 1, "named-item": 1, "attr-value": 1, written: 2, opened: 2, clicked: 2, posted: 2, child: 2, pushed: 2 },
        opened: true, parsedSrc: [`${direct}/parsed`, `${direct}/parsed`], blob: "blob", script: `<iframe src='${direct}/in-script'>`, written: [`${direct}/split`],
      });
      expect(hits.filter((h) => !h.startsWith("page.localhost")).sort()).toEqual([...paths, "posted"].map((p) =>
        `routed.localhost:${server.port}/frame?for=` + encodeURIComponent(`${direct}/${p}`)).sort());
      expect(errors).toEqual([]);
    } finally { await page.close(); await server.stop(true); }
  });
});
