export function installWebLocation(context: { page: string | null }, navigate: (url: string, replace: boolean) => void): void {
  if (!context.page || !/^https?:/.test(context.page)) return;
  let url = new URL(context.page);
  const current = () => {
    if (url.href !== context.page) url = new URL(context.page!);
    return url;
  };
  const go = (next: URL, replace: boolean, hash = false) => {
    if ((hash || next.href.includes("#")) && next.href.split("#")[0] === current().href.split("#")[0]) {
      const local = new URL(location.href);
      local.hash = next.hash;
      if (replace) location.replace(local.href); else location.assign(local.href);
    } else navigate(next.href, replace);
  };
  const assign = (value: string | URL, replace = false) => go(new URL(`${value}`, document.baseURI), replace);
  const virtual: object = Object.create(Location.prototype);
  const check = (receiver: unknown) => { if (receiver !== virtual) throw new TypeError("Illegal invocation"); };
  for (const key of ["href", "protocol", "host", "hostname", "port", "pathname", "search", "hash"] as const) {
    Object.defineProperty(virtual, key, { enumerable: true,
      get: function () { check(this); return current()[key]; },
      set: function (value: string) {
        check(this);
        if (key === "href") { assign(value); return; }
        const next = new URL(current());
        next[key] = value;
        go(next, false, key === "hash");
      },
    });
  }
  Object.defineProperties(virtual, {
    origin: { enumerable: true, get: function () { check(this); return current().origin; } },
    assign: { enumerable: true, value: function (value: string | URL) {
      check(this); if (!arguments.length) throw new TypeError("Location.assign requires a URL"); assign(value);
    } },
    replace: { enumerable: true, value: function (value: string | URL) {
      check(this); if (!arguments.length) throw new TypeError("Location.replace requires a URL"); assign(value, true);
    } },
    reload: { enumerable: true, value: function () { check(this); navigate(current().href, true); } },
    toString: { enumerable: true, value: function () { check(this); return current().href; } },
  });
  const owner = (target: Window | Document) => new Proxy(target, {
    get: (target, key) => key === "location" ? virtual : Reflect.get(target, key, target),
    set: (target, key, value) => {
      if (key !== "location") return Reflect.set(target, key, value, target);
      assign(value); return true;
    },
  });
  const windowOwner = owner(window), documentOwner = owner(document);
  Object.defineProperty(window, "__wdLocationOwner", { value: function (value?: unknown) {
    return !arguments.length || value === window ? windowOwner : value === document ? documentOwner : value;
  } });
  for (const key of ["URL", "documentURI"]) Object.defineProperty(document, key, { get: () => current().href, configurable: true });
}
