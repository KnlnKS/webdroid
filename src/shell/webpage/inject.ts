// The page script: the first script of every WebView page's document, on its renderer origin. It
// takes the load's context from the renderer bootstrap (renderer.ts) and gives the page Android
// WebView's navigator, cookies, JavaScript interfaces, subframes, history and location.
import { installClientHints } from "./clienthints.ts";
import { setDocumentCookie } from "./cookie.ts";
import { routeSubframes } from "./frames.ts";
import { installWebHistory } from "./history.ts";
import { installWebLocation } from "./location.ts";
import { snapshotDocument } from "./snapshot.ts";
import { request, respond, type AppMessage, type BridgeReply, type PageConfig, type PageMessage, type WebFonts } from "./protocol.ts";

/** the WebView settings' faces, by their families, and the rules that use them, before the page's own */
function installWebFonts(fonts: WebFonts): void {
  for (const f of fonts.faces) document.fonts.add(new FontFace(f.family, `url(${JSON.stringify(location.origin + f.path)})`, { weight: f.weight, style: f.style, stretch: f.stretch }));
  if (!fonts.css) return;
  const style = document.createElement("style");
  style.textContent = fonts.css;
  document.head.insertBefore(style, document.head.firstChild);
}

function start(config: PageConfig | undefined) {
  const ua = config?.userAgent;
  if (ua) {
    Object.defineProperty(navigator, "userAgent", { value: ua });
    Object.defineProperty(navigator, "appVersion", { value: ua.startsWith("Mozilla/") ? ua.slice(8) : ua });
  }
  if (config?.clientHints) installClientHints(config.clientHints);
  if (!config?.id) return;
  const { id, port } = config, send = (message: PageMessage) => port.postMessage(message);
  if (config.fonts) installWebFonts(config.fonts);
  // the page's links, forms and navigations: into a frame of the page, where the app answers, or to the app
  if (config.frames) routeSubframes(config.frames, (url, init) => request({ kind: "subframe", url, init }, (m, answer) => port.postMessage(m, [answer])),
    () => config.page, (url, init) => send(init?.method === "POST" ? { kind: "submit", url, init } : { kind: "navigate", url, replace: false }));
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
    const result = JSON.parse(xhr.responseText) as BridgeReply;
    if ("error" in result) throw Error(result.error);
    return "value" in result ? result.value : undefined;
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
    configurable: true,
    get: () => cookies.filter((c) => !c.expires || c.expires > Date.now()).map((c) => c.text).join("; "),
    set: (value) => {
      value = String(value);
      if (/^https?:/.test(config.page)) cookies = setDocumentCookie(cookies, value, config.page);
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
      const body: PageMessage = { kind: "invoke", object: name, method, args: JSON.parse(JSON.stringify(args)) };
      if (!sharesThread()) return call(body);
      if (returns) throw Error("A WebView JavaScript interface result needs the page in a renderer apart from the app's (site isolation)");
      send(body);
    };
    Object.defineProperty(window, name, { value: object, configurable: true });
  }
  installWebLocation(config, (url, replace) => send({ kind: "navigate", url, replace }));
  addEventListener("hashchange", (event) => { if (event.isTrusted) send({ kind: "fragment", url: config.page }); });
  addEventListener("load", () => send({ kind: "loaded", url: config.page ?? document.querySelector<HTMLMetaElement>('meta[name="wd-proxy-url"]')?.content ?? null,
    error: document.querySelector<HTMLMetaElement>('meta[name="wd-proxy-error"]')?.content ?? null, title: document.title,
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  // what the app asks of the page, answered on the port that comes with it
  port.onmessage = ({ data, ports: [answer] }: MessageEvent<AppMessage>) => {
    if (data.kind === "eval") {
      let value = "null";
      try { value = JSON.stringify((0, eval)(data.script)) ?? "null"; } catch {}
      if (answer) respond(data, answer, value);
    } else if (data.kind === "stop") window.stop();
    else if (data.kind === "cookies") { if (data.ack >= written) cookies = data.list; }
    else if (data.kind === "snapshot" && answer) snapshotDocument(document).then((result) => respond(data, answer, result), (error) => respond(data, answer, { error: String(error) }));
  };
  send({ kind: "script-ready" });
}

const scope = window as { __wdWebView?: PageConfig };
const config = scope.__wdWebView;
delete scope.__wdWebView;
start(config);
