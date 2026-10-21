// The renderer origin's service worker: a WebView page's requests go through the app's proxy as the
// WebView's network stack sends them (its user agent, client hints, cookie jar and client), and its
// apk assets and device fonts come from the app.
import { webViewBrands } from "./clienthints.ts";
import { request as ask, type Answers, type RendererContext } from "./protocol.ts";
import { nextHop, parseProxyQuery, proxyPath, readAnswer, writeAnswer, type ProxyRequest } from "./proxywire.ts";

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
/** what the client's renderer bootstrap answers, or the app through it */
const message = <M extends { kind: keyof Answers }>(client: Client, data: M) => ask(data, (m, port) => client.postMessage(m, [port]), 10000);
function context(client: Client): Promise<RendererContext> {
  const key = client.id + client.url;
  let value = contexts.get(key);
  if (!value) {
    value = message(client, { kind: "webcontext" }); contexts.set(key, value);
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
      const result: Answers["webasset"] = await message(client, { kind: "webasset", path: original.pathname }).catch(() => ({ status: 404 }));
      if (result.status !== 200) return fetch(request);
      return new Response(result.bytes || null, { status: result.status, headers: result.type
        ? { "content-type": result.type, "x-wd-local-asset": "1", "cache-control": "no-store" } : { "cache-control": "no-store" } });
    })());
    return;
  }
  const localProxy = original.origin === worker.location.origin && original.pathname === "/proxy";
  const query = localProxy ? parseProxyQuery(original.searchParams) : null;
  // a malformed proxy request is the proxy's to refuse
  if (original.origin === worker.location.origin && ["/webview", "/webview-worker.js"].includes(original.pathname) || localProxy && !query) return;
  event.respondWith((async () => {
    const client = await worker.clients.get(event.clientId);
    // Only a WebView page's renderer document names its bridge (Client.url is the URL it was created at,
    // which replaceState leaves). The shell's page and Workers, under this worker for a local apk's assets,
    // and a page's own Workers have no renderer to ask: they fetch as they are.
    if (!client?.url.includes("__wd_bridge")) return fetch(request);
    const { page, agent, id, intercept, sub } = await context(client), isolated = !!id;
    const headers = new Headers();
    // client hints describe the host browser, not the WebView the user agent names
    request.headers.forEach((value, name) => { if (!name.startsWith("sec-ch-")) headers.set(name.startsWith("x-wd-") ? name : "x-wd-" + name, value); });
    if (agent) headers.set("x-wd-user-agent", agent);
    // fetch metadata the browser adds past the worker; the frame's fetch of its document is its navigation
    const frame = !!query?.frame;
    headers.set("x-wd-sec-fetch-mode", frame ? "navigate" : request.mode);
    headers.set("x-wd-sec-fetch-dest", frame ? "document" : request.destination || "empty");
    let target = query?.url ?? request.url;
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
    let hop: ProxyRequest = { url: target, method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer() };
    for (let redirects = 0; redirects <= 20; redirects++) {
      const { url, headers } = hop;
      // a browser sends them to secure origins
      for (const [name, value] of clientHints) if (new URL(url).protocol === "https:") headers.set(name, value); else headers.delete(name);
      const include = isolated && (localProxy || request.credentials === "include" || request.credentials === "same-origin" && page && new URL(page).origin === new URL(url).origin);
      headers.delete("x-wd-cookie");
      if (include) {
        const value = await message(client, { kind: "webcookies", url });
        if (value) headers.set("x-wd-cookie", value);
      }
      if (isolated && (frame || request.destination === "script") && !request.integrity) {
        headers.delete("x-wd-if-none-match"); headers.delete("x-wd-if-modified-since");
      }
      const response = await fetch(proxyPath({ url, manual: true, frame: frame ? sub ? "sub" : "main" : undefined, bridge: isolated ? id : undefined,
        intercept: isolated && intercept && !redirects, webview: isolated && !request.integrity && /^https?:/.test(page) }),
        { method: hop.method, headers, body: hop.body, credentials: "omit" });
      const answer = readAnswer(response);
      if (include && answer.setCookie.length) await message(client, { kind: "webcookies", url, values: answer.setCookie });
      const next = nextHop(response, hop);
      if (!next) {
        // the page sees the upstream response; the renderer learns where its document landed
        const out = new Headers(answer.headers.filter(([name]) => name !== "set-cookie"));
        if (frame && answer.finalUrl) writeAnswer(out, { finalUrl: answer.finalUrl });
        return new Response(response.body, { status: answer.status, statusText: answer.statusText, headers: out });
      }
      await response.body?.cancel();
      hop = next;
    }
    throw Error("Too many WebView redirects");
  })());
});
