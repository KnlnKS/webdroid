// WebViews occupy DOM frames above the canvas. JavaScript interfaces use a separate renderer
// so synchronous page calls can wait while the Java runtime continues executing.

import { rt, JObj, type NativeSpec, type ClassInfo, stubs, noops, fieldGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { mangleMethod, parseMethodDesc, jmethod } from "../jvm/abi";
import { vcall, mkEnumSet, JThread, curThread, setCurThread, type JSimpleEnum } from "../jvm/natives/jlang";
import { readStreamFully } from "../jvm/natives/jio";
import { toJsArray } from "../jvm/natives/jutil";
import { JViewGroup, initViewFromCtx, defaultSize, rootOf, type JView } from "./view";
import { overlays } from "./popup";
import { device } from "../shell/config";
import { onMain } from "./mainloop";
import { type JContext } from "./context";
import { mkUri } from "./net";
import { appHost } from "./apphost";
import { webCookies, thirdPartyCookies } from "./cookies";
import { WebBridge, type WebInterfaces, type WebRequest, type WebResponse } from "../shell/webbridge";
import { localAsset } from "../shell/localassets";
import { EXT_MIME, MIME_EXT } from "../mime";
import { WEB_INJECT, webFormRequest } from "../shell/webinject";
import { snapshotDocument } from "../shell/websnapshot";
import { webPrintAdapter } from "./printing";
import type { JCanvas } from "./graphics";
import { recordOrRun } from "./recording";

const inst = <T = JObj>(cls: string): T => rt.make(cls);

rt.register({ name: "android/webkit/WebView$FindListener", ctor: class extends JObj {}, methods: {
  "onFindResultReceived(IIZ)V": () => {},
} });

rt.register({
  name: "android/webkit/MimeTypeMap", ctor: class extends JObj {},
  methods: {
    "static getSingleton()Landroid/webkit/MimeTypeMap;": () => inst("android/webkit/MimeTypeMap"),
    "static getFileExtensionFromUrl(Ljava/lang/String;)Ljava/lang/String;": (u: string) => /\.([A-Za-z0-9]+)(?:[?#]|$)/.exec(u ?? "")?.[1] ?? "",
    "getMimeTypeFromExtension(Ljava/lang/String;)Ljava/lang/String;": (ext: string) => EXT_MIME[ext?.toLowerCase()] ?? null,
    "getExtensionFromMimeType(Ljava/lang/String;)Ljava/lang/String;": (mime: string) => MIME_EXT[mime?.toLowerCase()] ?? null,
    "hasExtension(Ljava/lang/String;)Z": (ext: string) => ext?.toLowerCase() in EXT_MIME ? 1 : 0,
    "hasMimeType(Ljava/lang/String;)Z": (mime: string) => mime?.toLowerCase() in MIME_EXT ? 1 : 0,
  },
});

// ── WebSettings: the app reads back what it wrote, so every setter has its value and getter
// the provider is AOSP's config_webview_packages default, versioned as the Chrome the UA names
const WEBVIEW_PACKAGE = "com.android.webview", WEBVIEW_VERSION = "120.0";
const UA = `Mozilla/5.0 (Linux; Android 13; webdroid) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${WEBVIEW_VERSION} Mobile Safari/537.36`;
const pluginStates = mkEnumSet("android/webkit/WebSettings$PluginState", ["ON", "ON_DEMAND", "OFF"]);
const layoutAlgs = mkEnumSet("android/webkit/WebSettings$LayoutAlgorithm", ["NORMAL", "SINGLE_COLUMN", "NARROW_COLUMNS", "TEXT_AUTOSIZING"]);
mkEnumSet("android/webkit/WebSettings$RenderPriority", ["NORMAL", "HIGH", "LOW"]);
class JWebSettings extends JObj {
  v: Record<string, unknown> = {
    userAgentString: UA, cacheMode: -1, textZoom: 100, minimumFontSize: 8, minimumLogicalFontSize: 8, defaultFontSize: 16,
    defaultFixedFontSize: 13, mixedContentMode: 1, forceDark: 1, supportZoom: 1, displayZoomControls: 1, allowContentAccess: 1,
    mediaPlaybackRequiresUserGesture: 1, safeBrowsingEnabled: 1, loadsImagesAutomatically: 1, standardFontFamily: "sans-serif",
    fixedFontFamily: "monospace", sansSerifFontFamily: "sans-serif", serifFontFamily: "serif", cursiveFontFamily: "cursive",
    fantasyFontFamily: "fantasy", defaultTextEncodingName: "UTF-8", layoutAlgorithm: layoutAlgs[0], pluginState: pluginStates[2],
  };
}
const settingsMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function () {},
  "static getDefaultUserAgent(Landroid/content/Context;)Ljava/lang/String;": () => UA,
  "setAppCacheEnabled(Z)V": () => {}, "setAppCacheMaxSize(J)V": () => {}, "setAppCachePath(Ljava/lang/String;)V": () => {},
  "setDatabasePath(Ljava/lang/String;)V": () => {}, "setGeolocationDatabasePath(Ljava/lang/String;)V": () => {},
  "setEnableSmoothTransition(Z)V": () => {},
  // AOSP: null or empty restores the default string
  "setUserAgentString(Ljava/lang/String;)V": function (this: JWebSettings, s: string | null) { this.v.userAgentString = s || UA; },
};
function prop(name: string, d: string, get: string | null = "get" + name) {
  const k = name[0].toLowerCase() + name.slice(1);
  settingsMethods[`set${name}(${d})V`] ??= function (this: JWebSettings, x: unknown) { this.v[k] = x; };
  if (get) settingsMethods[`${get}()${d}`] = function (this: JWebSettings) { return this.v[k] ?? (d.length === 1 ? 0 : null); };
}
for (const n of ["JavaScriptEnabled", "DomStorageEnabled", "DatabaseEnabled", "UseWideViewPort", "LoadWithOverviewMode", "BuiltInZoomControls",
  "DisplayZoomControls", "MediaPlaybackRequiresUserGesture", "AllowFileAccess", "AllowContentAccess", "AllowFileAccessFromFileURLs",
  "AllowUniversalAccessFromFileURLs", "JavaScriptCanOpenWindowsAutomatically", "SaveFormData", "SavePassword", "OffscreenPreRaster",
  "SafeBrowsingEnabled", "LoadsImagesAutomatically", "BlockNetworkImage", "BlockNetworkLoads"]) prop(n, "Z");
for (const n of ["CacheMode", "MixedContentMode", "TextZoom", "MinimumFontSize", "MinimumLogicalFontSize", "DefaultFontSize",
  "DefaultFixedFontSize", "ForceDark", "DisabledActionModeMenuItems"]) prop(n, "I");
for (const n of ["UserAgentString", "StandardFontFamily", "FixedFontFamily", "SansSerifFontFamily", "SerifFontFamily", "CursiveFontFamily",
  "FantasyFontFamily", "DefaultTextEncodingName"]) prop(n, "Ljava/lang/String;");
prop("SupportZoom", "Z", "supportZoom"); prop("SupportMultipleWindows", "Z", "supportMultipleWindows");
prop("AlgorithmicDarkeningAllowed", "Z", "isAlgorithmicDarkeningAllowed");
prop("GeolocationEnabled", "Z", null); prop("NeedInitialFocus", "Z", null);
prop("LayoutAlgorithm", "Landroid/webkit/WebSettings$LayoutAlgorithm;"); prop("PluginState", "Landroid/webkit/WebSettings$PluginState;");
prop("RenderPriority", "Landroid/webkit/WebSettings$RenderPriority;", null);
rt.register({
  name: "android/webkit/WebSettings", ctor: JWebSettings, methods: settingsMethods,
  statics: {
    LOAD_DEFAULT: -1, LOAD_CACHE_ELSE_NETWORK: 1, LOAD_NO_CACHE: 2, LOAD_CACHE_ONLY: 3,
    FORCE_DARK_OFF: 0, FORCE_DARK_AUTO: 1, FORCE_DARK_ON: 2,
    MIXED_CONTENT_ALWAYS_ALLOW: 0, MIXED_CONTENT_NEVER_ALLOW: 1, MIXED_CONTENT_COMPATIBILITY_MODE: 2,
  },
});

class JServiceWorkerController extends JObj { client: unknown = null; }
const serviceWorkerController = new JServiceWorkerController();
rt.register({
  name: "android/webkit/ServiceWorkerController", ctor: JServiceWorkerController,
  methods: {
    "static getInstance()Landroid/webkit/ServiceWorkerController;": () => serviceWorkerController,
    "setServiceWorkerClient(Landroid/webkit/ServiceWorkerClient;)V": function (this: JServiceWorkerController, client: unknown) { this.client = client; },
  },
});
rt.register({ name: "android/webkit/ServiceWorkerClient", ctor: class extends JObj {} });

// ── the frame layer (shell-owned) and the per-frame sweep
let layer: HTMLElement | null = null;
let layerObserver: ResizeObserver | null = null;
let proxyReady: Promise<void> | null = null;
function webProxy(): Promise<void> {
  return proxyReady ??= (async () => {
    const service = navigator.serviceWorker;
    await service.register("/webview-worker.js");
    await service.ready;
    if (!service.controller) await new Promise<void>((resolve) => service.addEventListener("controllerchange", () => resolve(), { once: true }));
  })();
}
/** the shell's <div> that sits exactly over the canvas; without one every WebView stays inert */
export function setWebLayer(el: HTMLElement) {
  if (!layer) window.addEventListener("message", JWebView.message);
  layerObserver?.disconnect();
  layer = el;
  layerObserver = new ResizeObserver(([entry]) => {
    el.style.setProperty("--wd-web-scale", String(entry.contentRect.width * device.density / device.width));
  });
  layerObserver.observe(el);
}
let frame = 1;
/** attached WebViews the last draw passes may have painted */
const live = new Set<JWebView>();
/** what a WebView's page holds on the host side; it never references the WebView itself */
interface FrameHold { el: HTMLIFrameElement | null; remote: WebBridge | null; port: MessagePort | null }
function unbridge(h: FrameHold) {
  if (h.remote) { bridges.delete(h.remote.id); h.remote.close(); h.remote = null; }
  h.port?.close(); h.port = null;
}
function release(h: FrameHold) { unbridge(h); h.el?.remove(); h.el = null; }
// Chromium destroys an AwContents once its WebView is garbage collected (a CleanupReference), so
// an app that drops a WebView without destroy() does not keep its page. Page-side callbacks and the
// bridge therefore reach a WebView only weakly; detaching alone keeps the page, as apps reattach.
const collected = new FinalizationRegistry<FrameHold>(release);
const bridges = new Map<string, WeakRef<JWebView>>();
/** page-side proxies of the interfaces, so the page does not keep the Java objects (and so often its WebView) reachable */
function weakIfaces(of: () => WebInterfaces | null | undefined): WebInterfaces {
  const out: WebInterfaces = Object.create(null);
  for (const [name, methods] of Object.entries(of() ?? {})) {
    const proxy: WebInterfaces[string] = out[name] = Object.create(null);
    for (const m in methods) proxy[m] = async (...args) => of()?.[name]?.[m]?.(...args);
  }
  return out;
}
/** frames sit above the canvas, so a visible window stacked over the WebView's own hides it */
function covered(v: JView): boolean {
  const root = rootOf(v);
  for (let i = overlays.length - 1; i >= 0 && overlays[i].view !== root; i--) if (overlays[i].view.visibility === 0) return true;
  return false;
}
/** after each canvas draw pass: show the WebViews that pass painted, at their on-screen rect */
export function webLayerSweep(): void {
  for (const v of live) {
    if (!v.hold.el) continue;
    const show = v.drawnAt === frame && !covered(v) && v.place();
    if (show !== v.shown) { v.shown = show; v.hold.el.hidden = !show; }
  }
  frame++;
}
/** debug: the canvas capture cannot see frame pixels, so this is how a harness proves a page loaded */
export function webViewInfo(): { url: string | null; title: string; loaded: boolean; progress: number; rect: [number, number, number, number] }[] {
  return [...live].map((v) => ({ url: v.url, title: v.title, loaded: v.loaded, progress: v.progress, rect: [v.x0, v.y0, v.x1, v.y1] }));
}

const assetOf = (v: JView) => (v.ctx as JContext | null)?.$host?.assetKey ?? "";
/** what the browser loads for an Android URL: the dev server fronts http(s) and the apk's assets */
function srcFor(url: string, v: JWebView): string {
  if (/^https?:/i.test(url)) return "/proxy?frame=1&url=" + encodeURIComponent(url) + "&ua=" + encodeURIComponent(String(v.settings.v.userAgentString));
  const m = /^file:\/\/\/android_asset\/(.*)$/i.exec(url);
  return m ? "/asset/" + encodeURIComponent(assetOf(v)) + "/assets/" + m[1] : url;
}
/** a frame-side absolute URL back to the Android-visible one the app knows */
function unmap(href: string, v: JWebView): string {
  const o = location.origin;
  if (href.startsWith(o + "/proxy?")) {
    const local = new URL(href), source = local.searchParams.get("url");
    if (!source) return href;
    const url = new URL(source); if (local.hash) url.hash = local.hash;
    return url.href;
  }
  const a = o + "/asset/" + encodeURIComponent(assetOf(v)) + "/assets/";
  return href.startsWith(a) ? "file:///android_asset/" + href.slice(a.length) : href;
}
/** the frame's window when its document is ours to script (data: URLs are opaque) */
function win(v: JWebView): Window | null {
  const w = v.hold.el?.contentWindow ?? null;
  try { return w?.document ? w : null; } catch { return null; }
}
const toJava = (d: string, x: unknown): unknown =>
  d === "J" ? BigInt(Math.trunc(Number(x)) || 0) : d === "Z" ? (x ? 1 : 0) : d === "F" || d === "D" ? Number(x)
  : d === "C" ? String(x).charCodeAt(0) | 0 : d.length === 1 ? Number(x) | 0 : x;
const fromJava = (d: string, r: unknown): unknown => d === "J" ? Number(r) : d === "Z" ? !!r : d === "V" ? undefined : r;
function bridge(o: JObj, thread: JThread): WebInterfaces[string] {
  const out: WebInterfaces[string] = Object.create(null);
  for (let ci = (o.constructor as unknown as { $i?: ClassInfo }).$i ?? null; ci && ci.def && ci.dex; ci = ci.superInfo) {
    const dex = ci.dex, annos = dex.classAnnotations(ci.def).methods;
    for (const m of ci.def.virtualMethods) {
      const name = dex.method(m.methodIdx).name;
      if ((m.flags & 9) !== 1 || name in out || !annos.get(m.methodIdx)?.some((a) => a.type === "android/webkit/JavascriptInterface")) continue;
      const desc = dex.methodDesc(m.methodIdx), { params, ret } = parseMethodDesc(desc);
      out[name] = async (...args: unknown[]) => {
        const previous = curThread;
        setCurThread(thread);
        try { return fromJava(ret, await vcall(o, name, desc, ...params.map((d, i) => toJava(d, args[i])))); }
        finally { if (curThread === thread) setCurThread(previous); }
      };
    }
  }
  return out;
}

const WV_S = "(Landroid/webkit/WebView;Ljava/lang/String;)V";
const navigationKeys: Record<number, readonly [string, number]> = {
  19: ["ArrowUp", 38], 20: ["ArrowDown", 40], 21: ["ArrowLeft", 37], 22: ["ArrowRight", 39],
  23: ["Enter", 13], 61: ["Tab", 9], 62: [" ", 32], 66: ["Enter", 13], 67: ["Backspace", 8],
  92: ["PageUp", 33], 93: ["PageDown", 34], 111: ["Escape", 27], 112: ["Delete", 46],
  122: ["Home", 36], 123: ["End", 35],
};
const REQ = "com/android/webview/chromium/WebViewContentsClientAdapter$WebResourceRequestAdapter";
class JReq extends JObj { url = ""; main = true; gesture = false; method = "GET"; headers: unknown = null; }
function mkRequest(url: string, gesture = false): JReq {
  const r = inst<JReq>(REQ);
  r.url = url; r.gesture = gesture;
  return r;
}
class JWebErr extends JObj { code = -1; desc = ""; }

interface Entry { url: string; src?: string; doc?: string; method?: string; body?: ArrayBuffer; contentType?: string }
class JWebHistoryItem extends JObj {
  constructor(public entry: Entry) { super(); }
}
class JWebBackForwardList extends JObj {
  constructor(public entries: Entry[], public index: number) { super(); }
}
rt.register({
  name: "android/webkit/WebHistoryItem", ctor: JWebHistoryItem,
  methods: {
    "getUrl()Ljava/lang/String;": function (this: JWebHistoryItem) { return this.entry.url; },
    "getOriginalUrl()Ljava/lang/String;": function (this: JWebHistoryItem) { return this.entry.url; },
    "getTitle()Ljava/lang/String;": () => null,
    "getFavicon()Landroid/graphics/Bitmap;": () => null,
  },
});
rt.register({
  name: "android/webkit/WebBackForwardList", ctor: JWebBackForwardList,
  methods: {
    "getSize()I": function (this: JWebBackForwardList) { return this.entries.length; },
    "getCurrentIndex()I": function (this: JWebBackForwardList) { return this.index; },
    "getCurrentItem()Landroid/webkit/WebHistoryItem;": function (this: JWebBackForwardList) {
      return this.index < 0 ? null : new JWebHistoryItem(this.entries[this.index]);
    },
    "getItemAtIndex(I)Landroid/webkit/WebHistoryItem;": function (this: JWebBackForwardList, index: number) {
      return index < 0 || index >= this.entries.length ? null : new JWebHistoryItem(this.entries[index]);
    },
  },
});
export class JWebView extends JViewGroup {
  settings = inst<JWebSettings>("android/webkit/WebSettings");
  client = inst("android/webkit/WebViewClient");
  chrome = inst("android/webkit/WebChromeClient");
  dl: unknown = null;
  findListener: unknown = null;
  findQuery = "";
  findCount = 0;
  findOrdinal = 0;
  url: string | null = null;
  title = "";
  progress = 0;
  loaded = false;
  hist: Entry[] = [];
  idx = -1;
  ifaces: WebInterfaces = Object.create(null);
  /** the interfaces the bridged page was loaded with, as Chromium injects them per load */
  private pageIfaces: WebInterfaces | null = null;
  bridgeThread = Object.assign(new JThread(), { jname: "JavaBridge" });
  private requestThread = Object.assign(new JThread(), { jname: "Chrome_IOThread" });
  private readonly ref = new WeakRef(this);
  readonly hold: FrameHold = { el: null, remote: null, port: null };
  private remoteOrigin = "";
  remoteWidth = 0;
  remoteHeight = 0;
  private nextEval = 0;
  private evaluations = new Map<number, (value: string) => void>();
  private nextSnapshot = 0;
  private snapshots = new Map<number, { resolve: (data: string) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private pendingScripts = new Map<number, string>();
  private scriptReady = false;
  static message(event: MessageEvent) { bridges.get(event.data?.bridge)?.deref()?.message(event); }
  private message(event: MessageEvent) {
    if (event.source !== this.hold.el?.contentWindow || event.origin !== this.remoteOrigin) return;
    const data = event.data, ref = this.ref;
    if (data.kind === "ready" && !this.hold.port) {
      const channel = new MessageChannel(), cookies = webCookies(appHost?.pkg ?? "");
      this.hold.port = channel.port1;
      channel.port1.onmessage = async ({ data, ports }) => {
        if (!ports[0]) return;
        if (data?.kind === "webasset") {
          const port = ports[0];
          try { port.postMessage(await localAsset(data.path)); }
          catch { port.postMessage({ status: 500 }); }
          port.close();
          return;
        }
        const v = ref.deref();
        if (typeof data?.url !== "string" || !v) return;
        const jar = await cookies;
        const values = Array.isArray(data.values) ? data.values.filter((value: unknown): value is string => typeof value === "string") : [];
        ports[0].postMessage(jar.network(data.url, v.url ?? "", values, thirdPartyCookies.has(v))); ports[0].close();
      };
      const entry = this.hist[this.idx];
      this.send({ kind: "load", src: entry?.src, doc: entry?.doc, method: entry?.method, body: entry?.body,
        contentType: entry?.contentType, userAgent: this.settings.v.userAgentString }, [channel.port2]);
    }
    else if (data.kind === "script-ready") {
      this.scriptReady = true;
      for (const [seq, script] of this.pendingScripts) this.send({ kind: "eval", seq, script });
      this.pendingScripts.clear();
    }
    else if (data.kind === "loaded") {
      this.remoteWidth = typeof data.width === "number" ? data.width : 0;
      this.remoteHeight = typeof data.height === "number" ? data.height : 0;
      this.finishLoad(typeof data.url === "string" ? data.url : null, typeof data.title === "string" ? data.title : "", typeof data.error === "string" ? data.error : null);
    } else if (data.kind === "fragment" && typeof data.url === "string") this.fragmentNavigated(data.url);
    else if (data.kind === "navigate" && typeof data.url === "string") this.navigate(data.url, data.replace === true);
    else if (data.kind === "submit" && typeof data.url === "string" && typeof data.method === "string" && data.body instanceof ArrayBuffer)
      this.go({ url: data.url, src: srcFor(data.url, this), method: data.method, body: data.body,
        contentType: typeof data.contentType === "string" ? data.contentType : undefined });
    else if (data.kind === "console") this.consoleMessage(data);
    else if (data.kind === "evaluated" && typeof data.seq === "number" && typeof data.value === "string") this.evaluations.get(data.seq)?.(data.value);
    else if (data.kind === "snapshot" && typeof data.seq === "number") {
      const pending = this.snapshots.get(data.seq);
      if (pending) {
        clearTimeout(pending.timer); this.snapshots.delete(data.seq);
        if (data.error) pending.reject(rt.mkThrowable("java/lang/UnsupportedOperationException", data.error));
        else pending.resolve(data.data);
      }
    }
  }
  private send(data: object, transfer: Transferable[] = []) { this.hold.el?.contentWindow?.postMessage({ ...data, bridge: this.hold.remote?.id }, this.remoteOrigin, transfer); }
  requestPrint(): boolean {
    if (!this.loaded || !this.hold.el?.contentWindow) return false;
    if (this.remoteOrigin) this.send({ kind: "print" });
    else this.hold.el.contentWindow.print();
    return true;
  }
  async bitmapSnapshot(): Promise<ImageBitmap> {
    let data: string;
    if (this.remoteOrigin) {
      data = await new Promise<string>((resolve, reject) => {
        const seq = ++this.nextSnapshot;
        const timer = setTimeout(() => {
          this.snapshots.delete(seq);
          reject(rt.mkThrowable("java/lang/UnsupportedOperationException", "WebView snapshot timed out"));
        }, 10_000);
        this.snapshots.set(seq, { resolve, reject, timer });
        this.send({ kind: "snapshot", seq });
      });
    } else if (this.hold.el?.contentDocument) {
      data = (await snapshotDocument(this.hold.el.contentDocument)).data;
    } else throw rt.mkThrowable("java/lang/UnsupportedOperationException", "WebView content is unavailable for bitmap capture");
    return createImageBitmap(await (await fetch(data)).blob());
  }
  private closeBridge() {
    this.scriptReady = false;
    unbridge(this.hold); this.remoteOrigin = "";
    for (const done of this.evaluations.values()) done("null");
    for (const pending of this.snapshots.values()) {
      clearTimeout(pending.timer);
      pending.reject(rt.mkThrowable("java/lang/UnsupportedOperationException", "WebView snapshot interrupted"));
    }
    this.snapshots.clear();
  }
  destroy() { this.gen++; this.closeBridge(); collected.unregister(this.hold); release(this.hold); this.shown = false; live.delete(this); }
  drawnAt = 0;
  shown = false;
  /** bumped by every load and by stopLoading: a frame event from an older load is ignored */
  gen = 0;
  x0 = 0; y0 = 0; x1 = 0; y1 = 0;

  frame(): HTMLIFrameElement | null {
    if (this.hold.el || !layer) return this.hold.el;
    const el = this.hold.el = document.createElement("iframe"), ref = this.ref;
    el.referrerPolicy = "no-referrer";
    el.style.cssText = "position:absolute;border:0;pointer-events:auto;transform-origin:top left;transform:scale(var(--wd-web-scale,1))";
    el.hidden = true;
    (el as unknown as { __wdConsole: unknown }).__wdConsole = (data: unknown) => ref.deref()?.consoleMessage(data);
    el.addEventListener("load", () => ref.deref()?.onLoad());
    layer.appendChild(el);
    collected.register(this, this.hold, this.hold);
    return el;
  }
  go(e: Entry, push = true) {
    if (push) { this.hist.length = ++this.idx; this.hist.push(e); }
    this.url = e.url; this.loaded = false; this.progress = 10; this.title = "";
    const g = ++this.gen, el = this.frame(), url = e.url;
    if (el) {
      (el as unknown as { __wdUserAgent: unknown }).__wdUserAgent = this.settings.v.userAgentString;
      const load = () => {
        if (this.gen !== g) return;
        if (e.doc !== undefined) el.srcdoc = e.doc;
        else { el.removeAttribute("srcdoc"); el.src = e.src!; }
      };
      this.closeBridge();
      // Chromium injects the interfaces a page loads with; a later add or remove applies at the next load
      const ref = this.ref, ifaces = this.pageIfaces = { ...this.ifaces };
      (el as unknown as { __wdIfaces: WebInterfaces }).__wdIfaces = weakIfaces(() => ref.deref()?.pageIfaces);
      const base = rt.link("android/webkit/WebViewClient").ctor.prototype;
      const intercept = ["Landroid/webkit/WebResourceRequest;", "Ljava/lang/String;"].some(arg => {
        const method = mangleMethod("shouldInterceptRequest", "(Landroid/webkit/WebView;" + arg + ")Landroid/webkit/WebResourceResponse;");
        return jmethod(this.client, method) !== jmethod(base, method);
      });
      if (intercept || Object.keys(ifaces).length || e.method === "POST") {
        const remote = this.hold.remote = new WebBridge(weakIfaces(() => ref.deref()?.pageIfaces),
          webCookies(appHost?.pkg ?? ""), () => ref.deref()?.url ?? null, intercept ? async request => ref.deref()?.intercept(request) ?? null : undefined);
        bridges.set(remote.id, ref);
        void remote.ready.then((origin) => {
          if (this.gen !== g) return;
          this.remoteOrigin = origin;
          el.removeAttribute("srcdoc"); el.src = origin + "/webview?__wd_bridge=" + remote.id + "&__wd_url=" + encodeURIComponent(e.url) + "&__wd_ua=" + encodeURIComponent(String(this.settings.v.userAgentString)) + (intercept ? "&__wd_intercept=1" : "");
        }).catch(() => { if (this.gen === g) this.finishLoad(null, "", "WebView bridge unavailable"); });
      } else if (e.src?.startsWith("/proxy?")) void webProxy().then(load).catch((error) => { console.error("[webview transport]", error); load(); });
      else load();
    }
    void onMain(() => this.gen === g && vcall(this.client, "onPageStarted", "(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V", this, url, null));
  }
  loadUrl(url: string) {
    if (/^javascript:/i.test(url)) { this.evalJs(url.slice(11)); return; }
    this.go({ url, src: srcFor(url, this) });
  }
  private async intercept(request: WebRequest): Promise<WebResponse | null> {
    const previous = curThread;
    setCurThread(this.requestThread);
    try {
      const req = mkRequest(request.url);
      req.main = request.main; req.method = request.method;
      req.headers = inst("java/util/HashMap");
      for (const [key, value] of Object.entries(request.headers)) await vcall(req.headers, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, value);
      const response = await vcall(this.client, "shouldInterceptRequest", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;", this, req) as JWebResourceResponse | null;
      if (!response) return null;
      const headers: Record<string, string> = {};
      if (response.headers) for (const entry of await toJsArray(await vcall(response.headers, "entrySet", "()Ljava/util/Set;"))) {
        const key = await vcall(entry, "getKey", "()Ljava/lang/Object;") as string;
        headers[key] = await vcall(entry, "getValue", "()Ljava/lang/Object;") as string;
      }
      if (response.mime) headers["content-type"] = response.mime + (response.enc ? "; charset=" + response.enc : "");
      let binary = "";
      if (response.data) {
        try {
          const bytes = await readStreamFully(response.data);
          for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        } finally { await vcall(response.data, "close", "()V"); }
      }
      return { body: btoa(binary), status: response.status, reason: response.reason, headers };
    } finally { if (curThread === this.requestThread) setCurThread(previous); }
  }
  step(n: number) {
    const i = this.idx + n;
    if (i < 0 || i >= this.hist.length) return;
    this.idx = i;
    this.go(this.hist[i], false);
  }
  private onLoad() {
    if (this.hold.remote) return;
    const cur = this.hist[this.idx], doc = this.hold.el!.contentDocument;
    // the iframe's initial about:blank fires load too; it is nobody's navigation
    if (doc?.URL === "about:blank" && cur?.src !== "about:blank") return;
    const redirected = doc?.querySelector('meta[name="wd-proxy-url"]')?.getAttribute("content");
    const err = doc?.querySelector('meta[name="wd-proxy-error"]')?.getAttribute("content");
    if (doc && !err) this.hookLinks(doc);
    this.finishLoad(redirected ?? null, doc?.title ?? "", err ?? null);
  }
  private finishLoad(redirected: string | null, title: string, err: string | null) {
    const g = this.gen, cur = this.hist[this.idx];
    if (redirected) { this.url = redirected; if (cur) cur.url = redirected; }
    const url = this.url ?? "";
    this.loaded = !err; this.progress = 100; this.title = title || url;
    // Chromium's order; each step re-checks the generation because a callback commonly starts
    // the next load (an app's error page), which ends this one's sequence
    const steps: [unknown, string, string, ...unknown[]][] = err
      ? [[this.client, "onReceivedError", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V", this, mkRequest(url), Object.assign(new JWebErr(), { code: -2, desc: err })],
         [this.client, "onPageFinished", WV_S, this, url]]
      : [[this.chrome, "onProgressChanged", "(Landroid/webkit/WebView;I)V", this, 100], [this.chrome, "onReceivedTitle", WV_S, this, this.title],
         [this.client, "onPageCommitVisible", WV_S, this, url], [this.client, "onPageFinished", WV_S, this, url]];
    void onMain(async () => { for (const [o, n, d, ...a] of steps) { if (this.gen !== g) return; await vcall(o, n, d, ...a); } });
  }
  /** an uncaught page error, as Chromium reports it; unhandled messages go to logcat's chromium tag */
  consoleMessage(data: unknown) {
    const { message, source, line } = (data ?? {}) as { message?: unknown; source?: unknown; line?: unknown };
    const m = inst<JConsoleMessage>("android/webkit/ConsoleMessage");
    m.msg = String(message); m.src = typeof source === "string" ? unmap(source, this) : ""; m.line = typeof line === "number" ? line : 0;
    m.level = msgLevels[3];
    void onMain(async () => {
      if (!await vcall(this.chrome, "onConsoleMessage", "(Landroid/webkit/ConsoleMessage;)Z", m))
        console.log("[I/chromium]", `[INFO:CONSOLE(${m.line})] "${m.msg}", source: ${m.src} (${m.line})`);
    });
  }
  fragmentNavigated(url: string) {
    const g = this.gen, cur = this.hist[this.idx];
    this.url = url;
    if (cur) { cur.url = url; if (cur.src) cur.src = srcFor(url, this); }
    void onMain(async () => {
      if (this.gen !== g) return;
      await vcall(this.client, "doUpdateVisitedHistory", "(Landroid/webkit/WebView;Ljava/lang/String;Z)V", this, url, 0);
      if (this.gen === g) await vcall(this.client, "onPageFinished", WV_S, this, url);
    });
  }
  /** a link click in the frame is the app's to override, as Chromium asks before navigating */
  private hookLinks(doc: Document) {
    const g = this.gen, ref = this.ref;
    doc.defaultView?.addEventListener("hashchange", event => {
      const v = ref.deref();
      if (event.isTrusted && v?.gen === g) v.fragmentNavigated(unmap(event.newURL, v));
    });
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null, v = ref.deref();
      if (!a || !v || /^javascript:/i.test(a.href)) return;
      const href = unmap(a.href, v);
      if (a.hash && href.split("#")[0] === (v.url ?? "").split("#")[0]) return; // same-document fragment: no navigation
      e.preventDefault();
      v.navigate(href);
    }, true);
    const submit = (form: HTMLFormElement, submitter: HTMLElement | null) => {
      void webFormRequest(form, submitter, ref.deref()?.url ?? doc.URL).then((request) => {
        const v = ref.deref();
        if (!request || v?.gen !== g) return;
        if (request.method === "GET") v.navigate(request.url);
        else v.go({ ...request, src: srcFor(request.url, v) });
      });
    };
    doc.defaultView?.addEventListener("submit", (event) => {
      if (event.defaultPrevented || (event.target as Element)?.tagName !== "FORM") return;
      event.preventDefault();
      submit(event.target as HTMLFormElement, (event as SubmitEvent).submitter);
    });
    const prototype = Object.getPrototypeOf(doc.createElement("form")) as HTMLFormElement;
    prototype.submit = function (this: HTMLFormElement) { submit(this, null); };
  }
  private navigate(href: string, replace = false) {
    void onMain(async () => {
      if (await vcall(this.client, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z", this, mkRequest(href, true))) return;
      if (replace && this.idx >= 0 && !/^javascript:/i.test(href)) {
        const entry = { url: href, src: srcFor(href, this) };
        this.hist[this.idx] = entry;
        this.go(entry, false);
      } else this.loadUrl(href);
    });
  }
  /** Chromium JSON-encodes the completion value; undefined, functions and throws all read as null */
  evalJs(js: string): string | Promise<string> {
    if (this.hold.remote) return new Promise<string>((resolve) => {
      const seq = ++this.nextEval;
      const done = (value: string) => { clearTimeout(timer); this.evaluations.delete(seq); this.pendingScripts.delete(seq); resolve(value); };
      const timer = setTimeout(() => done("null"), 30_000);
      this.evaluations.set(seq, done);
      if (this.scriptReady) this.send({ kind: "eval", seq, script: js });
      else this.pendingScripts.set(seq, js);
    });
    const w = win(this);
    if (!w) return "null";
    try { return JSON.stringify((w as unknown as { eval(s: string): unknown }).eval(js)) ?? "null"; } catch { return "null"; }
  }
  findAll(query: string) {
    this.findQuery = query;
    const generation = this.gen;
    const script = `(() => { const q = ${JSON.stringify(query.toLowerCase())}; const text = (document.body?.innerText ?? "").toLowerCase(); let count = 0, pos = 0; while (q && (pos = text.indexOf(q, pos)) !== -1) { count++; pos += q.length; } if (count) window.find(${JSON.stringify(query)}, false, false, true); return count; })()`;
    void Promise.resolve(this.evalJs(script)).then(result => {
      if (generation !== this.gen || query !== this.findQuery) return;
      this.findCount = Number(result) || 0;
      this.findOrdinal = 0;
      this.notifyFind();
    });
  }
  notifyFind() {
    if (this.findListener) void onMain(() => vcall(this.findListener, "onFindResultReceived", "(IIZ)V", this.findOrdinal, this.findCount, 1));
  }
  findNext(forward: boolean) {
    if (!this.findQuery || !this.findCount) return;
    this.findOrdinal = (this.findOrdinal + (forward ? 1 : -1) + this.findCount) % this.findCount;
    const script = `window.find(${JSON.stringify(this.findQuery)}, false, ${!forward}, true)`;
    void Promise.resolve(this.evalJs(script)).then(() => this.notifyFind());
  }
  async keyEvent(code: number, event: unknown, type: "keydown" | "keyup"): Promise<number> {
    if (await vcall(this.client, "shouldOverrideKeyEvent", "(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z", this, event)) return 1;
    const key = navigationKeys[code];
    if (!key || !this.hold.el || !this.loaded) return 0;
    const init = { key: key[0], code: code === 62 ? "Space" : key[0], keyCode: key[1], which: key[1], bubbles: true, cancelable: true,
      repeat: (await vcall(event, "getRepeatCount", "()I")) > 0 };
    const generation = this.gen;
    // Renderer handlers can call back into Java; never hold the main queue awaiting them.
    void Promise.resolve(this.evalJs(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, ${JSON.stringify(init)}))`)).then((unhandled) => {
      if (unhandled === "true" && this.gen === generation) void onMain(() => vcall(this.client, "onUnhandledKeyEvent", "(Landroid/webkit/WebView;Landroid/view/KeyEvent;)V", this, event));
    });
    return 1;
  }
  /** screen rect of the view: up the tree, clipped by each ancestor the way its dispatchDraw clips */
  place(): boolean {
    let l = 0, t = 0, r = this.width(), b = this.height(), v: JView = this;
    for (;;) {
      const p = v.parent;
      const dx = v.left + v.translationX - (p ? p.scrollX : 0), dy = v.top + v.translationY - (p ? p.scrollY : 0);
      l += dx; t += dy; r += dx; b += dy;
      if (!p) break;
      if (l < 0) l = 0; if (t < 0) t = 0; if (r > p.width()) r = p.width(); if (b > p.height()) b = p.height();
      v = p;
    }
    if (l < 0) l = 0; if (t < 0) t = 0; if (r > device.width) r = device.width; if (b > device.height) b = device.height;
    if (r <= l || b <= t) return false;
    if (l !== this.x0 || t !== this.y0 || r !== this.x1 || b !== this.y1) {
      this.x0 = l; this.y0 = t; this.x1 = r; this.y1 = b;
      const s = this.hold.el!.style;
      s.left = l / device.width * 100 + "%"; s.top = t / device.height * 100 + "%";
      s.width = (r - l) / device.density + "px"; s.height = (b - t) / device.density + "px";
    }
    return true;
  }
  contentHeight() { return this.hold.remote ? this.remoteHeight : win(this)?.document.documentElement.scrollHeight ?? 0; }
  hide() { if (this.shown) { this.shown = false; this.hold.el!.hidden = true; } }
}
/** srcdoc payload: the bridge bootstrap first (after a doctype, or the document goes quirks), then the base */
function srcdoc(data: string, enc: string | null, base: string | null): string {
  if (/^base64$/i.test(enc ?? "")) data = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  const inject = WEB_INJECT + (base ? `<base href="${base.replace(/"/g, "&quot;")}">` : "");
  const dt = /^\s*<!doctype[^>]*>/i.exec(data);
  return dt ? dt[0] + inject + data.slice(dt[0].length) : inject + data;
}
const wvCtor = async function (this: JWebView, c: unknown, set: unknown = null) { await initViewFromCtx(this, c, set as null); };
const loadUrl = function (this: JWebView, u: string) { this.loadUrl(u); };
rt.register({
  name: "android/webkit/WebView", ctor: JWebView, sup: "android/view/ViewGroup",
  statics: { RENDERER_PRIORITY_WAIVED: 0, RENDERER_PRIORITY_BOUND: 1, RENDERER_PRIORITY_IMPORTANT: 2, SCHEME_TEL: "tel:", SCHEME_MAILTO: "mailto:", SCHEME_GEO: "geo:0,0?q=" },
  methods: {
    "<init>(Landroid/content/Context;)V": wvCtor,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": wvCtor,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": wvCtor,
    // AOSP WebView measures like a plain View (getDefaultSize fills AT_MOST); ViewGroup's wraps children
    "onMeasure(II)V": function (this: JWebView, w: number, h: number) {
      this.measuredW = defaultSize(Math.max(this.minW, this.padL + this.padR, this.remoteWidth * device.density), w);
      this.measuredH = defaultSize(Math.max(this.minH, this.padT + this.padB, this.remoteHeight * device.density), h);
    },
    "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JWebView, canvas: JCanvas): Gen {
      // a recorded display list (a Compose layer) is replayed without calling onDraw again
      if (!canvas.bmp) { recordOrRun(canvas.ctx, () => { this.drawnAt = frame; live.add(this); }); return; }
      const image = yield this.bitmapSnapshot();
      try { canvas.ctx.drawImage(image, 0, 0, this.width(), this.height()); }
      finally { image.close(); }
    }),
    "onDetachedFromWindow()V": function (this: JWebView) { this.hide(); live.delete(this); },
    "destroy()V": function (this: JWebView) { this.destroy(); },
    "createPrintDocumentAdapter()Landroid/print/PrintDocumentAdapter;": function (this: JWebView) { return webPrintAdapter(this, this.title || "WebView"); },
    "createPrintDocumentAdapter(Ljava/lang/String;)Landroid/print/PrintDocumentAdapter;": function (this: JWebView, name: string) { return webPrintAdapter(this, name); },
    // AOSP substitutes its default client for null
    "setWebViewClient(Landroid/webkit/WebViewClient;)V": function (this: JWebView, c: JObj | null) { this.client = c ?? inst("android/webkit/WebViewClient"); },
    "setWebChromeClient(Landroid/webkit/WebChromeClient;)V": function (this: JWebView, c: JObj | null) { this.chrome = c ?? inst("android/webkit/WebChromeClient"); },
    "loadUrl(Ljava/lang/String;)V": loadUrl,
    "loadUrl(Ljava/lang/String;Ljava/util/Map;)V": loadUrl,
    // AOSP: loadData navigates to the data: URL itself; loadDataWithBaseURL's entry is historyUrl (about:blank when absent)
    "loadData(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JWebView, data: string, mime: string | null, enc: string | null) {
      this.go({ url: `data:${mime ?? "text/html"}${/^base64$/i.test(enc ?? "") ? ";base64" : ""},${data}`, doc: srcdoc(data, enc, null) });
    },
    "loadDataWithBaseURL(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      function (this: JWebView, base: string | null, data: string, _mime: string | null, enc: string | null, hist: string | null) {
        this.go({ url: hist || "about:blank", doc: srcdoc(data, enc, base) });
      },
    "reload()V": function (this: JWebView) { if (this.idx >= 0) this.go(this.hist[this.idx], false); },
    "stopLoading()V": function (this: JWebView) { this.gen++; win(this)?.stop(); },
    ...fieldGetters({ "getSettings()Landroid/webkit/WebSettings;": "settings",
      "getWebViewClient()Landroid/webkit/WebViewClient;": "client",
      "getWebChromeClient()Landroid/webkit/WebChromeClient;": "chrome", "getUrl()Ljava/lang/String;": "url",
      "getOriginalUrl()Ljava/lang/String;": "url", "getTitle()Ljava/lang/String;": "title",
      "getProgress()I": "progress" }),
    ...fieldSetters({ "setDownloadListener(Landroid/webkit/DownloadListener;)V": "dl" }),
    "canGoBack()Z": function (this: JWebView) { return this.idx > 0 ? 1 : 0; },
    "canGoForward()Z": function (this: JWebView) { return this.idx < this.hist.length - 1 ? 1 : 0; },
    "canGoBackOrForward(I)Z": function (this: JWebView, n: number) { const i = this.idx + n; return i >= 0 && i < this.hist.length ? 1 : 0; },
    "goBack()V": function (this: JWebView) { this.step(-1); },
    "goForward()V": function (this: JWebView) { this.step(1); },
    "goBackOrForward(I)V": function (this: JWebView, n: number) { this.step(n); },
    "copyBackForwardList()Landroid/webkit/WebBackForwardList;": function (this: JWebView) {
      return new JWebBackForwardList(this.hist.map((entry) => ({ ...entry })), this.idx);
    },
    // Chromium prunes every entry but the current one
    "clearHistory()V": function (this: JWebView) { if (this.idx >= 0) { this.hist = [this.hist[this.idx]]; this.idx = 0; } },
    "evaluateJavascript(Ljava/lang/String;Landroid/webkit/ValueCallback;)V": function (this: JWebView, js: string, cb: unknown) {
      void Promise.resolve(this.evalJs(js)).then((r) => cb && onMain(() => vcall(cb, "onReceiveValue", "(Ljava/lang/Object;)V", r)));
    },
    "onKeyDown(ILandroid/view/KeyEvent;)Z": function (this: JWebView, code: number, event: unknown) { return this.keyEvent(code, event, "keydown"); },
    "onKeyUp(ILandroid/view/KeyEvent;)Z": function (this: JWebView, code: number, event: unknown) { return this.keyEvent(code, event, "keyup"); },
    "addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V": function (this: JWebView, o: JObj, name: string) { this.ifaces[name] = bridge(o, this.bridgeThread); },
    "removeJavascriptInterface(Ljava/lang/String;)V": function (this: JWebView, name: string) { delete this.ifaces[name]; },
    "getContentHeight()I": function (this: JWebView) { return this.contentHeight(); },
    "getScale()F": () => device.density,
    "pageUp(Z)Z": function (this: JWebView, top: number) { const w = win(this); if (!w) return 0; w.scrollBy(0, top ? -w.document.documentElement.scrollHeight : -w.innerHeight); return 1; },
    "pageDown(Z)Z": function (this: JWebView, bottom: number) { const w = win(this); if (!w) return 0; w.scrollBy(0, bottom ? w.document.documentElement.scrollHeight : w.innerHeight); return 1; },
    "scrollTo(II)V": () => {}, "flingScroll(II)V": () => {},
    "zoomIn()Z": () => 0, "zoomOut()Z": () => 0,
    "onPause()V": () => {}, "onResume()V": () => {}, "pauseTimers()V": () => {}, "resumeTimers()V": () => {},
    "findAllAsync(Ljava/lang/String;)V": function (this: JWebView, query: string) { this.findAll(query); },
    "findNext(Z)V": function (this: JWebView, forward: number) { this.findNext(!!forward); },
    "clearMatches()V": function (this: JWebView) {
      this.findQuery = ""; this.findCount = 0; this.findOrdinal = 0;
      void this.evalJs("window.getSelection()?.removeAllRanges()");
    },
    "clearCache(Z)V": () => {}, "clearFormData()V": () => {}, "clearSslPreferences()V": () => {},
    "setNetworkAvailable(Z)V": () => {}, "setRendererPriorityPolicy(IZ)V": () => {},
    "setFindListener(Landroid/webkit/WebView$FindListener;)V": function (this: JWebView, listener: unknown) { this.findListener = listener; },
    ...stubs(null, "getFavicon()Landroid/graphics/Bitmap;",
      "saveState(Landroid/os/Bundle;)Landroid/webkit/WebBackForwardList;",
      "restoreState(Landroid/os/Bundle;)Landroid/webkit/WebBackForwardList;",
      "getCertificate()Landroid/net/http/SslCertificate;"),
    ...noops("setInitialScale(I)V", "static setWebContentsDebuggingEnabled(Z)V",
      "static enableSlowWholeDocumentDraw()V", "static setDataDirectorySuffix(Ljava/lang/String;)V",
      "static disableWebView()V"),
    ...stubs(0, "isPrivateBrowsingEnabled()Z"),
    ...stubs(1, "requestFocusFromTouch()Z"),
    "static getCurrentWebViewPackage()Landroid/content/pm/PackageInfo;": () => {
      const pi = inst<{ packageName: string; versionName: string; applicationInfo: unknown }>("android/content/pm/PackageInfo");
      const ai = inst<{ packageName: string; processName: string; flags: number }>("android/content/pm/ApplicationInfo");
      pi.packageName = ai.packageName = ai.processName = WEBVIEW_PACKAGE;
      ai.flags = 1; // FLAG_SYSTEM
      pi.versionName = WEBVIEW_VERSION; pi.applicationInfo = ai;
      return pi;
    },
    "static getWebViewClassLoader()Ljava/lang/ClassLoader;": () => rt.link("java/lang/Class").ctor.prototype[mangleMethod("getClassLoader", "()Ljava/lang/ClassLoader;")](),
  },
});

// ── clients: base behaviour subclasses invoke-super, and the request/error/response value types
rt.register({
  name: "android/webkit/WebViewClient", ctor: class extends JObj {},
  statics: {
    ERROR_UNKNOWN: -1, ERROR_HOST_LOOKUP: -2, ERROR_UNSUPPORTED_AUTH_SCHEME: -3, ERROR_AUTHENTICATION: -4, ERROR_PROXY_AUTHENTICATION: -5,
    ERROR_CONNECT: -6, ERROR_IO: -7, ERROR_TIMEOUT: -8, ERROR_REDIRECT_LOOP: -9, ERROR_UNSUPPORTED_SCHEME: -10, ERROR_FAILED_SSL_HANDSHAKE: -11,
    ERROR_BAD_URL: -12, ERROR_FILE: -13, ERROR_FILE_NOT_FOUND: -14, ERROR_TOO_MANY_REQUESTS: -15, ERROR_UNSAFE_RESOURCE: -16,
  },
  methods: {
    // AOSP forwards the request overload to the String one, so a subclass overriding either sees the click
    "shouldOverrideUrlLoading(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z": function (this: JObj, v: JWebView, r: JReq) {
      return vcall(this, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Ljava/lang/String;)Z", v, r.url);
    },
    // AOSP forwards a main-frame error to the legacy overload
    "onReceivedError(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V": function (this: JObj, v: JWebView, r: JReq, e: JWebErr) {
      if (r.main) return vcall(this, "onReceivedError", "(Landroid/webkit/WebView;ILjava/lang/String;Ljava/lang/String;)V", v, e.code, e.desc, r.url);
    },
    "onReceivedSslError(Landroid/webkit/WebView;Landroid/webkit/SslErrorHandler;Landroid/net/http/SslError;)V": (_v: unknown, h: unknown) => vcall(h, "cancel", "()V"),
    "onReceivedHttpAuthRequest(Landroid/webkit/WebView;Landroid/webkit/HttpAuthHandler;Ljava/lang/String;Ljava/lang/String;)V": (_v: unknown, h: unknown) => vcall(h, "cancel", "()V"),
    "onFormResubmission(Landroid/webkit/WebView;Landroid/os/Message;Landroid/os/Message;)V": (_v: unknown, dontResend: unknown) => vcall(dontResend, "sendToTarget", "()V"),
    "shouldInterceptRequest(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;": function (this: JObj, v: JWebView, r: JReq) {
      return vcall(this, "shouldInterceptRequest", "(Landroid/webkit/WebView;Ljava/lang/String;)Landroid/webkit/WebResourceResponse;", v, r.url);
    },
    ...noops("<init>()V", "onUnhandledKeyEvent(Landroid/webkit/WebView;Landroid/view/KeyEvent;)V"),
  },
});
rt.register({
  name: "android/webkit/WebChromeClient", ctor: class extends JObj {},
  methods: {
    // AOSP calls the deprecated overload for compatibility, then reports "not handled"
    "onConsoleMessage(Landroid/webkit/ConsoleMessage;)Z": driven(function* (this: JObj, m: JConsoleMessage): Gen {
      yield vcall(this, "onConsoleMessage", "(Ljava/lang/String;ILjava/lang/String;)V", m.msg, m.line, m.src);
      return 0;
    }),
    ...noops("<init>()V", "onPermissionRequest(Landroid/webkit/PermissionRequest;)V"),
  },
});
for (const n of ["android/webkit/WebChromeClient$CustomViewCallback", "android/webkit/WebResourceRequest", "android/webkit/ValueCallback", "android/webkit/DownloadListener"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}
rt.register({ name: "android/webkit/JavascriptInterface", ctor: class extends JObj {}, ifaces: ["java/lang/annotation/Annotation"] });
rt.register({
  name: REQ, ctor: JReq, ifaces: ["android/webkit/WebResourceRequest"],
  methods: {
    "getUrl()Landroid/net/Uri;": function (this: JReq) { return mkUri(this.url); },
    "isForMainFrame()Z": function (this: JReq) { return this.main ? 1 : 0; },
    "isRedirect()Z": () => 0,
    "hasGesture()Z": function (this: JReq) { return this.gesture ? 1 : 0; },
    "getMethod()Ljava/lang/String;": function (this: JReq) { return this.method; },
    "getRequestHeaders()Ljava/util/Map;": function (this: JReq) { return this.headers ??= inst("java/util/HashMap"); },
  },
});
rt.register({
  name: "android/webkit/WebResourceError", ctor: JWebErr,
  methods: {
    "getErrorCode()I": function (this: JWebErr) { return this.code; },
    "getDescription()Ljava/lang/CharSequence;": function (this: JWebErr) { return this.desc; },
  },
});
class JWebResourceResponse extends JObj {
  mime: string | null = null; enc: string | null = null; data: unknown = null;
  status = 200; reason = "OK"; headers: unknown = null;
}
rt.register({
  name: "android/webkit/WebResourceResponse", ctor: JWebResourceResponse,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/io/InputStream;)V":
      function (this: JWebResourceResponse, m: string, e: string, d: unknown) { this.mime = m; this.enc = e; this.data = d; },
    "<init>(Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;Ljava/util/Map;Ljava/io/InputStream;)V":
      function (this: JWebResourceResponse, m: string, e: string, st: number, rs: string, h: unknown, d: unknown) {
        this.mime = m; this.enc = e; this.status = st; this.reason = rs; this.headers = h; this.data = d;
      },
    "setStatusCodeAndReasonPhrase(ILjava/lang/String;)V": function (this: JWebResourceResponse, st: number, rs: string) { this.status = st; this.reason = rs; },
    ...fieldGetters({ "getMimeType()Ljava/lang/String;": "mime", "getEncoding()Ljava/lang/String;": "enc",
      "getData()Ljava/io/InputStream;": "data", "getStatusCode()I": "status",
      "getReasonPhrase()Ljava/lang/String;": "reason", "getResponseHeaders()Ljava/util/Map;": "headers" }),
    ...fieldSetters({ "setMimeType(Ljava/lang/String;)V": "mime", "setEncoding(Ljava/lang/String;)V": "enc",
      "setData(Ljava/io/InputStream;)V": "data", "setResponseHeaders(Ljava/util/Map;)V": "headers" }),
  },
});
rt.register({ name: "android/webkit/SslErrorHandler", ctor: class extends JObj {}, methods: { "cancel()V": () => {}, "proceed()V": () => {} } });
class JSslError extends JObj { url = ""; primary = 5; }
rt.register({
  name: "android/net/http/SslError", ctor: JSslError,
  statics: { SSL_NOTYETVALID: 0, SSL_EXPIRED: 1, SSL_IDMISMATCH: 2, SSL_UNTRUSTED: 3, SSL_DATE_INVALID: 4, SSL_INVALID: 5 },
  methods: {
    "getUrl()Ljava/lang/String;": function (this: JSslError) { return this.url; },
    "getPrimaryError()I": function (this: JSslError) { return this.primary; },
    "getCertificate()Landroid/net/http/SslCertificate;": () => null,
  },
});
rt.register({
  name: "android/webkit/RenderProcessGoneDetail", ctor: class extends JObj {},
  methods: { "didCrash()Z": () => 0, "rendererPriorityAtExit()I": () => 0 },
});

// ── URLUtil (AOSP's string rules)
function guessUrl(u: string): string {
  if (!u || /^(about|data|file|javascript):/.test(u)) return u;
  const m = /^(?:(https?|file):\/\/)?(?:([^@/?#]+)@)?([^/:?#]*)(?::(\d+))?(.*)$/.exec(u.endsWith(".") ? u.slice(0, -1) : u);
  if (!m || !m[3]) return u;
  const host = m[3].includes(".") ? m[3] : "www." + m[3] + ".com", path = m[5] || "/";
  return (m[1] ?? "http") + "://" + (m[2] ? m[2] + "@" : "") + host + (m[4] ? ":" + m[4] : "") + (path[0] === "/" ? path : "/" + path);
}
function guessFileName(url: string, disposition: string | null, mime: string | null): string {
  let name = /attachment;\s*filename\s*=\s*("?)([^"]*)\1\s*$/i.exec(disposition ?? "")?.[2].split("/").pop() || null;
  if (!name && url) {
    const u = decodeURIComponent(url).split("?")[0];
    if (!u.endsWith("/")) name = u.slice(u.lastIndexOf("/") + 1) || null;
  }
  name ||= "downloadfile";
  const dot = name.indexOf("."), lmime = mime?.toLowerCase();
  let ext: string | null = null;
  if (dot < 0) {
    if (lmime) ext = MIME_EXT[lmime] ? "." + MIME_EXT[lmime] : lmime === "text/html" ? ".html" : lmime.startsWith("text/") ? ".txt" : null;
    return name + (ext ?? ".bin");
  }
  // an extension that contradicts the declared type is replaced, not appended to
  const fromExt = EXT_MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
  if (lmime && fromExt && fromExt !== lmime && MIME_EXT[lmime]) ext = "." + MIME_EXT[lmime];
  return name.slice(0, dot) + (ext ?? name.slice(dot));
}
const urlIs: Record<string, RegExp> = {
  isHttpUrl: /^http:\/\//i, isHttpsUrl: /^https:\/\//i, isNetworkUrl: /^https?:\/\//i, isAssetUrl: /^file:\/\/\/android_asset\//,
  isResourceUrl: /^file:\/\/\/android_res\//, isFileUrl: /^file:\/\/(?!\/android_(asset|res)\/)/, isContentUrl: /^content:/,
  isDataUrl: /^data:/i, isJavaScriptUrl: /^javascript:/i, isAboutUrl: /^about:/, isValidUrl: /^(file:\/\/|about:|https?:\/\/|javascript:|content:)/i,
};
rt.register({
  name: "android/webkit/URLUtil", ctor: class extends JObj {},
  methods: {
    "static guessUrl(Ljava/lang/String;)Ljava/lang/String;": guessUrl,
    "static guessFileName(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": guessFileName,
    "static stripAnchor(Ljava/lang/String;)Ljava/lang/String;": (u: string) => { const i = u.indexOf("#"); return i < 0 ? u : u.slice(0, i); },
    ...Object.fromEntries(Object.entries(urlIs).map(([n, re]) => [`static ${n}(Ljava/lang/String;)Z`, (u: string | null) => u && re.test(u) ? 1 : 0])),
  },
});

const msgLevels = mkEnumSet("android/webkit/ConsoleMessage$MessageLevel", ["TIP", "LOG", "WARNING", "ERROR", "DEBUG"]);
class JConsoleMessage extends JObj { msg = ""; src = ""; line = 0; level: JSimpleEnum = msgLevels[1]; }
rt.register({
  name: "android/webkit/ConsoleMessage", ctor: JConsoleMessage,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;ILandroid/webkit/ConsoleMessage$MessageLevel;)V":
      function (this: JConsoleMessage, m: string, s: string, l: number, lv: JSimpleEnum) { this.msg = m; this.src = s; this.line = l; this.level = lv; },
    ...fieldGetters({ "message()Ljava/lang/String;": "msg", "sourceId()Ljava/lang/String;": "src",
      "lineNumber()I": "line", "messageLevel()Landroid/webkit/ConsoleMessage$MessageLevel;": "level" }),
  },
});
class JJsResult extends JObj {}
rt.register({ name: "android/webkit/JsResult", ctor: JJsResult, methods: { "confirm()V": () => {}, "cancel()V": () => {} } });
rt.register({
  name: "android/webkit/JsPromptResult", ctor: class extends JJsResult {}, sup: "android/webkit/JsResult",
  methods: { "confirm(Ljava/lang/String;)V": () => {} },
});
