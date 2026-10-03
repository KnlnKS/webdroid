// The renderer bootstrap: the document every WebView frame first loads on its renderer origin. It
// announces itself to the app's window, which answers with what it is to do over a port: load the
// page (fetched through this origin's proxy worker, or written by the app), or work on the origin's
// storage.
import { holdFrames } from "./frames";
import type { PageConfig } from "./protocol";

/** the page script, as the renderer bootstrap writes it into an apk asset's document */
declare const WEB_INJECT: string;

/** a renderer origin's storage: its quota-managed usage (less this proxy's own worker), or what a
 *  StorageOp deletes. Runs in a frame on that origin. */
async function storageOp(op: string): Promise<{ usage?: number; quota?: number }> {
  if (op === "usage") {
    // the browser keeps an emptied IndexedDB backing store, which the quota manager would delete
    const { usage = 0, quota = 0, usageDetails: details = {} } = await navigator.storage.estimate() as StorageEstimate & { usageDetails?: Record<string, number> };
    const emptied = (await indexedDB.databases()).length ? 0 : details.indexedDB ?? 0;
    return { usage: Math.max(0, usage - (details.serviceWorkerRegistrations ?? 0) - emptied), quota };
  }
  const jobs: Promise<unknown>[] = [];
  for (const { name } of await indexedDB.databases()) if (name) jobs.push(new Promise((done) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = done;
  }));
  const root = await navigator.storage.getDirectory();
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) jobs.push(root.removeEntry(name, { recursive: true }).catch(() => {}));
  if (op !== "origin") localStorage.clear();
  if (op === "all") {
    sessionStorage.clear();
    for (const name of await caches.keys()) jobs.push(caches.delete(name));
    for (const registration of await navigator.serviceWorker.getRegistrations()) jobs.push(registration.unregister());
  }
  await Promise.all(jobs);
  return {};
}

function start() {
  // a frame of the app's own origin would hand its parent's document the app's storage
  try { if (top!.location.href) return; } catch {}
  const params = new URL(location.href).searchParams, id = params.get("__wd_bridge");
  // a subframe's page replaces this document, and its frame shows one load event, that page's
  if (params.has("__wd_sub")) parent.postMessage({ wdFrame: "bootstrap" }, "*");
  // Only the app's realm drives this frame: the nearest ancestor of the top's origin. A page that
  // frames another renderer origin cannot load a document into it or clear its storage.
  const ancestors = location.ancestorOrigins, app = ancestors?.[ancestors.length - 1];
  let owner = parent;
  for (let i = 0; app && i < ancestors.length - 1 && ancestors[i] !== app; i++) owner = owner.parent;
  const post = (data: object) => owner.postMessage({ bridge: id, ...data }, app ?? "*");
  const loaded = async (event: MessageEvent) => {
    try {
      const port = event.ports[0], send = port.postMessage.bind(port), service = navigator.serviceWorker;
      const context: PageConfig = { id, page: params.get("__wd_url"), agent: event.data.userAgent, interfaces: event.data.interfaces, cookies: event.data.cookies,
        clientHints: event.data.clientHints, sharedThread: event.data.sharedThread, intercept: params.get("__wd_intercept") === "1",
        sub: params.has("__wd_sub"), frames: event.data.frames, fonts: event.data.fonts };
      // the document's own response may set cookies before it is written
      const early = (data: { kind?: string; list?: PageConfig["cookies"] } | null) => { if (data?.kind === "cookies") context.cookies = data.list; };
      if (context.sub) port.onmessage = (event) => early(event.data);
      else addEventListener("message", (event) => { if (event.source === owner && event.data?.bridge === id) early(event.data); });
      const stop = Event.prototype.stopImmediatePropagation;
      const controller = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, "controller")!.get!.bind(service);
      service.addEventListener("message", (event) => {
        if (!event.isTrusted || event.source !== controller() || !event.ports[0]) return;
        if (event.data?.kind === "webcontext") {
          stop.call(event); event.ports[0].postMessage(context); event.ports[0].close();
        } else if (event.data?.kind === "webcookies" || event.data?.kind === "webasset") { stop.call(event); send(event.data, [event.ports[0]]); }
      }, { capture: true });
      await service.register("/webview-worker.js");
      await service.ready;
      if (!service.controller) await new Promise((resolve) => service.addEventListener("controllerchange", resolve, { once: true }));
      const response = event.data.doc === undefined ? await fetch(event.data.src, {
        method: event.data.method || "GET", body: event.data.body,
        headers: { "x-wd-user-agent": event.data.userAgent, ...(event.data.contentType ? { "content-type": event.data.contentType } : {}) },
      }) : null;
      const final = response?.headers.get("x-wd-final-url") ?? event.data.final;
      // a redirect to another origin renders in that origin's partition
      if (response && final && /^https?:/.test(context.page ?? "") && new URL(final).origin !== new URL(context.page!).origin) {
        post({ kind: "redirect", url: final, html: await response.text() });
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
      let html: string = event.data.doc ?? await response!.text();
      if (response?.headers.get("x-wd-local-asset") === "1") {
        const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
        html = doctype + WEB_INJECT + html.slice(doctype.length);
      }
      // its frames load through the app: the parser must not start their navigations
      if (context.frames) html = holdFrames(html);
      // a subframe's page talks to the app through its port: its parent is the page that framed it
      (window as { __wdWebView?: PageConfig }).__wdWebView = { ...context, post: context.sub ? send : null,
        listen: context.sub ? (receive) => { port.onmessage = (event) => { if (event.data) receive(event.data); }; } : null };
      document.open(); document.write(html); document.close();
    } catch { post({ kind: "loaded", error: "WebView document transport failed" }); }
  };
  let started = false;
  addEventListener("message", (event) => {
    if (!event.isTrusted || event.source !== owner || app && event.origin !== app || event.data?.bridge !== id || !event.ports[0] || started) return;
    if (event.data.kind === "load") { started = true; void loaded(event); }
    else if (event.data.kind === "storage") {
      started = true;
      const port = event.ports[0];
      storageOp(event.data.op).then((answer) => port.postMessage(answer), () => port.postMessage({}));
    }
  });
  post({ kind: "ready", sub: params.get("__wd_sub") });
}
start();
