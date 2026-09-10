import { expect, test } from "bun:test";
import { WebCookies } from "./webcookies";

test("WebView cookies retain domain, path, expiry and HttpOnly boundaries", () => {
  const jar = new WebCookies("cookie-boundaries"); jar.remove();
  expect(jar.set("https://a.example.com/path/page", "host=one; Path=/path; HttpOnly")).toBe(true);
  expect(jar.set("https://a.example.com/", "domain=two; Domain=example.com; Secure; Path=/")).toBe(true);
  expect(jar.get("https://a.example.com/path/child")).toBe("host=one; domain=two");
  expect(jar.get("https://a.example.com/path/child", false)).toBe("domain=two");
  expect(jar.set("https://a.example.com/path/page", "host=changed; Path=/path", false)).toBe(false);
  expect(jar.get("https://b.example.com/")).toBe("domain=two");
  expect(jar.get("http://a.example.com/")).toBe("");
  expect(jar.set("https://a.example.com/", "wide=bad; Domain=com")).toBe(false);
  expect(jar.set("https://a.example.co.uk/", "wide=bad; Domain=co.uk")).toBe(false);
  expect(jar.set("https://a.example.com/", "other=bad; Domain=other.com")).toBe(false);
  expect(jar.set("https://a.example.com/", "__Host-bad=x; Secure; Domain=example.com; Path=/")).toBe(false);
  expect(jar.set("https://a.example.com/", "none=bad; SameSite=None")).toBe(false);
  jar.set("https://a.example.com/", "domain=expired; Domain=example.com; Path=/; Max-Age=0");
  expect(jar.get("https://b.example.com/")).toBe("");
  jar.remove();
});

test("WebView session removal retains persistent cookies and network access respects SameSite", () => {
  const jar = new WebCookies("cookie-sessions"); jar.remove();
  const url = "https://a.example.com/";
  jar.set(url, "session=one; Path=/");
  jar.set(url, "persist=two; Path=/; Max-Age=3600; SameSite=Strict");
  jar.set(url, "cross=three; Path=/; Max-Age=3600; SameSite=None; Secure");
  expect(jar.remove(true)).toBe(true);
  expect(jar.get(url)).toBe("persist=two; cross=three");
  expect(jar.network(url, "https://b.example.com/", [], false)).toBe("persist=two; cross=three");
  expect(jar.network(url, "https://other.com/", [], false)).toBe("");
  expect(jar.network(url, "https://other.com/", [], true)).toBe("cross=three");
  jar.accept = false;
  expect(jar.set(url, "new=blocked")).toBe(false);
  expect(jar.remove()).toBe(true);
  expect(jar.has()).toBe(false);
});
