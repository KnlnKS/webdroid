// The renderer bootstrap: the document every WebView frame first loads on its renderer origin. It
// announces itself to the app's window, which hands it its task and a port: load the page (fetched
// through this origin's proxy worker, or written by the app), or work on the origin's storage.
import { holdFrames } from "./frames.ts";
import { withPageScript, type AppMessage, type LoadMessage, type PageConfig, type PageMessage, type RendererContext, type RendererReady, type RendererTask,
  type StorageOp } from "./protocol.ts";

/** the page script, as the renderer bootstrap writes it into an apk asset's document */
declare const WEB_INJECT: string;

// the types Blink shows (blink/common/mime_util): text but these, its images, media, and the XML,
// JSON and script types. WebView has no plugins, a PDF viewer among them.
const UNSHOWN_TEXT = /^text\/(?:(?:x-)?v?calendar|(?:x-)?vcard|directory|ldif|(?:x-)?qif|x-csv|x-vcf|rtf|comma-separated-values|csv|tab-separated-values|tsv|ofx|vnd\.sun\.j2me\.app-descriptor)$/;
const SHOWN = /^(?:text\/.*|image\/(?:jpeg|pjpeg|jpg|webp|png|apng|gif|bmp|vnd\.microsoft\.icon|x-icon|x-xbitmap|x-png|avif|svg\+xml)|(?:audio|video)\/.*|application\/(?:xhtml\+xml|xml|atom\+xml|rss\+xml|json|(?:x-)?(?:java|ecma)script|[^/]*\+json))$/;
/** whether a frame's response is a download, as Chromium's navigation decides it: an attachment
 *  (an unknown disposition type is one), or a successful response of a type Blink cannot show */
function isDownload(response: Response): boolean {
  const disposition = /^\s*([^\s;=]+)\s*(?:;|$)/.exec(response.headers.get("content-disposition") ?? "")?.[1].toLowerCase();
  if (disposition && disposition !== "inline") return true;
  const mime = mimeOf(response);
  return !!mime && response.ok && (!SHOWN.test(mime) || UNSHOWN_TEXT.test(mime));
}
const mimeOf = (response: Response) => (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

/** a renderer origin's storage: its quota-managed usage (less this proxy's own worker), or what a
 *  StorageOp deletes. Runs in a frame on that origin. */
async function storageOp(op: StorageOp): Promise<{ usage?: number; quota?: number }> {
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
  const params = new URL(location.href).searchParams, id = params.get("__wd_bridge"), sub = params.get("__wd_sub");
  // a subframe's page replaces this document, and its frame shows one load event, that page's
  if (sub !== null) parent.postMessage({ wdFrame: "bootstrap" }, "*");
  // Only the app's realm drives this frame: the nearest ancestor of the top's origin. A page that
  // frames another renderer origin cannot load a document into it or clear its storage.
  const ancestors = location.ancestorOrigins, app = ancestors?.[ancestors.length - 1];
  let owner = parent;
  for (let i = 0; app && i < ancestors.length - 1 && ancestors[i] !== app; i++) owner = owner.parent;
  // the page the app loads here, and everything it and the worker tell the app, go over `port`
  const load = async (task: LoadMessage, port: MessagePort) => {
    const send = (message: PageMessage) => port.postMessage(message), doc = task.document;
    try {
      const service = navigator.serviceWorker;
      const context: RendererContext = { id: id!, page: task.page, agent: task.userAgent, interfaces: task.interfaces, cookies: task.cookies,
        clientHints: task.clientHints, sharedThread: task.sharedThread, intercept: task.intercept, sub: sub !== null, frames: task.frames, fonts: task.fonts };
      // the document's own response may set cookies before it is written
      port.onmessage = ({ data }: MessageEvent<AppMessage>) => { if (data.kind === "cookies") context.cookies = data.list; };
      const stop = Event.prototype.stopImmediatePropagation;
      const controller = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, "controller")!.get!.bind(service);
      service.addEventListener("message", (event) => {
        if (!event.isTrusted || event.source !== controller() || !event.ports[0]) return;
        if (event.data?.kind === "webcontext") {
          stop.call(event); event.ports[0].postMessage(context); event.ports[0].close();
        } else if (event.data?.kind === "webcookies" || event.data?.kind === "webasset") { stop.call(event); port.postMessage(event.data, [event.ports[0]]); }
      }, { capture: true });
      await service.register("/webview-worker.js");
      await service.ready;
      if (!service.controller) await new Promise((resolve) => service.addEventListener("controllerchange", resolve, { once: true }));
      const response = "src" in doc ? await fetch(doc.src, {
        method: doc.init?.method || "GET", body: doc.init?.body,
        headers: { "x-wd-user-agent": task.userAgent, ...(doc.init?.contentType ? { "content-type": doc.init.contentType } : {}) },
      }) : null;
      const final = response?.headers.get("x-wd-final-url") ?? ("html" in doc ? doc.final : undefined);
      // A download commits no document: the app's DownloadListener takes it. Chromium keeps the frame's
      // previous page, which this frame has left; it shows an empty one, whose load ends the app's.
      if (response && isDownload(response)) {
        void response.body?.cancel();
        const url = final ?? context.page, length = Number(response.headers.get("x-wd-content-length") ?? response.headers.get("content-length") ?? -1);
        send({ kind: "download", url, disposition: response.headers.get("content-disposition") ?? "", mime: mimeOf(response),
          length: Number.isSafeInteger(length) && length >= 0 ? length : -1 });
        send({ kind: "loaded", url, title: "", error: null, width: 0, height: 0 });
        return;
      }
      // a redirect to another origin renders in that origin's partition
      if (response && final && /^https?:/.test(context.page) && new URL(final).origin !== new URL(context.page).origin) {
        send({ kind: "redirect", url: final, html: await response.text() });
        return;
      }
      if (final) {
        const source = new URL(final), local = new URL(location.href);
        local.pathname = source.pathname; local.search = source.search; local.hash = source.hash;
        context.page = final;
        history.replaceState(null, "", local);
      }
      // an android_asset page's relative URLs and its own location.search belong to the asset, not /webview
      if ("src" in doc && doc.src.startsWith("/asset/")) history.replaceState(null, "", doc.src);
      let html = "html" in doc ? doc.html : await response!.text();
      if (response?.headers.get("x-wd-local-asset") === "1") html = withPageScript(html, WEB_INJECT);
      // its frames load through the app: the parser must not start their navigations
      if (context.frames) html = holdFrames(html);
      (window as { __wdWebView?: PageConfig }).__wdWebView = { ...context, port };
      document.open(); document.write(html); document.close();
    } catch { send({ kind: "loaded", url: null, title: "", error: "WebView document transport failed", width: 0, height: 0 }); }
  };
  let started = false;
  addEventListener("message", (event: MessageEvent<RendererTask & { bridge?: unknown }>) => {
    const port = event.ports[0];
    if (!event.isTrusted || event.source !== owner || app && event.origin !== app || event.data?.bridge !== id || !port || started) return;
    if (event.data.kind === "load") { started = true; void load(event.data, port); }
    else if (event.data.kind === "storage") {
      started = true;
      storageOp(event.data.op).then((answer) => port.postMessage(answer), () => port.postMessage({}));
    }
  });
  owner.postMessage({ kind: "ready", bridge: id, sub } satisfies RendererReady, app ?? "*");
}
start();
