// android.webkit: MimeTypeMap, a WebView that renders nothing (only ad SDKs reach it), the client
// base classes SDK subclasses invoke-super, and the small value types they pass.

import { rt, JObj } from "../jvm/runtime";
import { JViewGroup, initViewFromCtx } from "./view";
import { mkEnumSet, type JSimpleEnum } from "../jvm/natives/jlang";

rt.register({
  name: "android/webkit/MimeTypeMap", ctor: class extends JObj {},
  methods: {
    "static getSingleton()Landroid/webkit/MimeTypeMap;": () => new (rt.link("android/webkit/MimeTypeMap").ctor)(),
    "static getFileExtensionFromUrl(Ljava/lang/String;)Ljava/lang/String;": (u: string) => {
      const m = /\.([A-Za-z0-9]+)(?:[?#]|$)/.exec(u ?? "");
      return m?.[1] ?? "";
    },
    "getMimeTypeFromExtension(Ljava/lang/String;)Ljava/lang/String;": (ext: string) => {
      const map: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
        csv: "text/csv", txt: "text/plain", pdf: "application/pdf", zip: "application/zip", db: "application/octet-stream",
      };
      return map[ext?.toLowerCase()] ?? null;
    },
    "getExtensionFromMimeType(Ljava/lang/String;)Ljava/lang/String;": (mime: string) => {
      const map: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "text/csv": "csv" };
      return map[mime] ?? null;
    },
  },
});

// WebView — minimal stub (usually ad SDKs; render as blank view)
rt.register({
  name: "android/webkit/WebView", ctor: class extends JViewGroup {}, sup: "android/view/ViewGroup",
  methods: {
    "<init>(Landroid/content/Context;)V": async function (this: any, c: unknown) { await initViewFromCtx(this, c, null); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: any, c: unknown, set: any) { await initViewFromCtx(this, c, set); },
    "getSettings()Landroid/webkit/WebSettings;": () => new (rt.link("android/webkit/WebSettings").ctor)(),
    "loadUrl(Ljava/lang/String;)V": () => {},
    "loadData(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": () => {},
    "loadDataWithBaseURL(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": () => {},
    "setWebViewClient(Landroid/webkit/WebViewClient;)V": () => {},
    "setWebChromeClient(Landroid/webkit/WebChromeClient;)V": () => {},
    "addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V": () => {},
    "setBackgroundColor(I)V": () => {},
    "onResume()V": () => {}, "onPause()V": () => {}, "destroy()V": () => {},
    "canGoBack()Z": () => 0, "goBack()V": () => {}, "reload()V": () => {},
    "getUrl()Ljava/lang/String;": () => null,
    "setVerticalScrollBarEnabled(Z)V": () => {}, "setHorizontalScrollBarEnabled(Z)V": () => {},
    "clearCache(Z)V": () => {}, "clearHistory()V": () => {},
    "setDownloadListener(Landroid/webkit/DownloadListener;)V": () => {},
    "setLayerType(ILandroid/graphics/Paint;)V": () => {},
    "setInitialScale(I)V": () => {},
    "setScrollBarStyle(I)V": () => {},
    "requestFocusFromTouch()Z": () => 1,
    "setFocusable(Z)V": () => {}, "setFocusableInTouchMode(Z)V": () => {},
    "stopLoading()V": () => {}, "getContentHeight()I": () => 0,
    "setVisibility(I)V": () => {},
    "static setWebContentsDebuggingEnabled(Z)V": () => {},
  },
});
rt.register({
  name: "android/webkit/WebSettings", ctor: class extends JObj {},
  methods: {
    "setJavaScriptEnabled(Z)V": () => {}, "setDomStorageEnabled(Z)V": () => {},
    "setLoadWithOverviewMode(Z)V": () => {}, "setUseWideViewPort(Z)V": () => {},
    "setBuiltInZoomControls(Z)V": () => {}, "setSupportZoom(Z)V": () => {},
    "setCacheMode(I)V": () => {}, "setUserAgentString(Ljava/lang/String;)V": () => {},
    "getUserAgentString()Ljava/lang/String;": () => "Mozilla/5.0 (Linux; Android 13; webdroid)",
    "setMediaPlaybackRequiresUserGesture(Z)V": () => {}, "setAllowFileAccess(Z)V": () => {},
    "setPluginState(Landroid/webkit/WebSettings$PluginState;)V": () => {},
    "setMixedContentMode(I)V": () => {},
    "setSupportMultipleWindows(Z)V": () => {},
    "setJavaScriptCanOpenWindowsAutomatically(Z)V": () => {},
    "setAppCacheEnabled(Z)V": () => {},
    "setDatabaseEnabled(Z)V": () => {},
    "setGeolocationEnabled(Z)V": () => {},
    "setRenderPriority(Landroid/webkit/WebSettings$RenderPriority;)V": () => {},
    "setSaveFormData(Z)V": () => {},
    "setNeedInitialFocus(Z)V": () => {},
    "setSavePassword(Z)V": () => {},
    "setAppCacheMaxSize(J)V": () => {},
    "setAppCachePath(Ljava/lang/String;)V": () => {},
    "setDatabasePath(Ljava/lang/String;)V": () => {},
    "setDisplayZoomControls(Z)V": () => {},
  },
});
rt.register({ name: "android/webkit/DownloadListener", ctor: class extends JObj {} });

// Base no-ops: SDK subclasses invoke-super these.
rt.register({
  name: "android/webkit/WebViewClient", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "shouldOverrideUrlLoading(Landroid/webkit/WebView;Ljava/lang/String;)Z": () => 0,
    "onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V": () => {},
    "onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V": () => {},
    "onReceivedError(Landroid/webkit/WebView;ILjava/lang/String;Ljava/lang/String;)V": () => {},
    "onLoadResource(Landroid/webkit/WebView;Ljava/lang/String;)V": () => {},
  },
});
rt.register({
  name: "android/webkit/WebChromeClient", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "onConsoleMessage(Landroid/webkit/ConsoleMessage;)Z": () => 0,
    "onProgressChanged(Landroid/webkit/WebView;I)V": () => {},
    "onReceivedTitle(Landroid/webkit/WebView;Ljava/lang/String;)V": () => {},
    "onJsAlert(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Landroid/webkit/JsResult;)Z": () => 0,
    "onJsConfirm(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Landroid/webkit/JsResult;)Z": () => 0,
    "onJsPrompt(Landroid/webkit/WebView;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/webkit/JsPromptResult;)Z": () => 0,
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
class JWebResourceResponse extends JObj { mime: string | null = null; enc: string | null = null; data: unknown = null; }
rt.register({
  name: "android/webkit/WebResourceResponse", ctor: JWebResourceResponse,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/io/InputStream;)V":
      function (this: JWebResourceResponse, m: string, e: string, d: unknown) { this.mime = m; this.enc = e; this.data = d; },
    "getMimeType()Ljava/lang/String;": function (this: JWebResourceResponse) { return this.mime; },
    "getEncoding()Ljava/lang/String;": function (this: JWebResourceResponse) { return this.enc; },
    "getData()Ljava/io/InputStream;": function (this: JWebResourceResponse) { return this.data; },
  },
});
