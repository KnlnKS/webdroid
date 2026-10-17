import { WEB_INJECT } from "./webinject.ts";
import { webScript } from "./webscript.ts";

export const htmlAttribute = (value: string) => value.replace(/[&"<]/g, c => c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&lt;");

type RewriterElement = Parameters<NonNullable<Parameters<HTMLRewriter["on"]>[1]["element"]>>[0];

function bases(rewriter: HTMLRewriter, visit: (element: RewriterElement) => void) {
  let templates = 0;
  return rewriter.on("template", { element(element) {
    templates++;
    element.onEndTag(() => { templates--; });
  } }).on("base", { element(element) {
    if (!templates && element.namespaceURI === "http://www.w3.org/1999/xhtml") visit(element);
  } });
}

export async function webDocument(html: string, url?: string, scripts = false): Promise<string> {
  scripts &&= url !== undefined && /^https?:/.test(url);
  let hasBase = false, hasHref = false;
  const scriptBodies: string[][] = [];
  if (url !== undefined) {
    const scan = bases(new HTMLRewriter(), element => {
      hasBase = true;
      hasHref ||= element.hasAttribute("href");
    });
    if (scripts) scan.on("script", {
      element() { scriptBodies.push([]); },
      text(text) { scriptBodies[scriptBodies.length - 1].push(text.text); },
    });
    await scan.transform(new Response(html)).text();
  }

  const injection = (url === undefined ? "" : `<meta name="wd-proxy-url" content="${htmlAttribute(url)}">`
    + `<base data-wd-document-base${hasBase ? " data-wd-fallback" : ""} href="${htmlAttribute(url)}">`) + WEB_INJECT;
  let inserted = false;
  const rewriter = new HTMLRewriter().on("*", { element(element) {
    if (scripts) for (const attribute of element.attributes as Iterable<[string, string] | Attr>) {
      const [name, value] = Array.isArray(attribute) ? attribute : [attribute.name, attribute.value];
      if (/^on/i.test(name)) element.setAttribute(name, webScript(value));
    }
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
  if (scripts) {
    let index = 0;
    rewriter.on("script", {
      element(element) {
        const body = scriptBodies[index++].join("");
        const type = element.getAttribute("type")?.trim() ?? "";
        if (!element.hasAttribute("src") && (!type || type === "module" || /^(?:text|application)\/(?:java|ecma)script$/i.test(type)))
          element.setInnerContent(webScript(body), { html: true });
      },
    });
  }
  if (url !== undefined) bases(rewriter, element => {
    const href = element.getAttribute("href");
    // Pre-base resources need the upstream fallback; replace it when the document supplies its own href.
    if (hasBase && (href !== null || !hasHref)) {
      element.before('<script>document.querySelector("base[data-wd-fallback]")?.remove()</script>', { html: true });
      hasBase = false;
    }
    if (href !== null) {
      const resolved = URL.parse(href, url);
      element.setAttribute("href", resolved && !["data:", "javascript:"].includes(resolved.protocol) ? resolved.href : url);
    } else if (!hasHref) {
      element.setAttribute("href", url);
      element.setAttribute("data-wd-document-base", "");
      hasHref = true;
    }
  });
  return rewriter.transform(new Response(html)).text();
}
