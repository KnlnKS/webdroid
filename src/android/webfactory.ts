// WebViewFactory's provider: the WebView implementation package is this one (webkit.ts's provider),
// and what AOSP's WebView statics reach through it.
import { awaited, rt, JObj, stubs, fieldSetters, driven, setDeclared, type Gen } from "../jvm/runtime.ts";
import { vcall, scall, newObj, linkClass } from "../jvm/natives/jentry.ts";
import { boxBool } from "../jvm/natives/jbox.ts";
import { hostStub } from "./binder.ts";
import { onMain } from "./mainloop.ts";
import { cookieManager } from "./cookies.ts";
import { createFunctor } from "./webfunctor.ts";
import { newSettings } from "./websettings.ts";
import { defaultUserAgent, providerVersion } from "./webuseragent.ts";
import type { WebViewChromium } from "./webkit.ts";

const inst = <T = JObj>(cls: string): T => rt.make(cls);
const WEBVIEW_PACKAGE = "com.android.webview";
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
      linkClass("android/webkit/WebViewFactory").setStatic("sPackageInfo", yield* awaited(webViewPackage()));
      return yield scall("java/lang/Class", "forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;", FACTORY.replace(/\//g, "."), 0, null);
    }),
  },
});
// WebViewUpdateService: the provider package is the only one, current and never updated
rt.register({ name: "webdroid/WebViewUpdateService", ctor: class extends JObj {}, sup: "android/webkit/IWebViewUpdateService$Stub", methods: {
  "getCurrentWebViewPackage()Landroid/content/pm/PackageInfo;": webViewPackage,
  "getCurrentWebViewPackageName()Ljava/lang/String;": () => WEBVIEW_PACKAGE,
} });
hostStub("webviewupdate", "webdroid/WebViewUpdateService");


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
/** the provider factory WebViewFactory created */
export const factory = () => theFactory!;
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
    "getWebViewClassLoader()Ljava/lang/ClassLoader;": driven(function* (): Gen {
      return yield vcall(yield scall("java/lang/Class", "forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;", FACTORY.replace(/\//g, "."), 0, null), "getClassLoader", "()Ljava/lang/ClassLoader;");
    }),
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
