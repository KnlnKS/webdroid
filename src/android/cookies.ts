import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { boxBool } from "../jvm/natives/jbox.ts";
import type { WebCookies } from "../shell/webcookies.ts";
import { cookieCalls, type CookieCalls } from "../shell/cookie-access.ts";
import { appHost } from "./apphost.ts";
import { postMain } from "./mainloop.ts";

const defaults = new Map<string, Promise<WebCookies>>();
export let webCookies = (pkg: string): Promise<WebCookies> => {
  let store = defaults.get(pkg);
  if (!store) { store = import("../shell/webcookies.ts").then(({ WebCookies }) => new WebCookies(pkg)); defaults.set(pkg, store); }
  return store;
};
export function useWebCookies(get: typeof webCookies) { webCookies = get; }
/** The process's CookieManager reaches the canonical jar through acknowledged operations. */
export const cookieTransport: { calls?: () => CookieCalls } = {};
const localCalls = cookieCalls(() => webCookies(appHost?.pkg ?? ""));
const calls = (): CookieCalls => cookieTransport.calls?.() ?? localCalls;
const complete = (callback: unknown, value: boolean) => {
  if (callback) postMain(() => vcall(callback, "onReceiveValue", "(Ljava/lang/Object;)V", boxBool(value)));
};
/** the WebViews whose pages may send third-party cookies */
export const thirdPartyCookies = new WeakSet<JObj>();
let instance: JObj | null = null;
/** the WebView provider's CookieManager, over the app's cookie jar */
export const cookieManager = (): JObj => instance ??= rt.make("webdroid/CookieManager");
let acceptFileSchemeCookies = false;
const get = driven(function* (url: string): Gen { return (yield* awaited(calls().cookieGet(url))) || null; });
const has = driven(function* (): Gen { return (yield* awaited(calls().cookieHas())) ? 1 : 0; });
const removeAll = driven(function* (callback: unknown): Gen { return complete(callback, yield* awaited(calls().cookieRemove(false))); });
const removeSession = driven(function* (callback: unknown): Gen { return complete(callback, yield* awaited(calls().cookieRemove(true))); });
rt.register({
  name: "webdroid/CookieManager", ctor: class extends JObj {}, sup: "android/webkit/CookieManager",
  methods: {
    "setAcceptFileSchemeCookiesImpl(Z)V": (accept: number) => { acceptFileSchemeCookies = !!accept; },
    "allowFileSchemeCookiesImpl()Z": () => acceptFileSchemeCookies ? 1 : 0,
    "getCookie(Ljava/lang/String;)Ljava/lang/String;": get,
    // private browsing is unsupported, so the one jar answers both
    "getCookie(Ljava/lang/String;Z)Ljava/lang/String;": get,
    "hasCookies()Z": has,
    "hasCookies(Z)Z": has,
    "setCookie(Ljava/lang/String;Ljava/lang/String;)V": driven(function* (url: string, value: string): Gen { yield* awaited(calls().cookieSet(url, value)); }),
    "setCookie(Ljava/lang/String;Ljava/lang/String;Landroid/webkit/ValueCallback;)V": driven(function* (url: string, value: string, callback: unknown): Gen { complete(callback, yield* awaited(calls().cookieSet(url, value))); }),
    "setAcceptCookie(Z)V": driven(function* (accept: number): Gen { yield* awaited(calls().cookieAccept(!!accept)); }),
    "acceptCookie()Z": driven(function* (): Gen { return (yield* awaited(calls().cookieAccept())) ? 1 : 0; }),
    "setAcceptThirdPartyCookies(Landroid/webkit/WebView;Z)V": (view: JObj, accept: number) => { if (accept) thirdPartyCookies.add(view); else thirdPartyCookies.delete(view); },
    "acceptThirdPartyCookies(Landroid/webkit/WebView;)Z": (view: JObj) => thirdPartyCookies.has(view) ? 1 : 0,
    "removeAllCookies(Landroid/webkit/ValueCallback;)V": removeAll,
    "removeAllCookie()V": () => removeAll(null),
    "removeSessionCookies(Landroid/webkit/ValueCallback;)V": removeSession,
    "removeSessionCookie()V": () => removeSession(null),
    "flush()V": driven(function* (): Gen { yield* awaited(calls().cookieFlush()); }),
  },
});
