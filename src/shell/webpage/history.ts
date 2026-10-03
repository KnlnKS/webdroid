export function installWebHistory(context: { page: string | null }): void {
  if (!context.page) return;
  const source = new URL(context.page);
  if (source.protocol !== "https:" && source.protocol !== "http:") return;
  const sync = () => {
    const url = new URL(location.href);
    url.protocol = source.protocol; url.hostname = source.hostname; url.port = source.port;
    context.page = url.href;
    document.querySelector("base[data-wd-document-base]")?.setAttribute("href", url.href);
  };
  const wrap = (method: History["pushState"]): History["pushState"] => function (this: History, ...args) {
    if (this !== history || args.length < 3 || args[2] == null) return Reflect.apply(method, this, args);
    const value = `${args[2]}`;
    if (!value) { args[2] = value; return Reflect.apply(method, this, args); }
    let url: URL;
    try { url = new URL(value, document.baseURI); }
    catch { args[2] = value; return Reflect.apply(method, this, args); }
    if (url.origin === source.origin) {
      url.protocol = location.protocol; url.hostname = location.hostname; url.port = location.port;
    }
    args[2] = url.href;
    const result = Reflect.apply(method, this, args);
    sync();
    return result;
  };
  History.prototype.pushState = wrap(History.prototype.pushState);
  History.prototype.replaceState = wrap(History.prototype.replaceState);
  addEventListener("popstate", sync);
  addEventListener("hashchange", sync);
}
