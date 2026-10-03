import { installWebHistory } from "./webhistory";
import { installWebLocation } from "./weblocation";
import { snapshotDocument } from "./websnapshot";

export async function webFormRequest(form: HTMLFormElement, submitter: HTMLElement | null, page: string): Promise<
  { url: string; method: "GET" | "POST"; body?: ArrayBuffer; contentType?: string } | null
> {
  const method = (submitter?.getAttribute("formmethod") || form.method).toUpperCase();
  if (method === "DIALOG") return null;
  const action = submitter?.getAttribute("formaction") ?? form.getAttribute("action");
  const url = new URL(action || page || form.ownerDocument.baseURI, form.ownerDocument.baseURI);
  const fields = new FormData(form, submitter);
  if (method === "GET") {
    url.search = "";
    for (const [key, value] of fields) url.searchParams.append(key, typeof value === "string" ? value : value.name);
    return { url: url.href, method: "GET" };
  }
  const encoding = (submitter?.getAttribute("formenctype") || form.enctype).toLowerCase();
  const body = encoding === "multipart/form-data" ? fields
    : encoding === "text/plain" ? [...fields].map(([key, value]) => key + "=" + (typeof value === "string" ? value : value.name)).join("\r\n")
    : new URLSearchParams([...fields].map(([key, value]) => [key, typeof value === "string" ? value : value.name]));
  const request = new Request(url, { method: "POST", body });
  return { url: url.href, method: "POST", contentType: request.headers.get("content-type") ?? undefined,
    body: await request.arrayBuffer() };
}

/** Android WebView's User-Agent Client Hints brands at Chromium `version`, as Chromium's
 *  GenerateBrandVersionList orders them: the GREASE brand and the order follow the major version */
export function webViewBrands(version: string, full: boolean): { brand: string; version: string }[] {
  const major = Number.parseInt(version) || 0, chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const greased = ["8", "99", "24"][major % 3], own = full ? version : String(major);
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][major % 6], list: { brand: string; version: string }[] = [];
  list[order[0]] = { brand: "Not" + chars[major % 11] + "A" + chars[(major + 1) % 11] + "Brand", version: full ? greased + ".0.0.0" : greased };
  list[order[1]] = { brand: "Chromium", version: own };
  list[order[2]] = { brand: "Android WebView", version: own };
  return list;
}

/** the user agent metadata the WebView provider reports: getHighEntropyValues' hints */
export type ClientHints = { brands: { brand: string; version: string }[]; fullVersionList: { brand: string; version: string }[];
  uaFullVersion: string; model: string; platformVersion: string; architecture: string; bitness: string; wow64: boolean; formFactors: string[] };

/** NavigatorUAData over the provider's metadata, in the page */
export function installClientHints(hints: ClientHints): void {
  const low = () => ({ brands: hints.brands.map((b) => ({ ...b })), mobile: true, platform: "Android" });
  const high = ["architecture", "bitness", "formFactors", "fullVersionList", "model", "platformVersion", "uaFullVersion", "wow64"] as const;
  const data = {
    get brands() { return low().brands; },
    mobile: true,
    platform: "Android",
    getHighEntropyValues(asked: Iterable<string>) {
      const values: Record<string, unknown> = low(), wanted = [...asked];
      for (const hint of high) if (wanted.includes(hint)) values[hint] = structuredClone(hints[hint]);
      return Promise.resolve(values);
    },
    toJSON: low,
  };
  Object.defineProperty(navigator, "userAgentData", { value: data, configurable: true, enumerable: true });
}

/** document.cookie's cookies once the page sets `value` at `page`, as the jar will store it: a
 *  cookie it would refuse, or one this document cannot see, is left out */
export function setDocumentCookie(cookies: { text: string; expires: number }[], value: string, page: string): { text: string; expires: number }[] {
  const [pair, ...attributes] = value.split(";"), at = pair.indexOf("=");
  const name = at < 0 ? "" : pair.slice(0, at).trim(), text = at < 0 ? pair.trim() : name + "=" + pair.slice(at + 1).trim();
  const url = new URL(page), path = url.pathname || "/";
  let expires = 0, maxAge = false;
  for (const attribute of attributes) {
    const eq = attribute.indexOf("="), key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase(), v = eq < 0 ? "" : attribute.slice(eq + 1).trim();
    if (key === "max-age" && /^-?\d+$/.test(v)) { maxAge = true; expires = Number(v) <= 0 ? -1 : Date.now() + Number(v) * 1000; }
    else if (key === "expires" && !maxAge && !Number.isNaN(Date.parse(v))) expires = Date.parse(v) <= Date.now() ? -1 : Date.parse(v);
    else if (key === "domain" && v) {
      const domain = v.replace(/^\./, "").toLowerCase();
      if (url.hostname !== domain && !url.hostname.endsWith("." + domain)) return cookies;
    } else if (key === "path" && v.startsWith("/") && !(path === v || path.startsWith(v) && (v.endsWith("/") || path[v.length] === "/"))) return cookies;
    else if (key === "secure" && url.protocol !== "https:" || key === "httponly") return cookies;
  }
  const kept = cookies.filter((c) => (c.text.includes("=") ? c.text.slice(0, c.text.indexOf("=")) : "") !== name);
  return expires < 0 ? kept : [...kept, { text, expires }];
}

export const WEB_INJECT = `<script>(function(){
// Wrangler can insert __name into functions embedded through toString().
const __name = (target, value) => Object.defineProperty(target, "name", {value, configurable: true});
const config = window.__wdWebView;
delete window.__wdWebView;
const ua = config?.agent;
if (ua) {
  Object.defineProperty(navigator, "userAgent", {value: ua});
  Object.defineProperty(navigator, "appVersion", {value: ua.startsWith("Mozilla/") ? ua.slice(8) : ua});
}
if (config?.clientHints) (${installClientHints.toString()})(config.clientHints);
const id = config?.id;
if (!id) return;
// Chromium hands a WebView page's uncaught errors to WebChromeClient.onConsoleMessage; cancelling
// them keeps the embedding page from reporting them as its own exceptions.
const consoleMessage = data => parent.postMessage({bridge: id, kind: "console", ...data}, "*");
{
  addEventListener("error", event => {
    if (!event.isTrusted || !(event instanceof ErrorEvent)) return;
    event.preventDefault();
    consoleMessage({message: event.message, source: event.filename, line: event.lineno});
  });
  addEventListener("unhandledrejection", event => {
    if (!event.isTrusted) return;
    event.preventDefault();
    const reason = event.reason;
    consoleMessage({message: "Uncaught (in promise) " + (reason instanceof Error ? reason.name + ": " + reason.message : String(reason)),
      source: document.URL, line: 0});
  });
}
(${installWebHistory.toString()})(config);
function call(body) {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", location.origin + "/webview-call?id=" + encodeURIComponent(id), false);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.send(JSON.stringify(body));
  if (xhr.status !== 200) throw Error("WebView bridge unavailable: " + xhr.status);
  const result = JSON.parse(xhr.responseText);
  if (result.error) throw Error(result.error);
  return result.value;
}
const send = data => parent.postMessage({bridge: id, ...data}, "*");
// Chromium reports the content's size as it changes: a WebView measured by it lays out again
let width = -1, height = -1;
new ResizeObserver(() => {
  const root = document.documentElement;
  if (root.scrollWidth === width && root.scrollHeight === height) return;
  width = root.scrollWidth; height = root.scrollHeight;
  send({kind: "size", width, height});
}).observe(document.documentElement);
// The renderer may share the app's thread (no site isolation), which cannot answer a synchronous call
// while the page waits. document.cookie reads the cookies the app sends this document; a write
// applies here and reaches the jar in order, whose answer replaces them once it has every write.
let cookies = config.cookies ?? [], written = 0;
const setCookie = (${setDocumentCookie.toString()});
Object.defineProperty(document, "cookie", {
  get: () => cookies.filter(c => !c.expires || c.expires > Date.now()).map(c => c.text).join("; "),
  set: value => {
    value = String(value);
    if (/^https?:/.test(config.page ?? "")) cookies = setCookie(cookies, value, config.page);
    send({kind: "cookie", value, seq: ++written});
  },
});
// A JavaScript interface call is synchronous. Whether the app can answer while the page waits is
// probed once: from a renderer that shares its thread, calls returning nothing are posted and calls
// returning a value cannot be made.
let shared = config.sharedThread;
function sharesThread() {
  if (shared === undefined) {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", location.origin + "/webview-call?timeout=1500&id=" + encodeURIComponent(id), false);
    xhr.send('{"kind":"probe"}');
    if (xhr.status === 200 || xhr.status === 504) send({kind: "thread", shared: shared = xhr.status === 504});
  }
  return shared;
}
for (const [name, methods] of Object.entries(config.interfaces ?? {})) {
  const object = Object.create(null);
  for (const [method, returns] of Object.entries(methods)) object[method] = (...args) => {
    const body = {kind: "invoke", object: name, method, args: JSON.parse(JSON.stringify(args))};
    if (!sharesThread()) return call(body);
    if (returns) throw Error("A WebView JavaScript interface result needs the page in a renderer apart from the app's (site isolation)");
    send(body);
  };
  Object.defineProperty(window, name, {value: object, configurable: true});
}
const formRequest = (${webFormRequest.toString()});
(${installWebLocation.toString()})(config, (url, replace) => send({kind: "navigate", url, replace}));
addEventListener("hashchange", event => { if (event.isTrusted) send({kind: "fragment", url: config.page}); });
window.navigation?.addEventListener("navigate", event => {
  if (!event.cancelable || event.destination.sameDocument || event.hashChange || event.formData || event.downloadRequest) return;
  const url = new URL(event.destination.url);
  if (url.origin === location.origin) return;
  event.preventDefault(); send({kind: "navigate", url: url.href});
});
addEventListener("load", () => send({kind: "loaded", url: config.page ?? document.querySelector('meta[name="wd-proxy-url"]')?.content,
  error: document.querySelector('meta[name="wd-proxy-error"]')?.content, title: document.title,
  width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight}));
document.addEventListener("click", event => {
  const a = event.target.closest?.("a[href]");
  if (!a || /^javascript:/i.test(a.href)) return;
  if (a.hash && a.href.split("#")[0] === document.baseURI.split("#")[0]) return;
  event.preventDefault(); send({kind: "navigate", url: a.href});
}, true);
function submitForm(form, submitter) {
  void formRequest(form, submitter, config.page).then(request => {
    if (request) send({kind: request.method === "GET" ? "navigate" : "submit", ...request});
  });
}
addEventListener("submit", event => {
  if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
  event.preventDefault();
  submitForm(event.target, event.submitter);
});
HTMLFormElement.prototype.submit = function() { submitForm(this, null); };
addEventListener("message", event => {
  if (event.source !== parent || event.data?.bridge !== id) return;
  if (event.data.kind === "eval") {
    let value = "null";
    try { value = JSON.stringify((0, eval)(event.data.script)) ?? "null"; } catch {}
    send({kind: "evaluated", seq: event.data.seq, value});
  } else if (event.data.kind === "stop") window.stop();
  else if (event.data.kind === "cookies" && event.data.ack >= written) cookies = event.data.list;
  else if (event.data.kind === "snapshot") {
    (${snapshotDocument.toString()})(document).then(result => send({kind: "snapshot", seq: event.data.seq, ...result}),
      error => send({kind: "snapshot", seq: event.data.seq, error: String(error)}));
  }
});
send({kind: "script-ready"});
})()</script>`;

/** a WebView frame's sandbox: its own (renderer) origin, and no navigation of the app's window */
export const WEB_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export const WEB_FRAME = `<!doctype html><meta charset="utf-8"><script>(function(){
// a frame of the app's own origin would hand its parent's document the app's storage
try { if (top.location.href) return; } catch {}
const id = new URL(location.href).searchParams.get("__wd_bridge");
addEventListener("message", async event => {
  if (!event.isTrusted || event.source !== parent || event.data?.bridge !== id || event.data.kind !== "load" || !event.ports[0]) return;
  try {
    const port = event.ports[0], send = port.postMessage.bind(port), service = navigator.serviceWorker;
    const context = {id, page: new URL(location.href).searchParams.get("__wd_url"), agent: event.data.userAgent, interfaces: event.data.interfaces,
      cookies: event.data.cookies, clientHints: event.data.clientHints, sharedThread: event.data.sharedThread, intercept: new URL(location.href).searchParams.get("__wd_intercept") === "1"};
    // the document's own response may set cookies before it is written
    addEventListener("message", event => { if (event.source === parent && event.data?.bridge === id && event.data.kind === "cookies") context.cookies = event.data.list; });
    const stop = Event.prototype.stopImmediatePropagation;
    const controller = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, "controller").get.bind(service);
    service.addEventListener("message", event => {
      if (!event.isTrusted || event.source !== controller() || !event.ports[0]) return;
      if (event.data?.kind === "webcontext") {
        stop.call(event); event.ports[0].postMessage(context); event.ports[0].close();
      } else if (event.data?.kind === "webcookies" || event.data?.kind === "webasset") { stop.call(event); send(event.data, [event.ports[0]]); }
    }, {capture: true});
    await service.register("/webview-worker.js");
    await service.ready;
    if (!service.controller) await new Promise(resolve => service.addEventListener("controllerchange", resolve, {once: true}));
    const response = event.data.doc === undefined ? await fetch(event.data.src, {
      method: event.data.method || "GET", body: event.data.body,
      headers: {"x-wd-user-agent": event.data.userAgent, ...(event.data.contentType ? {"content-type": event.data.contentType} : {})},
    }) : null;
    const final = response?.headers.get("x-wd-final-url") ?? event.data.final;
    // a redirect to another origin renders in that origin's partition
    if (response && final && /^https?:/.test(context.page) && new URL(final).origin !== new URL(context.page).origin) {
      parent.postMessage({bridge: id, kind: "redirect", url: final, html: await response.text()}, "*");
      return;
    }
    if (final) {
      const source = new URL(final), local = new URL(location.href);
      local.pathname = source.pathname; local.search = source.search; local.hash = source.hash;
      context.page = final;
      history.replaceState(null, "", local);
    }
    // an android_asset page's relative URLs and its own location.search belong to the asset, not /webview
    if (event.data.doc === undefined && event.data.src?.startsWith("/asset/")) history.replaceState(null, "", event.data.src);
    let html = event.data.doc ?? await response.text();
    if (response?.headers.get("x-wd-local-asset") === "1") {
      const inject = ${JSON.stringify(WEB_INJECT).replace(/</g, "\\u003c")};
      html = /^\\s*<!doctype[^>]*>/i.test(html)
        ? html.replace(/^(\\s*<!doctype[^>]*>)/i, "$1" + inject) : inject + html;
    }
    window.__wdWebView = context;
    document.open(); document.write(html); document.close();
  } catch { parent.postMessage({bridge: id, kind: "loaded", error: "WebView document transport failed"}, "*"); }
}, {once: true});
parent.postMessage({bridge: id, kind: "ready"}, "*");
})()</script>`;

export const WEB_PROXY_WORKER = `
const __name = (target, value) => Object.defineProperty(target, "name", {value, configurable: true});
// Sec-CH-UA's defaults name Android WebView at the host's Chromium, as the page's userAgentData does
const brands = (${webViewBrands.toString()})(self.navigator.userAgentData?.brands?.find(b => b.brand === "Chromium")?.version
  ?? /Chrome\\/(\\d+)/.exec(self.navigator.userAgent)?.[1] ?? "120", false);
const clientHints = [["x-wd-sec-ch-ua", brands.map(b => '"' + b.brand + '";v="' + b.version + '"').join(", ")],
  ["x-wd-sec-ch-ua-mobile", "?1"], ["x-wd-sec-ch-ua-platform", '"Android"']];
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
const contexts = new Map();
function message(client, data) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(Error("WebView client unavailable")); }, 10000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    client.postMessage(data, [channel.port2]);
  });
}
async function context(client) {
  const url = new URL(client.url), config = url.searchParams;
  if (config.has("__wd_bridge")) return {id: config.get("__wd_bridge"), page: config.get("__wd_url"), agent: config.get("__wd_ua"), intercept: config.get("__wd_intercept") === "1"};
  const key = client.id + client.url;
  let value = contexts.get(key);
  if (!value) {
    value = message(client, {kind: "webcontext"}); contexts.set(key, value);
    if (contexts.size > 64) contexts.delete(contexts.keys().next().value);
    value.catch(() => contexts.delete(key));
  }
  return value;
}
self.addEventListener("fetch", event => {
  const request = event.request, original = new URL(request.url);
  if (original.origin === self.location.origin && original.pathname.startsWith("/wd-code/")) {
    event.respondWith(caches.open("wd-code").then(cache => cache.match(request)).then(hit => hit || new Response("", {status: 404})));
    return;
  }
  if (original.origin === self.location.origin && original.pathname.startsWith("/asset/")) {
    event.respondWith((async () => {
      const client = await self.clients.get(event.clientId);
      if (!client) return fetch(request);
      const result = await message(client, {kind: "webasset", path: original.pathname}).catch(() => ({status: 404}));
      if (result.status !== 200) return fetch(request);
      return new Response(result.bytes || null, {status: result.status, headers: result.type
        ? {"content-type": result.type, "x-wd-local-asset": "1", "cache-control": "no-store"} : {"cache-control": "no-store"}});
    })());
    return;
  }
  const localProxy = original.origin === self.location.origin && original.pathname === "/proxy";
  if (original.origin === self.location.origin && !localProxy) return;
  event.respondWith((async () => {
    const client = await self.clients.get(event.clientId);
    if (!client) return fetch(request);
    // the shell's own pages (its Java networking) are no WebView: nothing to rewrite
    if (!client.url.includes("__wd_bridge") && ["/", "/process"].includes(new URL(client.url).pathname)) return fetch(request);
    const {page, agent, id, intercept} = await context(client), isolated = !!id;
    const headers = new Headers();
    // client hints describe the host browser, not the WebView the user agent names
    request.headers.forEach((value, name) => { if (!name.startsWith("sec-ch-")) headers.set(name.startsWith("x-wd-") ? name : "x-wd-" + name, value); });
    if (agent) headers.set("x-wd-user-agent", agent);
    // fetch metadata the browser adds past the worker; the frame's fetch of its document is its navigation
    const frame = localProxy && original.searchParams.get("frame") === "1";
    headers.set("x-wd-sec-fetch-mode", frame ? "navigate" : request.mode);
    headers.set("x-wd-sec-fetch-dest", frame ? "document" : request.destination || "empty");
    let target = localProxy ? original.searchParams.get("url") : request.url;
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
        const value = await message(client, {kind: "webcookies", url: target});
        if (value) headers.set("x-wd-cookie", value); else headers.delete("x-wd-cookie");
      }
      if (isolated && (frame || request.destination === "script") && !request.integrity) {
        headers.delete("x-wd-if-none-match"); headers.delete("x-wd-if-modified-since");
      }
      const response = await fetch("/proxy?manual=1&url=" + encodeURIComponent(target) + (frame ? "&frame=1" : "") + (isolated ? "&bridge=" + encodeURIComponent(id) + (intercept && !redirects ? "&intercept=1" : "") : "") + (isolated && !request.integrity && /^https?:/.test(page) ? "&webview=1" : ""), { method, headers, body, credentials: "omit" });
      const values = response.headers.get("x-wd-set-cookie");
      if (include && values) await message(client, {kind: "webcookies", url: target, values: JSON.parse(values)});
      const status = Number(response.headers.get("x-wd-status") || response.status), location = response.headers.get("location");
      if (![301,302,303,307,308].includes(status) || !location) {
        const clean = new Headers(response.headers);
        clean.delete("x-wd-set-cookie"); clean.delete("x-wd-status");
        return new Response(response.body, {status: response.status, statusText: response.statusText, headers: clean});
      }
      await response.body?.cancel();
      if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") { method = "GET"; body = undefined; headers.delete("x-wd-content-type"); }
      const next = new URL(location, target).href;
      if (new URL(next).origin !== new URL(target).origin) headers.delete("x-wd-authorization");
      target = next;
    }
    throw Error("Too many WebView redirects");
  })());
});`;
