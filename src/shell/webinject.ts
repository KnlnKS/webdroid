import { installWebHistory } from "./webhistory";
import { installWebLocation } from "./weblocation";

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

export const WEB_INJECT = `<script>(function(){
// Wrangler can insert __name into functions embedded through toString().
const __name = (target, value) => Object.defineProperty(target, "name", {value, configurable: true});
const config = window.__wdWebView, f = window.frameElement;
delete window.__wdWebView;
const ua = config?.agent || f?.__wdUserAgent;
if (ua) {
  Object.defineProperty(navigator, "userAgent", {value: ua});
  Object.defineProperty(navigator, "appVersion", {value: ua.startsWith("Mozilla/") ? ua.slice(8) : ua});
}
const id = config?.id;
if (!id) { if (f && f.__wdIfaces) Object.assign(window, f.__wdIfaces); return; }
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
Object.defineProperty(document, "cookie", {get: () => call({kind: "cookie"}), set: value => call({kind: "cookie", value: String(value)})});
const interfaces = call({kind: "describe"});
for (const [name, methods] of Object.entries(interfaces)) {
  const object = Object.create(null);
  for (const method of methods) object[method] = (...args) => call({kind: "invoke", object: name, method, args});
  Object.defineProperty(window, name, {value: object, configurable: true});
}
const send = data => parent.postMessage({bridge: id, ...data}, "*");
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
  error: document.querySelector('meta[name="wd-proxy-error"]')?.content, title: document.title, height: document.documentElement.scrollHeight}));
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
});
send({kind: "script-ready"});
})()</script>`;

export const WEB_FRAME = `<!doctype html><meta charset="utf-8"><script>(function(){
const id = new URL(location.href).searchParams.get("__wd_bridge");
addEventListener("message", async event => {
  if (!event.isTrusted || event.source !== parent || event.data?.bridge !== id || event.data.kind !== "load" || !event.ports[0]) return;
  try {
    const port = event.ports[0], send = port.postMessage.bind(port), service = navigator.serviceWorker;
    const context = {id, page: new URL(location.href).searchParams.get("__wd_url"), agent: event.data.userAgent, intercept: new URL(location.href).searchParams.get("__wd_intercept") === "1"};
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
    const final = response?.headers.get("x-wd-final-url");
    if (final) {
      const source = new URL(final), local = new URL(location.href);
      local.pathname = source.pathname; local.search = source.search; local.hash = source.hash;
      context.page = final;
      history.replaceState(null, "", local);
    }
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
  if (url.pathname === "/proxy" && config.get("frame") === "1") return {page: config.get("url")};
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
    const {page, agent, id, intercept} = await context(client), isolated = !!id;
    const headers = new Headers();
    request.headers.forEach((value, name) => headers.set(name.startsWith("x-wd-") ? name : "x-wd-" + name, value));
    if (agent) headers.set("x-wd-user-agent", agent);
    let target = localProxy ? original.searchParams.get("url") : request.url;
    if (page && /^https?:/.test(page)) {
      const source = new URL(page);
      if (request.mode === "cors") headers.set("x-wd-origin", source.origin);
      if (request.referrerPolicy !== "no-referrer") headers.set("x-wd-referer", source.origin === new URL(target).origin ? source.href : source.origin + "/");
    }
    let method = request.method, body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    for (let redirects = 0; redirects <= 20; redirects++) {
      const include = isolated && (localProxy || request.credentials === "include" || request.credentials === "same-origin" && page && new URL(page).origin === new URL(target).origin);
      headers.delete("x-wd-cookie");
      if (include) {
        const value = await message(client, {kind: "webcookies", url: target});
        if (value) headers.set("x-wd-cookie", value); else headers.delete("x-wd-cookie");
      }
      const frame = localProxy && original.searchParams.get("frame") === "1";
      if (isolated && (frame || request.destination === "script") && !request.integrity) {
        headers.delete("x-wd-if-none-match"); headers.delete("x-wd-if-modified-since");
      }
      const response = await fetch("/proxy?manual=1&url=" + encodeURIComponent(target) + (frame ? "&frame=1" : "") + (isolated && intercept && !redirects ? "&bridge=" + encodeURIComponent(id) : "") + (isolated && !request.integrity && /^https?:/.test(page) ? "&webview=1" : ""), { method, headers, body, credentials: "omit" });
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
