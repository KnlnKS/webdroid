export const WEB_INJECT = `<script>(function(){
const id = new URL(location.href).searchParams.get("bridge");
if (!id) { const f = window.frameElement; if (f && f.__wdIfaces) Object.assign(window, f.__wdIfaces); return; }
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
const interfaces = call({kind: "describe"});
for (const [name, methods] of Object.entries(interfaces)) {
  const object = Object.create(null);
  for (const method of methods) object[method] = (...args) => call({kind: "invoke", object: name, method, args});
  Object.defineProperty(window, name, {value: object, configurable: true});
}
const send = data => parent.postMessage({bridge: id, ...data}, "*");
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

export const WEB_FRAME = `<!doctype html><script>
const id = new URL(location.href).searchParams.get("bridge");
addEventListener("message", async event => {
  if (event.source !== parent || event.data?.bridge !== id || event.data.kind !== "load") return;
  try {
    const service = navigator.serviceWorker;
    await service.register("/webview-worker.js");
    await service.ready;
    if (!service.controller) await new Promise(resolve => service.addEventListener("controllerchange", resolve, {once: true}));
    const html = event.data.doc ?? await (await fetch(event.data.src)).text();
    document.open(); document.write(html); document.close();
  } catch { parent.postMessage({bridge: id, kind: "loaded", error: "WebView document transport failed"}, "*"); }
}, {once: true});
parent.postMessage({bridge: id, kind: "ready"}, "*");
</script>`;

export const WEB_PROXY_WORKER = `
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.destination !== "script" || new URL(request.url).origin === self.location.origin) return;
  event.respondWith((async () => {
    const client = await self.clients.get(event.clientId);
    const url = client && new URL(client.url);
    if (!url || (url.pathname !== "/webview" && (url.pathname !== "/proxy" || url.searchParams.get("frame") !== "1"))) return fetch(request);
    return fetch("/proxy?url=" + encodeURIComponent(request.url), { credentials: "omit" });
  })());
});`;
