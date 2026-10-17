// The renderer origin's service worker: a WebView page's requests go through the app's proxy as the
// WebView's network stack sends them (its user agent, client hints, cookie jar and client), and its
// apk assets and device fonts come from the app.
import { webViewBrands } from "./clienthints.ts";
import type { RendererContext } from "./protocol.ts";

type Client = { id: string; url: string; type: string; postMessage(data: unknown, transfer: Transferable[]): void };
type FetchEvent = Event & { request: Request; clientId: string; respondWith(response: Promise<Response>): void };
type ExtendableEvent = Event & { waitUntil(work: Promise<unknown>): void };
const worker = globalThis as unknown as { location: Location; navigator: Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } };
  skipWaiting(): Promise<void>; clients: { claim(): Promise<void>; get(id: string): Promise<Client | undefined> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void };

// Sec-CH-UA's defaults name Android WebView at the host's Chromium, as the page's userAgentData does
const brands = webViewBrands(worker.navigator.userAgentData?.brands?.find((b) => b.brand === "Chromium")?.version
  ?? /Chrome\/(\d+)/.exec(worker.navigator.userAgent)?.[1] ?? "120", false);
const clientHints = [["x-wd-sec-ch-ua", brands.map((b) => '"' + b.brand + '";v="' + b.version + '"').join(", ")],
  ["x-wd-sec-ch-ua-mobile", "?1"], ["x-wd-sec-ch-ua-platform", '"Android"']];
worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));
// each client's load, which its renderer bootstrap answers
const contexts = new Map<string, Promise<RendererContext>>();
function message<T>(client: Client, data: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(Error("WebView client unavailable")); }, 10000);
    channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    client.postMessage(data, [channel.port2]);
  });
}
function context(client: Client): Promise<RendererContext> {
  const key = client.id + client.url;
  let value = contexts.get(key);
  if (!value) {
    value = message<RendererContext>(client, { kind: "webcontext" }); contexts.set(key, value);
    if (contexts.size > 64) contexts.delete(contexts.keys().next().value!);
    value.catch(() => contexts.delete(key));
  }
  return value;
}
worker.addEventListener("fetch", (event) => {
  const request = event.request, original = new URL(request.url);
  // an apk asset, or a device font the WebView's settings name, from the app
  if (original.origin === worker.location.origin && /^\/(asset|system\/fonts|data\/fonts)\//.test(original.pathname)) {
    event.respondWith((async () => {
      const client = await worker.clients.get(event.clientId);
      if (!client) return fetch(request);
      const result = await message<{ status: number; bytes?: Uint8Array<ArrayBuffer>; type?: string }>(client, { kind: "webasset", path: original.pathname }).catch(() => ({ status: 404 }) as const);
      if (result.status !== 200) return fetch(request);
      return new Response("bytes" in result && result.bytes || null, { status: result.status, headers: "type" in result && result.type
        ? { "content-type": result.type, "x-wd-local-asset": "1", "cache-control": "no-store" } : { "cache-control": "no-store" } });
    })());
    return;
  }
  const localProxy = original.origin === worker.location.origin && original.pathname === "/proxy";
  if (original.origin === worker.location.origin && ["/webview", "/webview-worker.js"].includes(original.pathname)) return;
  event.respondWith((async () => {
    const client = await worker.clients.get(event.clientId);
    if (!client) return fetch(request);
    // JVM/compiler Workers have no document renderer context. Their local modules
    // and archives keep the shell fetch path, as before resource URL translation.
    if (original.origin === worker.location.origin && !localProxy && client.type !== "window") return fetch(request);
    // the shell's own page (its Java networking) is no WebView: nothing to rewrite
    if (!client.url.includes("__wd_bridge") && new URL(client.url).pathname === "/") return fetch(request);
    const { page, agent, id, intercept, sub } = await context(client), isolated = !!id;
    const headers = new Headers();
    // client hints describe the host browser, not the WebView the user agent names
    request.headers.forEach((value, name) => { if (!name.startsWith("sec-ch-")) headers.set(name.startsWith("x-wd-") ? name : "x-wd-" + name, value); });
    if (agent) headers.set("x-wd-user-agent", agent);
    // fetch metadata the browser adds past the worker; the frame's fetch of its document is its navigation
    const frame = localProxy && original.searchParams.get("frame") === "1";
    headers.set("x-wd-sec-fetch-mode", frame ? "navigate" : request.mode);
    headers.set("x-wd-sec-fetch-dest", frame ? "document" : request.destination || "empty");
    let target = (localProxy ? original.searchParams.get("url") : request.url)!;
    // A script cached on the renderer can resolve resources against its own URL.
    // Those paths still belong to the document's upstream site, not the DOM owner.
    if (original.origin === worker.location.origin && !localProxy) {
      if (!isolated || !/^https?:/.test(page)) return fetch(request);
      target = new URL(original.pathname + original.search, new URL(page).origin).href;
    }
    if (page && /^https?:/.test(page) && !frame) {
      const source = new URL(page);
      if (request.mode === "cors") headers.set("x-wd-origin", source.origin);
      if (request.referrerPolicy !== "no-referrer") headers.set("x-wd-referer", source.origin === new URL(target).origin ? source.href : source.origin + "/");
    }
    let method = request.method, body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    for (let redirects = 0; redirects <= 20; redirects++) {
      // a browser sends them to secure origins
      for (const [name, value] of clientHints) if (new URL(target).protocol === "https:") headers.set(name, value); else headers.delete(name);
      const include = isolated && (localProxy || request.credentials === "include" || request.credentials === "same-origin" && page && new URL(page).origin === new URL(target).origin);
      headers.delete("x-wd-cookie");
      if (include) {
        const value = await message<string>(client, { kind: "webcookies", url: target });
        if (value) headers.set("x-wd-cookie", value); else headers.delete("x-wd-cookie");
      }
      if (isolated && (frame || request.destination === "script") && !request.integrity) {
        headers.delete("x-wd-if-none-match"); headers.delete("x-wd-if-modified-since");
      }
      const response = await fetch("/proxy?manual=1&url=" + encodeURIComponent(target) + (frame ? "&frame=1" + (sub ? "&sub=1" : "") : "") + (isolated ? "&bridge=" + encodeURIComponent(id) + (intercept && !redirects ? "&intercept=1" : "") : "") + (isolated && !request.integrity && /^https?:/.test(page) ? "&webview=1" : ""), { method, headers, body, credentials: "omit" });
      const values = response.headers.get("x-wd-set-cookie");
      if (include && values) await message(client, { kind: "webcookies", url: target, values: JSON.parse(values) });
      const status = Number(response.headers.get("x-wd-status") || response.status), location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(status) || !location) {
        const clean = new Headers(response.headers);
        clean.delete("x-wd-set-cookie"); clean.delete("x-wd-status");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: clean });
      }
      await response.body?.cancel();
      if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") { method = "GET"; body = undefined; headers.delete("x-wd-content-type"); }
      const next = new URL(location, target).href;
      if (new URL(next).origin !== new URL(target).origin) headers.delete("x-wd-authorization");
      target = next;
    }
    throw Error("Too many WebView redirects");
  })());
});
