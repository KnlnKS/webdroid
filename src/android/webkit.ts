// The WebView implementation package's provider. AOSP's android.webkit (WebView, WebViewFactory, the
// clients) runs from bytecode; WebViewFactory loads webfactory.ts's WebViewFactoryProvider where it
// would load Chromium's, and each WebView's WebViewProvider shows its page in a DOM frame over the
// display (webframes.ts), placed where the WebView's draw functor composes. Every page renders on a renderer origin of its
// own app and web origin, apart from this page's window and storage, as Chromium sandboxes web
// content from the app. Synchronous page calls wait there while the Java runtime continues
// executing; a browser that runs that renderer on this thread gets only the calls that return
// nothing, posted.

import { awaited, rt, JObj, stubs, noEffect, fieldGetters, fieldSetters, driven, type Gen } from "../jvm/runtime.ts";
import { after, vcall, newObj, staticField, JThread, iof, classNameOf } from "../jvm/natives/jentry.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { device } from "../shell/config.ts";
import { onMain } from "./mainloop.ts";
import { watchCookies } from "./cookies.ts";
import { broker } from "../shell/broker-access.ts";
import { WebBridge, type WebInterfaces } from "../shell/webbridge.ts";
import { rendererPattern, rendererUrl } from "../shell/webrenderer.ts";
import { parsePageMessage, request, respond, type Answers, type AppMessage, type LoadMessage, type PageMessage, type WebRequest,
  type WebResponse } from "../shell/webpage/protocol.ts";
import { webRenderer } from "./webstorage.ts";
import { webPrintAdapter } from "./printing.ts";
import { canvasOf, type JavaCanvas } from "./canvas.ts";
import { cssColor } from "./graphics.ts";
import { createFunctor, drawFunctor, type Rect } from "./webfunctor.ts";
import { factory } from "./webfactory.ts";
import type { WebSettingsAdapter } from "./websettings.ts";
import { clientHints } from "./webuseragent.ts";
import { webAsset, webFonts } from "./webfonts.ts";
import { javaInterface, weakIfaces } from "./webjavabridge.ts";
import { WebHistory, documentFor, srcEntry, srcFor, srcdoc, webOrigin, type Entry } from "./webnavigation.ts";
import { interceptRequest, mkError, mkRequest } from "./webrequests.ts";
import { PageHost, RendererFrame, Subframes, dropFrame, viewFrame, type FrameLoad } from "./webframes.ts";

import type { FrameAnnouncement } from "../shell/web-surface.ts";
import { KEY_ACTION_DOWN, domKeyOf, keyCodes } from "./input-codes.ts";

/** the main frame's port once its page script listens, and the page's end */
const newPage = () => ({ script: Promise.withResolvers<MessagePort>(), closed: new AbortController() });
/** whether a bridged page's renderer shares this thread, as its first interface call found */
let sharedRenderer: boolean | undefined;
const WV_S = "(Landroid/webkit/WebView;Ljava/lang/String;)V";
const SPACE = keyCodes.get("SPACE")!;
const MS_MODE = 0xc0000000, MS_EXACTLY = 0x40000000, MS_AT_MOST = 0x80000000 | 0, MEASURED_STATE_TOO_SMALL = 0x01000000;

function weakPlacement(ref: WeakRef<WebViewChromium>) {
  return { w: 0, h: 0, place: (rect: Rect | null) => ref.deref()?.place(rect) };
}

/** Chromium's WebViewChromium: a WebView's WebViewProvider and its view and scroll delegates */
export class WebViewChromium extends JObj {
  view!: JObj;
  access!: JObj;
  settings!: WebSettingsAdapter;
  /** the app's client, or once init ran the process's default one (Chromium's null client, a plain WebViewClient) */
  client!: JObj;
  chrome: JObj | null = null;
  /** the app's DownloadListener, which takes each response a frame downloads */
  dl: JObj | null = null;
  findListener: unknown = null;
  findQuery = "";
  findCount = 0;
  findOrdinal = 0;
  url: string | null = null;
  title = "";
  progress = 0;
  loaded = false;
  paused = false;
  readonly history = new WebHistory();
  ifaces: WebInterfaces = Object.create(null);
  /** the interfaces the bridged page was loaded with, as Chromium injects them per load */
  private pageIfaces: WebInterfaces | null = null;
  bridgeThread = Object.assign(new JThread(), { jname: "JavaBridge" });
  private requestThread = Object.assign(new JThread(), { jname: "Chrome_IOThread" });
  private readonly ref = new WeakRef(this);
  /** the view's size, which its draw functor covers */
  readonly size = weakPlacement(this.ref);
  readonly host = new PageHost(createFunctor(this.size));
  background: string | null = null;
  /** the page's content size, in CSS pixels */
  remoteWidth = 0;
  remoteHeight = 0;
  /** the last measure's terms: whether the width is the content's, and the height's limit (-1 when exact) */
  private measured = { width: true, height: Infinity };
  /** the main frame's document until its renderer announces itself */
  private loading: FrameLoad | null = null;
  private readonly subframes = new Subframes(this);
  private page = newPage();
  /** whether the client intercepts requests, as the page loaded */
  intercepting = false;
  /** where the content shows, in display pixels, or null when hidden */
  rect: Rect | null = null;
  /** bumped by every load and by stopLoading: a frame event from an older load is ignored */
  gen = 0;

  private static frameReceiver(ref: WeakRef<WebViewChromium>, frame: RendererFrame) {
    return ({ data, ports }: MessageEvent) => {
      const message = parsePageMessage(data);
      if (message) ref.deref()?.frameMessage(frame, message, ports[0]);
    };
  }
  private static pageCallbacks(ref: WeakRef<WebViewChromium>) {
    return {
      ifaces: () => ref.deref()?.pageIfaces,
      intercept: async (request: WebRequest) => ref.deref()?.intercept(request) ?? null,
      ready: (event: FrameAnnouncement) => ref.deref()?.rendererReady(event),
      cookies: () => ref.deref()?.refreshCookies(),
    };
  }

  /** the WebView whose provider this is, its View access and its settings, which WebViewFactoryProvider gives it */
  attach(view: JObj, access: JObj, settings: WebSettingsAdapter) { this.view = view; this.access = access; this.settings = settings; }

  /** a renderer document announced itself: the main frame's, or a subframe's within it */
  private rendererReady(event: FrameAnnouncement) {
    const { surface, bridge } = this.host, token = event.data.sub, win = event.frame;
    if (!surface || !bridge) return;
    const load = token === null ? event.main ? this.loading : null : this.subframes.get(token);
    if (!load || event.origin !== load.origin || token !== null && event.main) return;
    if (token === null) this.loading = null;
    const g = this.gen, channel = new MessageChannel(), ref = this.ref, frame = new RendererFrame(token !== null, load.entry.url, win, channel.port1);
    channel.port1.onmessage = WebViewChromium.frameReceiver(ref, frame);
    void this.loadMessage(frame, load).then((task) => {
      if (this.gen !== g) { channel.port1.close(); return; }
      this.host.adopt(frame);
      frame.loadedCookies(task.cookies);
      surface.open(win, load.origin, bridge.id, task, channel.port2);
    });
  }
  /** what a frame loads: its document, the interfaces (and which methods return a value), as
   *  Chromium injects them per load, the cookies its document sees, and the renderer's settings. The
   *  interfaces travel with the load: a synchronous call back would deadlock a renderer that shares
   *  this realm's thread, as one does without site isolation. */
  private async loadMessage(frame: RendererFrame, { entry, prefetched }: FrameLoad): Promise<LoadMessage> {
    const interfaces = Object.fromEntries(Object.entries(this.pageIfaces ?? {}).map(([name, methods]) =>
      [name, Object.fromEntries(Object.entries(methods).map(([method, fn]) => [method, fn.returns]))]));
    const [cookies, frames, fonts] = await Promise.all([this.frameCookies(frame, entry.url).catch(() => []), rendererPattern(), webFonts(this.settings)]);
    return { kind: "load", page: entry.url, userAgent: this.settings.userAgent, intercept: this.intercepting, interfaces,
      cookies, clientHints: clientHints(), sharedThread: sharedRenderer, frames, fonts,
      document: documentFor(entry, prefetched) };
  }
  /** what a frame's page tells the app. Chromium reports a subframe's console and cookies as the
   *  main frame's; a subframe's navigations stay in it (Subframes.message). */
  private frameMessage(frame: RendererFrame, m: PageMessage, answer: MessagePort | undefined) {
    switch (m.kind) {
      case "webasset":
        if (answer) void webAsset(m.path).catch(() => ({ status: 500 })).then((asset) => respond(m, answer, asset as Answers["webasset"]));
        return;
      case "webcookies":
        if (answer) void broker().cookieNetwork(m.url, this.url ?? "", m.values, this.settings.thirdPartyCookies)
          .then((header) => respond(m, answer, header), () => respond(m, answer, ""));
        return;
      case "subframe":
        if (answer) void this.subframes.src(srcEntry(m.url, m.init)).then((src) => respond(m, answer, src), () => respond(m, answer, null));
        return;
      case "console": this.consoleMessage(m); return;
      case "cookie":
        void this.frameCookies(frame, this.urlOf(frame), m.value).then((list) => { if (this.host.holds(frame)) frame.pushCookies(list, m.seq); }, () => {});
        return;
      case "invoke": this.host.bridge?.post(m); return;
      case "thread": sharedRenderer = m.shared; return;
      case "download": {
        // Chromium's download delegate hands the app any frame's download, with the user agent its request sent
        const listener = this.dl, agent = this.settings.userAgent;
        if (listener) void onMain(() => vcall(listener, "onDownloadStart", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;J)V",
          m.url, agent, m.disposition, m.mime, BigInt(m.length)));
        return;
      }
    }
    if (frame.sub) { this.subframes.message(frame, m); return; }
    switch (m.kind) {
      case "script-ready": this.page.script.resolve(frame.port); break;
      case "loaded":
        this.remoteWidth = m.width; this.remoteHeight = m.height;
        this.finishLoad(m.url, m.title, m.error);
        break;
      case "size": this.contentSized(m.width, m.height); break;
      case "fragment": this.fragmentNavigated(m.url); break;
      case "navigate": this.navigate(m.url, m.replace); break;
      case "submit": this.go(srcEntry(m.url, m.init)); break;
      case "redirect": {
        // the document is another origin's: it renders in that origin's partition
        const entry = srcEntry(m.url);
        this.history.replace(entry);
        this.go(entry, false, m.html);
        break;
      }
    }
  }
  /** the URL whose cookies a frame's document sees */
  private urlOf(frame: RendererFrame) { return frame.sub ? frame.url : this.url ?? ""; }
  /** what a frame's document.cookie reads at `url` once it wrote `value`: a subframe's sees cookies
   *  first-party to the page, or any when third-party ones are allowed */
  private frameCookies(frame: RendererFrame, url: string, value?: string) {
    return broker().cookieDocument(url, frame.sub ? this.url ?? "" : null, this.settings.thirdPartyCookies, value);
  }
  /** each frame's document.cookie, once the jar changed */
  private refreshCookies() {
    for (const frame of this.host.frames.values()) void this.frameCookies(frame, this.urlOf(frame)).then((list) => {
      if (this.host.holds(frame)) frame.pushCookies(list);
    }, () => {});
  }
  /** `message` to the page once its script listens, which rejects once the page closes */
  private ask<M extends AppMessage & { kind: keyof Answers }>(message: M, ms: number) {
    const { script, closed } = this.page;
    return request(message, (m, answer) => void script.promise.then((port) => port.postMessage(m, [answer])), ms, closed.signal);
  }
  async bitmapSnapshot(): Promise<ImageBitmap> {
    const failed = (message: string) => rt.mkThrowable("java/lang/UnsupportedOperationException", message);
    if (!this.host.bridge) throw failed("WebView content is unavailable for bitmap capture");
    const answer = await this.ask({ kind: "snapshot" }, 10_000).catch((why) => { throw failed("WebView snapshot " + why); });
    if ("error" in answer) throw failed(answer.error);
    return createImageBitmap(await (await fetch(answer.data)).blob());
  }
  stop() {
    this.gen++;
    this.host.main()?.port.postMessage({ kind: "stop" } satisfies AppMessage);
  }
  private closeBridge() {
    this.host.close();
    this.loading = null; this.subframes.clear();
    this.page.closed.abort(); this.page = newPage();
  }
  destroy() { this.gen++; this.closeBridge(); dropFrame(this); this.rect = null; }

  /** the display composed: show the content at the rect its functor drew, or hide it */
  place(rect: Rect | null): void {
    const el = this.host.surface;
    if (!el) return;
    const was = this.rect;
    this.rect = rect;
    // hidden, the page keeps its layout, which its content size reports
    if (!rect) { if (was) el.style({visibility:"hidden"}); return; }
    if (!was) el.style({visibility:"visible"});
    if (was && was[0] === rect[0] && was[1] === rect[1] && was[2] === rect[2] && was[3] === rect[3]) return;
    const [l, t, r, b] = rect;
    el.style({left:l / device.width * 100 + "%", top:t / device.height * 100 + "%",
      width:(r - l) / device.density + "px", height:(b - t) / device.density + "px"});
  }
  /** load `e`; `prefetched` is its document, already fetched by a frame that redirected to it */
  go(e: Entry, push = true, prefetched?: string) {
    if (push) this.history.push(e);
    this.url = e.url; this.loaded = false; this.progress = 10; this.title = "";
    const g = ++this.gen, el = viewFrame(this), url = e.url;
    if (el) {
      this.closeBridge();
      // Chromium injects the interfaces a page loads with; a later add or remove applies at the next load
      const callbacks = WebViewChromium.pageCallbacks(this.ref);
      this.pageIfaces = { ...this.ifaces };
      // The base client returns null. Subclasses run through the Java entry, including
      // inherited defaults; comparing JS prototype functions cannot identify Wasm overrides.
      const intercept = classNameOf(this.client) !== "android/webkit/WebViewClient";
      this.intercepting = intercept;
      const bridge = new WebBridge(weakIfaces(callbacks.ifaces), intercept ? callbacks.intercept : undefined, webRenderer(webOrigin(e)));
      this.host.open(bridge, el.ready(bridge.id, callbacks.ready), watchCookies(callbacks.cookies));
      void bridge.ready.then((origin) => {
        if (this.gen !== g) return;
        this.loading = { entry: e, origin, prefetched };
        el.load(rendererUrl(origin, bridge.id));
      }).catch(() => { if (this.gen === g) this.finishLoad(null, "", "WebView bridge unavailable"); });
    }
    if (prefetched === undefined) void onMain(() => this.gen === g && vcall(this.client, "onPageStarted", "(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V", this.view, url, null));
  }
  loadUrl(url: string) {
    if (/^javascript:/i.test(url)) { this.evalJs(url.slice(11)); return; }
    this.go(/^about:blank$/i.test(url) ? { url, doc: "" } : srcEntry(url));
  }
  /** WebViewClient.shouldInterceptRequest, which Chromium calls on its IO thread */
  intercept(request: WebRequest): Promise<WebResponse | null> { return interceptRequest(this.client, this.view, this.requestThread, request); }
  step(n: number) {
    const e = this.history.go(n);
    if (e) this.go(e, false);
  }
  private finishLoad(redirected: string | null, title: string, err: string | null) {
    const g = this.gen, cur = this.history.current;
    if (redirected) { this.url = redirected; if (cur) cur.url = redirected; }
    const url = this.url ?? "", { view, client, chrome } = this;
    this.loaded = !err; this.progress = 100;
    const shown = this.title = title || url, self = this;
    // Chromium's order. A callback commonly starts the next load (an app's error page), which ends this
    // one's sequence, so each call waits on its load still being the view's.
    function* call(target: JObj | null, name: string, desc: string, ...args: unknown[]): Gen {
      if (target && self.gen === g) yield vcall(target, name, desc, ...args);
    }
    void onMain(() => rt.drive(function* () {
      // the content size changed, which AwLayoutSizer answers with a layout
      yield* call(view, "requestLayout", "()V");
      if (err) yield* call(client, "onReceivedError", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;Landroid/webkit/WebResourceError;)V",
        view, mkRequest(url), mkError(-2, err));
      else {
        yield* call(chrome, "onProgressChanged", "(Landroid/webkit/WebView;I)V", view, 100);
        yield* call(chrome, "onReceivedTitle", WV_S, view, shown);
        yield* call(client, "onPageCommitVisible", WV_S, view, url);
      }
      yield* call(client, "onPageFinished", WV_S, view, url);
    }()));
  }
  /** an uncaught page error, as Chromium reports it; unhandled messages go to logcat's chromium tag */
  consoleMessage({ message: msg, source: src, line: n }: { message: string; source: string; line: number }) {
    const self = this;
    void onMain(() => rt.drive(function* () {
      const level = yield staticField("android/webkit/ConsoleMessage$MessageLevel", "ERROR");
      const m = yield newObj("android/webkit/ConsoleMessage", "(Ljava/lang/String;Ljava/lang/String;ILandroid/webkit/ConsoleMessage$MessageLevel;)V", msg, src, n, level);
      if (!self.chrome || !(yield vcall(self.chrome, "onConsoleMessage", "(Landroid/webkit/ConsoleMessage;)Z", m)))
        console.log("[I/chromium]", `[INFO:CONSOLE(${n})] "${msg}", source: ${src} (${n})`);
    }()));
  }
  fragmentNavigated(url: string) {
    const g = this.gen, cur = this.history.current;
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
      if (replace && this.history.current && !/^javascript:/i.test(href)) {
        const entry = srcEntry(href);
        this.history.replace(entry);
        this.go(entry, false);
      } else this.loadUrl(href);
    }));
  }
  /** Chromium JSON-encodes the completion value; undefined, functions and throws all read as null */
  evalJs(js: string): string | Promise<string> {
    if (!this.host.bridge) return "null";
    return this.ask({ kind: "eval", script: js }, 30_000).catch(() => "null");
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
      const code: number = yield vcall(event, "getKeyCode", "()I"), key = domKeyOf.get(code);
      if (!key || !self.host.surface || !self.loaded) return superDispatch();
      const type = (yield vcall(event, "getAction", "()I")) === KEY_ACTION_DOWN ? "keydown" : "keyup";
      const init = { key: key[0], code: code === SPACE ? "Space" : key[0], keyCode: key[1], which: key[1], bubbles: true, cancelable: true,
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
    const el = this.host.surface;
    if (el && !this.rect && wMode) { el.style({width:wSize / device.density + "px", height:hMode === MS_EXACTLY ? hSize / device.density + "px" : "0"}); }
    let w = wMode === 0 ? cw : wSize, h = hMode === MS_EXACTLY || hMode === MS_AT_MOST && ch > hSize ? hSize : ch;
    if (w < cw) w |= MEASURED_STATE_TOO_SMALL;
    if (h < ch) h |= MEASURED_STATE_TOO_SMALL;
    return vcall(this.access, "setMeasuredDimension", "(II)V", w, h);
  }
}
const W = "android/webkit/WebViewProvider";
type P = WebViewChromium;
const loadUrl = function (this: P, u: string) { this.loadUrl(u); };
/** AwContents.pageUp/pageDown: the page scrolls by its viewport, or to its end */
const page = (sign: number) => function (this: P, end: number): number {
  if (!this.host.bridge) return 0;
  void this.evalJs(`scrollBy(0, ${sign} * (${end ? "document.documentElement.scrollHeight" : "innerHeight"}))`);
  return 1;
};
let nullClient: JObj | undefined;
const viaAccess = (name: string, desc: string) => function (this: P, ...args: unknown[]) { return vcall(this.access, name, desc, ...args); };
rt.register({
  name: "webdroid/WebViewProvider", ctor: WebViewChromium, ifaces: [W, W + "$ViewDelegate", W + "$ScrollDelegate"],
  methods: {
    "init(Ljava/util/Map;Z)V": driven(function* (this: P, interfaces: JObj | null, privateBrowsing: number): Gen {
      if (privateBrowsing) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Private browsing is not supported in WebView.");
      this.client = nullClient ??= yield newObj("android/webkit/WebViewClient");
      // AwContents draws its container: a ViewGroup otherwise skips onDraw
      yield vcall(this.view, "setWillNotDraw", "(Z)V", 0);
      for (const e of interfaces ? yield* awaited(toJsArray(yield vcall(interfaces, "entrySet", "()Ljava/util/Set;"))) : [])
        this.ifaces[yield vcall(e, "getKey", "()Ljava/lang/Object;")] = yield javaInterface(yield vcall(e, "getValue", "()Ljava/lang/Object;"), this.bridgeThread);
    }),
    "getViewDelegate()Landroid/webkit/WebViewProvider$ViewDelegate;": function (this: P) { return this; },
    "getScrollDelegate()Landroid/webkit/WebViewProvider$ScrollDelegate;": function (this: P) { return this; },
    "destroy()V": function (this: P) { this.destroy(); },
    "createPrintDocumentAdapter(Ljava/lang/String;)Landroid/print/PrintDocumentAdapter;": function (this: P, name: string) { return webPrintAdapter(this, name); },
    // AOSP substitutes its default client for null
    "setWebViewClient(Landroid/webkit/WebViewClient;)V": function (this: P, c: JObj | null) { this.client = c ?? nullClient!; },
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
      this.go(srcEntry(url, { method: "POST", body: body.slice().buffer, contentType: "application/x-www-form-urlencoded" }));
    },
    "reload()V": function (this: P) { const e = this.history.current; if (e) this.go(e, false); },
    "stopLoading()V": function (this: P) { this.stop(); },
    ...fieldGetters({ "getSettings()Landroid/webkit/WebSettings;": "settings",
      "getWebViewClient()Landroid/webkit/WebViewClient;": "client",
      "getWebChromeClient()Landroid/webkit/WebChromeClient;": "chrome", "getUrl()Ljava/lang/String;": "url",
      "getOriginalUrl()Ljava/lang/String;": "url", "getTitle()Ljava/lang/String;": "title",
      "getProgress()I": "progress" }),
    ...fieldSetters({ "setDownloadListener(Landroid/webkit/DownloadListener;)V": "dl",
      "setFindListener(Landroid/webkit/WebView$FindListener;)V": "findListener" }),
    "canGoBack()Z": function (this: P) { return this.history.canGo(-1) ? 1 : 0; },
    "canGoForward()Z": function (this: P) { return this.history.canGo(1) ? 1 : 0; },
    "canGoBackOrForward(I)Z": function (this: P, n: number) { return this.history.canGo(n) ? 1 : 0; },
    "goBack()V": function (this: P) { this.step(-1); },
    "goForward()V": function (this: P) { this.step(1); },
    "goBackOrForward(I)V": function (this: P, n: number) { this.step(n); },
    "copyBackForwardList()Landroid/webkit/WebBackForwardList;": function (this: P) { return this.history.copy(); },
    "clearHistory()V": function (this: P) { this.history.clear(); },
    "evaluateJavaScript(Ljava/lang/String;Landroid/webkit/ValueCallback;)V": function (this: P, js: string, cb: unknown) {
      void Promise.resolve(this.evalJs(js)).then((r) => cb && onMain(() => vcall(cb, "onReceiveValue", "(Ljava/lang/Object;)V", r)));
    },
    "addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V": driven(function* (this: P, o: JObj, name: string): Gen { this.ifaces[name] = yield javaInterface(o, this.bridgeThread); }),
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
    ...noEffect("setHorizontalScrollbarOverlay(Z)V", "setVerticalScrollbarOverlay(Z)V", "setMapTrackballToArrowKeys(Z)V",
      "notifyFindDialogDismissed()V", "freeMemory()V", "clearView()V", "setInitialScale(I)V", "setRendererPriorityPolicy(IZ)V",
      "setPictureListener(Landroid/webkit/WebView$PictureListener;)V"),
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
      } else if (iof(canvas, "android/graphics/RecordingCanvas")) {
        yield vcall(factory().delegate, "drawWebViewFunctor", "(Landroid/graphics/Canvas;I)V", canvas, this.host.functor);
      } else drawFunctor(nc.ctx, this.host.functor, [nc.cl, nc.ct, nc.cr, nc.cb]);
    }),
    "onSizeChanged(IIII)V": function (this: P, w: number, h: number) { this.size.w = w; this.size.h = h; },
    "onMeasure(II)V": function (this: P, ws: number, hs: number) { return this.measure(ws, hs); },
    "setBackgroundColor(I)V": function (this: P, color: number) {
      this.background = cssColor(color);
      this.host.surface?.style({background:this.background});
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
    ...noEffect("onAttachedToWindow()V", "onDetachedFromWindow()V", "onVisibilityChanged(Landroid/view/View;I)V",
      "onWindowVisibilityChanged(I)V", "onWindowFocusChanged(Z)V", "onFocusChanged(ZILandroid/graphics/Rect;)V",
      "onScrollChanged(IIII)V", "onOverScrolled(IIZZ)V", "setOverScrollMode(I)V", "setScrollBarStyle(I)V", "setLayerType(ILandroid/graphics/Paint;)V",
      "preDispatchDraw(Landroid/graphics/Canvas;)V", "onStartTemporaryDetach()V", "onFinishTemporaryDetach()V",
      "onConfigurationChanged(Landroid/content/res/Configuration;)V", "onProvideVirtualStructure(Landroid/view/ViewStructure;)V",
      "onInitializeAccessibilityNodeInfo(Landroid/view/accessibility/AccessibilityNodeInfo;)V",
      "onInitializeAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)V"),
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

