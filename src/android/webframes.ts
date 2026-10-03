// The WebView's frames: each WebView's page shows in a DOM frame over the display, on a renderer
// origin, and each subframe the page routes through the app in a renderer frame of its own origin.
// The page's documents talk to the app over the port their load hands them.
import type { JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jentry";
import { device } from "../shell/config";
import { onMain } from "./mainloop";
import { runningApp } from "./apphost";
import { onProcessExit } from "../process-exit";
import type { WebBridge, WebRequest, WebResponse } from "../shell/webbridge";
import { rendererUrl } from "../shell/webrenderer";
import { WEB_FRAME_SANDBOX } from "../shell/webinject";
import { webRenderer } from "./webstorage";
import { releaseFunctor, type Rect } from "./webfunctor";
import { mkError, mkRequest } from "./webrequests";
import { srcdoc, webOrigin, type Entry, type SrcEntry } from "./webnavigation";

// ── the frame layer (shell-owned)
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
  /** the document.cookie last sent, and the page's last write it answers */
  cookies = { ack: 0, sent: "" };
  constructor(readonly sub: boolean, public url: string, readonly win: Window, readonly port: MessagePort) {}
}
/** what a WebView's page holds on the host side, by its frames' windows; it never references the provider itself */
export interface FrameHold { el: HTMLIFrameElement | null; remote: WebBridge | null; frames: Map<Window, RendererFrame>; functor: number; ends: (() => void)[] }
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
const live = new Set<FrameView>();
// a page's renderer ends with its app's process, closing what it held open on its origin
onProcessExit(() => { for (const view of live) release(view.hold); live.clear(); });
// Chromium destroys an AwContents once its WebView is garbage collected (a CleanupReference), so
// an app that drops a WebView without destroy() does not keep its page. Page-side callbacks and the
// bridge therefore reach a provider only weakly; detaching alone keeps the page, as apps reattach.
const collected = new FinalizationRegistry<FrameHold>(release);
/** `view`'s frame, made over the display once the shell has a layer */
export function viewFrame(view: FrameView): HTMLIFrameElement | null {
  if (view.hold.el || !layer) return view.hold.el;
  const el = view.hold.el = document.createElement("iframe");
  el.referrerPolicy = "no-referrer";
  el.setAttribute("sandbox", WEB_FRAME_SANDBOX);
  el.style.cssText = "position:absolute;border:0;pointer-events:auto;transform-origin:top left;transform:scale(var(--wd-web-scale,1));visibility:hidden";
  if (view.background) el.style.background = view.background;
  layer.appendChild(el);
  collected.register(view, view.hold, view.hold);
  live.add(view);
  return el;
}
/** `view`'s frame removed, with everything its page held */
export function dropFrame(view: FrameView) { collected.unregister(view.hold); release(view.hold); live.delete(view); }
/** debug: the canvas capture cannot see frame pixels, so this is how a harness proves a page loaded */
export function webViewInfo(): { url: string | null; title: string; loaded: boolean; progress: number; rect: Rect | null }[] {
  return [...live].map((v) => ({ url: v.url, title: v.title, loaded: v.loaded, progress: v.progress, rect: v.rect }));
}

/** whether `win` is a frame within `main`'s document */
export function inside(win: Window, main: Window): boolean {
  for (let w = win, depth = 0; w !== w.parent && depth < 32; w = w.parent, depth++) if (w.parent === main) return true;
  return false;
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
  private loads = new Map<string, FrameLoad>();
  constructor(private readonly owner: FrameOwner) {}
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
    void this.src(entry, prefetched).then((src) => { if (src) frame.win.location.replace(src); }, () => {});
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
    const origin = await webRenderer(runningApp().pkg, webOrigin(entry)), token = crypto.randomUUID();
    if (hold.remote !== remote) throw new Error("page closed");
    this.loads.set(token, { entry, origin, prefetched });
    if (this.loads.size > 256) this.loads.delete(this.loads.keys().next().value!);
    return rendererUrl(origin, remote.id, token);
  }
}
