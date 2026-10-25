import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { after, vcall } from "../jvm/natives/jentry.ts";
import { boxBool } from "../jvm/natives/jbox.ts";
import type { CookieCalls } from "../shell/cookie-access.ts";
import { postMain } from "./mainloop.ts";
import { broker } from "../shell/broker-access.ts";

/** The process's CookieManager and WebViews reach the package's one jar, the broker's, through acknowledged operations. */
const calls = (): CookieCalls => broker();
const watchers = new Set<() => void>();
let watching = false;
/** `f` after each change to the jar, until the returned function is called */
export function watchCookies(f: () => void): () => void {
  watchers.add(f);
  // a later WebView asks again if this process's ask failed
  if (!watching) { watching = true; calls().cookieWatch().catch(() => { watching = false; }); }
  return () => watchers.delete(f);
}
/** the broker's notice of a change to the jar */
export function cookiesChanged(): void { for (const f of watchers) f(); }
const complete = (callback: unknown, value: boolean) => {
  if (callback) postMain(() => vcall(callback, "onReceiveValue", "(Ljava/lang/Object;)V", boxBool(value)));
};
let instance: JObj | null = null;
/** the WebView provider's CookieManager, over the app's cookie jar */
export const cookieManager = (): JObj => instance ??= rt.make("webdroid/CookieManager");
let acceptFileSchemeCookies = false;
const get = driven(function* (url: string): Gen { return (yield* awaited(calls().cookieGet(url))) || null; });
const has = driven(function* (): Gen { return (yield* awaited(calls().cookieHas())) ? 1 : 0; });
const removeAll = driven(function* (callback: unknown): Gen { return complete(callback, yield* awaited(calls().cookieRemove(false))); });
const removeSession = driven(function* (callback: unknown): Gen { return complete(callback, yield* awaited(calls().cookieRemove(true))); });
// Chromium's CookieManagerAdapter keeps a WebView's third-party cookie choice in its settings
const settings = (view: JObj) => vcall(view, "getSettings", "()Landroid/webkit/WebSettings;");
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
    "setAcceptThirdPartyCookies(Landroid/webkit/WebView;Z)V": (view: JObj, accept: number) =>
      after(settings(view), (s) => vcall(s, "setAcceptThirdPartyCookies", "(Z)V", accept)),
    "acceptThirdPartyCookies(Landroid/webkit/WebView;)Z": (view: JObj) => after(settings(view), (s) => vcall(s, "getAcceptThirdPartyCookies", "()Z")),
    "removeAllCookies(Landroid/webkit/ValueCallback;)V": removeAll,
    "removeAllCookie()V": () => removeAll(null),
    "removeSessionCookies(Landroid/webkit/ValueCallback;)V": removeSession,
    "removeSessionCookie()V": () => removeSession(null),
    "flush()V": driven(function* (): Gen { yield* awaited(calls().cookieFlush()); }),
  },
});
