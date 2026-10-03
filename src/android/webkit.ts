// The WebView implementation package. AOSP's android.webkit (WebView, WebViewFactory, the clients)
// runs from bytecode; WebViewFactory loads this module's WebViewFactoryProvider where it would load
// Chromium's, and each WebView's WebViewProvider shows its page in a DOM frame over the display,
// placed where the WebView's draw functor composes. Every page renders on a renderer origin of its
// own app and web origin, apart from this page's window and storage, as Chromium sandboxes web
// content from the app. Synchronous page calls wait there while the Java runtime continues
// executing; a browser that runs that renderer on this thread gets only the calls that return
// nothing, posted.

import { awaited, rt, JObj, type NativeSpec, type ClassInfo, stubs, fieldGetters, fieldSetters, driven, setDeclared, type Gen } from "../jvm/runtime";
import { mangleMethod, mangleStaticField, parseMethodDesc, jmethod, jarray, PRIM_ARRAYS, type PrimElem } from "../jvm/abi";
import { after, vcall, scall, callOn, newObj, staticField, JThread } from "../jvm/natives/jentry";
import { readStreamFully } from "../jvm/natives/jio";
import { toJsArray } from "../jvm/natives/jcoll";
import { boxBool } from "../jvm/natives/jbox";
import { hostStub } from "./binder";
import { device } from "../shell/config";
import { propertyValue } from "../shell/properties";
import { onMain } from "./mainloop";
import { mkUri } from "./net";
import { runningApp } from "./apphost";
import { onProcessExit } from "../process-exit";
import { webCookies, thirdPartyCookies, cookieManager } from "./cookies";
import { WebBridge, type WebInterfaces, type WebRequest, type WebResponse } from "../shell/webbridge";
import { onRendererReady, openRenderer, rendererPattern, rendererUrl } from "../shell/webrenderer";
import { parsePageMessage, type AppMessage, type FrameDocument, type FrameInit, type LoadMessage, type PageMessage, type RendererReady } from "../shell/webpage/protocol";
import { webRenderer } from "./webstorage";
import { isPlatformFont, platformFontBytes, typefaceOf, ITAL, WGHT } from "./fonts";
import { localAsset } from "../shell/localassets";
import { WEB_FRAME_SANDBOX, WEB_INJECT } from "../shell/webinject";
import { webViewBrands, type ClientHints } from "../shell/webpage/clienthints";
import type { WebCookies } from "../shell/webcookies";
import { webPrintAdapter } from "./printing";
import { canvasOf, type JavaCanvas } from "./canvas";
import { createFunctor, releaseFunctor, drawFunctor, type Rect } from "./webfunctor";

const inst = <T = JObj>(cls: string): T => rt.make(cls);

// ── WebViewFactory: the provider package is this one, versioned as the Chromium the UA names.
// Its pages render in the host's Blink, so that is the host's Chromium: a site's UA feature
// detection then describes the engine running it, as the host's client hints do. WebView keeps the
// full version (no UA reduction); the host's reduced UA gives the major until its client hints
// answer, and the first reader fixes it. A host that is not Chromium has none to give: 120.0.0.0.
const WEBVIEW_PACKAGE = "com.android.webview";
let webViewVersion = /Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent ?? "")?.[1] ?? "120.0.0.0", versionRead = false;
type HostHints = { getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }> };
void (globalThis.navigator as { userAgentData?: HostHints } | undefined)?.userAgentData?.getHighEntropyValues(["fullVersionList"]).then((values) => {
  const chromium = values.fullVersionList?.find((b) => b.brand === "Chromium")?.version;
  if (chromium && !versionRead) webViewVersion = chromium;
}, () => {});
const providerVersion = (): string => { versionRead = true; return webViewVersion; };
/** AwContentClient's user agent: GetAndroidOSInfo with the model and build ID, "; wv", and the
 *  product after Version/4.0 */
function defaultUserAgent(): string {
  const model = propertyValue("ro.product.model") ?? "", build = propertyValue("ro.build.id") ?? "";
  const info = (model ? `; ${model}` : "") + (build ? `${model ? "" : ";"} Build/${build}` : "");
  return `Mozilla/5.0 (Linux; Android ${propertyValue("ro.build.version.release")}${info}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${providerVersion()} Mobile Safari/537.36`;
}
/** the user agent metadata AwContentClient reports with that user agent, from the same build */
function clientHints(): ClientHints {
  const version = providerVersion(), release = (propertyValue("ro.build.version.release") ?? "").split(".");
  return { brands: webViewBrands(version, false), fullVersionList: webViewBrands(version, true), uaFullVersion: version,
    model: propertyValue("ro.product.model") ?? "", platformVersion: [0, 1, 2].map((i) => release[i] || "0").join("."),
    architecture: "", bitness: "", wow64: false, formFactors: ["Mobile"] };
}
/** whether a bridged page's renderer shares this thread, as its first interface call found */
let sharedRenderer: boolean | undefined;
const FACTORY = "webdroid/WebViewFactoryProvider";
/** the provider package's PackageInfo */
const webViewPackage = driven(function* webViewPackage$(): Gen<JObj> {
  const pi: JObj = yield newObj("android/content/pm/PackageInfo"), ai: JObj = yield newObj("android/content/pm/ApplicationInfo");
  setDeclared(ai, "android/content/pm/ApplicationInfo", { packageName: WEBVIEW_PACKAGE, processName: WEBVIEW_PACKAGE, flags: 1 }); // FLAG_SYSTEM
  setDeclared(pi, "android/content/pm/PackageInfo", { packageName: WEBVIEW_PACKAGE, versionName: providerVersion(), applicationInfo: ai });
  return pi;
});
rt.register({
  name: "android/webkit/WebViewFactory", ctor: class extends JObj {}, platformClinit: true,
  methods: {
    // getWebViewContextAndSetProvider's package, then the provider class its context's loader finds
    "static getProviderClass()Ljava/lang/Class;": driven(function* (): Gen {
      (rt.link("android/webkit/WebViewFactory").ctor as unknown as Record<string, unknown>)[mangleStaticField("sPackageInfo")] = yield* awaited(webViewPackage());
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
  "setUserAgentString(Ljava/lang/String;)V": function (this: WebSettingsAdapter, s: string | null) { this.v.userAgentString = s || defaultUserAgent(); },
  ...stubs(undefined, "setDatabasePath(Ljava/lang/String;)V", "setGeolocationDatabasePath(Ljava/lang/String;)V", "setEnableSmoothTransition(Z)V"),
};
class WebSettingsAdapter extends JObj {
  v: Record<string, unknown> = {
    userAgentString: defaultUserAgent(), cacheMode: -1, textZoom: 100, minimumFontSize: 8, minimumLogicalFontSize: 8, defaultFontSize: 16,
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
function* newSettings(): Gen<WebSettingsAdapter> {
  const s = inst<WebSettingsAdapter>("webdroid/WebSettings");
  s.v.layoutAlgorithm = yield staticField("android/webkit/WebSettings$LayoutAlgorithm", "NARROW_COLUMNS");
  s.v.pluginState = yield staticField("android/webkit/WebSettings$PluginState", "OFF");
  return s;
}

// ── the renderer's settings. AwSettings sets Blink's per-script family and size preferences, which a
// host browser does not let a page set: the standard family (a page's default text) and default size
// apply as the document's lowest-precedence style. Every family name of the system font map that is
// no CSS generic (sans-serif-light, arial, times new roman...) is a font face of the device's fonts,
// as Skia's Android font manager resolves a page's family names.
type WebFace = { family: string; path: string; weight: string; style: string; stretch: string };
const GENERIC = new Set(["sans-serif", "serif", "monospace", "cursive", "fantasy"]);
const WDTH = 0x77647468;
/** the faces of `t`'s first family, named `family`. A variable face's weight is its wght range, an
 *  alias's (sans-serif-light) its base weight; an italic made by its ital axis is left to the
 *  browser's oblique, and a set wdth is the face's stretch. */
function typefaceFaces(family: string, t: JObj | null): WebFace[] {
  const typeface = typefaceOf(t), fam = typeface.collection.families[0], base = typeface.baseWeight, out = new Map<string, WebFace>();
  if (!fam) return [];
  const fonts = base === 400 ? fam.fonts : [fam.closest(base, false), fam.closest(base, true)];
  for (const f of fonts) {
    const axes = f.fvarAxes, wght = axes.find((a) => a.tag === WGHT), wdth = f.axes.find((a) => a.tag === WDTH)?.value ?? 100;
    if (f.ttcIndex || f.italic && axes.some((a) => a.tag === ITAL) || !isPlatformFont(f.path)) continue;
    const weight = wght ? base === 400 ? `${wght.min} ${wght.max}` : String(base) : String(f.weight), style = f.italic ? "italic" : "normal";
    out.set(f.path + style, { family, path: f.path, weight, style, stretch: `${wdth}%` });
  }
  return [...out.values()];
}
let systemFaces: Promise<WebFace[]> | null = null;
const standardFaces = new Map<string, Promise<WebFace[]>>();
async function webFonts(settings: WebSettingsAdapter): Promise<{ faces: WebFace[]; css: string }> {
  const name = String(settings.v.standardFontFamily || "sans-serif");
  systemFaces ??= onMain(() => after(scall("android/graphics/Typeface", "getSystemFontMap", "()Ljava/util/Map;"), (map: JObj) => rt.drive(function* (): Gen<WebFace[]> {
    const faces: WebFace[] = [];
    // an ArrayMap's entries are its iterator, so the names are read first
    for (const family of (yield* awaited(toJsArray(yield vcall(map, "keySet", "()Ljava/util/Set;")))) as string[])
      if (!GENERIC.has(family)) faces.push(...typefaceFaces(family, yield vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", family)));
    return faces;
  }()))).catch(() => []);
  let standard = standardFaces.get(name);
  // an unknown name is the default family's, as the font manager answers it
  if (!standard) standardFaces.set(name, standard = onMain(() => after(scall("android/graphics/Typeface", "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", name, 0),
    (t: JObj) => typefaceFaces("wd-standard", t))).catch(() => []));
  const [system, std] = await Promise.all([systemFaces, standard]), size = Number(settings.v.defaultFontSize);
  const rules = (std.length ? "font-family:wd-standard;" : "") + (size !== 16 ? `font-size:${size}px;` : "");
  return { faces: [...system, ...std], css: rules && `:where(:root){${rules}}` };
}
/** what a frame's worker asks of the app: an apk asset, or a device font its settings use */
async function webAsset(path: unknown): Promise<{ status: number; bytes?: Uint8Array; type?: string }> {
  if (typeof path !== "string" || !isPlatformFont(path)) return localAsset(path);
  return { status: 200, bytes: await platformFontBytes(path), type: path.endsWith(".otf") ? "font/otf" : "font/ttf" };
}

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
/** the providers with a frame */
const live = new Set<WebViewChromium>();
/** a document a WebView's page shows on a renderer origin: its main frame, or a subframe the page
 *  routed there, which talks to the app over `port` */
class RendererFrame {
  /** the document.cookie last sent, and the page's last write it answers */
  cookies = { ack: 0, sent: "" };
  constructor(readonly sub: boolean, public url: string, readonly win: Window, readonly port: MessagePort) {}
}
/** what a WebView's page holds on the host side, by its frames' windows; it never references the provider itself */
interface FrameHold { el: HTMLIFrameElement | null; remote: WebBridge | null; frames: Map<Window, RendererFrame>; functor: number; ends: (() => void)[] }
function unbridge(h: FrameHold) {
  h.remote?.close(); h.remote = null;
  for (const end of h.ends.splice(0)) end();
  for (const frame of h.frames.values()) frame.port.close();
  h.frames.clear();
}
function release(h: FrameHold) { unbridge(h); h.el?.remove(); h.el = null; releaseFunctor(h.functor); }
// a page's renderer ends with its app's process, closing what it held open on its origin
onProcessExit(() => { for (const view of live) release(view.hold); live.clear(); });
// Chromium destroys an AwContents once its WebView is garbage collected (a CleanupReference), so
// an app that drops a WebView without destroy() does not keep its page. Page-side callbacks and the
// bridge therefore reach a provider only weakly; detaching alone keeps the page, as apps reattach.
const collected = new FinalizationRegistry<FrameHold>(release);
/** page-side proxies of the interfaces, so the page does not keep the Java objects (and so often its WebView) reachable */
function weakIfaces(of: () => WebInterfaces | null | undefined): WebInterfaces {
  const out: WebInterfaces = Object.create(null);
  for (const [name, methods] of Object.entries(of() ?? {})) {
    const proxy: WebInterfaces[string] = out[name] = Object.create(null);
    for (const m in methods) proxy[m] = Object.assign(async (...args: unknown[]) => of()?.[name]?.[m]?.(...args), { returns: methods[m].returns });
  }
  return out;
}
/** debug: the canvas capture cannot see frame pixels, so this is how a harness proves a page loaded */
export function webViewInfo(): { url: string | null; title: string; loaded: boolean; progress: number; rect: Rect | null }[] {
  return [...live].map((v) => ({ url: v.url, title: v.title, loaded: v.loaded, progress: v.progress, rect: v.rect }));
}

/** what the browser loads for an Android URL: the dev server fronts http(s) and the apk's assets */
function srcFor(url: string): string {
  if (/^https?:/i.test(url)) return "/proxy?frame=1&url=" + encodeURIComponent(url);
  const m = /^file:\/\/\/android_asset\/(.*)$/i.exec(url);
  return m ? "/asset/" + encodeURIComponent(runningApp().assetKey) + "/assets/" + m[1] : url;
}
const toJava = (d: string, x: unknown): unknown =>
  d === "J" ? BigInt(Math.trunc(Number(x)) || 0) : d === "Z" ? (x ? 1 : 0) : d === "F" || d === "D" ? Number(x)
  : d === "C" ? String(x).charCodeAt(0) | 0 : d.length === 1 ? Number(x) | 0 : d[0] === "[" ? toJavaArray(d.slice(1), x) : x;
/** a JavaScript array as Chromium's bridge passes it for an array parameter: primitive and String
 *  elements convert, and any other array type, or a value that is no array, is null */
function toJavaArray(elem: string, x: unknown): unknown {
  if (!Array.isArray(x)) return null;
  if (elem in PRIM_ARRAYS) {
    const out = new PRIM_ARRAYS[elem as PrimElem](x.length) as unknown as unknown[];
    x.forEach((v, i) => { out[i] = toJava(elem, v); });
    return out;
  }
  return elem === "Ljava/lang/String;" ? jarray(x.map((v) => typeof v === "string" ? v : null), elem) : null;
}
const fromJava = (d: string, r: unknown): unknown => d === "J" ? Number(r) : d === "Z" ? !!r : d === "V" ? undefined : r;
function bridge(o: JObj, thread: JThread): WebInterfaces[string] {
  const out: WebInterfaces[string] = Object.create(null);
  for (let ci = (o.constructor as unknown as { $i?: ClassInfo }).$i ?? null; ci && ci.def && ci.dex; ci = ci.superInfo) {
    const dex = ci.dex, annos = dex.classAnnotations(ci.def).methods;
    for (const m of ci.def.virtualMethods) {
      const name = dex.method(m.methodIdx).name;
      if ((m.flags & 9) !== 1 || name in out || !annos.get(m.methodIdx)?.some((a) => a.type === "android/webkit/JavascriptInterface")) continue;
      const desc = dex.methodDesc(m.methodIdx), { params, ret } = parseMethodDesc(desc);
      out[name] = Object.assign(async (...args: unknown[]) =>
        fromJava(ret, await callOn(thread, () => vcall(o, name, desc, ...params.map((d, i) => toJava(d, args[i]))))), { returns: ret !== "V" });
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

/** a page as history keeps it: a URL the frame fetches (`src`, with a form's request), or a document
 *  the app wrote (with its base URL) */
type SrcEntry = { url: string; src: string; init?: FrameInit };
type Entry = SrcEntry | { url: string; doc: string; base?: string };
/** what a frame loads for `e`: the document a redirect already fetched, the app's, or its src */
const documentFor = (e: Entry, prefetched?: string): FrameDocument =>
  prefetched !== undefined ? { html: prefetched, final: e.url } : "doc" in e ? { html: e.doc } : { src: e.src, init: e.init };
/** a document a renderer frame is to load: its entry, the renderer origin, and a redirect's document */
interface FrameLoad { entry: Entry; origin: string; prefetched?: string }
/** the web origin whose storage a page of `e` keeps: the base URL's for a document the app wrote,
 *  the file scheme's for files, and none (opaque) otherwise */
function webOrigin(e: Entry): string {
  const url = "doc" in e ? e.base ?? "" : e.url;
  return /^https?:/i.test(url) ? new URL(url).origin : /^file:/i.test(url) ? "file://" : "null";
}
/** whether `win` is a frame within `main`'s document */
function inside(win: Window, main: Window): boolean {
  for (let w = win, depth = 0; w !== w.parent && depth < 32; w = w.parent, depth++) if (w.parent === main) return true;
  return false;
}
const reply = (port: MessagePort, value: unknown) => { port.postMessage(value); port.close(); };
/** the main frame's port once its page script listens, and the page's end */
const newPage = () => ({ script: Promise.withResolvers<MessagePort>(), closed: new AbortController() });
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
  readonly hold: FrameHold = { el: null, remote: null, frames: new Map(), functor: 0, ends: [] };
  /** the view's size, which its draw functor covers */
  readonly size = { w: 0, h: 0, place: (rect: Rect | null) => this.ref.deref()?.place(rect) };
  background: string | null = null;
  /** the page's content size, in CSS pixels */
  remoteWidth = 0;
  remoteHeight = 0;
  /** the last measure's terms: whether the width is the content's, and the height's limit (-1 when exact) */
  private measured = { width: true, height: Infinity };
  /** the main frame's document until its renderer announces itself */
  private loading: FrameLoad | null = null;
  /** the subframes handed out to the page, by the token in their renderer URL */
  private subframes = new Map<string, FrameLoad>();
  private page = newPage();
  /** whether the client intercepts requests, as the page loaded */
  private intercepting = false;
  private cookieJar: Promise<WebCookies> | null = null;
  /** where the content shows, in display pixels, or null when hidden */
  rect: Rect | null = null;
  /** bumped by every load and by stopLoading: a frame event from an older load is ignored */
  gen = 0;

  /** the app's cookie jar, which every page of its WebViews shares */
  private get jar() { return this.cookieJar ??= webCookies(runningApp().pkg); }

  /** a renderer document announced itself: the main frame's, or a subframe's within it */
  private rendererReady(event: MessageEvent<RendererReady>, win: Window) {
    const main = this.hold.el?.contentWindow, remote = this.hold.remote, token = event.data.sub;
    if (!main || !remote) return;
    const load = token === null ? win === main ? this.loading : null : this.subframes.get(token);
    if (!load || event.origin !== load.origin || token !== null && !inside(win, main)) return;
    if (token === null) this.loading = null;
    const g = this.gen, channel = new MessageChannel(), ref = this.ref, frame = new RendererFrame(token !== null, load.entry.url, win, channel.port1);
    channel.port1.onmessage = ({ data, ports }) => {
      const message = parsePageMessage(data);
      if (message) ref.deref()?.frameMessage(frame, message, ports[0]);
    };
    void this.loadMessage(frame, load).then((task) => {
      if (this.gen !== g) { channel.port1.close(); return; }
      this.hold.frames.get(win)?.port.close();
      this.hold.frames.set(win, frame);
      frame.cookies.sent = JSON.stringify(task.cookies);
      openRenderer(win, load.origin, remote.id, task, channel.port2);
    });
  }
  /** what a frame loads: its document, the interfaces (and which methods return a value), as
   *  Chromium injects them per load, the cookies its document sees, and the renderer's settings. The
   *  interfaces travel with the load: a synchronous call back would deadlock a renderer that shares
   *  this realm's thread, as one does without site isolation. */
  private async loadMessage(frame: RendererFrame, { entry, prefetched }: FrameLoad): Promise<LoadMessage> {
    const interfaces = Object.fromEntries(Object.entries(this.pageIfaces ?? {}).map(([name, methods]) =>
      [name, Object.fromEntries(Object.entries(methods).map(([method, fn]) => [method, fn.returns]))]));
    const [jar, frames, fonts] = await Promise.all([this.jar, rendererPattern(), webFonts(this.settings)]);
    return { kind: "load", page: entry.url, userAgent: String(this.settings.v.userAgentString), intercept: this.intercepting, interfaces,
      cookies: this.sees(jar, frame) ? jar.document(entry.url) : [], clientHints: clientHints(), sharedThread: sharedRenderer, frames, fonts,
      document: documentFor(entry, prefetched) };
  }
  /** what a frame's page tells the app. Chromium reports a subframe's console and cookies as the
   *  main frame's; a subframe's navigations stay in it, through the renderer of their origin. */
  private frameMessage(frame: RendererFrame, m: PageMessage, answer: MessagePort | undefined) {
    const sub = frame.sub;
    switch (m.kind) {
      case "webasset":
        if (answer) void webAsset(m.path).catch(() => ({ status: 500 })).then((asset) => reply(answer, asset));
        break;
      case "webcookies":
        if (answer) void this.jar.then((jar) => reply(answer, jar.network(m.url, this.url ?? "", m.values, thirdPartyCookies.has(this.view))));
        break;
      case "subframe":
        if (answer) void this.subframeSrc({ url: m.url, src: srcFor(m.url), init: m.init }).then((src) => reply(answer, src), () => reply(answer, null));
        break;
      case "console": this.consoleMessage(m); break;
      case "cookie": {
        const url = this.urlOf(frame);
        void this.jar.then((jar) => {
          if (this.hold.frames.get(frame.win) !== frame) return;
          frame.cookies.ack = m.seq;
          if (this.sees(jar, frame)) jar.set(url, m.value, false);
          this.pushCookies(jar, frame, true);
        });
        break;
      }
      case "invoke": this.hold.remote?.post(m); break;
      case "thread": sharedRenderer = m.shared; break;
      case "script-ready": if (!sub) this.page.script.resolve(frame.port); break;
      case "loaded":
        if (sub) { if (m.url !== null) frame.url = m.url; break; }
        this.remoteWidth = m.width; this.remoteHeight = m.height;
        this.finishLoad(m.url, m.title, m.error);
        break;
      case "size": if (!sub) this.contentSized(m.width, m.height); break;
      case "fragment": if (!sub) this.fragmentNavigated(m.url); break;
      case "navigate":
        if (!sub) this.navigate(m.url, m.replace);
        else if (!/^javascript:/i.test(m.url)) this.subframeNavigate(frame, { url: m.url, src: srcFor(m.url) });
        break;
      case "submit": {
        const entry = { url: m.url, src: srcFor(m.url), init: m.init };
        if (sub) this.subframeNavigate(frame, entry); else this.go(entry);
        break;
      }
      case "redirect": {
        // the document is another origin's: it renders in that origin's partition
        const entry = { url: m.url, src: srcFor(m.url) };
        if (sub) { this.subframeNavigate(frame, entry, m.html); break; }
        if (this.idx >= 0) this.hist[this.idx] = entry;
        this.go(entry, false, m.html);
      }
    }
  }
  /** the URL whose cookies a frame's document sees */
  private urlOf(frame: RendererFrame) { return frame.sub ? frame.url : this.url ?? ""; }
  /** whether a frame's document sees the jar's cookies: a subframe's when they are first-party to the
   *  page or third-party ones are allowed */
  private sees(jar: WebCookies, frame: RendererFrame) { return !frame.sub || jar.sameSite(frame.url, this.url ?? "") || thirdPartyCookies.has(this.view); }
  /** each frame's document.cookie, once the jar changed */
  private sendCookies(jar: WebCookies) { for (const frame of this.hold.frames.values()) this.pushCookies(jar, frame); }
  /** a frame's document.cookie, when it changed or answers the page's write */
  private pushCookies(jar: WebCookies, frame: RendererFrame, answer = false) {
    const list = this.sees(jar, frame) ? jar.document(this.urlOf(frame)) : [], sent = JSON.stringify(list);
    if (sent === frame.cookies.sent && !answer) return;
    frame.cookies.sent = sent;
    frame.port.postMessage({ kind: "cookies", list, ack: frame.cookies.ack } satisfies AppMessage);
  }
  /** Chromium's navigation throttle offers a subframe navigation of any scheme but http(s), about: and
   *  javascript: to shouldOverrideUrlLoading. Then a blob: loads; any other goes to shouldInterceptRequest
   *  (as http(s) does through the proxy), whose response loads; otherwise a data: URL loads and an
   *  unknown scheme fails with ERR_UNKNOWN_URL_SCHEME and an error page. Answers where the frame
   *  loads: a renderer, the URL itself, or nowhere. */
  private async subframeSrc(entry: SrcEntry, prefetched?: string): Promise<string | null> {
    if (/^https?:/i.test(entry.url)) return this.subframe(entry, prefetched);
    const request = mkRequest(entry.url);
    request.main = false;
    if (await onMain(() => vcall(this.client, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z", this.view, request))) return null;
    if (/^blob:/i.test(entry.url)) return entry.url;
    if (entry.src !== entry.url) return this.subframe(entry);
    const response = this.intercepting ? await this.intercept({ url: entry.url, method: "GET", main: false, headers: {} }) : null;
    if (response) return this.interceptedFrame(entry.url, response);
    if (/^data:/i.test(entry.url)) return entry.url;
    const error = inst<JWebErr>("webdroid/WebResourceError");
    error.code = -10; error.desc = "net::ERR_UNKNOWN_URL_SCHEME";
    void onMain(() => vcall(this.client, "onReceivedError", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V", this.view, request, error));
    // in place of Chromium's error page: a document the page cannot read, with its load event
    return "data:text/html,";
  }
  /** a client's response for a subframe: an HTML document on the opaque renderer, which carries the
   *  page script, or the bytes as they are */
  private interceptedFrame(url: string, response: WebResponse): Promise<string> | string {
    const type = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "text/html";
    if (!/^\s*text\/html\b/i.test(type)) return "data:" + type.replace(/\s+/g, "") + ";base64," + response.body;
    const bytes = Uint8Array.fromBase64(response.body), charset = /charset=([^;\s]+)/i.exec(type)?.[1] ?? "utf-8";
    let html: string;
    try { html = new TextDecoder(charset).decode(bytes); } catch { html = new TextDecoder().decode(bytes); }
    return this.subframe({ url, doc: srcdoc(html, null, /^data:/i.test(url) ? null : url) });
  }
  /** the renderer document a subframe of `entry` loads, on its web origin's renderer */
  private async subframe(entry: Entry, prefetched?: string): Promise<string> {
    const remote = this.hold.remote;
    if (!remote) throw new Error("no page");
    const origin = await webRenderer(runningApp().pkg, webOrigin(entry)), token = crypto.randomUUID();
    if (this.hold.remote !== remote) throw new Error("page closed");
    this.subframes.set(token, { entry, origin, prefetched });
    if (this.subframes.size > 256) this.subframes.delete(this.subframes.keys().next().value!);
    return rendererUrl(origin, remote.id, token);
  }
  private subframeNavigate(frame: RendererFrame, entry: SrcEntry, prefetched?: string) {
    void this.subframeSrc(entry, prefetched).then((src) => { if (src) frame.win.location.replace(src); }, () => {});
  }
  /** `message` to the page once its script listens, and the answer on a port of its own; a rejection
   *  ("interrupted", "timed out") when the page closes or `ms` pass first */
  private ask(message: AppMessage, ms: number): Promise<unknown> {
    const { script, closed } = this.page, channel = new MessageChannel();
    return new Promise((resolve, reject) => {
      const settle = (done: () => void) => { clearTimeout(timer); closed.signal.removeEventListener("abort", interrupted); channel.port1.close(); done(); };
      const interrupted = () => settle(() => reject("interrupted"));
      const timer = setTimeout(() => settle(() => reject("timed out")), ms);
      closed.signal.addEventListener("abort", interrupted);
      channel.port1.onmessage = ({ data }) => settle(() => resolve(data));
      void script.promise.then((port) => port.postMessage(message, [channel.port2]));
    });
  }
  async bitmapSnapshot(): Promise<ImageBitmap> {
    const failed = (message: string) => rt.mkThrowable("java/lang/UnsupportedOperationException", message);
    if (!this.hold.remote) throw failed("WebView content is unavailable for bitmap capture");
    const answer = await this.ask({ kind: "snapshot" }, 10_000).catch((why) => { throw failed("WebView snapshot " + why); }) as { data?: string; error?: string };
    if (answer.error) throw failed(answer.error);
    return createImageBitmap(await (await fetch(answer.data!)).blob());
  }
  stop() {
    this.gen++;
    const win = this.hold.el?.contentWindow;
    if (win) this.hold.frames.get(win)?.port.postMessage({ kind: "stop" } satisfies AppMessage);
  }
  private closeBridge() {
    unbridge(this.hold);
    this.loading = null; this.subframes.clear();
    this.page.closed.abort(); this.page = newPage();
  }
  destroy() { this.gen++; this.closeBridge(); collected.unregister(this.hold); release(this.hold); this.rect = null; live.delete(this); }

  frame(): HTMLIFrameElement | null {
    if (this.hold.el || !layer) return this.hold.el;
    const el = this.hold.el = document.createElement("iframe");
    el.referrerPolicy = "no-referrer";
    el.setAttribute("sandbox", WEB_FRAME_SANDBOX);
    el.style.cssText = "position:absolute;border:0;pointer-events:auto;transform-origin:top left;transform:scale(var(--wd-web-scale,1));visibility:hidden";
    if (this.background) el.style.background = this.background;
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
    // hidden, the page keeps its layout, which its content size reports
    if (!rect) { if (was) el.style.visibility = "hidden"; return; }
    if (!was) el.style.visibility = "visible";
    if (was && was[0] === rect[0] && was[1] === rect[1] && was[2] === rect[2] && was[3] === rect[3]) return;
    const [l, t, r, b] = rect, s = el.style;
    s.left = l / device.width * 100 + "%"; s.top = t / device.height * 100 + "%";
    s.width = (r - l) / device.density + "px"; s.height = (b - t) / device.density + "px";
  }
  /** load `e`; `prefetched` is its document, already fetched by a frame that redirected to it */
  go(e: Entry, push = true, prefetched?: string) {
    if (push) { this.hist.length = ++this.idx; this.hist.push(e); }
    this.url = e.url; this.loaded = false; this.progress = 10; this.title = "";
    const g = ++this.gen, el = this.frame(), url = e.url;
    if (el) {
      this.closeBridge();
      // Chromium injects the interfaces a page loads with; a later add or remove applies at the next load
      const ref = this.ref;
      this.pageIfaces = { ...this.ifaces };
      const base = rt.link("android/webkit/WebViewClient").ctor.prototype;
      const intercept = ["Landroid/webkit/WebResourceRequest;", "Ljava/lang/String;"].some(arg => {
        const method = mangleMethod("shouldInterceptRequest", "(Landroid/webkit/WebView;" + arg + ")Landroid/webkit/WebResourceResponse;");
        return jmethod(this.client, method) !== jmethod(base, method);
      });
      this.intercepting = intercept;
      const remote = this.hold.remote = new WebBridge(weakIfaces(() => ref.deref()?.pageIfaces),
        intercept ? async request => ref.deref()?.intercept(request) ?? null : undefined, webRenderer(runningApp().pkg, webOrigin(e)));
      this.hold.ends.push(onRendererReady(remote.id, (event, win) => ref.deref()?.rendererReady(event, win)));
      void this.jar.then((jar) => {
        if (this.hold.remote === remote) this.hold.ends.push(jar.watch(() => ref.deref()?.sendCookies(jar)));
      });
      void remote.ready.then((origin) => {
        if (this.gen !== g) return;
        this.loading = { entry: e, origin, prefetched };
        el.src = rendererUrl(origin, remote.id);
      }).catch(() => { if (this.gen === g) this.finishLoad(null, "", "WebView bridge unavailable"); });
    }
    if (prefetched === undefined) void onMain(() => this.gen === g && vcall(this.client, "onPageStarted", "(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V", this.view, url, null));
  }
  loadUrl(url: string) {
    if (/^javascript:/i.test(url)) { this.evalJs(url.slice(11)); return; }
    this.go(/^about:blank$/i.test(url) ? { url, doc: "" } : { url, src: srcFor(url) });
  }
  /** WebViewClient.shouldInterceptRequest, which Chromium calls on its IO thread */
  private intercept(request: WebRequest): Promise<WebResponse | null> {
    const self = this;
    return Promise.resolve(callOn(this.requestThread, () => rt.drive(function* (): Gen<WebResponse | null> {
      const req = mkRequest(request.url);
      req.main = request.main; req.method = request.method;
      req.headers = inst("java/util/HashMap");
      for (const [key, value] of Object.entries(request.headers)) yield vcall(req.headers, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, value);
      const response: JObj | null = yield vcall(self.client, "shouldInterceptRequest", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;", self.view, req);
      if (!response) return null;
      const mime: string | null = yield vcall(response, "getMimeType", "()Ljava/lang/String;");
      const enc: string | null = yield vcall(response, "getEncoding", "()Ljava/lang/String;");
      const status: number = yield vcall(response, "getStatusCode", "()I");
      const reason: string | null = yield vcall(response, "getReasonPhrase", "()Ljava/lang/String;");
      const responseHeaders: JObj | null = yield vcall(response, "getResponseHeaders", "()Ljava/util/Map;");
      const data: JObj | null = yield vcall(response, "getData", "()Ljava/io/InputStream;");
      const headers: Record<string, string> = {};
      const entries = responseHeaders ? yield vcall(responseHeaders, "entrySet", "()Ljava/util/Set;") : null;
      if (entries) for (const entry of yield* awaited(toJsArray(entries))) {
        headers[yield vcall(entry, "getKey", "()Ljava/lang/Object;")] = yield vcall(entry, "getValue", "()Ljava/lang/Object;");
      }
      if (mime) headers["content-type"] = mime + (enc ? "; charset=" + enc : "");
      let body = "";
      if (data) {
        try { body = (yield* awaited(readStreamFully(data))).toBase64(); }
        finally { yield vcall(data, "close", "()V"); }
      }
      return { body, status, reason: reason ?? "OK", headers };
    }())));
  }
  step(n: number) {
    const i = this.idx + n;
    if (i < 0 || i >= this.hist.length) return;
    this.idx = i;
    this.go(this.hist[i], false);
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
    const self = this;
    void onMain(() => rt.drive(function* () { for (const [o, n, d, ...a] of steps) { if (self.gen !== g) return; if (o) yield vcall(o, n, d, ...a); } }()));
  }
  /** an uncaught page error, as Chromium reports it; unhandled messages go to logcat's chromium tag */
  consoleMessage(data: unknown) {
    const { message, source, line } = (data ?? {}) as { message?: unknown; source?: unknown; line?: unknown };
    const msg = String(message), src = typeof source === "string" ? source : "", n = typeof line === "number" ? line : 0;
    const self = this;
    void onMain(() => rt.drive(function* () {
      const level = yield staticField("android/webkit/ConsoleMessage$MessageLevel", "ERROR");
      const m = yield newObj("android/webkit/ConsoleMessage", "(Ljava/lang/String;Ljava/lang/String;ILandroid/webkit/ConsoleMessage$MessageLevel;)V", msg, src, n, level);
      if (!self.chrome || !(yield vcall(self.chrome, "onConsoleMessage", "(Landroid/webkit/ConsoleMessage;)Z", m)))
        console.log("[I/chromium]", `[INFO:CONSOLE(${n})] "${msg}", source: ${src} (${n})`);
    }()));
  }
  fragmentNavigated(url: string) {
    const g = this.gen, cur = this.hist[this.idx];
    this.url = url;
    if (cur) { cur.url = url; if ("src" in cur) cur.src = srcFor(url); }
    const self = this;
    void onMain(() => rt.drive(function* () {
      if (self.gen !== g) return;
      yield vcall(self.client, "doUpdateVisitedHistory", "(Landroid/webkit/WebView;Ljava/lang/String;Z)V", self.view, url, 0);
      if (self.gen === g) yield vcall(self.client, "onPageFinished", WV_S, self.view, url);
    }()));
  }
  private navigate(href: string, replace = false) {
    void onMain(() => after(vcall(this.client, "shouldOverrideUrlLoading", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z", this.view, mkRequest(href, true)), (overridden) => {
      if (overridden) return;
      if (replace && this.idx >= 0 && !/^javascript:/i.test(href)) {
        const entry = { url: href, src: srcFor(href) };
        this.hist[this.idx] = entry;
        this.go(entry, false);
      } else this.loadUrl(href);
    }));
  }
  /** Chromium JSON-encodes the completion value; undefined, functions and throws all read as null */
  evalJs(js: string): string | Promise<string> {
    if (!this.hold.remote) return "null";
    return this.ask({ kind: "eval", script: js }, 30_000).then((value) => typeof value === "string" ? value : "null", () => "null");
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
  keyEvent(event: JObj): unknown {
    const self = this;
    return rt.drive(function* (): Gen {
      const superDispatch = () => vcall(self.access, "super_dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", event);
      if (yield vcall(self.client, "shouldOverrideKeyEvent", "(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z", self.view, event)) return superDispatch();
      const code: number = yield vcall(event, "getKeyCode", "()I"), key = navigationKeys[code];
      if (!key || !self.hold.el || !self.loaded) return superDispatch();
      const type = (yield vcall(event, "getAction", "()I")) === 0 ? "keydown" : "keyup";
      const init = { key: key[0], code: code === 62 ? "Space" : key[0], keyCode: key[1], which: key[1], bubbles: true, cancelable: true,
        repeat: (yield vcall(event, "getRepeatCount", "()I")) > 0 };
      const generation = self.gen;
      // Renderer handlers can call back into Java; never hold the main queue awaiting them.
      void Promise.resolve(self.evalJs(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, ${JSON.stringify(init)}))`)).then((unhandled) => {
        if (unhandled === "true" && self.gen === generation) void onMain(() => vcall(self.client, "onUnhandledKeyEvent", "(Landroid/webkit/WebView;Landroid/view/KeyEvent;)V", self.view, event));
      });
      return 1;
    }());
  }
  /** AwLayoutSizer.onContentSizeChanged: a layout when the view's measure took the size that changed */
  private contentSized(width: number, height: number) {
    const { measured } = this, limit = (h: number) => h * device.density > measured.height;
    const relayout = measured.width && width !== this.remoteWidth
      || measured.height >= 0 && height !== this.remoteHeight && !(limit(height) && limit(this.remoteHeight));
    this.remoteWidth = width; this.remoteHeight = height;
    if (relayout) void onMain(() => vcall(this.view, "requestLayout", "()V"));
  }
  /** AwLayoutSizer.onMeasure: the given size unless unspecified, the content's height unless the
   *  height is exact or the content exceeds its limit */
  measure(ws: number, hs: number): Promise<unknown> {
    const wMode = ws & MS_MODE, hMode = hs & MS_MODE, wSize = ws & ~MS_MODE, hSize = hs & ~MS_MODE;
    const cw = Math.round(this.remoteWidth * device.density), ch = Math.round(this.remoteHeight * device.density);
    this.measured = { width: wMode !== MS_EXACTLY, height: hMode === MS_EXACTLY ? -1 : hMode === MS_AT_MOST ? hSize : Infinity };
    // until it shows, the page lays out at the width it is measured at, its height its content's
    const el = this.hold.el;
    if (el && !this.rect && wMode) { el.style.width = wSize / device.density + "px"; el.style.height = hMode === MS_EXACTLY ? hSize / device.density + "px" : "0"; }
    let w = wMode === 0 ? cw : wSize, h = hMode === MS_EXACTLY || hMode === MS_AT_MOST && ch > hSize ? hSize : ch;
    if (w < cw) w |= MEASURED_STATE_TOO_SMALL;
    if (h < ch) h |= MEASURED_STATE_TOO_SMALL;
    return vcall(this.access, "setMeasuredDimension", "(II)V", w, h);
  }
}
/** srcdoc payload: the bridge bootstrap first (after a doctype, or the document goes quirks), then the base */
function srcdoc(data: string, enc: string | null, base: string | null): string {
  if (/^base64$/i.test(enc ?? "")) data = new TextDecoder().decode(Uint8Array.fromBase64(data));
  const inject = WEB_INJECT + (base ? `<base href="${base.replace(/"/g, "&quot;")}">` : "");
  const dt = /^\s*<!doctype[^>]*>/i.exec(data);
  return dt ? dt[0] + inject + data.slice(dt[0].length) : inject + data;
}
const W = "android/webkit/WebViewProvider";
type P = WebViewChromium;
const loadUrl = function (this: P, u: string) { this.loadUrl(u); };
/** AwContents.pageUp/pageDown: the page scrolls by its viewport, or to its end */
const page = (sign: number) => function (this: P, end: number): number {
  if (!this.hold.remote) return 0;
  void this.evalJs(`scrollBy(0, ${sign} * (${end ? "document.documentElement.scrollHeight" : "innerHeight"}))`);
  return 1;
};
const viaAccess = (name: string, desc: string) => function (this: P, ...args: unknown[]) { return vcall(this.access, name, desc, ...args); };
rt.register({
  name: "webdroid/WebViewProvider", ctor: WebViewChromium, ifaces: [W, W + "$ViewDelegate", W + "$ScrollDelegate"],
  methods: {
    "init(Ljava/util/Map;Z)V": driven(function* (this: P, interfaces: JObj | null, privateBrowsing: number): Gen {
      if (privateBrowsing) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Private browsing is not supported in WebView.");
      // AwContents draws its container: a ViewGroup otherwise skips onDraw
      yield vcall(this.view, "setWillNotDraw", "(Z)V", 0);
      for (const e of interfaces ? yield* awaited(toJsArray(yield vcall(interfaces, "entrySet", "()Ljava/util/Set;"))) : [])
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
        this.go({ url: hist || "about:blank", doc: srcdoc(data, enc, base), base: base ?? undefined });
      },
    "postUrl(Ljava/lang/String;[B)V": function (this: P, url: string, body: Uint8Array) {
      this.go({ url, src: srcFor(url), init: { method: "POST", body: body.slice().buffer, contentType: "application/x-www-form-urlencoded" } });
    },
    "reload()V": function (this: P) { if (this.idx >= 0) this.go(this.hist[this.idx], false); },
    "stopLoading()V": function (this: P) { this.stop(); },
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
    "getContentHeight()I": function (this: P) { return this.remoteHeight; },
    "getContentWidth()I": function (this: P) { return this.remoteWidth; },
    "getScale()F": () => device.density,
    "pageUp(Z)Z": page(-1),
    "pageDown(Z)Z": page(1),
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
        const image = yield* awaited(this.bitmapSnapshot());
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
      p.view = view; p.access = access; p.settings = yield* newSettings();
      p.hold.functor = createFunctor(p.size);
      return p;
    }),
    "getStatics()Landroid/webkit/WebViewFactoryProvider$Statics;": function (this: Factory) { return this.statics; },
    "getCookieManager()Landroid/webkit/CookieManager;": () => cookieManager(),
    "getWebViewDatabase(Landroid/content/Context;)Landroid/webkit/WebViewDatabase;": function (this: Factory) { return this.database ??= inst("webdroid/WebViewDatabase"); },
    // the base answers no origins: nothing here keeps per-origin geolocation grants
    "getGeolocationPermissions()Landroid/webkit/GeolocationPermissions;": driven(function* (this: Factory): Gen { return this.geolocation ??= yield newObj("android/webkit/GeolocationPermissions"); }),
    "getWebStorage()Landroid/webkit/WebStorage;": function (this: Factory) { return this.storage ??= inst("webdroid/WebStorage"); },
    "getServiceWorkerController()Landroid/webkit/ServiceWorkerController;": function (this: Factory) { return this.serviceWorker ??= inst("webdroid/ServiceWorkerController"); },
    "getTracingController()Landroid/webkit/TracingController;": function (this: Factory) { return this.tracing ??= inst("webdroid/TracingController"); },
    "getWebViewClassLoader()Ljava/lang/ClassLoader;": () => vcall(rt.classFor(FACTORY), "getClassLoader", "()Ljava/lang/ClassLoader;"),
    ...stubs(null, "getTokenBindingService()Landroid/webkit/TokenBindingService;", "getWebIconDatabase()Landroid/webkit/WebIconDatabase;"),
  },
});
rt.register({
  name: "webdroid/WebViewStatics", ctor: class extends JObj {}, ifaces: ["android/webkit/WebViewFactoryProvider$Statics"],
  methods: {
    "getDefaultUserAgent(Landroid/content/Context;)Ljava/lang/String;": defaultUserAgent,
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
