export const WEB_INJECT = `<script>(function(){
const config = new URL(location.href).searchParams, f = window.frameElement;
const ua = config.get("__wd_ua") || f?.__wdUserAgent;
if (ua) {
  Object.defineProperty(navigator, "userAgent", {value: ua});
  Object.defineProperty(navigator, "appVersion", {value: ua.startsWith("Mozilla/") ? ua.slice(8) : ua});
}
const id = config.get("__wd_bridge");
if (!id) { if (f && f.__wdIfaces) Object.assign(window, f.__wdIfaces); return; }
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
window.navigation?.addEventListener("navigate", event => {
  if (!event.cancelable || event.destination.sameDocument || event.hashChange || event.formData || event.downloadRequest) return;
  const url = new URL(event.destination.url);
  if (url.origin === location.origin) return;
  event.preventDefault(); send({kind: "navigate", url: url.href});
});
addEventListener("load", () => send({kind: "loaded", url: document.querySelector('meta[name="wd-proxy-url"]')?.content,
  error: document.querySelector('meta[name="wd-proxy-error"]')?.content, title: document.title, height: document.documentElement.scrollHeight}));
document.addEventListener("click", event => {
  const a = event.target.closest?.("a[href]");
  if (!a || /^javascript:/i.test(a.href)) return;
  if (a.hash && a.href.split("#")[0] === document.baseURI.split("#")[0]) return;
  event.preventDefault(); send({kind: "navigate", url: a.href});
}, true);
addEventListener("message", event => {
  if (event.source !== parent || event.data?.bridge !== id) return;
  if (event.data.kind === "eval") {
    let value = "null";
    try { value = JSON.stringify((0, eval)(event.data.script)) ?? "null"; } catch {}
    send({kind: "evaluated", seq: event.data.seq, value});
  } else if (event.data.kind === "stop") window.stop();
});
})()</script>`;

export const WEB_FRAME = `<!doctype html><script>(function(){
const id = new URL(location.href).searchParams.get("__wd_bridge");
addEventListener("message", async event => {
  if (!event.isTrusted || event.source !== parent || event.data?.bridge !== id || event.data.kind !== "load" || !event.ports[0]) return;
  try {
    const port = event.ports[0], send = port.postMessage.bind(port), service = navigator.serviceWorker;
    const stop = Event.prototype.stopImmediatePropagation;
    const controller = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, "controller").get.bind(service);
    service.addEventListener("message", event => {
      if (!event.isTrusted || event.source !== controller() || event.data?.kind !== "webcookies" || !event.ports[0]) return;
      stop.call(event); send(event.data, [event.ports[0]]);
    }, {capture: true});
    await service.register("/webview-worker.js");
    await service.ready;
    if (!service.controller) await new Promise(resolve => service.addEventListener("controllerchange", resolve, {once: true}));
    const response = event.data.doc === undefined ? await fetch(event.data.src, {headers: {"x-wd-user-agent": event.data.userAgent}}) : null;
    const final = response?.headers.get("x-wd-final-url");
    if (final) {
      const source = new URL(final), local = new URL(location.href);
      local.pathname = source.pathname; local.search = source.search; local.hash = source.hash;
      local.searchParams.set("__wd_bridge", id); local.searchParams.set("__wd_url", final); local.searchParams.set("__wd_ua", event.data.userAgent);
      history.replaceState(null, "", local);
    }
    const html = event.data.doc ?? await response.text();
    document.open(); document.write(html); document.close();
  } catch { parent.postMessage({bridge: id, kind: "loaded", error: "WebView document transport failed"}, "*"); }
}, {once: true});
parent.postMessage({bridge: id, kind: "ready"}, "*");
})()</script>`;

export const WEB_PROXY_WORKER = `
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
function cookies(client, url, values) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(Error("WebView cookie owner unavailable")); }, 10000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    client.postMessage({kind: "webcookies", url, values}, [channel.port2]);
  });
}
self.addEventListener("fetch", event => {
  const request = event.request, original = new URL(request.url);
  const localProxy = original.origin === self.location.origin && original.pathname === "/proxy";
  if (original.origin === self.location.origin && !localProxy) return;
  event.respondWith((async () => {
    const client = await self.clients.get(event.clientId), url = client && new URL(client.url);
    if (!url || (!url.searchParams.has("__wd_bridge") && (url.pathname !== "/proxy" || url.searchParams.get("frame") !== "1"))) return fetch(request);
    const isolated = url.searchParams.has("__wd_bridge");
    const headers = new Headers();
    request.headers.forEach((value, name) => headers.set(name.startsWith("x-wd-") ? name : "x-wd-" + name, value));
    const page = url.searchParams.get(isolated ? "__wd_url" : "url"), agent = url.searchParams.get("__wd_ua");
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
        const value = await cookies(client, target);
        if (value) headers.set("x-wd-cookie", value); else headers.delete("x-wd-cookie");
      }
      const frame = localProxy && original.searchParams.get("frame") === "1";
      const response = await fetch("/proxy?manual=1&url=" + encodeURIComponent(target) + (frame ? "&frame=1" : ""), { method, headers, body, credentials: "omit" });
      const values = response.headers.get("x-wd-set-cookie");
      if (include && values) await cookies(client, target, JSON.parse(values));
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
