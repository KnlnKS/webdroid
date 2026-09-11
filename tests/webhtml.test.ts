import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { webDocument } from "../src/shell/webhtml";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

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

for (const fixture of cases) test(`WebView preserves ${fixture.name}`, async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const html = `<!doctype html><html><head>${fixture.head}<script>
    document.documentElement.dataset.baseCount = document.getElementsByTagName("BASE").length;
    document.documentElement.dataset.bridge = String(!Object.hasOwn(window, "__wdWebView"));
  </script></head><body><a href="child">child</a><form action="submit"></form></body></html>`;
  await page.route("https://renderer.example/**", route => route.fulfill({ contentType: "text/html", body: webDocument(html, source) }));
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

test("WebView injects before scripts with an omitted head and preserves asset URLs", async () => {
  const page = await browser.newPage();
  const html = '<!doctype html><!-- <head> --><html><script>document.documentElement.dataset.bridge = String(!Object.hasOwn(window, "__wdWebView"));</script><a href="next">next</a></html>';
  await page.route("https://renderer.example/**", route => route.fulfill({ contentType: "text/html", body: webDocument(html) }));
  await page.addInitScript(() => { Object.defineProperty(window, "__wdWebView", { value: {}, configurable: true }); });
  try {
    await page.goto("https://renderer.example/asset/page");
    expect(await page.evaluate(() => [document.documentElement.dataset.bridge, document.compatMode, document.querySelector("a")?.href,
      document.getElementsByTagName("base").length])).toEqual(["true", "CSS1Compat", "https://renderer.example/asset/next", 0]);
  } finally { await page.close(); }
});
