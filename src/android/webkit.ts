// The WebView implementation package. AOSP's android.webkit (WebView, WebViewFactory, the clients)
// runs from bytecode; WebViewFactory loads this module's WebViewFactoryProvider where it would load
// Chromium's, and each WebView's WebViewProvider shows its page in a DOM frame over the display,
// placed where the WebView's draw functor composes. JavaScript interfaces use a separate renderer
// so synchronous page calls can wait while the Java runtime continues executing.

import { rt, JObj, type NativeSpec, type ClassInfo, stubs, fieldGetters, fieldSetters, driven, setDeclared, type Gen } from "../jvm/runtime";
import { mangleMethod, mangleStaticField, parseMethodDesc, jmethod } from "../jvm/abi";
import { vcall, callOn, newObj, linkInit, JThread } from "../jvm/natives/jlang";
import { readStreamFully } from "../jvm/natives/jio";
import { toJsArray } from "../jvm/natives/jcoll";
import { boxBool } from "../jvm/natives/jbox";
import { hostStub } from "./binder";
import { device } from "../shell/config";
import { onMain } from "./mainloop";
import { mkUri } from "./net";
import { appHost } from "./apphost";
import { webCookies, thirdPartyCookies, cookieManager } from "./cookies";
import { WebBridge, type WebInterfaces, type WebRequest, type WebResponse } from "../shell/webbridge";
import { localAsset } from "../shell/localassets";
import { EXT_MIME, MIME_EXT, mimeOf } from "../mime";
import { WEB_INJECT, webFormRequest } from "../shell/webinject";
import { snapshotDocument } from "../shell/websnapshot";
import { webPrintAdapter } from "./printing";
import { canvasOf, type JavaCanvas } from "./canvas";
import { createFunctor, releaseFunctor, drawFunctor, type Rect } from "./webfunctor";

const inst = <T = JObj>(cls: string): T => rt.make(cls);
/** a static of a bytecode class, by name and descriptor */
async function staticOf(cls: string, field: string): Promise<unknown> {
  const info = await linkInit(cls);
  return (info.ctor as unknown as Record<string, unknown>)[info.staticFieldTable.get(field)!];
}

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

// ── WebViewFactory: the provider package is this one, versioned as the Chromium the UA names
const WEBVIEW_PACKAGE = "com.android.webview", WEBVIEW_VERSION = "120.0";
const UA = `Mozilla/5.0 (Linux; Android 13; webdroid) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${WEBVIEW_VERSION} Mobile Safari/537.36`;
const FACTORY = "webdroid/WebViewFactoryProvider";
/** the provider package's PackageInfo */
const webViewPackage = driven(function* webViewPackage$(): Gen<JObj> {
  const pi: JObj = yield newObj("android/content/pm/PackageInfo"), ai: JObj = yield newObj("android/content/pm/ApplicationInfo");
  setDeclared(ai, "android/content/pm/ApplicationInfo", { packageName: WEBVIEW_PACKAGE, processName: WEBVIEW_PACKAGE, flags: 1 }); // FLAG_SYSTEM
  setDeclared(pi, "android/content/pm/PackageInfo", { packageName: WEBVIEW_PACKAGE, versionName: WEBVIEW_VERSION, applicationInfo: ai });
  return pi;
});
rt.register({
  name: "android/webkit/WebViewFactory", ctor: class extends JObj {}, platformClinit: true,
  methods: {
    // getWebViewContextAndSetProvider's package, then the provider class its context's loader finds
    "static getProviderClass()Ljava/lang/Class;": driven(function* (): Gen {
      (rt.link("android/webkit/WebViewFactory").ctor as unknown as Record<string, unknown>)[mangleStaticField("sPackageInfo")] = yield webViewPackage();
      return rt.classFor(FACTORY);
    }),
  },
});
// WebViewUpdateService: the provider package is the only one, current and never updated
rt.register({ name: "webdroid/WebViewUpdateService", ctor: class extends JObj {}, sup: "android/webkit/IWebViewUpdateService$Stub", methods: {
  "getCurrentWebViewPackage()Landroid/content/pm/PackageInfo;": webViewPackage,
  "getCurrentWebViewPackageName()Ljava/lang/String;": () => WEBVIEW_PACKAGE,
} });
hostStub("webviewupdate", "webdroid/WebViewUpdateService");

// ── WebSettings: the app reads back what it wrote, so every setter has its value and getter
const settingsMethods: NonNullable<NativeSpec["methods"]> = {
  // AOSP: null or empty restores the default string
  "setUserAgentString(Ljava/lang/String;)V": function (this: WebSettingsAdapter, s: string | null) { this.v.userAgentString = s || UA; },
  ...stubs(undefined, "setDatabasePath(Ljava/lang/String;)V", "setGeolocationDatabasePath(Ljava/lang/String;)V", "setEnableSmoothTransition(Z)V"),
};
class WebSettingsAdapter extends JObj {
  v: Record<string, unknown> = {
    userAgentString: UA, cacheMode: -1, textZoom: 100, minimumFontSize: 8, minimumLogicalFontSize: 8, defaultFontSize: 16,
    defaultFixedFontSize: 13, mixedContentMode: 1, forceDark: 1, supportZoom: 1, displayZoomControls: 1, allowContentAccess: 1,
    mediaPlaybackRequiresUserGesture: 1, safeBrowsingEnabled: 1, loadsImagesAutomatically: 1, standardFontFamily: "sans-serif",
    fixedFontFamily: "monospace", sansSerifFontFamily: "sans-serif", serifFontFamily: "serif", cursiveFontFamily: "cursive",
    fantasyFontFamily: "fantasy", defaultTextEncodingName: "UTF-8", acceptThirdPartyCookies: 0,
  };
}
function prop(name: string, d: string, get: string | null = "get" + name) {
  const k = name[0].toLowerCase() + name.slice(1);
  settingsMethods[`set${name}(${d})V`] ??= function (this: WebSettingsAdapter, x: unknown) { this.v[k] = x; };
  if (get) settingsMethods[`${get}()${d}`] = function (this: WebSettingsAdapter) { return this.v[k] ?? (d.length === 1 ? 0 : null); };
}
for (const n of ["JavaScriptEnabled", "DomStorageEnabled", "DatabaseEnabled", "UseWideViewPort", "LoadWithOverviewMode", "BuiltInZoomControls",
  "DisplayZoomControls", "MediaPlaybackRequiresUserGesture", "AllowFileAccess", "AllowContentAccess", "AllowFileAccessFromFileURLs",
  "AllowUniversalAccessFromFileURLs", "JavaScriptCanOpenWindowsAutomatically", "SaveFormData", "SavePassword", "OffscreenPreRaster",
  "SafeBrowsingEnabled", "LoadsImagesAutomatically", "BlockNetworkImage", "BlockNetworkLoads", "AcceptThirdPartyCookies"]) prop(n, "Z");
for (const n of ["CacheMode", "MixedContentMode", "TextZoom", "MinimumFontSize", "MinimumLogicalFontSize", "DefaultFontSize",
  "DefaultFixedFontSize", "ForceDark", "DisabledActionModeMenuItems"]) prop(n, "I");
for (const n of ["UserAgentString", "StandardFontFamily", "FixedFontFamily", "SansSerifFontFamily", "SerifFontFamily", "CursiveFontFamily",
  "FantasyFontFamily", "DefaultTextEncodingName"]) prop(n, "Ljava/lang/String;");
prop("SupportZoom", "Z", "supportZoom"); prop("SupportMultipleWindows", "Z", "supportMultipleWindows");
prop("AlgorithmicDarkeningAllowed", "Z", "isAlgorithmicDarkeningAllowed");
prop("GeolocationEnabled", "Z", null); prop("NeedInitialFocus", "Z", null);
prop("LayoutAlgorithm", "Landroid/webkit/WebSettings$LayoutAlgorithm;"); prop("PluginState", "Landroid/webkit/WebSettings$PluginState;");
prop("RenderPriority", "Landroid/webkit/WebSettings$RenderPriority;", null);
rt.register({ name: "webdroid/WebSettings", ctor: WebSettingsAdapter, sup: "android/webkit/WebSettings", methods: settingsMethods });
async function newSettings(): Promise<WebSettingsAdapter> {
  const s = inst<WebSettingsAdapter>("webdroid/WebSettings");
  s.v.layoutAlgorithm = await staticOf("android/webkit/WebSettings$LayoutAlgorithm", "NARROW_COLUMNS:Landroid/webkit/WebSettings$LayoutAlgorithm;");
  s.v.pluginState = await staticOf("android/webkit/WebSettings$PluginState", "OFF:Landroid/webkit/WebSettings$PluginState;");
  return s;
}

// ── the frame layer (shell-owned)
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
  if (!layer) window.addEventListener("message", WebViewChromium.message);
  layerObserver?.disconnect();
  layer = el;
  layerObserver = new ResizeObserver(([entry]) => {
    el.style.setProperty("--wd-web-scale", String(entry.contentRect.width * device.density / device.width));
  });
  layerObserver.observe(el);
}
/** the providers with a frame */
const live = new Set<WebViewChromium>();
/** what a WebView's page holds on the host side; it never references the provider itself */
interface FrameHold { el: HTMLIFrameElement | null; remote: WebBridge | null; port: MessagePort | null; functor: number }
function unbridge(h: FrameHold) {
  if (h.remote) { bridges.delete(h.remote.id); h.remote.close(); h.remote = null; }
  h.port?.close(); h.port = null;
}
function release(h: FrameHold) { unbridge(h); h.el?.remove(); h.el = null; releaseFunctor(h.functor); }
// Chromium destroys an AwContents once its WebView is garbage collected (a CleanupReference), so
// an app that drops a WebView without destroy() does not keep its page. Page-side callbacks and the
// bridge therefore reach a provider only weakly; detaching alone keeps the page, as apps reattach.
const collected = new FinalizationRegistry<FrameHold>(release);
const bridges = new Map<string, WeakRef<WebViewChromium>>();
/** page-side proxies of the interfaces, so the page does not keep the Java objects (and so often its WebView) reachable */
function weakIfaces(of: () => WebInterfaces | null | undefined): WebInterfaces {
  const out: WebInterfaces = Object.create(null);
  for (const [name, methods] of Object.entries(of() ?? {})) {
    const proxy: WebInterfaces[string] = out[name] = Object.create(null);
    for (const m in methods) proxy[m] = async (...args) => of()?.[name]?.[m]?.(...args);
  }
  return out;
}
/** debug: the canvas capture cannot see frame pixels, so this is how a harness proves a page loaded */
export function webViewInfo(): { url: string | null; title: string; loaded: boolean; progress: number; rect: Rect | null }[] {
  return [...live].map((v) => ({ url: v.url, title: v.title, loaded: v.loaded, progress: v.progress, rect: v.rect }));
}

/** what the browser loads for an Android URL: the dev server fronts http(s) and the apk's assets */
function srcFor(url: string, v: WebViewChromium): string {
  if (/^https?:/i.test(url)) return "/proxy?frame=1&url=" + encodeURIComponent(url) + "&ua=" + encodeURIComponent(String(v.settings.v.userAgentString));
  const m = /^file:\/\/\/android_asset\/(.*)$/i.exec(url);
  return m ? "/asset/" + encodeURIComponent(appHost?.assetKey ?? "") + "/assets/" + m[1] : url;
}
/** a frame-side absolute URL back to the Android-visible one the app knows */
function unmap(href: string): string {
  const o = location.origin;
  if (href.startsWith(o + "/proxy?")) {
    const local = new URL(href), source = local.searchParams.get("url");
    if (!source) return href;
    const url = new URL(source); if (local.hash) url.hash = local.hash;
    return url.href;
  }
  const a = o + "/asset/" + encodeURIComponent(appHost?.assetKey ?? "") + "/assets/";
  return href.startsWith(a) ? "file:///android_asset/" + href.slice(a.length) : href;
}
/** the frame's window when its document is ours to script (data: URLs are opaque) */
function win(v: WebViewChromium): Window | null {
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
      out[name] = async (...args: unknown[]) =>
        fromJava(ret, await callOn(thread, () => vcall(o, name, desc, ...params.map((d, i) => toJava(d, args[i])))));
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
class JReq extends JObj { url = ""; main = true; gesture = false; method = "GET"; headers: unknown = null; }
function mkRequest(url: string, gesture = false): JReq {
  const r = inst<JReq>("webdroid/WebResourceRequest");
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
const item = (e: Entry | undefined) => e ? Object.setPrototypeOf(new JWebHistoryItem(e), rt.link("webdroid/WebHistoryItem").ctor.prototype) : null;
rt.register({
  name: "webdroid/WebHistoryItem", ctor: JWebHistoryItem, sup: "android/webkit/WebHistoryItem",
  methods: {
    "getUrl()Ljava/lang/String;": function (this: JWebHistoryItem) { return this.entry.url; },
    "getOriginalUrl()Ljava/lang/String;": function (this: JWebHistoryItem) { return this.entry.url; },
    "getTitle()Ljava/lang/String;": () => null,
    "getFavicon()Landroid/graphics/Bitmap;": () => null,
    "getId()I": () => -1,
    "clone()Landroid/webkit/WebHistoryItem;": function (this: JWebHistoryItem) { return item(this.entry); },
  },
});
rt.register({
  name: "webdroid/WebBackForwardList", ctor: JWebBackForwardList, sup: "android/webkit/WebBackForwardList",
  methods: {
    "getSize()I": function (this: JWebBackForwardList) { return this.entries.length; },
    "getCurrentIndex()I": function (this: JWebBackForwardList) { return this.index; },
    "getCurrentItem()Landroid/webkit/WebHistoryItem;": function (this: JWebBackForwardList) { return item(this.entries[this.index]); },
    "getItemAtIndex(I)Landroid/webkit/WebHistoryItem;": function (this: JWebBackForwardList, index: number) { return item(this.entries[index]); },
    "clone()Landroid/webkit/WebBackForwardList;": function (this: JWebBackForwardList) { return backForward(this.entries, this.index); },
  },
});
const backForward = (entries: Entry[], index: number) =>
  Object.setPrototypeOf(new JWebBackForwardList(entries.map((e) => ({ ...e })), index), rt.link("webdroid/WebBackForwardList").ctor.prototype);

const MS_MODE = 0xc0000000, MS_EXACTLY = 0x40000000, MS_AT_MOST = 0x80000000 | 0, MEASURED_STATE_TOO_SMALL = 0x01000000;

/** Chromium's WebViewChromium: a WebView's WebViewProvider and its view and scroll delegates */
export class WebViewChromium extends JObj {
  view!: JObj;
  access!: JObj;
  settings!: WebSettingsAdapter;
  client = inst("android/webkit/WebViewClient");
  chrome: JObj | null = null;
  dl: unknown = null;
  findListener: unknown = null;
  findQuery = "";
  findCount = 0;
  findOrdinal = 0;
  url: string | null = null;
  title = "";
  progress = 0;
  loaded = false;
  paused = false;
  hist: Entry[] = [];
  idx = -1;
  ifaces: WebInterfaces = Object.create(null);
  /** the interfaces the bridged page was loaded with, as Chromium injects them per load */
  private pageIfaces: WebInterfaces | null = null;
  bridgeThread = Object.assign(new JThread(), { jname: "JavaBridge" });
  private requestThread = Object.assign(new JThread(), { jname: "Chrome_IOThread" });
  private readonly ref = new WeakRef(this);
  readonly hold: FrameHold = { el: null, remote: null, port: null, functor: 0 };
  /** the view's size, which its draw functor covers */
  readonly size = { w: 0, h: 0, place: (rect: Rect | null) => this.ref.deref()?.place(rect) };
  background: string | null = null;
  private remoteOrigin = "";
  remoteWidth = 0;
  remoteHeight = 0;
  private nextEval = 0;
  private evaluations = new Map<number, (value: string) => void>();
  private nextSnapshot = 0;
  private snapshots = new Map<number, { resolve: (data: string) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private pendingScripts = new Map<number, string>();
  private scriptReady = false;
  /** where the content shows, in display pixels, or null when hidden */
  rect: Rect | null = null;
  /** bumped by every load and by stopLoading: a frame event from an older load is ignored */
  gen = 0;

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
        ports[0].postMessage(jar.network(data.url, v.url ?? "", values, thirdPartyCookies.has(v.view))); ports[0].close();
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
  destroy() { this.gen++; this.closeBridge(); collected.unregister(this.hold); release(this.hold); this.rect = null; live.delete(this); }

  frame(): HTMLIFrameElement | null {
    if (this.hold.el || !layer) return this.hold.el;
    const el = this.hold.el = document.createElement("iframe"), ref = this.ref;
    el.referrerPolicy = "no-referrer";
    el.style.cssText = "position:absolute;border:0;pointer-events:auto;transform-origin:top left;transform:scale(var(--wd-web-scale,1))";
    if (this.background) el.style.background = this.background;
    el.hidden = true;
    (el as unknown as { __wdConsole: unknown }).__wdConsole = (data: unknown) => ref.deref()?.consoleMessage(data);
    el.addEventListener("load", () => ref.deref()?.onLoad());
    layer.appendChild(el);
    collected.register(this, this.hold, this.hold);
    live.add(this);
    return el;
  }
  /** the display composed: show the content at the rect its functor drew, or hide it */
  place(rect: Rect | null): void {
    const el = this.hold.el;
    if (!el) return;
    const was = this.rect;
    this.rect = rect;
    if (!rect) { if (was) el.hidden = true; return; }
    if (!was) el.hidden = false;
    if (was && was[0] === rect[0] && was[1] === rect[1] && was[2] === rect[2] && was[3] === rect[3]) return;
    const [l, t, r, b] = rect, s = el.style;
    s.left = l / device.width * 100 + "%"; s.top = t / device.height * 100 + "%";
    s.width = (r - l) / device.density + "px"; s.height = (b - t) / device.density + "px";
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
    void onMain(() => this.gen === g && vcall(this.client, "onPageStarted", "(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V", this.view, url, null));
  }
  loadUrl(url: string) {
    if (/^javascript:/i.test(url)) { this.evalJs(url.slice(11)); return; }
    this.go({ url, src: srcFor(url, this) });
  }
  private async intercept(request: WebRequest): Promise<WebResponse | null> {
    const on = <T>(call: () => T) => callOn(this.requestThread, call);
    const req = mkRequest(request.url);
    req.main = request.main; req.method = request.method;
    req.headers = inst("java/util/HashMap");
    for (const [key, value] of Object.entries(request.headers)) await on(() => vcall(req.headers, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, value));
    const response = await on(() => vcall(this.client, "shouldInterceptRequest", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;", this.view, req)) as JObj | null;
    if (!response) return null;
    const get = <T>(name: string, desc: string) => on(() => vcall(response, name, desc)) as Promise<T>;
    const [mime, enc, status, reason, responseHeaders, data] = [await get<string | null>("getMimeType", "()Ljava/lang/String;"),
      await get<string | null>("getEncoding", "()Ljava/lang/String;"), await get<number>("getStatusCode", "()I"),
      await get<string | null>("getReasonPhrase", "()Ljava/lang/String;"), await get<JObj | null>("getResponseHeaders", "()Ljava/util/Map;"),
      await get<JObj | null>("getData", "()Ljava/io/InputStream;")];
    const headers: Record<string, string> = {};
    const entries = responseHeaders ? await on(() => vcall(responseHeaders, "entrySet", "()Ljava/util/Set;")) : null;
    if (entries) for (const entry of await on(() => toJsArray(entries))) {
      const key = await on(() => vcall(entry, "getKey", "()Ljava/lang/Object;")) as string;
      headers[key] = await on(() => vcall(entry, "getValue", "()Ljava/lang/Object;")) as string;
    }
    if (mime) headers["content-type"] = mime + (enc ? "; charset=" + enc : "");
    let binary = "";
    if (data) {
      try {
        const bytes = await on(() => readStreamFully(data));
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      } finally { await on(() => vcall(data, "close", "()V")); }
    }
    return { body: btoa(binary), status, reason: reason ?? "OK", headers };
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
    const view = this.view, error = inst<JWebErr>("webdroid/WebResourceError");
    error.code = -2; error.desc = err ?? "";
    // Chromium's order; each step re-checks the generation because a callback commonly starts
    // the next load (an app's error page), which ends this one's sequence. The content size
    // changed, which AwLayoutSizer answers with a layout.
    const steps: [unknown, string, string, ...unknown[]][] = [[view, "requestLayout", "()V"], ...(err
      ? [[this.client, "onReceivedError", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V", view, mkRequest(url), error],
         [this.client, "onPageFinished", WV_S, view, url]] as [unknown, string, string, ...unknown[]][]
      : [[this.chrome, "onProgressChanged", "(Landroid/webkit/WebView;I)V", view, 100], [this.chrome, "onReceivedTitle", WV_S, view, this.title],
         [this.client, "onPageCommitVisible", WV_S, view, url], [this.client, "onPageFinished", WV_S, view, url]] as [unknown, string, string, ...unknown[]][])];
    void onMain(async () => { for (const [o, n, d, ...a] of steps) { if (this.gen !== g) return; if (o) await vcall(o, n, d, ...a); } });
  }
  /** an uncaught page error, as Chromium reports it; unhandled messages go to logcat's chromium tag */
  consoleMessage(data: unknown) {
    const { message, source, line } = (data ?? {}) as { message?: unknown; source?: unknown; line?: unknown };
    const msg = String(message), src = typeof source === "string" ? unmap(source) : "", n = typeof line === "number" ? line : 0;
    void onMain(async () => {
      const level = await staticOf("android/webkit/ConsoleMessage$MessageLevel", "ERROR:Landroid/webkit/ConsoleMessage$MessageLevel;");
      const m = await newObj("android/webkit/ConsoleMessage", "(Ljava/lang/String;Ljava/lang/String;ILandroid/webkit/ConsoleMessage$MessageLevel;)V", msg, src, n, level);
      if (!this.chrome || !await vcall(this.chrome, "onConsoleMessage", "(Landroid/webkit/ConsoleMessage;)Z", m))
        console.log("[I/chromium]", `[INFO:CONSOLE(${n})] "${msg}", source: ${src} (${n})`);
    });
  }
  fragmentNavigated(url: string) {
    const g = this.gen, cur = this.hist[this.idx];
    this.url = url;
    if (cur) { cur.url = url; if (cur.src) cur.src = srcFor(url, this); }
    void onMain(async () => {
      if (this.gen !== g) return;
      await vcall(this.client, "doUpdateVisitedHistory", "(Landroid/webkit/WebView;Ljava/lang/String;Z)V", this.view, url, 0);
      if (this.gen === g) await vcall(this.client, "onPageFinished", WV_S, this.view, url);
    });
  }
  /** a link click in the frame is the app's to override, as Chromium asks before navigating */
  private hookLinks(doc: Document) {
    const g = this.gen, ref = this.ref;
    doc.defaultView?.addEventListener("hashchange", event => {
      const v = ref.deref();
      if (event.isTrusted && v?.gen === g) v.fragmentNavigated(unmap(event.newURL));
    });
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null, v = ref.deref();
      if (!a || !v || /^javascript:/i.test(a.href)) return;
      const href = unmap(a.href);
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
      if (await vcall(this.client, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z", this.view, mkRequest(href, true))) return;
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
  /** AwContents.dispatchKeyEvent: an override the client claims, and keys the page cannot take,
   *  go through View's dispatch; the page's navigation keys reach the focused element */
  async keyEvent(event: JObj): Promise<number> {
    const superDispatch = () => vcall(this.access, "super_dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", event);
    if (await vcall(this.client, "shouldOverrideKeyEvent", "(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z", this.view, event)) return superDispatch();
    const code: number = await vcall(event, "getKeyCode", "()I"), key = navigationKeys[code];
    if (!key || !this.hold.el || !this.loaded) return superDispatch();
    const type = await vcall(event, "getAction", "()I") === 0 ? "keydown" : "keyup";
    const init = { key: key[0], code: code === 62 ? "Space" : key[0], keyCode: key[1], which: key[1], bubbles: true, cancelable: true,
      repeat: (await vcall(event, "getRepeatCount", "()I")) > 0 };
    const generation = this.gen;
    // Renderer handlers can call back into Java; never hold the main queue awaiting them.
    void Promise.resolve(this.evalJs(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, ${JSON.stringify(init)}))`)).then((unhandled) => {
      if (unhandled === "true" && this.gen === generation) void onMain(() => vcall(this.client, "onUnhandledKeyEvent", "(Landroid/webkit/WebView;Landroid/view/KeyEvent;)V", this.view, event));
    });
    return 1;
  }
  contentWidth() { return this.hold.remote ? this.remoteWidth : win(this)?.document.documentElement.scrollWidth ?? 0; }
  contentHeight() { return this.hold.remote ? this.remoteHeight : win(this)?.document.documentElement.scrollHeight ?? 0; }
  /** AwLayoutSizer.onMeasure: the given size unless unspecified, the content's height unless the
   *  height is exact or the content exceeds its limit */
  measure(ws: number, hs: number): Promise<unknown> {
    const wMode = ws & MS_MODE, hMode = hs & MS_MODE, wSize = ws & ~MS_MODE, hSize = hs & ~MS_MODE;
    const cw = Math.round(this.contentWidth() * device.density), ch = Math.round(this.contentHeight() * device.density);
    let w = wMode === 0 ? cw : wSize, h = hMode === MS_EXACTLY || hMode === MS_AT_MOST && ch > hSize ? hSize : ch;
    if (w < cw) w |= MEASURED_STATE_TOO_SMALL;
    if (h < ch) h |= MEASURED_STATE_TOO_SMALL;
    return vcall(this.access, "setMeasuredDimension", "(II)V", w, h);
  }
}
/** srcdoc payload: the bridge bootstrap first (after a doctype, or the document goes quirks), then the base */
function srcdoc(data: string, enc: string | null, base: string | null): string {
  if (/^base64$/i.test(enc ?? "")) data = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  const inject = WEB_INJECT + (base ? `<base href="${base.replace(/"/g, "&quot;")}">` : "");
  const dt = /^\s*<!doctype[^>]*>/i.exec(data);
  return dt ? dt[0] + inject + data.slice(dt[0].length) : inject + data;
}
const W = "android/webkit/WebViewProvider";
type P = WebViewChromium;
const loadUrl = function (this: P, u: string) { this.loadUrl(u); };
const page = (scroll: (w: Window) => void) => function (this: P): number { const w = win(this); if (!w) return 0; scroll(w); return 1; };
const viaAccess = (name: string, desc: string) => function (this: P, ...args: unknown[]) { return vcall(this.access, name, desc, ...args); };
rt.register({
  name: "webdroid/WebViewProvider", ctor: WebViewChromium, ifaces: [W, W + "$ViewDelegate", W + "$ScrollDelegate"],
  methods: {
    "init(Ljava/util/Map;Z)V": driven(function* (this: P, interfaces: JObj | null, privateBrowsing: number): Gen {
      if (privateBrowsing) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Private browsing is not supported in WebView.");
      // AwContents draws its container: a ViewGroup otherwise skips onDraw
      yield vcall(this.view, "setWillNotDraw", "(Z)V", 0);
      for (const e of interfaces ? yield toJsArray(yield vcall(interfaces, "entrySet", "()Ljava/util/Set;")) : [])
        this.ifaces[yield vcall(e, "getKey", "()Ljava/lang/Object;")] = bridge(yield vcall(e, "getValue", "()Ljava/lang/Object;"), this.bridgeThread);
    }),
    "getViewDelegate()Landroid/webkit/WebViewProvider$ViewDelegate;": function (this: P) { return this; },
    "getScrollDelegate()Landroid/webkit/WebViewProvider$ScrollDelegate;": function (this: P) { return this; },
    "destroy()V": function (this: P) { this.destroy(); },
    "createPrintDocumentAdapter(Ljava/lang/String;)Landroid/print/PrintDocumentAdapter;": function (this: P, name: string) { return webPrintAdapter(this, name); },
    // AOSP substitutes its default client for null
    "setWebViewClient(Landroid/webkit/WebViewClient;)V": function (this: P, c: JObj | null) { this.client = c ?? inst("android/webkit/WebViewClient"); },
    "setWebChromeClient(Landroid/webkit/WebChromeClient;)V": function (this: P, c: JObj | null) { this.chrome = c; },
    "loadUrl(Ljava/lang/String;)V": loadUrl,
    "loadUrl(Ljava/lang/String;Ljava/util/Map;)V": loadUrl,
    // AOSP: loadData navigates to the data: URL itself; loadDataWithBaseURL's entry is historyUrl (about:blank when absent)
    "loadData(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: P, data: string, mime: string | null, enc: string | null) {
      this.go({ url: `data:${mime ?? "text/html"}${/^base64$/i.test(enc ?? "") ? ";base64" : ""},${data}`, doc: srcdoc(data, enc, null) });
    },
    "loadDataWithBaseURL(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      function (this: P, base: string | null, data: string, _mime: string | null, enc: string | null, hist: string | null) {
        this.go({ url: hist || "about:blank", doc: srcdoc(data, enc, base) });
      },
    "postUrl(Ljava/lang/String;[B)V": function (this: P, url: string, body: Uint8Array) {
      this.go({ url, src: srcFor(url, this), method: "POST", body: body.slice().buffer, contentType: "application/x-www-form-urlencoded" });
    },
    "reload()V": function (this: P) { if (this.idx >= 0) this.go(this.hist[this.idx], false); },
    "stopLoading()V": function (this: P) { this.gen++; win(this)?.stop(); },
    ...fieldGetters({ "getSettings()Landroid/webkit/WebSettings;": "settings",
      "getWebViewClient()Landroid/webkit/WebViewClient;": "client",
      "getWebChromeClient()Landroid/webkit/WebChromeClient;": "chrome", "getUrl()Ljava/lang/String;": "url",
      "getOriginalUrl()Ljava/lang/String;": "url", "getTitle()Ljava/lang/String;": "title",
      "getProgress()I": "progress" }),
    ...fieldSetters({ "setDownloadListener(Landroid/webkit/DownloadListener;)V": "dl",
      "setFindListener(Landroid/webkit/WebView$FindListener;)V": "findListener" }),
    "canGoBack()Z": function (this: P) { return this.idx > 0 ? 1 : 0; },
    "canGoForward()Z": function (this: P) { return this.idx < this.hist.length - 1 ? 1 : 0; },
    "canGoBackOrForward(I)Z": function (this: P, n: number) { const i = this.idx + n; return i >= 0 && i < this.hist.length ? 1 : 0; },
    "goBack()V": function (this: P) { this.step(-1); },
    "goForward()V": function (this: P) { this.step(1); },
    "goBackOrForward(I)V": function (this: P, n: number) { this.step(n); },
    "copyBackForwardList()Landroid/webkit/WebBackForwardList;": function (this: P) { return backForward(this.hist, this.idx); },
    // Chromium prunes every entry but the current one
    "clearHistory()V": function (this: P) { if (this.idx >= 0) { this.hist = [this.hist[this.idx]]; this.idx = 0; } },
    "evaluateJavaScript(Ljava/lang/String;Landroid/webkit/ValueCallback;)V": function (this: P, js: string, cb: unknown) {
      void Promise.resolve(this.evalJs(js)).then((r) => cb && onMain(() => vcall(cb, "onReceiveValue", "(Ljava/lang/Object;)V", r)));
    },
    "addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V": function (this: P, o: JObj, name: string) { this.ifaces[name] = bridge(o, this.bridgeThread); },
    "removeJavascriptInterface(Ljava/lang/String;)V": function (this: P, name: string) { delete this.ifaces[name]; },
    "getContentHeight()I": function (this: P) { return this.contentHeight(); },
    "getContentWidth()I": function (this: P) { return this.contentWidth(); },
    "getScale()F": () => device.density,
    "pageUp(Z)Z": function (this: P, top: number) { return page((w) => w.scrollBy(0, top ? -w.document.documentElement.scrollHeight : -w.innerHeight)).call(this); },
    "pageDown(Z)Z": function (this: P, bottom: number) { return page((w) => w.scrollBy(0, bottom ? w.document.documentElement.scrollHeight : w.innerHeight)).call(this); },
    "findAllAsync(Ljava/lang/String;)V": function (this: P, query: string) { this.findAll(query); },
    "findNext(Z)V": function (this: P, forward: number) { this.findNext(!!forward); },
    "clearMatches()V": function (this: P) {
      this.findQuery = ""; this.findCount = 0; this.findOrdinal = 0;
      void this.evalJs("window.getSelection()?.removeAllRanges()");
    },
    "isPaused()Z": function (this: P) { return this.paused ? 1 : 0; },
    "onPause()V": function (this: P) { this.paused = true; },
    "onResume()V": function (this: P) { this.paused = false; },
    "isPrivateBrowsingEnabled()Z": () => 0,
    "getVisibleTitleHeight()I": () => 0,
    "overlayHorizontalScrollbar()Z": () => 1,
    "overlayVerticalScrollbar()Z": () => 0,
    "getHitTestResult()Landroid/webkit/WebView$HitTestResult;": () => newObj("android/webkit/WebView$HitTestResult"),
    "getRendererRequestedPriority()I": () => 2,
    "getRendererPriorityWaivedWhenNotVisible()Z": () => 0,
    // what Chromium accepts and keeps no visible state for here
    ...Object.fromEntries(["setHorizontalScrollbarOverlay(Z)V", "setVerticalScrollbarOverlay(Z)V", "setMapTrackballToArrowKeys(Z)V",
      "notifyFindDialogDismissed()V", "freeMemory()V", "clearView()V", "setInitialScale(I)V", "setRendererPriorityPolicy(IZ)V",
      "setPictureListener(Landroid/webkit/WebView$PictureListener;)V"].map((sig) => [sig, () => {}])),
    ...stubs(undefined, "setNetworkAvailable(Z)V", "pauseTimers()V", "resumeTimers()V", "clearCache(Z)V", "clearFormData()V",
      "clearSslPreferences()V", "flingScroll(II)V", "invokeZoomPicker()V",
      "setWebViewRenderProcessClient(Ljava/util/concurrent/Executor;Landroid/webkit/WebViewRenderProcessClient;)V"),
    ...stubs(null, "getFavicon()Landroid/graphics/Bitmap;", "getTouchIconUrl()Ljava/lang/String;", "getCertificate()Landroid/net/http/SslCertificate;",
      "saveState(Landroid/os/Bundle;)Landroid/webkit/WebBackForwardList;", "restoreState(Landroid/os/Bundle;)Landroid/webkit/WebBackForwardList;",
      "getWebViewRenderProcess()Landroid/webkit/WebViewRenderProcess;", "getWebViewRenderProcessClient()Landroid/webkit/WebViewRenderProcessClient;",
      "getZoomControls()Landroid/view/View;"),
    ...stubs(0, "canZoomIn()Z", "canZoomOut()Z", "zoomIn()Z", "zoomOut()Z", "zoomBy(F)Z", "showFindDialog(Ljava/lang/String;Z)Z"),

    // ── ViewDelegate: what Chromium leaves to View goes through WebView.PrivateAccess
    "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: P, canvas: JavaCanvas): Gen {
      const nc = canvasOf(canvas);
      if (nc.bmp) {
        // a software capture of the view: the page's pixels
        const image = yield this.bitmapSnapshot();
        try { nc.ctx.drawImage(image, 0, 0, this.size.w, this.size.h); } finally { image.close(); }
      } else if (rt.iof(canvas, "android/graphics/RecordingCanvas")) {
        yield vcall(factory().delegate, "drawWebViewFunctor", "(Landroid/graphics/Canvas;I)V", canvas, this.hold.functor);
      } else drawFunctor(nc.ctx, this.hold.functor, [nc.cl, nc.ct, nc.cr, nc.cb]);
    }),
    "onSizeChanged(IIII)V": function (this: P, w: number, h: number) { this.size.w = w; this.size.h = h; },
    "onMeasure(II)V": function (this: P, ws: number, hs: number) { return this.measure(ws, hs); },
    "setBackgroundColor(I)V": function (this: P, color: number) {
      this.background = `rgba(${color >> 16 & 255},${color >> 8 & 255},${color & 255},${(color >>> 24) / 255})`;
      if (this.hold.el) this.hold.el.style.background = this.background;
    },
    "dispatchKeyEvent(Landroid/view/KeyEvent;)Z": function (this: P, event: JObj) { return this.keyEvent(event); },
    "setFrame(IIII)Z": viaAccess("super_setFrame", "(IIII)Z"),
    "setLayoutParams(Landroid/view/ViewGroup$LayoutParams;)V": viaAccess("super_setLayoutParams", "(Landroid/view/ViewGroup$LayoutParams;)V"),
    "requestFocus(ILandroid/graphics/Rect;)Z": viaAccess("super_requestFocus", "(ILandroid/graphics/Rect;)Z"),
    "performLongClick()Z": viaAccess("super_performLongClick", "()Z"),
    "performAccessibilityAction(ILandroid/os/Bundle;)Z": viaAccess("super_performAccessibilityAction", "(ILandroid/os/Bundle;)Z"),
    "onGenericMotionEvent(Landroid/view/MotionEvent;)Z": viaAccess("super_onGenericMotionEvent", "(Landroid/view/MotionEvent;)Z"),
    "onHoverEvent(Landroid/view/MotionEvent;)Z": viaAccess("super_onHoverEvent", "(Landroid/view/MotionEvent;)Z"),
    "onDrawVerticalScrollBar(Landroid/graphics/Canvas;Landroid/graphics/drawable/Drawable;IIII)V":
      viaAccess("super_onDrawVerticalScrollBar", "(Landroid/graphics/Canvas;Landroid/graphics/drawable/Drawable;IIII)V"),
    // the page's own frame takes pointer input in the browser, so the WebView consumes what reaches it as Android events
    "onTouchEvent(Landroid/view/MotionEvent;)Z": () => 1,
    "shouldDelayChildPressedState()Z": () => 1,
    "getHandler(Landroid/os/Handler;)Landroid/os/Handler;": (h: unknown) => h,
    "findFocus(Landroid/view/View;)Landroid/view/View;": (v: unknown) => v,
    "onKeyDown(ILandroid/view/KeyEvent;)Z": () => 0,
    "onKeyUp(ILandroid/view/KeyEvent;)Z": () => 0,
    "onKeyMultiple(IILandroid/view/KeyEvent;)Z": () => 0,
    "onTrackballEvent(Landroid/view/MotionEvent;)Z": () => 0,
    "onDragEvent(Landroid/view/DragEvent;)Z": () => 0,
    "requestChildRectangleOnScreen(Landroid/view/View;Landroid/graphics/Rect;Z)Z": () => 0,
    "getAccessibilityNodeProvider()Landroid/view/accessibility/AccessibilityNodeProvider;": () => null,
    "onCreateInputConnection(Landroid/view/inputmethod/EditorInfo;)Landroid/view/inputmethod/InputConnection;": () => null,
    // placement follows the draw functor, so attachment, visibility and scroll need nothing more
    ...Object.fromEntries(["onAttachedToWindow()V", "onDetachedFromWindow()V", "onVisibilityChanged(Landroid/view/View;I)V",
      "onWindowVisibilityChanged(I)V", "onWindowFocusChanged(Z)V", "onFocusChanged(ZILandroid/graphics/Rect;)V",
      "onScrollChanged(IIII)V", "onOverScrolled(IIZZ)V", "setOverScrollMode(I)V", "setScrollBarStyle(I)V", "setLayerType(ILandroid/graphics/Paint;)V",
      "preDispatchDraw(Landroid/graphics/Canvas;)V", "onStartTemporaryDetach()V", "onFinishTemporaryDetach()V",
      "onConfigurationChanged(Landroid/content/res/Configuration;)V", "onProvideVirtualStructure(Landroid/view/ViewStructure;)V",
      "onInitializeAccessibilityNodeInfo(Landroid/view/accessibility/AccessibilityNodeInfo;)V",
      "onInitializeAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)V"].map((sig) => [sig, () => {}])),
    ...stubs(undefined, "onActivityResult(IILandroid/content/Intent;)V"),

    // ── ScrollDelegate: the page scrolls inside its frame, so the view itself never scrolls
    "computeHorizontalScrollRange()I": function (this: P) { return this.size.w; },
    "computeVerticalScrollRange()I": function (this: P) { return this.size.h; },
    "computeVerticalScrollExtent()I": function (this: P) { return this.size.h; },
    "computeHorizontalScrollOffset()I": () => 0,
    "computeVerticalScrollOffset()I": () => 0,
    "computeScroll()V": () => {},
  },
});

// ── the factory and what AOSP's statics reach through it
class Factory extends JObj {
  delegate!: JObj;
  statics = inst("webdroid/WebViewStatics");
  database: JObj | null = null;
  geolocation: JObj | null = null;
  storage: JObj | null = null;
  serviceWorker: JObj | null = null;
  tracing: JObj | null = null;
}
let theFactory: Factory | null = null;
const factory = () => theFactory!;
rt.register({
  name: FACTORY, ctor: Factory, ifaces: ["android/webkit/WebViewFactoryProvider"],
  methods: {
    "static create(Landroid/webkit/WebViewDelegate;)Landroid/webkit/WebViewFactoryProvider;": (delegate: JObj) => {
      const f = theFactory = inst<Factory>(FACTORY);
      f.delegate = delegate;
      return f;
    },
    "createWebView(Landroid/webkit/WebView;Landroid/webkit/WebView$PrivateAccess;)Landroid/webkit/WebViewProvider;": driven(function* (view: JObj, access: JObj): Gen {
      const p = inst<WebViewChromium>("webdroid/WebViewProvider");
      p.view = view; p.access = access; p.settings = yield newSettings();
      p.hold.functor = createFunctor(p.size);
      return p;
    }),
    "getStatics()Landroid/webkit/WebViewFactoryProvider$Statics;": function (this: Factory) { return this.statics; },
    "getCookieManager()Landroid/webkit/CookieManager;": () => cookieManager(),
    "getWebViewDatabase(Landroid/content/Context;)Landroid/webkit/WebViewDatabase;": function (this: Factory) { return this.database ??= inst("webdroid/WebViewDatabase"); },
    // the bases answer no origins: nothing here keeps per-origin grants or quotas
    "getGeolocationPermissions()Landroid/webkit/GeolocationPermissions;": driven(function* (this: Factory): Gen { return this.geolocation ??= yield newObj("android/webkit/GeolocationPermissions"); }),
    "getWebStorage()Landroid/webkit/WebStorage;": driven(function* (this: Factory): Gen { return this.storage ??= yield newObj("android/webkit/WebStorage"); }),
    "getServiceWorkerController()Landroid/webkit/ServiceWorkerController;": function (this: Factory) { return this.serviceWorker ??= inst("webdroid/ServiceWorkerController"); },
    "getTracingController()Landroid/webkit/TracingController;": function (this: Factory) { return this.tracing ??= inst("webdroid/TracingController"); },
    "getWebViewClassLoader()Ljava/lang/ClassLoader;": () => vcall(rt.classFor(FACTORY), "getClassLoader", "()Ljava/lang/ClassLoader;"),
    ...stubs(null, "getTokenBindingService()Landroid/webkit/TokenBindingService;", "getWebIconDatabase()Landroid/webkit/WebIconDatabase;"),
  },
});
rt.register({
  name: "webdroid/WebViewStatics", ctor: class extends JObj {}, ifaces: ["android/webkit/WebViewFactoryProvider$Statics"],
  methods: {
    "getDefaultUserAgent(Landroid/content/Context;)Ljava/lang/String;": () => UA,
    "setWebContentsDebuggingEnabled(Z)V": () => {},
    "enableSlowWholeDocumentDraw()V": () => {},
    "freeMemoryForTests()V": () => {},
    "clearClientCertPreferences(Ljava/lang/Runnable;)V": (done: JObj | null) => { if (done) void onMain(() => vcall(done, "run", "()V")); },
    // there is no Safe Browsing service: initialization reports that it did not start
    "initSafeBrowsing(Landroid/content/Context;Landroid/webkit/ValueCallback;)V": (_c: unknown, cb: JObj | null) => {
      if (cb) void onMain(() => vcall(cb, "onReceiveValue", "(Ljava/lang/Object;)V", boxBool(false)));
    },
  },
});
rt.register({
  name: "webdroid/WebViewDatabase", ctor: class extends JObj {}, sup: "android/webkit/WebViewDatabase",
  methods: {
    // the frames keep no form data or credentials for the app to see
    ...stubs(0, "hasFormData()Z", "hasHttpAuthUsernamePassword()Z", "hasUsernamePassword()Z"),
    ...stubs(undefined, "clearFormData()V", "clearHttpAuthUsernamePassword()V", "clearUsernamePassword()V",
      "setHttpAuthUsernamePassword(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V"),
    ...stubs(null, "getHttpAuthUsernamePassword(Ljava/lang/String;Ljava/lang/String;)[Ljava/lang/String;"),
  },
});
rt.register({
  name: "webdroid/ServiceWorkerController", ctor: class extends JObj { client: unknown = null; }, sup: "android/webkit/ServiceWorkerController",
  methods: { ...fieldSetters({ "setServiceWorkerClient(Landroid/webkit/ServiceWorkerClient;)V": "client" }) },
});
rt.register({
  name: "webdroid/TracingController", ctor: class extends JObj {}, sup: "android/webkit/TracingController",
  methods: { "isTracing()Z": () => 0 },
});

// ── request and error values the provider hands its clients
rt.register({
  name: "webdroid/WebResourceRequest", ctor: JReq, ifaces: ["android/webkit/WebResourceRequest"],
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
  name: "webdroid/WebResourceError", ctor: JWebErr, sup: "android/webkit/WebResourceError",
  methods: {
    "getErrorCode()I": function (this: JWebErr) { return this.code; },
    "getDescription()Ljava/lang/CharSequence;": function (this: JWebErr) { return this.desc; },
  },
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
  const fromExt = mimeOf(name);
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
