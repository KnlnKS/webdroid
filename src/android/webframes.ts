// The WebView's frames: each WebView's page shows in a DOM frame over the display, on a renderer
// origin, and each subframe the page routes through the app in a renderer frame of its own origin.
// The page's documents talk to the app over the port their load hands them.
import type { JObj } from "../jvm/runtime.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { onMain } from "./mainloop.ts";
import { onProcessExit } from "../process-exit.ts";
import type { WebBridge } from "../shell/webbridge.ts";
import type { AppMessage, DocumentCookie, PageMessage, WebRequest, WebResponse } from "../shell/webpage/protocol.ts";
import { rendererUrl } from "../shell/webrenderer.ts";
import type { WebSurface, FrameIdentity } from "../shell/web-surface.ts";
import { webRenderer } from "./webstorage.ts";
import { releaseFunctor, type Rect } from "./webfunctor.ts";
import { mkError, mkRequest } from "./webrequests.ts";
import { srcEntry, srcdoc, webOrigin, type Entry, type SrcEntry } from "./webnavigation.ts";

// ── the frame layer, on the page that owns the process; without it every WebView stays inert
let surfaceFactory: (() => WebSurface) | null = null;
export function useWebSurfaces(factory: (() => WebSurface) | null) { surfaceFactory = factory; }

/** a document a WebView's page shows on a renderer origin: its main frame, or a subframe the page
 *  routed there, which talks to the app over `port` */
export class RendererFrame {
  readonly sub: boolean; url: string; readonly win: FrameIdentity; readonly port: MessagePort;
  /** the document.cookie last sent, and the page's last write it answers */
  private sentCookies = ""; private ack = 0;
  constructor(sub: boolean, url: string, win: FrameIdentity, port: MessagePort) { this.sub = sub; this.url = url; this.win = win; this.port = port; }
  /** the cookies its document loads with */
  loadedCookies(list: DocumentCookie[]) { this.sentCookies = JSON.stringify(list); }
  /** its document.cookie, when it changed or answers the page's write `seq` */
  pushCookies(list: DocumentCookie[], seq?: number) {
    const sent = JSON.stringify(list);
    if (seq === undefined && sent === this.sentCookies) return;
    if (seq !== undefined) this.ack = seq;
    this.sentCookies = sent;
    this.port.postMessage({ kind: "cookies", list, ack: this.ack } satisfies AppMessage);
  }
}
/** What a WebView's page holds on the host side: its frame over the display, the bridge of the page it
 *  shows, that page's renderer frames by their windows, and what it watches. It never references the
 *  provider, whose collection releases it. */
export class PageHost {
  surface: WebSurface | null = null;
  bridge: WebBridge | null = null;
  readonly frames = new Map<FrameIdentity, RendererFrame>();
  private ends: (() => void)[] = [];
  readonly functor: number;
  constructor(functor: number) { this.functor = functor; }
  /** a page on `bridge`, which ends what `ends` stop */
  open(bridge: WebBridge, ...ends: (() => void)[]) { this.bridge = bridge; this.ends.push(...ends); }
  /** the page's end: its bridge, what it watched and its frames' ports */
  close() {
    this.bridge?.close(); this.bridge = null;
    for (const end of this.ends.splice(0)) end();
    for (const frame of this.frames.values()) frame.port.close();
    this.frames.clear();
  }
  release() { this.close(); this.surface?.remove(); this.surface = null; releaseFunctor(this.functor); }
  /** `frame` in place of what its window showed */
  adopt(frame: RendererFrame) { this.frames.get(frame.win)?.port.close(); this.frames.set(frame.win, frame); }
  /** whether `frame` still shows in its window */
  holds(frame: RendererFrame) { return this.frames.get(frame.win) === frame; }
  main(): RendererFrame | undefined { for (const frame of this.frames.values()) if (!frame.sub) return frame; }
}
/** what the frame layer reads of a WebView */
export interface FrameView { readonly host: PageHost; url: string | null; title: string; loaded: boolean; progress: number; rect: Rect | null; background: string | null }
/** the views with a frame */
const live = new Map<PageHost, WeakRef<FrameView>>();
// a page's renderer ends with its app's process, closing what it held open on its origin
onProcessExit(() => { for (const host of live.keys()) host.release(); live.clear(); });
// Chromium destroys an AwContents once its WebView is garbage collected (a CleanupReference), so
// an app that drops a WebView without destroy() does not keep its page. Page-side callbacks and the
// bridge therefore reach a provider only weakly; detaching alone keeps the page, as apps reattach.
const collected = new FinalizationRegistry<PageHost>(host => { live.delete(host); host.release(); });
/** `view`'s frame, made over the display once the page gives this process a layer */
export function viewFrame(view: FrameView): WebSurface | null {
  const { host } = view;
  if (host.surface || !surfaceFactory) return host.surface;
  const el = host.surface = surfaceFactory();
  if (view.background) el.style({background:view.background});
  collected.register(view, host, host);
  live.set(host, new WeakRef(view));
  return el;
}
/** `view`'s frame removed, with everything its page held */
export function dropFrame({ host }: FrameView) { collected.unregister(host); host.release(); live.delete(host); }
/** debug: the canvas capture cannot see frame pixels, so this is how a harness proves a page loaded */
export function webViewInfo(): { url: string | null; title: string; loaded: boolean; progress: number; rect: Rect | null }[] {
  return [...live.values()].flatMap(ref => {
    const v = ref.deref();
    return v ? [{ url: v.url, title: v.title, loaded: v.loaded, progress: v.progress, rect: v.rect }] : [];
  });
}

/** a document a renderer frame is to load: its entry, the renderer origin, and a redirect's document */
export interface FrameLoad { entry: Entry; origin: string; prefetched?: string }
/** what routing a page's subframes reads of its WebView */
export interface FrameOwner {
  readonly client: JObj; readonly view: JObj; readonly host: PageHost; readonly intercepting: boolean;
  intercept(request: WebRequest): Promise<WebResponse | null>;
}
/** the subframes a WebView's page loads through the app, by the token in their renderer URL */
export class Subframes {
  private readonly owner: FrameOwner;
  private loads = new Map<string, FrameLoad>();
  constructor(owner: FrameOwner) { this.owner = owner; }
  get(token: string) { return this.loads.get(token); }
  clear() { this.loads.clear(); }
  /** Chromium's navigation throttle offers a subframe navigation of any scheme but http(s), about: and
   *  javascript: to shouldOverrideUrlLoading. Then a blob: loads; any other goes to shouldInterceptRequest
   *  (as http(s) does through the proxy), whose response loads; otherwise a data: URL loads and an
   *  unknown scheme fails with ERR_UNKNOWN_URL_SCHEME and an error page. Answers where the frame
   *  loads: a renderer, the URL itself, or nowhere. */
  async src(entry: SrcEntry, prefetched?: string): Promise<string | null> {
    const { client, view } = this.owner;
    if (/^https?:/i.test(entry.url)) return this.open(entry, prefetched);
    const request = mkRequest(entry.url);
    request.main = false;
    if (await onMain(() => vcall(client, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z", view, request))) return null;
    if (/^blob:/i.test(entry.url)) return entry.url;
    if (entry.src !== entry.url) return this.open(entry);
    const response = this.owner.intercepting ? await this.owner.intercept({ url: entry.url, method: "GET", main: false, headers: {} }) : null;
    if (response) return this.intercepted(entry.url, response);
    if (/^data:/i.test(entry.url)) return entry.url;
    const error = mkError(-10, "net::ERR_UNKNOWN_URL_SCHEME");
    void onMain(() => vcall(client, "onReceivedError", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V", view, request, error));
    // in place of Chromium's error page: a document the page cannot read, with its load event
    return "data:text/html,";
  }
  /** what a subframe's page tells the app of itself: where it loaded, and its navigations, which stay in it */
  message(frame: RendererFrame, m: PageMessage) {
    switch (m.kind) {
      case "loaded": if (m.url !== null) frame.url = m.url; break;
      case "navigate": if (!/^javascript:/i.test(m.url)) this.navigate(frame, srcEntry(m.url)); break;
      case "submit": this.navigate(frame, srcEntry(m.url, m.init)); break;
      // the document is another origin's: it renders in that origin's partition
      case "redirect": this.navigate(frame, srcEntry(m.url), m.html); break;
    }
  }
  private navigate(frame: RendererFrame, entry: SrcEntry, prefetched?: string) {
    void this.src(entry, prefetched).then((src) => { if (src) this.owner.host.surface?.replace(frame.win, src); }, () => {});
  }
  /** a client's response for a subframe: an HTML document on the opaque renderer, which carries the
   *  page script, or the bytes as they are */
  private intercepted(url: string, response: WebResponse): Promise<string> | string {
    const type = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "text/html";
    if (!/^\s*text\/html\b/i.test(type)) return "data:" + type.replace(/\s+/g, "") + ";base64," + response.body;
    const bytes = Uint8Array.fromBase64(response.body), charset = /charset=([^;\s]+)/i.exec(type)?.[1] ?? "utf-8";
    let html: string;
    try { html = new TextDecoder(charset).decode(bytes); } catch { html = new TextDecoder().decode(bytes); }
    return this.open({ url, doc: srcdoc(html, null, /^data:/i.test(url) ? null : url) });
  }
  /** the renderer document a subframe of `entry` loads, on its web origin's renderer */
  private async open(entry: Entry, prefetched?: string): Promise<string> {
    const { host } = this.owner, bridge = host.bridge;
    if (!bridge) throw new Error("no page");
    const origin = await webRenderer(webOrigin(entry)), token = crypto.randomUUID();
    if (host.bridge !== bridge) throw new Error("page closed");
    this.loads.set(token, { entry, origin, prefetched });
    if (this.loads.size > 256) this.loads.delete(this.loads.keys().next().value!);
    return rendererUrl(origin, bridge.id, token);
  }
}
