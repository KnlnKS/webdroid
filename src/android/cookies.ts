import { JObj, rt, noops, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { boxBool } from "../jvm/natives/jbox";
import type { WebCookies } from "../shell/webcookies";
import { appHost } from "./apphost";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";

const defaults = new Map<string, Promise<WebCookies>>();
export let webCookies = (pkg: string): Promise<WebCookies> => {
  let store = defaults.get(pkg);
  if (!store) { store = import("../shell/webcookies").then(({ WebCookies }) => new WebCookies(pkg)); defaults.set(pkg, store); }
  return store;
};
// a child process gets the broker's Promise from the parent realm, which a driven native
// would not recognise as one to wait for
export function useWebCookies(get: typeof webCookies) { webCookies = (pkg) => Promise.resolve(get(pkg)); }
const store = () => webCookies(appHost?.pkg ?? "");
const complete = (callback: unknown, value: boolean) => {
  if (callback) void onMain(() => vcall(callback, "onReceiveValue", "(Ljava/lang/Object;)V", boxBool(value))).catch(reportUncaught);
};
export const thirdPartyCookies = new WeakSet<JObj>();
class JCookieManager extends JObj {}
let instance: JCookieManager | null = null;
let acceptFileSchemeCookies = false;
// the deprecated syncer: cookies are written through as they are set, so every sync is a no-op
let syncManager: JObj | null = null;
rt.register({
  name: "android/webkit/CookieSyncManager", ctor: class extends JObj {},
  methods: {
    "static createInstance(Landroid/content/Context;)Landroid/webkit/CookieSyncManager;": () => syncManager ??= rt.make("android/webkit/CookieSyncManager") as JObj,
    "static getInstance()Landroid/webkit/CookieSyncManager;": () => {
      if (!syncManager) throw rt.mkThrowable("java/lang/IllegalStateException", "CookieSyncManager::createInstance() needs to be called before CookieSyncManager::getInstance()");
      return syncManager;
    },
    ...noops("sync()V"),
  },
});
rt.register({
  name: "android/webkit/CookieManager", ctor: JCookieManager,
  methods: {
    "static getInstance()Landroid/webkit/CookieManager;": () => instance ??= new JCookieManager(),
    "static setAcceptFileSchemeCookies(Z)V": (accept: number) => { acceptFileSchemeCookies = !!accept; },
    "static allowFileSchemeCookies()Z": () => acceptFileSchemeCookies ? 1 : 0,
    "getCookie(Ljava/lang/String;)Ljava/lang/String;": driven(function* (url: string): Gen { return (yield store()).get(url) || null; }),
    "setCookie(Ljava/lang/String;Ljava/lang/String;)V": driven(function* (url: string, value: string): Gen { (yield store()).set(url, value); }),
    "setCookie(Ljava/lang/String;Ljava/lang/String;Landroid/webkit/ValueCallback;)V": driven(function* (url: string, value: string, callback: unknown): Gen { complete(callback, (yield store()).set(url, value)); }),
    "setAcceptCookie(Z)V": driven(function* (accept: number): Gen { (yield store()).accept = !!accept; }),
    "acceptCookie()Z": driven(function* (): Gen { return (yield store()).accept ? 1 : 0; }),
    "setAcceptThirdPartyCookies(Landroid/webkit/WebView;Z)V": (view: JObj, accept: number) => { if (accept) thirdPartyCookies.add(view); else thirdPartyCookies.delete(view); },
    "acceptThirdPartyCookies(Landroid/webkit/WebView;)Z": (view: JObj) => thirdPartyCookies.has(view) ? 1 : 0,
    "hasCookies()Z": driven(function* (): Gen { return (yield store()).has() ? 1 : 0; }),
    "removeAllCookies(Landroid/webkit/ValueCallback;)V": driven(function* (callback: unknown): Gen { return complete(callback, (yield store()).remove()); }),
    "removeSessionCookies(Landroid/webkit/ValueCallback;)V": driven(function* (callback: unknown): Gen { return complete(callback, (yield store()).remove(true)); }),
    "flush()V": driven(function* (): Gen { (yield store()).flush(); }),
  },
});
