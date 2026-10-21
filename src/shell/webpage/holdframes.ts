// The frames in HTML a WebView page parses, held until the app answers where each loads (frames.ts).

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
