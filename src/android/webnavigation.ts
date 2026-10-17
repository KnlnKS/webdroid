// What a WebView loads for a URL, and the back/forward history Chromium keeps of it.
import { rt, JObj } from "../jvm/runtime.ts";
import { runningApp } from "./apphost.ts";
import { WEB_INJECT } from "../shell/webinject.ts";
import type { FrameDocument, FrameInit } from "../shell/webpage/protocol.ts";

/** what the browser loads for an Android URL: the dev server fronts http(s) and the apk's assets */
export function srcFor(url: string): string {
  if (/^https?:/i.test(url)) return "/proxy?frame=1&url=" + encodeURIComponent(url);
  const m = /^file:\/\/\/android_asset\/(.*)$/i.exec(url);
  return m ? "/asset/" + encodeURIComponent(runningApp().assetKey) + "/assets/" + m[1] : url;
}
/** the entry of `url`, which the frame fetches */
export const srcEntry = (url: string, init?: FrameInit): SrcEntry => ({ url, src: srcFor(url), init });
/** a page as history keeps it: a URL the frame fetches (`src`, with a form's request), or a document
 *  the app wrote (with its base URL) */
export type SrcEntry = { url: string; src: string; init?: FrameInit };
export type Entry = SrcEntry | { url: string; doc: string; base?: string };
/** what a frame loads for `e`: the document a redirect already fetched, the app's, or its src */
export const documentFor = (e: Entry, prefetched?: string): FrameDocument =>
  prefetched !== undefined ? { html: prefetched, final: e.url } : "doc" in e ? { html: e.doc } : { src: e.src, init: e.init };
/** the web origin whose storage a page of `e` keeps: the base URL's for a document the app wrote,
 *  the file scheme's for files, and none (opaque) otherwise */
export function webOrigin(e: Entry): string {
  const url = "doc" in e ? e.base ?? "" : e.url;
  return /^https?:/i.test(url) ? new URL(url).origin : /^file:/i.test(url) ? "file://" : "null";
}
/** srcdoc payload: the bridge bootstrap first (after a doctype, or the document goes quirks), then the base */
export function srcdoc(data: string, enc: string | null, base: string | null): string {
  if (/^base64$/i.test(enc ?? "")) data = new TextDecoder().decode(Uint8Array.fromBase64(data));
  const inject = WEB_INJECT + (base ? `<base href="${base.replace(/"/g, "&quot;")}">` : "");
  const dt = /^\s*<!doctype[^>]*>/i.exec(data);
  return dt ? dt[0] + inject + data.slice(dt[0].length) : inject + data;
}
class JWebHistoryItem extends JObj {
  entry: Entry;
  constructor(entry: Entry) { super(); this.entry = entry; }
}
class JWebBackForwardList extends JObj {
  entries: Entry[]; index: number;
  constructor(entries: Entry[], index: number) { super(); this.entries = entries; this.index = index; }
}
const item = (e: Entry | undefined) => e ? new JWebHistoryItem(e) : null;
rt.register({
  name: "webdroid/WebHistoryItem", ctor: JWebHistoryItem, sup: "android/webkit/WebHistoryItem",
  methods: {
    "getUrl()Ljava/lang/String;": function (this: JWebHistoryItem) { return this.entry.url; },
    "getOriginalUrl()Ljava/lang/String;": function (this: JWebHistoryItem) { return this.entry.url; },
    "getTitle()Ljava/lang/String;": () => null,
    "getFavicon()Landroid/graphics/Bitmap;": () => null,
    "getId()I": () => -1,
    "clone()Landroid/webkit/WebHistoryItem;": function (this: JWebHistoryItem) { return item(this.entry); },
  },
});
rt.register({
  name: "webdroid/WebBackForwardList", ctor: JWebBackForwardList, sup: "android/webkit/WebBackForwardList",
  methods: {
    "getSize()I": function (this: JWebBackForwardList) { return this.entries.length; },
    "getCurrentIndex()I": function (this: JWebBackForwardList) { return this.index; },
    "getCurrentItem()Landroid/webkit/WebHistoryItem;": function (this: JWebBackForwardList) { return item(this.entries[this.index]); },
    "getItemAtIndex(I)Landroid/webkit/WebHistoryItem;": function (this: JWebBackForwardList, index: number) { return item(this.entries[index]); },
    "clone()Landroid/webkit/WebBackForwardList;": function (this: JWebBackForwardList) { return backForward(this.entries, this.index); },
  },
});
const backForward = (entries: Entry[], index: number) => new JWebBackForwardList(entries.map((e) => ({ ...e })), index);

/** a WebView's back/forward list: its entries and the current one */
export class WebHistory {
  entries: Entry[] = [];
  index = -1;
  get current(): Entry | undefined { return this.entries[this.index]; }
  /** `e` after the current entry, in place of the forward ones */
  push(e: Entry) { this.entries.length = ++this.index; this.entries.push(e); }
  /** `e` in place of the current entry, as a redirect or location.replace does */
  replace(e: Entry) { if (this.index >= 0) this.entries[this.index] = e; }
  canGo(n: number) { const i = this.index + n; return i >= 0 && i < this.entries.length; }
  /** the entry `n` away, now current, if there is one */
  go(n: number): Entry | undefined { if (!this.canGo(n)) return undefined; this.index += n; return this.current; }
  /** Chromium prunes every entry but the current one */
  clear() { if (this.index >= 0) { this.entries = [this.entries[this.index]]; this.index = 0; } }
  /** a WebBackForwardList of the entries as they are now */
  copy(): JObj { return backForward(this.entries, this.index); }
}
