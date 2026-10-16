import type { WebCookies } from "./webcookies.ts";

/** CookieManager operations; the owner resolves the caller's package, never a wire package name. */
export type CookieCalls = {
  cookieGet(url: string): Promise<string>;
  cookieSet(url: string, value: string): Promise<boolean>;
  cookieAccept(accept?: boolean): Promise<boolean>;
  cookieHas(): Promise<boolean>;
  cookieRemove(sessionOnly: boolean): Promise<boolean>;
  cookieFlush(): Promise<void>;
};
export function cookieCalls(owner: () => Promise<WebCookies>, check: () => void = () => {}): CookieCalls {
  const run = async <T>(operation: (jar: WebCookies) => T): Promise<T> => {
    const jar = await owner();
    check();
    return operation(jar);
  };
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
  };
}
