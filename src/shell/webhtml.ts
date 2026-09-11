import { WEB_INJECT } from "./webinject";

export const htmlAttribute = (value: string) => value.replace(/[&"<]/g, c => c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&lt;");

function bases(rewriter: HTMLRewriter, visit: (element: HTMLRewriterTypes.Element) => void) {
  let templates = 0;
  return rewriter.on("template", { element(element) {
    templates++;
    element.onEndTag(() => { templates--; });
  } }).on("base", { element(element) {
    if (!templates && element.namespaceURI === "http://www.w3.org/1999/xhtml") visit(element);
  } });
}

export function webDocument(html: string, url?: string): string {
  let hasBase = false, hasHref = false;
  if (url !== undefined) bases(new HTMLRewriter(), element => {
    hasBase = true;
    hasHref ||= element.hasAttribute("href");
  }).transform(html);

  const injection = (url === undefined ? "" : `<meta name="wd-proxy-url" content="${htmlAttribute(url)}">`
    + `<base${hasBase ? " data-wd-fallback" : ""} href="${htmlAttribute(url)}">`) + WEB_INJECT;
  let inserted = false;
  const rewriter = new HTMLRewriter().on("*", { element(element) {
    if (inserted || element.tagName === "html") return;
    if (element.tagName === "head") element.prepend(injection, { html: true });
    else element.before(injection, { html: true });
    inserted = true;
  } }).onDocument({
    text(text) {
      if (!inserted && /\S/.test(text.text)) {
        text.before(injection, { html: true });
        inserted = true;
      }
    },
    end(end) { if (!inserted) end.append(injection, { html: true }); },
  });
  if (url !== undefined) bases(rewriter, element => {
    const href = element.getAttribute("href");
    // Keep pre-base resources on the upstream origin, then remove the fallback before page scripts see both bases.
    if (hasBase && (href !== null || !hasHref)) {
      element.before('<script>document.querySelector("base[data-wd-fallback]")?.remove()</script>', { html: true });
      hasBase = false;
    }
    if (href !== null) {
      const resolved = URL.parse(href, url);
      element.setAttribute("href", resolved && !["data:", "javascript:"].includes(resolved.protocol) ? resolved.href : url);
    } else if (!hasHref) {
      element.setAttribute("href", url);
      hasHref = true;
    }
  });
  return rewriter.transform(html);
}
