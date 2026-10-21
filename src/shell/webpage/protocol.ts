// What a WebView's renderer documents and the app tell each other. A renderer document announces
// itself on the app's window (RendererReady) and takes its task with a port (RendererTask); the page it
// loads then talks to the app over that port (PageMessage one way, AppMessage the other) and calls its
// JavaScript interfaces through the bridge (BridgeCall), as the proxy calls the client's callbacks.
import type { ClientHints } from "./clienthints.ts";

/** a cookie as document.cookie shows it, and when it expires (0: with the session) */
export type DocumentCookie = { text: string; expires: number };
/** what a navigation carries besides its URL: a form's request */
export type FrameInit = { method?: string; body?: ArrayBuffer; contentType?: string };
/** the WebView settings' font faces, by their families, and the rules that use them */
export type WebFonts = { faces: { family: string; path: string; weight: string; style: string; stretch: string }[]; css: string };
/** the document a frame loads: fetched from `src` (with a form's request), or the app's `html`, at
 *  `final` when a redirect led there */
export type FrameDocument = { src: string; init?: FrameInit } | { html: string; final?: string };

/** a renderer document's announcement: its bridge and, for a subframe, its token */
export type RendererReady = { kind: "ready"; bridge: string | null; sub: string | null };
/** a subframe's renderer document to the page that frames it, ahead of its load (frames.ts) */
export const FRAME_BOOTSTRAP = { wdFrame: "bootstrap" } as const;
/** the page a renderer document loads, and the context its page script and worker read */
export interface LoadMessage {
  kind: "load"; page: string; userAgent: string; intercept: boolean; interfaces: Record<string, Record<string, boolean>>;
  cookies: DocumentCookie[]; clientHints: ClientHints; sharedThread: boolean | undefined; frames: string; fonts: WebFonts; document: FrameDocument;
}
/** what a renderer origin's storage frame does: report its quota-managed usage, or delete its
 *  IndexedDB and file systems ("origin"), with its localStorage ("data"), or everything ("all") */
export type StorageOp = "usage" | "origin" | "data" | "all";
export type RendererTask = LoadMessage | { kind: "storage"; op: StorageOp };
/** the load's context, as the renderer bootstrap answers its worker: its bridge, and whether it is a subframe */
export type RendererContext = Omit<LoadMessage, "kind" | "document"> & { id: string; sub: boolean };
/** what the renderer bootstrap leaves the page script: the context, and the port to the app */
export type PageConfig = RendererContext & { port: MessagePort };

export type Invoke = { kind: "invoke"; object: string; method: string; args: unknown[] };
/** a request as the app's shouldInterceptRequest sees it */
export type WebRequest = { url: string; method: string; main: boolean; headers: Record<string, string> };
/** a WebResourceResponse, or the answer of the app's own server; its body base64 */
export type WebResponse = { body: string; status: number; reason: string; headers: Record<string, string> };
export type BridgeCall = Invoke | { kind: "probe" } | ({ kind: "request" } & WebRequest)
  | { kind: "loopback"; url: string; method: string; headers: Record<string, string>; body?: string };
/** the app's answer to a BridgeCall: a method's value (`void` when it returns none), a WebResponse or
 *  null, or why it failed */
export type BridgeReply<T = unknown> = { value: T } | { void: true } | { error: string };
/** a call or its reply on the bridge's socket, numbered so that the reply finds its call */
export const encodeFrame = (seq: number | string, body: string) => seq + "\n" + body;
export function decodeFrame(message: string): { seq: string; body: string } | null {
  const at = message.indexOf("\n");
  return at < 1 ? null : { seq: message.slice(0, at), body: message.slice(at + 1) };
}
/** a page's message to the app; "subframe", "webasset" and "webcookies" come with a port for the answer */
export type PageMessage = Invoke
  | { kind: "script-ready" }
  | { kind: "console"; message: string; source: string; line: number }
  | { kind: "cookie"; value: string; seq: number }
  | { kind: "thread"; shared: boolean }
  | { kind: "loaded"; url: string | null; title: string; error: string | null; width: number; height: number }
  | { kind: "size"; width: number; height: number }
  | { kind: "fragment"; url: string }
  | { kind: "navigate"; url: string; replace: boolean }
  | { kind: "submit"; url: string; init: FrameInit & { method: string; body: ArrayBuffer } }
  | { kind: "redirect"; url: string; html: string }
  | { kind: "download"; url: string; disposition: string; mime: string; length: number }
  | { kind: "subframe"; url: string; init?: FrameInit }
  | { kind: "webasset"; path: string }
  | { kind: "webcookies"; url: string; values: string[] };
/** the app's message to a page; "eval" and "snapshot" come with a port for the answer */
export type AppMessage = { kind: "cookies"; list: DocumentCookie[]; ack: number } | { kind: "eval"; script: string } | { kind: "stop" } | { kind: "snapshot" };

/** what each request that comes with a port answers: the app a page's ("subframe") and its worker's
 *  ("webasset", "webcookies"), the renderer bootstrap its worker's ("webcontext"), a page the app's
 *  ("eval", "snapshot") and a storage frame the app's ("storage") */
export interface Answers {
  subframe: string | null;
  webasset: { status: number; bytes?: Uint8Array<ArrayBuffer>; type?: string };
  webcookies: string;
  webcontext: RendererContext;
  eval: string;
  snapshot: { width: number; height: number; data: string } | { error: string };
  storage: { usage?: number; quota?: number };
}
/** `message` as `post` sends it with the port its answer comes back on; a rejection ("timed out",
 *  "interrupted") when `ms` pass or `signal` aborts first */
export function request<M extends { kind: keyof Answers }>(message: M, post: (message: M, port: MessagePort) => void,
  ms?: number, signal?: AbortSignal): Promise<Answers[M["kind"]]> {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve, reject) => {
    const settle = (done: () => void) => { clearTimeout(timer); signal?.removeEventListener("abort", interrupted); port1.close(); done(); };
    const interrupted = () => settle(() => reject("interrupted"));
    const timer = ms === undefined ? undefined : setTimeout(() => settle(() => reject("timed out")), ms);
    signal?.addEventListener("abort", interrupted);
    port1.onmessage = ({ data }) => settle(() => resolve(data));
    post(message, port2);
  });
}
/** answer `message`, which came with `port` */
export function respond<M extends { kind: keyof Answers }>(_message: M, port: MessagePort, value: Answers[M["kind"]]): void {
  port.postMessage(value);
  port.close();
}
/** `html` with `script` first: after its doctype, or the document goes quirks */
export function withPageScript(html: string, script: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  return doctype + script + html.slice(doctype.length);
}

type Fields = Record<string, unknown>;
const text = (v: unknown): v is string => typeof v === "string", count = (v: unknown): v is number => typeof v === "number";
const fields = (data: unknown): Fields | null => typeof data === "object" && data !== null ? data as Fields : null;
const init = (data: unknown): FrameInit => {
  const m = fields(data) ?? {};
  return { method: text(m.method) ? m.method : undefined, body: m.body instanceof ArrayBuffer ? m.body : undefined, contentType: text(m.contentType) ? m.contentType : undefined };
};
const invoke = (m: Fields): Invoke | null => text(m.object) && text(m.method) && Array.isArray(m.args) ? { kind: "invoke", object: m.object, method: m.method, args: m.args } : null;

/** what a page sent, if it is a message of the protocol */
export function parsePageMessage(data: unknown): PageMessage | null {
  const m = fields(data), url = m?.url;
  switch (m?.kind) {
    case "invoke": return invoke(m);
    case "script-ready": return { kind: "script-ready" };
    case "console": return { kind: "console", message: String(m.message), source: text(m.source) ? m.source : "", line: count(m.line) ? m.line : 0 };
    case "cookie": return text(m.value) && count(m.seq) ? { kind: "cookie", value: m.value, seq: m.seq } : null;
    case "thread": return typeof m.shared === "boolean" ? { kind: "thread", shared: m.shared } : null;
    case "loaded": return { kind: "loaded", url: text(url) ? url : null, title: text(m.title) ? m.title : "", error: text(m.error) ? m.error : null,
      width: count(m.width) ? m.width : 0, height: count(m.height) ? m.height : 0 };
    case "size": return count(m.width) && count(m.height) ? { kind: "size", width: m.width, height: m.height } : null;
    case "fragment": return text(url) ? { kind: "fragment", url } : null;
    case "navigate": return text(url) ? { kind: "navigate", url, replace: m.replace === true } : null;
    case "submit": {
      const { method, body, contentType } = init(m.init);
      return text(url) && method !== undefined && body ? { kind: "submit", url, init: { method, body, contentType } } : null;
    }
    case "redirect": return text(url) && text(m.html) ? { kind: "redirect", url, html: m.html } : null;
    case "download": return text(url) && text(m.disposition) && text(m.mime) && count(m.length) && Number.isSafeInteger(m.length)
      ? { kind: "download", url, disposition: m.disposition, mime: m.mime, length: m.length } : null;
    case "subframe": return text(url) ? { kind: "subframe", url, init: init(m.init) } : null;
    case "webasset": return text(m.path) ? { kind: "webasset", path: m.path } : null;
    case "webcookies": return text(url) ? { kind: "webcookies", url, values: Array.isArray(m.values) ? m.values.filter(text) : [] } : null;
  }
  return null;
}

/** a call through the bridge, if it is one */
export function parseBridgeCall(data: unknown): BridgeCall | null {
  const m = fields(data), headers = fields(m?.headers);
  const request = m && text(m.url) && text(m.method) && headers
    ? { url: m.url, method: m.method, headers: Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => text(e[1]))) } : null;
  switch (m?.kind) {
    case "invoke": return invoke(m);
    case "probe": return { kind: "probe" };
    case "request": return request && typeof m.main === "boolean" ? { kind: "request", ...request, main: m.main } : null;
    case "loopback": return request && { kind: "loopback", ...request, body: text(m.body) ? m.body : undefined };
  }
  return null;
}
