// A WebView page's subframes: Chromium loads them through the WebView's network stack, so each
// frame of a web origin renders on that origin's renderer, which the app hands out, and the client
// sees one of another scheme first. The page holds a frame's URL until then; the policy stops any
// direct load the holding missed.

import type { FrameInit } from "./protocol.ts";

/** what a form submits: a GET's URL, or a POST's body as the browser encodes it */
export type FormRequest = { url: string; method: "GET" } | { url: string; method: "POST"; body: ArrayBuffer; contentType?: string };
/** the request a form (with its submitter) submits from a document at `page` */
export async function webFormRequest(form: HTMLFormElement, submitter: HTMLElement | null, page: string | null): Promise<FormRequest | null> {
  const method = (submitter?.getAttribute("formmethod") || form.method).toUpperCase();
  if (method === "DIALOG") return null;
  const action = submitter?.getAttribute("formaction") ?? form.getAttribute("action");
  const url = new URL(action || page || form.ownerDocument.baseURI, form.ownerDocument.baseURI);
  const fields = new FormData(form, submitter);
  if (method === "GET") {
    url.search = "";
    for (const [key, value] of fields) url.searchParams.append(key, typeof value === "string" ? value : value.name);
    return { url: url.href, method: "GET" };
  }
  const encoding = (submitter?.getAttribute("formenctype") || form.enctype).toLowerCase();
  const body = encoding === "multipart/form-data" ? fields
    : encoding === "text/plain" ? [...fields].map(([key, value]) => key + "=" + (typeof value === "string" ? value : value.name)).join("\r\n")
    : new URLSearchParams([...fields].map(([key, value]) => [key, typeof value === "string" ? value : value.name]));
  const request = new Request(url, { method: "POST", body });
  return { url: url.href, method: "POST", contentType: request.headers.get("content-type") ?? undefined,
    body: await request.arrayBuffer() };
}

/** `html` with each frame's src that loads through the app renamed to data-wd-frame-src, so the
 *  parser inserts the frame without a navigation, and each srcdoc's frames held the same way. about:
 *  and javascript: frames load as Chromium loads them, without the client. With `carry`, `html` is
 *  one chunk of a stream (document.write): a construct the chunk leaves open waits in `carry.tail`
 *  for the next one, as the parser would wait for it, and a raw-text element carries over. */
export function holdFrames(html: string, carry?: { raw: string; tail: string }): string {
  if (carry) { html = carry.tail + html; carry.tail = ""; }
  else if (!/<i?frame[\s/>]/i.test(html)) return html;
  const tag = /<(\/?)([a-z][^\s/>]*)/iy, attr = /[\s/]*([^\s/>][^\s/>=]*)(?:\s*=\s*("[^"]*"?|'[^']*'?|[^\s>]*))?/y;
  const raw = /^(script|style|xmp|iframe|noembed|noframes|noscript|textarea|title|plaintext)$/;
  const decode = (value: string) => new DOMParser().parseFromString("<p title=" + value + ">", "text/html").body.firstElementChild?.getAttribute("title") ?? "";
  let out = "", from = 0, i = 0, open = carry?.raw ?? "";
  const cut = (at: number) => {
    carry!.tail = html.slice(at); carry!.raw = open;
    return out + html.slice(from, at);
  };
  for (;;) {
    if (open) {
      if (open === "plaintext") break;
      const end = new RegExp("</" + open + "[\\s/>]", "ig");
      end.lastIndex = i;
      const m = end.exec(html);
      if (!m) {
        const lt = html.lastIndexOf("<");
        if (carry && lt >= i && ("</" + open).startsWith(html.slice(lt).toLowerCase())) return cut(lt);
        break;
      }
      i = m.index; open = "";
    }
    i = html.indexOf("<", i);
    if (i < 0) break;
    const start = i;
    if (html.startsWith("<!--", i) || html[i + 1] === "!" || html[i + 1] === "?") {
      const comment = html.startsWith("<!--", i), end = comment ? html.indexOf("-->", i + 4) : html.indexOf(">", i);
      if (end < 0) { if (carry) return cut(start); break; }
      i = end + (comment ? 3 : 1); continue;
    }
    tag.lastIndex = i;
    const m = tag.exec(html);
    if (!m) {
      if (carry && /^<\/?$/.test(html.slice(i))) return cut(start);
      i++; continue;
    }
    const name = m[2].toLowerCase(), frame = !m[1] && (name === "iframe" || name === "frame");
    const edits: [number, number, string][] = [];
    // the first src counts; a duplicate of a held one is held too, so it cannot take its place
    let src = frame ? 0 : -1, at = tag.lastIndex;
    for (;;) {
      attr.lastIndex = at;
      const a = attr.exec(html);
      if (!a?.[0]) break;
      at = attr.lastIndex;
      if (!frame) continue;
      const key = a[1].toLowerCase();
      if (key === "src" && src >= 0) {
        if (!src && /^\s*$|^\s*(about|javascript):/i.test((a[2] ?? "").replace(/^["']|["']$/g, ""))) { src = -1; continue; }
        src = 1;
        const s = a.index + a[0].search(/[^\s/]/);
        edits.push([s, s + 3, "data-wd-frame-src"]);
      } else if (key === "srcdoc" && name === "iframe" && a[2] && /frame/i.test(a[2])) {
        const value = decode(a[2]), held = holdFrames(value), v = a.index + a[0].length - a[2].length;
        if (held !== value) edits.push([v, v + a[2].length, '"' + held.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"']);
      }
    }
    const close = html.indexOf(">", at);
    if (close < 0) { if (carry) return cut(start); break; }
    for (const [s, e, text] of edits) { out += html.slice(from, s) + text; from = e; }
    i = close + 1;
    if (!m[1] && raw.test(name)) open = name;
  }
  if (carry) carry.raw = open;
  return out + html.slice(from);
}

type NavigateEvent = Event & { cancelable: boolean; hashChange: boolean; downloadRequest: string | null; formData: FormData | null;
  destination: { url: string; sameDocument: boolean } };

/** each frame of the page that loads through the app (any URL but about: and javascript:) loads where
 *  `route` says: its web origin's renderer, the URL itself (data:, blob:), or nowhere. The page's src,
 *  setAttribute, Attr and HTML parsing entry points hold such a frame's URL before its navigation
 *  starts, and navigations of a frame's document (a link or form targeting it, window.open, a
 *  same-origin frame's own) go the same way, here and in each same-origin frame's realm. A navigation
 *  of this document (at `page`) goes to the app: `leave`. `renderers`, the renderer origins, are the
 *  only sites a frame may load from otherwise. `src` reads what the page set; the frame's initial
 *  document, which Chromium never shows, fires no load event. */
export function routeSubframes(renderers: string, route: (url: string, init?: FrameInit) => Promise<unknown>,
  page: () => string | null, leave: (url: string, form?: FormRequest) => void): void {
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "frame-src 'self' data: blob: " + renderers;
  document.head.insertBefore(policy, document.head.firstChild);
  const element = Element.prototype, getAttr = element.getAttribute, setAttr = element.setAttribute, removeAttr = element.removeAttribute;
  const html = "http://www.w3.org/1999/xhtml", fetchNative = fetch.bind(window), createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  // elements of any of the page's realms
  const isFrame = (node: unknown): node is Element => typeof node === "object" && node !== null
    && ((node as Element).localName === "iframe" || (node as Element).localName === "frame") && (node as Element).namespaceURI === html;
  const direct = (raw: string) => /^\s*$|^\s*(about|javascript):/i.test(raw);
  // the URL the page gave each frame, and the src attribute it had meanwhile or from the app's answer
  const frames = new WeakMap<Element, { raw: string; native: string | null; url?: string; answered?: boolean; blob?: Promise<Blob | null> }>();
  // the realms hooked (a srcdoc document keeps its frame's initial window) and documents watched
  const views = new WeakSet<Window>(), documents = new WeakSet<Document>();
  // a blob: URL resolves when the page sets it: its bytes outlive a revocation while the client answers
  const kept = new Set<string>(), revoked = new Set<string>();
  const keep = (url: string) => {
    if (!/^blob:/i.test(url)) return undefined;
    kept.add(url);
    return fetchNative(url).then((r) => r.blob(), () => null);
  };
  const ask = (frame: Element, url: string, init?: FrameInit, blob = keep(url)): Promise<string | null> => route(url, init).then(async (src) => {
    const gone = revoked.delete(url);
    kept.delete(url);
    if (typeof src !== "string") return null;
    if (!blob || src !== url || !gone) return src;
    const bytes = await blob;
    if (!bytes) return src;
    const copy = createURL(bytes);
    frame.addEventListener("load", () => revokeURL(copy), { once: true });
    return copy;
  });
  const visit = (frame: Element) => {
    const held = getAttr.call(frame, "data-wd-frame-src");
    if (held !== null) {
      removeAttr.call(frame, "data-wd-frame-src");
      if (direct(held)) setAttr.call(frame, "src", held); else frames.set(frame, { raw: held, native: getAttr.call(frame, "src") });
    }
    const native = getAttr.call(frame, "src");
    let entry = frames.get(frame);
    if (!entry || entry.native !== native) {
      if (native === null || direct(native)) return;
      frames.set(frame, entry = { raw: native, native });
    }
    if (entry.url !== undefined) return;
    const url = URL.parse(entry.raw, frame.ownerDocument.baseURI);
    if (!url) return;
    const asked = entry;
    asked.url = url.href;
    void ask(frame, url.href, undefined, asked.blob).then((src) => {
      if (frames.get(frame) !== asked) return;
      asked.answered = true;
      if (src === null) return;
      asked.native = src;
      routed(frame, src);
      setAttr.call(frame, "src", src);
    });
  };
  // a frame given a URL that loads through the app takes no src until the app answers
  const request = (frame: Element, raw: string) => {
    latest.delete(frame);
    if (direct(raw)) { frames.delete(frame); return false; }
    frames.set(frame, { raw, native: getAttr.call(frame, "src"), blob: keep(URL.parse(raw, frame.ownerDocument.baseURI)?.href ?? raw) });
    if (frame.isConnected) visit(frame);
    return true;
  };
  const native = (target: object, name: string) => Object.getOwnPropertyDescriptor(target, name)!;
  const windows = { iframe: native(HTMLIFrameElement.prototype, "contentWindow").get!, frame: native(HTMLFrameElement.prototype, "contentWindow").get! };
  const contentWindow = (frame: Element) => windows[frame.localName as keyof typeof windows].call(frame) as (Window & typeof globalThis) | null;
  // a same-origin page in the frame, which would take the app's answer for its own navigation
  const routed = (frame: Element, src: string) => {
    try { Object.defineProperty(contentWindow(frame)!, Symbol.for("wd.routed"), { value: URL.parse(src)?.href, configurable: true }); } catch {}
  };
  // a navigation of a frame's document rather than its src: the frame keeps its attributes, as there
  const latest = new WeakMap<Element, object>(), expected = new WeakMap<Element, string>();
  const go = (frame: Element, url: string, init?: FrameInit) => {
    latest.delete(frame);
    if (direct(url)) { try { contentWindow(frame)!.location.href = url; } catch {} return; }
    const mark = {};
    latest.set(frame, mark);
    void ask(frame, url, init).then((src) => {
      if (src === null || latest.get(frame) !== mark) return;
      latest.delete(frame);
      const href = URL.parse(src, frame.ownerDocument.baseURI)?.href ?? src;
      expected.set(frame, href);
      routed(frame, href);
      try { contentWindow(frame)!.location.href = href; } catch {}
    });
  };
  // the frame a navigation targets, by its browsing context name as Chromium finds it: in the page
  const named = (doc: Document, name: string): Element | null => {
    const list = [...doc.querySelectorAll("iframe, frame")].filter(isFrame), docs: Document[] = [];
    for (const frame of list) {
      let id = getAttr.call(frame, "name");
      try {
        const win = contentWindow(frame);
        if (win) { id = win.name; docs.push(win.document); }
      } catch {}
      if (id === name) return frame;
    }
    for (const child of docs) { const found = child && named(child, name); if (found) return found; }
    return null;
  };
  const target = (doc: Document, name: string): Element | null => {
    const view = doc.defaultView;
    if (!view) return null;
    try {
      if (!name || /^_self$/i.test(name)) return view === window ? null : view.frameElement;
      if (/^_parent$/i.test(name)) return view === window || view.parent === window ? null : view.parent.frameElement;
    } catch { return null; }
    return /^_(blank|top)$/i.test(name) ? null : named(doc, name) ?? (doc === document ? null : named(document, name));
  };
  // the frame a link or form (with its submitter) targets
  const frameFor = (element: Element, submitter?: Element | null) => target(element.ownerDocument, submitter?.getAttribute("formtarget")
    || element.getAttribute("target") || element.ownerDocument.querySelector("base[target]")?.getAttribute("target") || "");
  const added = (node: Node) => {
    // a srcdoc document keeps its frame's initial window, so its parse meets the hooks installed there
    const each = (frame: Element) => { visit(frame); if (frame.localName === "iframe" && getAttr.call(frame, "srcdoc") !== null) adopt(frame); };
    if (isFrame(node)) each(node);
    if ("querySelectorAll" in node) (node as ParentNode).querySelectorAll("iframe, frame").forEach((frame) => { if (isFrame(frame)) each(frame); });
  };
  const adopt = (frame: Element) => {
    // a routed frame's window is another origin's
    const src = getAttr.call(frame, "src");
    if (src !== null && !direct(src)) return;
    try {
      const win = contentWindow(frame);
      if (win?.document) install(win);
    } catch {}
  };
  // a parsed document's frames, held as the parser's own are
  const holdTree = (root: ParentNode) => {
    for (const frame of root.querySelectorAll("iframe, frame")) {
      if (!isFrame(frame)) continue;
      const src = getAttr.call(frame, "src"), doc = frame.localName === "iframe" ? getAttr.call(frame, "srcdoc") : null;
      if (src !== null && !direct(src)) { setAttr.call(frame, "data-wd-frame-src", src); removeAttr.call(frame, "src"); }
      if (doc !== null) setAttr.call(frame, "srcdoc", holdFrames(doc));
    }
    for (const template of root.querySelectorAll("template")) if ("content" in template) holdTree((template as HTMLTemplateElement).content);
  };
  const wrap = (target: object, name: string, change: (native: PropertyDescriptor) => PropertyDescriptor) =>
    Object.defineProperty(target, name, change(native(target, name)));
  // HTML parsed into the page: the frames it held go to the app as the parser inserts them
  const parse = <T>(value: unknown, apply: (value: unknown) => T, scope: () => Node | null | undefined): T => {
    const held = typeof value === "string" ? holdFrames(value) : value, result = apply(held);
    const node = held === value ? null : scope();
    if (node) added(node);
    return result;
  };
  // a frame's src or srcdoc set any way the DOM allows: false when it takes the value as it is
  const attribute = (frame: Element, name: string, value: string, set: (value: string) => void) => {
    const key = name.toLowerCase();
    if (key === "src") return request(frame, value);
    if (key !== "srcdoc" || frame.localName !== "iframe") return false;
    set(holdFrames(value));
    return true;
  };
  const owners = new WeakMap<NamedNodeMap, Element>();
  const attrValue = native(Attr.prototype, "value").set!;
  // an Attr node joining a frame: a src held instead, a srcdoc's frames held in it
  const attach = (attr: Attr | null | undefined, frame: Element | undefined) => {
    if (typeof attr !== "object" || !attr || attr.namespaceURI || !isFrame(frame)) return false;
    const key = attr.localName.toLowerCase();
    if (key === "src") return request(frame, attr.value);
    if (key === "srcdoc" && frame.localName === "iframe") attrValue.call(attr, holdFrames(attr.value));
    return false;
  };
  // document.write's chunks, as one stream per document
  const streams = new WeakMap<Document, { raw: string; tail: string }>();
  const install = (win: Window & typeof globalThis) => {
    if (!views.has(win)) { views.add(win); patch(win); }
    attachDocument(win.document);
  };
  const patch = (win: Window & typeof globalThis & { navigation?: EventTarget }) => {
    win.addEventListener("message", (event) => {
      if (event.data?.wdFrame !== "bootstrap") return;
      const frame = [...win.document.querySelectorAll("iframe, frame")].find((f) => isFrame(f) && contentWindow(f) === event.source);
      if (frame) { bootstrapping.add(frame); event.stopImmediatePropagation(); }
    }, true);
    for (const proto of [win.HTMLIFrameElement.prototype, win.HTMLFrameElement.prototype]) {
      wrap(proto, "src", (src) => ({ ...src, get(this: Element) {
        const held = getAttr.call(this, "data-wd-frame-src");
        if (held !== null) return URL.parse(held, this.ownerDocument.baseURI)?.href ?? held;
        const r = frames.get(this);
        return r?.url !== undefined && getAttr.call(this, "src") === r.native ? r.url : src.get!.call(this);
      }, set(this: Element, value: unknown) { if (!request(this, String(value))) src.set!.call(this, value); } }));
      Object.defineProperty(proto, "getAttribute", { configurable: true, writable: true, value(this: Element, name: string) {
        if (String(name).toLowerCase() !== "src") return getAttr.call(this, name);
        const held = getAttr.call(this, "data-wd-frame-src"), r = frames.get(this), native = getAttr.call(this, "src");
        return held ?? (r && native === r.native ? r.raw : native);
      } });
      if (proto === win.HTMLIFrameElement.prototype) wrap(proto, "srcdoc", (srcdoc) => ({ ...srcdoc, set(this: Element, value: unknown) {
        srcdoc.set!.call(this, typeof value === "string" ? holdFrames(value) : value);
      } }));
      // the page reaches a same-origin frame's realm through these before it can parse into it
      for (const name of ["contentWindow", "contentDocument"])
        wrap(proto, name, (content) => ({ ...content, get(this: Element) { adopt(this); return content.get!.call(this); } }));
      Object.defineProperty(proto, "setAttribute", { configurable: true, writable: true, value(this: Element, name: string, value: string) {
        if (!attribute(this, String(name), String(value), (held) => setAttr.call(this, name, held))) setAttr.call(this, name, value);
      } });
      const setNS = win.Element.prototype.setAttributeNS;
      Object.defineProperty(proto, "setAttributeNS", { configurable: true, writable: true, value(this: Element, ns: string | null, name: string, value: string) {
        if (ns || !attribute(this, String(name), String(value), (held) => setNS.call(this, ns, name, held))) setNS.call(this, ns, name, value);
      } });
      for (const name of ["setAttributeNode", "setAttributeNodeNS"] as const) {
        const set = win.Element.prototype[name];
        Object.defineProperty(proto, name, { configurable: true, writable: true, value(this: Element, attr: Attr) {
          return attach(attr, this) ? null : set.call(this, attr);
        } });
      }
      const attributes = native(win.Element.prototype, "attributes");
      Object.defineProperty(proto, "attributes", { ...attributes, get(this: Element) {
        const map = attributes.get!.call(this) as NamedNodeMap;
        owners.set(map, this);
        return map;
      } });
    }
    for (const name of ["setNamedItem", "setNamedItemNS"] as const) wrap(win.NamedNodeMap.prototype, name, (set) => ({ ...set, value(this: NamedNodeMap, attr: Attr) {
      return attach(attr, owners.get(this)) ? null : set.value.call(this, attr);
    } }));
    // an Attr's own setters, ahead of Node's, so other nodes' text costs nothing more
    for (const name of ["value", "nodeValue", "textContent"]) {
      const accessor = native(name === "value" ? win.Attr.prototype : win.Node.prototype, name);
      Object.defineProperty(win.Attr.prototype, name, { ...accessor, set(this: Attr, value: unknown) {
        const frame = this.ownerElement, text = value === null && name !== "value" ? "" : String(value);
        if (this.namespaceURI || !isFrame(frame) || !attribute(frame, this.localName, text, (held) => accessor.set!.call(this, held))) accessor.set!.call(this, value);
      } });
    }
    for (const proto of [win.Element.prototype, win.ShadowRoot.prototype]) wrap(proto, "innerHTML", (inner) => ({ ...inner, set(this: Element | ShadowRoot, value: unknown) {
      if (this instanceof win.Element && /^(script|style|textarea|title|xmp|noscript|plaintext)$/.test(this.localName)) inner.set!.call(this, value);
      else parse(value, (held) => inner.set!.call(this, held), () => this);
    } }));
    wrap(win.Element.prototype, "outerHTML", (outer) => ({ ...outer, set(this: Element, value: unknown) {
      const parent = this.parentNode;
      parse(value, (held) => outer.set!.call(this, held), () => parent);
    } }));
    wrap(win.Element.prototype, "insertAdjacentHTML", (fn) => ({ ...fn, value(this: Element, position: string, text: unknown) {
      const outside = /^(beforebegin|afterend)$/i.test(String(position));
      return parse(text, (held) => fn.value.call(this, position, held), () => outside ? this.parentNode : this);
    } }));
    for (const proto of [win.Element.prototype, win.ShadowRoot.prototype]) if ("setHTMLUnsafe" in proto) wrap(proto, "setHTMLUnsafe", (fn) => ({ ...fn,
      value(this: Node, text: unknown, ...rest: unknown[]) { return parse(text, (held) => fn.value.call(this, held, ...rest), () => this); } }));
    wrap(win.Range.prototype, "createContextualFragment", (fn) => ({ ...fn, value(this: Range, text: unknown) {
      return fn.value.call(this, typeof text === "string" ? holdFrames(text) : text);
    } }));
    const write = win.Document.prototype.write;
    const flush = (doc: Document) => {
      const stream = streams.get(doc);
      if (!stream?.tail) return;
      const tail = stream.tail;
      stream.tail = "";
      write.call(doc, tail);
    };
    for (const name of ["write", "writeln"] as const) wrap(win.Document.prototype, name, (fn) => ({ ...fn, value(this: Document, ...args: unknown[]) {
      let stream = streams.get(this);
      if (!stream) streams.set(this, stream = { raw: "", tail: "" });
      const pending = stream.tail, chunk = args.join("") + (name === "writeln" ? "\n" : ""), text = pending + chunk, out = holdFrames(chunk, stream);
      // a chunk left open waits for the next write in this script; the parser would wait for it there too
      if (stream.tail && !pending) queueMicrotask(() => flush(this));
      write.call(this, out);
      if (out !== text.slice(0, text.length - stream.tail.length)) added(this);
    } }));
    wrap(win.Document.prototype, "open", (fn) => ({ ...fn, value(this: Document, ...args: unknown[]) {
      if (args.length < 3) streams.delete(this);
      return fn.value.apply(this, args);
    } }));
    wrap(win.Document.prototype, "close", (fn) => ({ ...fn, value(this: Document) { flush(this); return fn.value.call(this); } }));
    // a parsed document's frames enter the page by adoption, past every setter
    wrap(win.DOMParser.prototype, "parseFromString", (fn) => ({ ...fn, value(this: DOMParser, ...args: unknown[]) {
      const doc = fn.value.apply(this, args) as Document;
      holdTree(doc);
      return doc;
    } }));
    if ("parseHTMLUnsafe" in win.Document) wrap(win.Document, "parseHTMLUnsafe", (fn) => ({ ...fn, value(this: unknown, ...args: unknown[]) {
      return fn.value.apply(this, args.map((arg) => typeof arg === "string" ? holdFrames(arg) : arg));
    } }));
    const loaded = new WeakSet<Document>();
    for (const name of ["response", "responseXML"]) wrap(win.XMLHttpRequest.prototype, name, (get) => ({ ...get, get(this: XMLHttpRequest) {
      const value = get.get!.call(this);
      if (value instanceof win.Document && !loaded.has(value)) { loaded.add(value); holdTree(value); }
      return value;
    } }));
    wrap(win.URL, "revokeObjectURL", (fn) => ({ ...fn, value(this: unknown, url: unknown) {
      if (kept.has(String(url))) revoked.add(String(url));
      return fn.value.call(this, url);
    } }));
    // window.open into a frame of the page, by its name
    const open = win.open;
    Object.defineProperty(win, "open", { ...native(win, "open"), value(this: unknown, ...args: unknown[]) {
      const [url, name] = args, frame = url === undefined || String(url) === "" || name === undefined ? null : target(win.document, String(name));
      const href = frame && URL.parse(String(url), win.document.baseURI)?.href;
      if (!frame || !href) return open.apply(this, args as Parameters<typeof open>);
      go(frame, href);
      return contentWindow(frame);
    } });
    // the realm's own navigations: this document's go to the app (its forms' through `submitted`),
    // but for the app's own routing of it; a same-origin frame's route its frame
    const top = win === window, submit = win.HTMLFormElement.prototype.submit;
    win.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { if (!submitted(this, null)) submit.call(this); };
    win.navigation?.addEventListener("navigate", (event) => {
      const nav = event as NavigateEvent, url = nav.destination.url;
      if (!nav.cancelable || nav.destination.sameDocument || nav.hashChange || nav.downloadRequest !== null) return;
      if (top) {
        if (nav.formData || URL.parse(url)?.origin === location.origin || url === (window as unknown as Record<symbol, unknown>)[Symbol.for("wd.routed")]) return;
        nav.preventDefault();
        leave(url);
        return;
      }
      let frame: Element | null = null;
      try { frame = win.frameElement; } catch {}
      if (!frame || direct(url)) return;
      // the app's own answer, to the frame's src or to a navigation of it
      const entry = frames.get(frame);
      if (expected.get(frame) === url) { expected.delete(frame); return; }
      if (entry?.answered && entry.native !== null && URL.parse(entry.native, frame.ownerDocument.baseURI)?.href === url) return;
      nav.preventDefault();
      const fields = nav.formData && new URLSearchParams([...nav.formData].map(([key, value]) => [key, typeof value === "string" ? value : value.name]));
      go(frame, url, fields ? { method: "POST", body: new TextEncoder().encode(fields.toString()).buffer, contentType: "application/x-www-form-urlencoded" } : undefined);
    });
  };
  // a form (with its submitter) into the frame it targets; one targeting none is the realm's own:
  // this document's goes to the app, a same-origin frame's submits as the browser would
  const submitted = (form: HTMLFormElement, submitter: HTMLElement | null) => {
    const top = form.ownerDocument === document, method = (submitter?.getAttribute("formmethod") || form.method).toLowerCase();
    const frame = method === "dialog" ? null : frameFor(form, submitter);
    if (!frame && !top) return false;
    void webFormRequest(form, submitter, top ? page() : form.ownerDocument.URL).then((request) => {
      if (request && frame) go(frame, request.url, request); else if (request) leave(request.url, request);
    });
    return true;
  };
  // a frame's initial document while the app answers, and a renderer's bootstrap document, which
  // announces itself before its load
  const bootstrapping = new WeakSet<Element>();
  const blank = (event: Event) => {
    const frame = event.target, entry = isFrame(frame) ? frames.get(frame) : undefined;
    if (isFrame(frame) && (bootstrapping.delete(frame) || getAttr.call(frame, "data-wd-frame-src") !== null
      || entry && !entry.answered && getAttr.call(frame, "src") === entry.native)) event.stopImmediatePropagation();
  };
  const attachDocument = (doc: Document) => {
    if (documents.has(doc)) return;
    documents.add(doc);
    const view = doc.defaultView as (Window & typeof globalThis) | null;
    if (!view) return;
    doc.addEventListener("load", blank, true);
    new view.MutationObserver((records) => {
      for (const record of records) if (record.type === "attributes") added(record.target); else record.addedNodes.forEach((node) => added(node));
    }).observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "data-wd-frame-src"] });
    // a same-origin frame's document (srcdoc, about:blank) the page did not reach into
    doc.addEventListener("load", (event) => { if (isFrame(event.target)) adopt(event.target); }, true);
    doc.querySelectorAll("iframe, frame").forEach((frame) => { if (isFrame(frame)) visit(frame); });
    // links and forms into a frame, itself included, and this document's own. A same-origin frame's
    // wait for the page's handlers; this document hands every link but an in-page one to the app
    // before them, as the app decides where it loads.
    const top = view === window;
    doc.addEventListener("click", (event) => {
      const link = event.defaultPrevented ? null : (event.target as Element).closest?.<HTMLAnchorElement>("a[href], area[href]");
      if (!link || direct(link.href) || link.hash && link.href.split("#")[0] === doc.baseURI.split("#")[0]) return;
      const frame = frameFor(link);
      if (!frame && !top) return;
      event.preventDefault();
      if (frame) go(frame, link.href); else leave(link.href);
    }, top);
    (top ? view : doc).addEventListener("submit", (event) => {
      if (!event.defaultPrevented && event.target instanceof view.HTMLFormElement && submitted(event.target, (event as SubmitEvent).submitter)) event.preventDefault();
    });
  };
  install(window);
}
