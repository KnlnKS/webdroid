// android.webkit. The canvas cannot rasterise a web page, so a WebView is an <iframe> the shell
// parks in a DOM layer over the framebuffer: each draw pass stamps the views it painted and the
// sweep afterwards shows exactly those, at the rect their view tree laid out. The dev server
// fronts http(s) (same-origin, un-framed) and the apk's assets, which keeps every frame document
// scriptable from here: JS bridge, evaluateJavascript and link interception all rely on it.

import { rt, JObj, type NativeSpec, type ClassInfo, maySuspend } from "../jvm/runtime";
import { mangleMethod, parseMethodDesc } from "../jvm/abi";
import { vcall, mkEnumSet, type JSimpleEnum } from "../jvm/natives/jlang";
import { JViewGroup, initViewFromCtx, defaultSize, type JView } from "./view";
import { device } from "../shell/config";
import { onMain } from "./mainloop";
import { type JContext } from "./context";
import { mkUri } from "./net";
import { WEB_INJECT } from "../shell/webinject";

const inst = <T = JObj>(cls: string): T => new (rt.link(cls).ctor)();

const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", json: "application/json", xml: "text/xml",
  csv: "text/csv", txt: "text/plain", pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg",
  apk: "application/vnd.android.package-archive", db: "application/octet-stream",
};
const MIME_EXT: Record<string, string> = {};
for (const [e, m] of Object.entries(EXT_MIME)) MIME_EXT[m] ??= e;
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
const UA = "Mozilla/5.0 (Linux; Android 13; webdroid) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
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

// ── the frame layer (shell-owned) and the per-frame sweep
let layer: HTMLElement | null = null;
/** the shell's <div> that sits exactly over the canvas; without one every WebView stays inert */
export function setWebLayer(el: HTMLElement) { layer = el; }
let frame = 1;
const live = new Set<JWebView>();
/** after each canvas draw pass: show the WebViews that pass painted, at their on-screen rect */
export function webLayerSweep(top: number, covered: boolean): void {
  for (const v of live) {
    if (!v.el) continue;
    const show = v.drawnAt === frame && !covered && v.place(top);
    if (show !== v.shown) { v.shown = show; v.el.hidden = !show; }
  }
  frame++;
}
/** debug: the canvas capture cannot see frame pixels, so this is how a harness proves a page loaded */
export function webViewInfo(): { url: string | null; title: string; loaded: boolean; progress: number; rect: [number, number, number, number] }[] {
  return [...live].map((v) => ({ url: v.url, title: v.title, loaded: v.loaded, progress: v.progress, rect: [v.x0, v.y0, v.x1, v.y1] }));
}

const apkOf = (v: JView) => (v.ctx as JContext | null)?.$host?.apkFile ?? "";
/** what the browser loads for an Android URL: the dev server fronts http(s) and the apk's assets */
function srcFor(url: string, v: JWebView): string {
  if (/^https?:/i.test(url)) return "/proxy?frame=1&url=" + encodeURIComponent(url);
  const m = /^file:\/\/\/android_asset\/(.*)$/i.exec(url);
  return m ? "/asset/" + encodeURIComponent(apkOf(v)) + "/assets/" + m[1] : url;
}
/** a frame-side absolute URL back to the Android-visible one the app knows */
function unmap(href: string, v: JWebView): string {
  const o = location.origin;
  if (href.startsWith(o + "/proxy?")) return new URL(href).searchParams.get("url") ?? href;
  const a = o + "/asset/" + encodeURIComponent(apkOf(v)) + "/assets/";
  return href.startsWith(a) ? "file:///android_asset/" + href.slice(a.length) : href;
}
/** the frame's window when its document is ours to script (data: URLs are opaque) */
function win(v: JWebView): Window | null {
  const w = v.el?.contentWindow ?? null;
  try { return w?.document ? w : null; } catch { return null; }
}
const toJava = (d: string, x: unknown): unknown =>
  d === "J" ? BigInt(Math.trunc(Number(x)) || 0) : d === "Z" ? (x ? 1 : 0) : d === "F" || d === "D" ? Number(x)
  : d === "C" ? String(x).charCodeAt(0) | 0 : d.length === 1 ? Number(x) | 0 : x;
const fromJava = (d: string, r: unknown): unknown => d === "J" ? Number(r) : d === "Z" ? !!r : d === "V" ? undefined : r;
/**
 * The page-side face of a Java object: one function per @JavascriptInterface method (past API 17
 * AOSP exposes nothing else). Android's bridge blocks the page's JS thread until Java returns; a
 * compiled Java method here is async, so every call returns a Promise instead -- a deliberate
 * deviation a page has to await.
 */
function bridge(o: JObj): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let ci = (o.constructor as unknown as { $i?: ClassInfo }).$i ?? null; ci && ci.def && ci.dex; ci = ci.superInfo) {
    const dex = ci.dex, annos = dex.classAnnotations(ci.def).methods;
    for (const m of ci.def.virtualMethods) {
      const name = dex.method(m.methodIdx).name;
      if ((m.flags & 9) !== 1 || name in out || !annos.get(m.methodIdx)?.some((a) => a.type === "android/webkit/JavascriptInterface")) continue;
      const desc = dex.methodDesc(m.methodIdx), { params, ret } = parseMethodDesc(desc);
      out[name] = async (...args: unknown[]) => fromJava(ret, await vcall(o, name, desc, ...params.map((d, i) => toJava(d, args[i]))));
    }
  }
  return out;
}

const WV_S = "(Landroid/webkit/WebView;Ljava/lang/String;)V";
const REQ = "com/android/webview/chromium/WebViewContentsClientAdapter$WebResourceRequestAdapter";
class JReq extends JObj { url = ""; main = true; gesture = false; }
function mkRequest(url: string, gesture = false): JReq {
  const r = inst<JReq>(REQ);
  r.url = url; r.gesture = gesture;
  return r;
}
class JWebErr extends JObj { code = -1; desc = ""; }

interface Entry { url: string; src?: string; doc?: string }
class JWebView extends JViewGroup {
  settings = inst<JWebSettings>("android/webkit/WebSettings");
  client = inst("android/webkit/WebViewClient");
  chrome = inst("android/webkit/WebChromeClient");
  dl: unknown = null;
  url: string | null = null;
  title = "";
  progress = 0;
  loaded = false;
  hist: Entry[] = [];
  idx = -1;
  ifaces: Record<string, unknown> = {};
  el: HTMLIFrameElement | null = null;
  drawnAt = 0;
  shown = false;
  /** bumped by every load and by stopLoading: a frame event from an older load is ignored */
  gen = 0;
  x0 = 0; y0 = 0; x1 = 0; y1 = 0;

  frame(): HTMLIFrameElement | null {
    if (this.el || !layer) return this.el;
    const el = this.el = document.createElement("iframe");
    el.style.cssText = "position:absolute;border:0;pointer-events:auto";
    el.hidden = true;
    (el as unknown as { __wdIfaces: unknown }).__wdIfaces = this.ifaces;
    el.addEventListener("load", () => this.onLoad());
    layer.appendChild(el);
    return el;
  }
  go(e: Entry, push = true) {
    if (push) { this.hist.length = ++this.idx; this.hist.push(e); }
    this.url = e.url; this.loaded = false; this.progress = 10; this.title = "";
    const g = ++this.gen, el = this.frame();
    if (el) {
      if (e.doc !== undefined) el.srcdoc = e.doc;
      else { el.removeAttribute("srcdoc"); el.src = e.src!; }
    }
    void onMain(() => this.gen === g && vcall(this.client, "onPageStarted", "(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V", this, e.url, null));
  }
  loadUrl(url: string) {
    if (/^javascript:/i.test(url)) { this.evalJs(url.slice(11)); return; }
    this.go({ url, src: srcFor(url, this) });
  }
  step(n: number) {
    const i = this.idx + n;
    if (i < 0 || i >= this.hist.length) return;
    this.idx = i;
    this.go(this.hist[i], false);
  }
  private onLoad() {
    const g = this.gen, url = this.url ?? "", cur = this.hist[this.idx];
    const doc = this.el!.contentDocument;
    // the iframe's initial about:blank fires load too; it is nobody's navigation
    if (doc?.URL === "about:blank" && cur?.src !== "about:blank") return;
    const err = doc?.querySelector('meta[name="wd-proxy-error"]')?.getAttribute("content");
    if (doc && !err) this.hookLinks(doc);
    this.loaded = !err; this.progress = 100; this.title = doc?.title || url;
    // Chromium's order; each step re-checks the generation because a callback commonly starts
    // the next load (an app's error page), which ends this one's sequence
    const steps: [unknown, string, string, ...unknown[]][] = err
      ? [[this.client, "onReceivedError", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V", this, mkRequest(url), Object.assign(new JWebErr(), { code: -2, desc: err })],
         [this.client, "onPageFinished", WV_S, this, url]]
      : [[this.chrome, "onProgressChanged", "(Landroid/webkit/WebView;I)V", this, 100], [this.chrome, "onReceivedTitle", WV_S, this, this.title],
         [this.client, "onPageCommitVisible", WV_S, this, url], [this.client, "onPageFinished", WV_S, this, url]];
    void onMain(async () => { for (const [o, n, d, ...a] of steps) { if (this.gen !== g) return; await vcall(o, n, d, ...a); } });
  }
  /** a link click in the frame is the app's to override, as Chromium asks before navigating */
  private hookLinks(doc: Document) {
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || /^javascript:/i.test(a.href)) return;
      const href = unmap(a.href, this);
      if (a.hash && href.split("#")[0] === (this.url ?? "").split("#")[0]) return; // same-document fragment: no navigation
      e.preventDefault();
      void onMain(async () => {
        if (await vcall(this.client, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z", this, mkRequest(href, true))) return;
        this.loadUrl(href);
      });
    }, true);
  }
  /** Chromium JSON-encodes the completion value; undefined, functions and throws all read as null */
  evalJs(js: string): string {
    const w = win(this);
    if (!w) return "null";
    try { return JSON.stringify((w as unknown as { eval(s: string): unknown }).eval(js)) ?? "null"; } catch { return "null"; }
  }
  /** screen rect of the view: up the tree, clipped by each ancestor the way its dispatchDraw clips */
  place(top: number): boolean {
    let l = 0, t = 0, r = this.width(), b = this.height(), v: JView = this;
    for (;;) {
      const p = v.parent;
      const dx = v.left + v.translationX - (p ? p.scrollX : 0), dy = v.top + v.translationY - (p ? p.scrollY : 0);
      l += dx; t += dy; r += dx; b += dy;
      if (!p) break;
      if (l < 0) l = 0; if (t < 0) t = 0; if (r > p.width()) r = p.width(); if (b > p.height()) b = p.height();
      v = p;
    }
    t += top; b += top;
    if (l < 0) l = 0; if (t < 0) t = 0; if (r > device.width) r = device.width; if (b > device.height) b = device.height;
    if (r <= l || b <= t) return false;
    if (l !== this.x0 || t !== this.y0 || r !== this.x1 || b !== this.y1) {
      this.x0 = l; this.y0 = t; this.x1 = r; this.y1 = b;
      // percentages: the canvas is CSS-scaled and the layer scales with it
      const s = this.el!.style;
      s.left = l / device.width * 100 + "%"; s.top = t / device.height * 100 + "%";
      s.width = (r - l) / device.width * 100 + "%"; s.height = (b - t) / device.height * 100 + "%";
    }
    return true;
  }
  hide() { if (this.shown) { this.shown = false; this.el!.hidden = true; } }
}
/** srcdoc payload: the bridge bootstrap first (after a doctype, or the document goes quirks), then the base */
function srcdoc(data: string, enc: string | null, base: string | null): string {
  if (/^base64$/i.test(enc ?? "")) data = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  const inject = WEB_INJECT + (base ? `<base href="${base.replace(/"/g, "&quot;")}">` : "");
  const dt = /^\s*<!doctype[^>]*>/i.exec(data);
  return dt ? dt[0] + inject + data.slice(dt[0].length) : inject + data;
}
const wvCtor = async function (this: JWebView, c: unknown, set: unknown = null) { await initViewFromCtx(this, c, set as null); };
rt.register({
  name: "android/webkit/WebView", ctor: JWebView, sup: "android/view/ViewGroup",
  statics: { RENDERER_PRIORITY_WAIVED: 0, RENDERER_PRIORITY_BOUND: 1, RENDERER_PRIORITY_IMPORTANT: 2, SCHEME_TEL: "tel:", SCHEME_MAILTO: "mailto:", SCHEME_GEO: "geo:0,0?q=" },
  methods: {
    "<init>(Landroid/content/Context;)V": wvCtor,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": wvCtor,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": wvCtor,
    // AOSP WebView measures like a plain View (getDefaultSize fills AT_MOST); ViewGroup's wraps children
    "onMeasure(II)V": function (this: JWebView, w: number, h: number) {
      this.measuredW = defaultSize(Math.max(this.minW, this.padL + this.padR), w);
      this.measuredH = defaultSize(Math.max(this.minH, this.padT + this.padB), h);
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JWebView) { this.drawnAt = frame; live.add(this); },
    "onDetachedFromWindow()V": function (this: JWebView) { this.hide(); },
    "destroy()V": function (this: JWebView) { this.gen++; this.hide(); this.el?.remove(); this.el = null; live.delete(this); },
    "getSettings()Landroid/webkit/WebSettings;": function (this: JWebView) { return this.settings; },
    // AOSP substitutes its default client for null
    "setWebViewClient(Landroid/webkit/WebViewClient;)V": function (this: JWebView, c: JObj | null) { this.client = c ?? inst("android/webkit/WebViewClient"); },
    "getWebViewClient()Landroid/webkit/WebViewClient;": function (this: JWebView) { return this.client; },
    "setWebChromeClient(Landroid/webkit/WebChromeClient;)V": function (this: JWebView, c: JObj | null) { this.chrome = c ?? inst("android/webkit/WebChromeClient"); },
    "getWebChromeClient()Landroid/webkit/WebChromeClient;": function (this: JWebView) { return this.chrome; },
    "setDownloadListener(Landroid/webkit/DownloadListener;)V": function (this: JWebView, l: unknown) { this.dl = l; },
    "loadUrl(Ljava/lang/String;)V": function (this: JWebView, u: string) { this.loadUrl(u); },
    "loadUrl(Ljava/lang/String;Ljava/util/Map;)V": function (this: JWebView, u: string) { this.loadUrl(u); },
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
    "getUrl()Ljava/lang/String;": function (this: JWebView) { return this.url; },
    "getOriginalUrl()Ljava/lang/String;": function (this: JWebView) { return this.url; },
    "getTitle()Ljava/lang/String;": function (this: JWebView) { return this.title; },
    "getProgress()I": function (this: JWebView) { return this.progress; },
    "getFavicon()Landroid/graphics/Bitmap;": () => null,
    "canGoBack()Z": function (this: JWebView) { return this.idx > 0 ? 1 : 0; },
    "canGoForward()Z": function (this: JWebView) { return this.idx < this.hist.length - 1 ? 1 : 0; },
    "canGoBackOrForward(I)Z": function (this: JWebView, n: number) { const i = this.idx + n; return i >= 0 && i < this.hist.length ? 1 : 0; },
    "goBack()V": function (this: JWebView) { this.step(-1); },
    "goForward()V": function (this: JWebView) { this.step(1); },
    "goBackOrForward(I)V": function (this: JWebView, n: number) { this.step(n); },
    // Chromium prunes every entry but the current one
    "clearHistory()V": function (this: JWebView) { if (this.idx >= 0) { this.hist = [this.hist[this.idx]]; this.idx = 0; } },
    "evaluateJavascript(Ljava/lang/String;Landroid/webkit/ValueCallback;)V": maySuspend(function (this: JWebView, js: string, cb: unknown) {
      const r = this.evalJs(js);
      if (cb) void onMain(() => vcall(cb, "onReceiveValue", "(Ljava/lang/Object;)V", r));
    }),
    "addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V": function (this: JWebView, o: JObj, name: string) { this.ifaces[name] = bridge(o); },
    "removeJavascriptInterface(Ljava/lang/String;)V": function (this: JWebView, name: string) { delete this.ifaces[name]; },
    "getContentHeight()I": function (this: JWebView) { return win(this)?.document.documentElement.scrollHeight ?? 0; },
    "getScale()F": () => device.density,
    "setInitialScale(I)V": () => {},
    "pageUp(Z)Z": function (this: JWebView, top: number) { const w = win(this); if (!w) return 0; w.scrollBy(0, top ? -w.document.documentElement.scrollHeight : -w.innerHeight); return 1; },
    "pageDown(Z)Z": function (this: JWebView, bottom: number) { const w = win(this); if (!w) return 0; w.scrollBy(0, bottom ? w.document.documentElement.scrollHeight : w.innerHeight); return 1; },
    "scrollTo(II)V": () => {}, "flingScroll(II)V": () => {},
    "zoomIn()Z": () => 0, "zoomOut()Z": () => 0,
    "onPause()V": () => {}, "onResume()V": () => {}, "pauseTimers()V": () => {}, "resumeTimers()V": () => {},
    "clearCache(Z)V": () => {}, "clearFormData()V": () => {}, "clearSslPreferences()V": () => {}, "clearMatches()V": () => {},
    "setNetworkAvailable(Z)V": () => {}, "setRendererPriorityPolicy(IZ)V": () => {}, "setFindListener(Landroid/webkit/WebView$FindListener;)V": () => {},
    "saveState(Landroid/os/Bundle;)Landroid/webkit/WebBackForwardList;": () => null,
    "restoreState(Landroid/os/Bundle;)Landroid/webkit/WebBackForwardList;": () => null,
    "getCertificate()Landroid/net/http/SslCertificate;": () => null,
    "isPrivateBrowsingEnabled()Z": () => 0,
    "requestFocusFromTouch()Z": () => 1,
    "static setWebContentsDebuggingEnabled(Z)V": () => {},
    "static enableSlowWholeDocumentDraw()V": () => {},
    "static setDataDirectorySuffix(Ljava/lang/String;)V": () => {},
    "static disableWebView()V": () => {},
    // no WebView apk is installed here; androidx.webkit reads null as "framework features only"
    // the provider is this frame layer, at the version the user agent already claims
    "static getCurrentWebViewPackage()Landroid/content/pm/PackageInfo;": () => {
      const pi = inst<{ packageName: string; versionName: string; versionCode: number; longVersionCode: bigint }>("android/content/pm/PackageInfo");
      pi.packageName = "com.android.webview"; pi.versionName = /Chrome\/([\d.]+)/.exec(UA)![1];
      pi.versionCode = parseInt(pi.versionName); pi.longVersionCode = BigInt(pi.versionCode);
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
    "<init>()V": function () {},
    "shouldOverrideUrlLoading(Landroid/webkit/WebView;Ljava/lang/String;)Z": () => 0,
    // AOSP forwards the request overload to the String one, so a subclass overriding either sees the click
    "shouldOverrideUrlLoading(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z": maySuspend(function (this: JObj, v: JWebView, r: JReq) {
      return vcall(this, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Ljava/lang/String;)Z", v, r.url);
    }),
    "onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V": () => {},
    "onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V": () => {},
    "onPageCommitVisible(Landroid/webkit/WebView;Ljava/lang/String;)V": () => {},
    "onLoadResource(Landroid/webkit/WebView;Ljava/lang/String;)V": () => {},
    "onReceivedError(Landroid/webkit/WebView;ILjava/lang/String;Ljava/lang/String;)V": () => {},
    // AOSP forwards a main-frame error to the legacy overload
    "onReceivedError(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V": maySuspend(function (this: JObj, v: JWebView, r: JReq, e: JWebErr) {
      if (r.main) return vcall(this, "onReceivedError", "(Landroid/webkit/WebView;ILjava/lang/String;Ljava/lang/String;)V", v, e.code, e.desc, r.url);
    }),
    "onReceivedHttpError(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceResponse;)V": () => {},
    "onReceivedSslError(Landroid/webkit/WebView;Landroid/webkit/SslErrorHandler;Landroid/net/http/SslError;)V": maySuspend((_v: unknown, h: unknown) => vcall(h, "cancel", "()V")),
    "onReceivedHttpAuthRequest(Landroid/webkit/WebView;Landroid/webkit/HttpAuthHandler;Ljava/lang/String;Ljava/lang/String;)V": maySuspend((_v: unknown, h: unknown) => vcall(h, "cancel", "()V")),
    "onFormResubmission(Landroid/webkit/WebView;Landroid/os/Message;Landroid/os/Message;)V": maySuspend((_v: unknown, dontResend: unknown) => vcall(dontResend, "sendToTarget", "()V")),
    "shouldInterceptRequest(Landroid/webkit/WebView;Ljava/lang/String;)Landroid/webkit/WebResourceResponse;": () => null,
    "shouldInterceptRequest(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;": maySuspend(function (this: JObj, v: JWebView, r: JReq) {
      return vcall(this, "shouldInterceptRequest", "(Landroid/webkit/WebView;Ljava/lang/String;)Landroid/webkit/WebResourceResponse;", v, r.url);
    }),
    "onRenderProcessGone(Landroid/webkit/WebView;Landroid/webkit/RenderProcessGoneDetail;)Z": () => 0,
    "doUpdateVisitedHistory(Landroid/webkit/WebView;Ljava/lang/String;Z)V": () => {},
    "onScaleChanged(Landroid/webkit/WebView;FF)V": () => {},
    "onUnhandledKeyEvent(Landroid/webkit/WebView;Landroid/view/KeyEvent;)V": () => {},
    "shouldOverrideKeyEvent(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z": () => 0,
    "onReceivedLoginRequest(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": () => {},
  },
});
rt.register({
  name: "android/webkit/WebChromeClient", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "onProgressChanged(Landroid/webkit/WebView;I)V": () => {},
    "onReceivedTitle(Landroid/webkit/WebView;Ljava/lang/String;)V": () => {},
    "onReceivedIcon(Landroid/webkit/WebView;Landroid/graphics/Bitmap;)V": () => {},
    "onReceivedTouchIconUrl(Landroid/webkit/WebView;Ljava/lang/String;Z)V": () => {},
    "onShowCustomView(Landroid/view/View;Landroid/webkit/WebChromeClient$CustomViewCallback;)V": () => {},
    "onShowCustomView(Landroid/view/View;ILandroid/webkit/WebChromeClient$CustomViewCallback;)V": () => {},
    "onHideCustomView()V": () => {},
    // AOSP calls the deprecated overload for compatibility, then reports "not handled"
    "onConsoleMessage(Landroid/webkit/ConsoleMessage;)Z": async function (this: JObj, m: JConsoleMessage) {
      await vcall(this, "onConsoleMessage", "(Ljava/lang/String;ILjava/lang/String;)V", m.msg, m.line, m.src);
      return 0;
    },
    "onConsoleMessage(Ljava/lang/String;ILjava/lang/String;)V": () => {},
    "onJsAlert(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Landroid/webkit/JsResult;)Z": () => 0,
    "onJsConfirm(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Landroid/webkit/JsResult;)Z": () => 0,
    "onJsPrompt(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/webkit/JsPromptResult;)Z": () => 0,
    "onJsBeforeUnload(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Landroid/webkit/JsResult;)Z": () => 0,
    "onJsTimeout()Z": () => 1,
    "onPermissionRequest(Landroid/webkit/PermissionRequest;)V": () => {},
    "onPermissionRequestCanceled(Landroid/webkit/PermissionRequest;)V": () => {},
    "onGeolocationPermissionsShowPrompt(Ljava/lang/String;Landroid/webkit/GeolocationPermissions$Callback;)V": () => {},
    "onGeolocationPermissionsHidePrompt()V": () => {},
    "getDefaultVideoPoster()Landroid/graphics/Bitmap;": () => null,
    "getVideoLoadingProgressView()Landroid/view/View;": () => null,
    "getVisitedHistory(Landroid/webkit/ValueCallback;)V": () => {},
    "onCreateWindow(Landroid/webkit/WebView;ZZLandroid/os/Message;)Z": () => 0,
    "onCloseWindow(Landroid/webkit/WebView;)V": () => {},
    "onRequestFocus(Landroid/webkit/WebView;)V": () => {},
    "onShowFileChooser(Landroid/webkit/WebView;Landroid/webkit/ValueCallback;Landroid/webkit/WebChromeClient$FileChooserParams;)Z": () => 0,
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
    "getMethod()Ljava/lang/String;": () => "GET",
    "getRequestHeaders()Ljava/util/Map;": () => inst("java/util/HashMap"),
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
    "getMimeType()Ljava/lang/String;": function (this: JWebResourceResponse) { return this.mime; },
    "getEncoding()Ljava/lang/String;": function (this: JWebResourceResponse) { return this.enc; },
    "getData()Ljava/io/InputStream;": function (this: JWebResourceResponse) { return this.data; },
    "getStatusCode()I": function (this: JWebResourceResponse) { return this.status; },
    "getReasonPhrase()Ljava/lang/String;": function (this: JWebResourceResponse) { return this.reason; },
    "getResponseHeaders()Ljava/util/Map;": function (this: JWebResourceResponse) { return this.headers; },
    "setMimeType(Ljava/lang/String;)V": function (this: JWebResourceResponse, m: string) { this.mime = m; },
    "setEncoding(Ljava/lang/String;)V": function (this: JWebResourceResponse, e: string) { this.enc = e; },
    "setData(Ljava/io/InputStream;)V": function (this: JWebResourceResponse, d: unknown) { this.data = d; },
    "setStatusCodeAndReasonPhrase(ILjava/lang/String;)V": function (this: JWebResourceResponse, st: number, rs: string) { this.status = st; this.reason = rs; },
    "setResponseHeaders(Ljava/util/Map;)V": function (this: JWebResourceResponse, h: unknown) { this.headers = h; },
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
    "message()Ljava/lang/String;": function (this: JConsoleMessage) { return this.msg; },
    "sourceId()Ljava/lang/String;": function (this: JConsoleMessage) { return this.src; },
    "lineNumber()I": function (this: JConsoleMessage) { return this.line; },
    "messageLevel()Landroid/webkit/ConsoleMessage$MessageLevel;": function (this: JConsoleMessage) { return this.level; },
  },
});
class JJsResult extends JObj {}
rt.register({ name: "android/webkit/JsResult", ctor: JJsResult, methods: { "confirm()V": () => {}, "cancel()V": () => {} } });
rt.register({
  name: "android/webkit/JsPromptResult", ctor: class extends JJsResult {}, sup: "android/webkit/JsResult",
  methods: { "confirm(Ljava/lang/String;)V": () => {} },
});
