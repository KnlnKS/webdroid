// Runs before any script of a document a WebView frame loads. The dev server injects it into
// proxied and asset HTML, srcdoc documents prepend it: the JavaScript interfaces a WebView
// declares are parked on its <iframe> element, which a same-origin child reaches as frameElement.
export const WEB_INJECT = "<script>(function(){var f=window.frameElement;if(f&&f.__wdIfaces)Object.assign(window,f.__wdIfaces)})()</script>";

export const WEB_PROXY_WORKER = `
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.destination !== "script" || new URL(request.url).origin === self.location.origin) return;
  event.respondWith((async () => {
    const client = await self.clients.get(event.clientId);
    const url = client && new URL(client.url);
    if (!url || url.pathname !== "/proxy" || url.searchParams.get("frame") !== "1") return fetch(request);
    return fetch("/proxy?url=" + encodeURIComponent(request.url), { credentials: "omit" });
  })());
});`;
