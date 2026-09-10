import { JObj, maySuspend, rt } from "../jvm/runtime";
import { box, JBool, vcall } from "../jvm/natives/jlang";
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
export function useWebCookies(get: typeof webCookies) { webCookies = get; }
const store = () => webCookies(appHost?.pkg ?? "");
const complete = (callback: unknown, value: boolean) => {
  if (callback) void onMain(() => vcall(callback, "onReceiveValue", "(Ljava/lang/Object;)V", box(JBool, value ? 1 : 0))).catch(reportUncaught);
};
export const thirdPartyCookies = new WeakSet<JObj>();
class JCookieManager extends JObj {}
let instance: JCookieManager | null = null;
rt.register({
  name: "android/webkit/CookieManager", ctor: JCookieManager,
  methods: {
    "static getInstance()Landroid/webkit/CookieManager;": () => instance ??= new JCookieManager(),
    "getCookie(Ljava/lang/String;)Ljava/lang/String;": maySuspend(async (url: string) => (await store()).get(url) || null),
    "setCookie(Ljava/lang/String;Ljava/lang/String;)V": maySuspend(async (url: string, value: string) => { (await store()).set(url, value); }),
    "setCookie(Ljava/lang/String;Ljava/lang/String;Landroid/webkit/ValueCallback;)V": maySuspend(async (url: string, value: string, callback: unknown) => { complete(callback, (await store()).set(url, value)); }),
    "setAcceptCookie(Z)V": maySuspend(async (accept: number) => { (await store()).accept = !!accept; }),
    "acceptCookie()Z": maySuspend(async () => (await store()).accept ? 1 : 0),
    "setAcceptThirdPartyCookies(Landroid/webkit/WebView;Z)V": (view: JObj, accept: number) => { if (accept) thirdPartyCookies.add(view); else thirdPartyCookies.delete(view); },
    "acceptThirdPartyCookies(Landroid/webkit/WebView;)Z": (view: JObj) => thirdPartyCookies.has(view) ? 1 : 0,
    "hasCookies()Z": maySuspend(async () => (await store()).has() ? 1 : 0),
    "removeAllCookies(Landroid/webkit/ValueCallback;)V": maySuspend(async (callback: unknown) => complete(callback, (await store()).remove())),
    "removeSessionCookies(Landroid/webkit/ValueCallback;)V": maySuspend(async (callback: unknown) => complete(callback, (await store()).remove(true))),
    "flush()V": maySuspend(async () => { (await store()).flush(); }),
  },
});
