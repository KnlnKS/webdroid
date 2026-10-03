// The page script: the first script of every WebView page's document, on its renderer origin. It
// takes the load's context from the renderer bootstrap (renderer.ts) and gives the page Android
// WebView's navigator, cookies, JavaScript interfaces, subframes, history and location.
import type { DocumentCookie } from "../webcookies";
import { installClientHints } from "./clienthints";
import { setDocumentCookie } from "./cookie";
import { routeSubframes, webFormRequest } from "./frames";
import { installWebHistory } from "./history";
import { installWebLocation } from "./location";
import { snapshotDocument } from "./snapshot";
import type { AppMessage, PageConfig, WebFonts } from "./protocol";

/** the WebView settings' faces, by their families, and the rules that use them, before the page's own */
function installWebFonts(fonts: WebFonts): void {
  for (const f of fonts.faces) document.fonts.add(new FontFace(f.family, `url(${JSON.stringify(location.origin + f.path)})`, { weight: f.weight, style: f.style, stretch: f.stretch }));
  if (!fonts.css) return;
  const style = document.createElement("style");
  style.textContent = fonts.css;
  document.head.insertBefore(style, document.head.firstChild);
}

function start(config: PageConfig | undefined) {
  const ua = config?.agent;
  if (ua) {
    Object.defineProperty(navigator, "userAgent", { value: ua });
    Object.defineProperty(navigator, "appVersion", { value: ua.startsWith("Mozilla/") ? ua.slice(8) : ua });
  }
  if (config?.clientHints) installClientHints(config.clientHints);
  const id = config?.id;
  if (!config || !id) return;
  // a subframe's page reaches the app through its frame's port, a main frame's through its parent
  const send = (data: object, transfer: Transferable[] = []) => config.post
    ? config.post({ bridge: id, ...data }, transfer) : parent.postMessage({ bridge: id, ...data }, "*", transfer);
  const ask = (data: object) => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
    send(data, [channel.port2]);
  });
  if (config.fonts) installWebFonts(config.fonts);
  const subframes = config.frames ? routeSubframes(config.frames, (url, init) => ask({ kind: "subframe", url, ...init })) : null;
  // Chromium hands a WebView page's uncaught errors to WebChromeClient.onConsoleMessage; cancelling
  // them keeps the embedding page from reporting them as its own exceptions.
  const consoleMessage = (data: { message: string; source: string; line: number }) => send({ kind: "console", ...data });
  window.addEventListener("error", (event) => {
    if (!event.isTrusted || !(event instanceof ErrorEvent)) return;
    event.preventDefault();
    consoleMessage({ message: event.message, source: event.filename, line: event.lineno });
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    const reason = event.reason;
    consoleMessage({ message: "Uncaught (in promise) " + (reason instanceof Error ? reason.name + ": " + reason.message : String(reason)),
      source: document.URL, line: 0 });
  });
  installWebHistory(config);
  const call = (body: object) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", location.origin + "/webview-call?id=" + encodeURIComponent(id), false);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(body));
    if (xhr.status !== 200) throw Error("WebView bridge unavailable: " + xhr.status);
    const result = JSON.parse(xhr.responseText);
    if (result.error) throw Error(result.error);
    return result.value;
  };
  // Chromium reports the content's size as it changes: a WebView measured by it lays out again
  let width = -1, height = -1;
  new ResizeObserver(() => {
    const root = document.documentElement;
    if (root.scrollWidth === width && root.scrollHeight === height) return;
    width = root.scrollWidth; height = root.scrollHeight;
    send({ kind: "size", width, height });
  }).observe(document.documentElement);
  // The renderer may share the app's thread (no site isolation), which cannot answer a synchronous call
  // while the page waits. document.cookie reads the cookies the app sends this document; a write
  // applies here and reaches the jar in order, whose answer replaces them once it has every write.
  let cookies = config.cookies ?? [], written = 0;
  Object.defineProperty(document, "cookie", {
    get: () => cookies.filter((c) => !c.expires || c.expires > Date.now()).map((c) => c.text).join("; "),
    set: (value) => {
      value = String(value);
      if (/^https?:/.test(config.page ?? "")) cookies = setDocumentCookie(cookies, value, config.page!);
      send({ kind: "cookie", value, seq: ++written });
    },
  });
  // A JavaScript interface call is synchronous. Whether the app can answer while the page waits is
  // probed once: from a renderer that shares its thread, calls returning nothing are posted and calls
  // returning a value cannot be made.
  let shared = config.sharedThread;
  const sharesThread = () => {
    if (shared === undefined) {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", location.origin + "/webview-call?timeout=1500&id=" + encodeURIComponent(id), false);
      xhr.send('{"kind":"probe"}');
      if (xhr.status === 200 || xhr.status === 504) send({ kind: "thread", shared: shared = xhr.status === 504 });
    }
    return shared;
  };
  for (const [name, methods] of Object.entries(config.interfaces ?? {})) {
    const object = Object.create(null);
    for (const [method, returns] of Object.entries(methods)) object[method] = (...args: unknown[]) => {
      const body = { kind: "invoke", object: name, method, args: JSON.parse(JSON.stringify(args)) };
      if (!sharesThread()) return call(body);
      if (returns) throw Error("A WebView JavaScript interface result needs the page in a renderer apart from the app's (site isolation)");
      send(body);
    };
    Object.defineProperty(window, name, { value: object, configurable: true });
  }
  installWebLocation(config, (url, replace) => send({ kind: "navigate", url, replace }));
  addEventListener("hashchange", (event) => { if (event.isTrusted) send({ kind: "fragment", url: config.page }); });
  type Navigate = Event & { cancelable: boolean; hashChange: boolean; downloadRequest: string | null; formData: FormData | null; destination: { url: string; sameDocument: boolean } };
  (window as { navigation?: EventTarget }).navigation?.addEventListener("navigate", (e) => {
    const event = e as Navigate;
    if (!event.cancelable || event.destination.sameDocument || event.hashChange || event.formData || event.downloadRequest) return;
    const url = new URL(event.destination.url);
    // the parent page's navigation of this frame to where the app routed it
    if (url.origin === location.origin || url.href === (window as unknown as Record<symbol, unknown>)[Symbol.for("wd.routed")]) return;
    event.preventDefault(); send({ kind: "navigate", url: url.href });
  });
  addEventListener("load", () => send({ kind: "loaded", url: config.page ?? document.querySelector<HTMLMetaElement>('meta[name="wd-proxy-url"]')?.content,
    error: document.querySelector<HTMLMetaElement>('meta[name="wd-proxy-error"]')?.content, title: document.title,
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  document.addEventListener("click", (event) => {
    const a = (event.target as Element).closest?.<HTMLAnchorElement>("a[href]");
    if (!a || /^javascript:/i.test(a.href)) return;
    if (a.hash && a.href.split("#")[0] === document.baseURI.split("#")[0]) return;
    event.preventDefault();
    // a link into a frame of the page navigates that frame
    const frame = subframes?.frameFor(a);
    if (frame) subframes!.go(frame, a.href); else send({ kind: "navigate", url: a.href });
  }, true);
  const submitForm = (form: HTMLFormElement, submitter: HTMLElement | null) => {
    const frame = subframes?.frameFor(form, submitter);
    void webFormRequest(form, submitter, config.page).then((request) => {
      if (request && frame) subframes!.go(frame, request.url, request);
      else if (request) send({ kind: request.method === "GET" ? "navigate" : "submit", ...request });
    });
  };
  window.addEventListener("submit", (event) => {
    if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    submitForm(event.target, event.submitter);
  });
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { submitForm(this, null); };
  const receive = (data: AppMessage) => {
    if (data.kind === "eval") {
      let value = "null";
      try { value = JSON.stringify((0, eval)(data.script as string)) ?? "null"; } catch {}
      send({ kind: "evaluated", seq: data.seq, value });
    } else if (data.kind === "stop") window.stop();
    else if (data.kind === "cookies" && (data.ack as number) >= written) cookies = data.list as DocumentCookie[];
    else if (data.kind === "snapshot") {
      snapshotDocument(document).then((result) => send({ kind: "snapshot", seq: data.seq, ...result }),
        (error) => send({ kind: "snapshot", seq: data.seq, error: String(error) }));
    }
  };
  // the app answers a subframe through its port too: its parent is the page that framed it
  if (config.listen) config.listen(receive);
  else addEventListener("message", (event) => { if (event.source === parent && event.data?.bridge === id) receive(event.data); });
  send({ kind: "script-ready" });
}

const scope = window as { __wdWebView?: PageConfig };
const config = scope.__wdWebView;
delete scope.__wdWebView;
start(config);
