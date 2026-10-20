import type { WebCookies } from "./webcookies.ts";
import type { DocumentCookie } from "./webpage/protocol.ts";

/** CookieManager's and the WebView's operations on the app's jar; the owner resolves the caller's package, never a wire package name. */
export type CookieCalls = {
  cookieGet(url: string): Promise<string>;
  cookieSet(url: string, value: string): Promise<boolean>;
  cookieAccept(accept?: boolean): Promise<boolean>;
  cookieHas(): Promise<boolean>;
  cookieRemove(sessionOnly: boolean): Promise<boolean>;
  cookieFlush(): Promise<void>;
  /** the Cookie header of a request to `url` by the page at `site`, once its response's Set-Cookie `values` are stored */
  cookieNetwork(url: string, site: string, values: string[], thirdParty: boolean): Promise<string>;
  /** what a frame's document.cookie reads at `url` once it wrote `value` (WebCookies.document) */
  cookieDocument(url: string, site: string | null, thirdParty: boolean, value?: string): Promise<DocumentCookie[]>;
  /** the caller hears of the jar's changes from now on */
  cookieWatch(): Promise<void>;
};
/** `changed` tells a watching caller of each turn's changes (a response's cookies are one), and answers
 *  false once it no longer hears */
export function cookieCalls(owner: () => Promise<WebCookies>, check: () => void = () => {}, changed: () => boolean = () => false): CookieCalls {
  const run = async <T>(operation: (jar: WebCookies) => T): Promise<T> => {
    const jar = await owner();
    check();
    return operation(jar);
  };
  let watching: Promise<void> | undefined;
  return {
    cookieGet: url => run(jar => jar.get(url)),
    cookieSet: (url, value) => run(jar => jar.set(url, value)),
    cookieAccept: accept => run(jar => {
      if (accept !== undefined) jar.accept = accept;
      return jar.accept;
    }),
    cookieHas: () => run(jar => jar.has()),
    cookieRemove: sessionOnly => run(jar => jar.remove(sessionOnly)),
    cookieFlush: () => run(jar => jar.flush()),
    cookieNetwork: (url, site, values, thirdParty) => run(jar => jar.network(url, site, values, thirdParty)),
    cookieDocument: (url, site, thirdParty, value) => run(jar => jar.document(url, site, thirdParty, value)),
    cookieWatch: () => watching ??= run(jar => {
      let queued = false;
      const stop = jar.watch(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => { queued = false; if (!changed()) stop(); });
      });
    }),
  };
}
