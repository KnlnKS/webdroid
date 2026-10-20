// The WebView's frames: each WebView's page shows in a DOM frame over the display, on a renderer
// origin, and each subframe the page routes through the app in a renderer frame of its own origin.
// The page's documents talk to the app over the port their load hands them.
import type { JObj } from "../jvm/runtime.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { device } from "../shell/config.ts";
import { onMain } from "./mainloop.ts";
import { onProcessExit } from "../process-exit.ts";
import type { WebBridge, WebRequest, WebResponse } from "../shell/webbridge.ts";
import { rendererUrl } from "../shell/webrenderer.ts";
import { domWebSurface, type WebSurface, type FrameIdentity } from "../shell/web-surface.ts";
import { webRenderer } from "./webstorage.ts";
import { releaseFunctor, type Rect } from "./webfunctor.ts";
import { mkError, mkRequest } from "./webrequests.ts";
import { srcdoc, webOrigin, type Entry, type SrcEntry } from "./webnavigation.ts";

// ── the frame layer (shell-owned)
let surfaceFactory: (() => WebSurface) | null = null;
export function useWebSurfaces(factory: (() => WebSurface) | null) { surfaceFactory = factory; }
let layer: HTMLElement | null = null;
let layerObserver: ResizeObserver | null = null;
/** the shell's <div> that sits exactly over the canvas; without one every WebView stays inert */
export function setWebLayer(el: HTMLElement) {
  layerObserver?.disconnect();
  layer = el;
  layerObserver = new ResizeObserver(([entry]) => {
    el.style.setProperty("--wd-web-scale", String(entry.contentRect.width * device.density / device.width));
  });
  layerObserver.observe(el);
}

/** a document a WebView's page shows on a renderer origin: its main frame, or a subframe the page
 *  routed there, which talks to the app over `port` */
export class RendererFrame {
  readonly sub: boolean; url: string; readonly win: FrameIdentity; readonly port: MessagePort;
  /** the document.cookie last sent, and the page's last write it answers */
  cookies = { ack: 0, sent: "" };
  constructor(sub: boolean, url: string, win: FrameIdentity, port: MessagePort) { this.sub = sub; this.url = url; this.win = win; this.port = port; }
}
/** what a WebView's page holds on the host side, by its frames' windows; it never references the provider itself */
export interface FrameHold { el: WebSurface | null; remote: WebBridge | null; frames: Map<FrameIdentity, RendererFrame>; functor: number; ends: (() => void)[] }
/** what the frame layer reads of a WebView */
export interface FrameView { readonly hold: FrameHold; url: string | null; title: string; loaded: boolean; progress: number; rect: Rect | null; background: string | null }
/** a page's end: its bridge, what it watched and its frames' ports */
export function unbridge(h: FrameHold) {
  h.remote?.close(); h.remote = null;
  for (const end of h.ends.splice(0)) end();
  for (const frame of h.frames.values()) frame.port.close();
  h.frames.clear();
}
function release(h: FrameHold) { unbridge(h); h.el?.remove(); h.el = null; releaseFunctor(h.functor); }
/** the views with a frame */
const live = new Map<FrameHold, WeakRef<FrameView>>();
// a page's renderer ends with its app's process, closing what it held open on its origin
onProcessExit(() => { for (const hold of live.keys()) release(hold); live.clear(); });
// Chromium destroys an AwContents once its WebView is garbage collected (a CleanupReference), so
// an app that drops a WebView without destroy() does not keep its page. Page-side callbacks and the
// bridge therefore reach a provider only weakly; detaching alone keeps the page, as apps reattach.
const collected = new FinalizationRegistry<FrameHold>(hold => { live.delete(hold); release(hold); });
/** `view`'s frame, made over the display once the shell has a layer */
export function viewFrame(view: FrameView): WebSurface | null {
  if (view.hold.el || !layer && !surfaceFactory) return view.hold.el;
  const el = view.hold.el = surfaceFactory ? surfaceFactory() : domWebSurface(layer!);
  if (view.background) el.style({background:view.background});
  collected.register(view, view.hold, view.hold);
  live.set(view.hold, new WeakRef(view));
  return el;
}
/** `view`'s frame removed, with everything its page held */
export function dropFrame(view: FrameView) { collected.unregister(view.hold); release(view.hold); live.delete(view.hold); }
/** debug: the canvas capture cannot see frame pixels, so this is how a harness proves a page loaded */
export function webViewInfo(): { url: string | null; title: string; loaded: boolean; progress: number; rect: Rect | null }[] {
  return [...live.values()].flatMap(ref => {
    const v = ref.deref();
    return v ? [{ url: v.url, title: v.title, loaded: v.loaded, progress: v.progress, rect: v.rect }] : [];
  });
}

/** `value` as the answer on `port`, its only one */
export const reply = (port: MessagePort, value: unknown) => { port.postMessage(value); port.close(); };

/** a document a renderer frame is to load: its entry, the renderer origin, and a redirect's document */
export interface FrameLoad { entry: Entry; origin: string; prefetched?: string }
/** what routing a page's subframes reads of its WebView */
export interface FrameOwner {
  readonly client: JObj; readonly view: JObj; readonly hold: FrameHold; readonly intercepting: boolean;
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
  /** a subframe's own navigation, which stays in it */
  navigate(frame: RendererFrame, entry: SrcEntry, prefetched?: string) {
    void this.src(entry, prefetched).then((src) => { if (src) this.owner.hold.el?.replace(frame.win, src); }, () => {});
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
    const { hold } = this.owner, remote = hold.remote;
    if (!remote) throw new Error("no page");
    const origin = await webRenderer(webOrigin(entry)), token = crypto.randomUUID();
    if (hold.remote !== remote) throw new Error("page closed");
    this.loads.set(token, { entry, origin, prefetched });
    if (this.loads.size > 256) this.loads.delete(this.loads.keys().next().value!);
    return rendererUrl(origin, remote.id, token);
  }
}
