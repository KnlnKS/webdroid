// The renderer origins a WebView's pages render on, apart from this page's window and storage, and
// the documents the app drives there.
import { request, type RendererReady, type RendererTask, type StorageOp } from "./webpage/protocol.ts";

/** the renderer origin pattern: a "*" label stands for each storage partition */
let rendererTemplate: Promise<string> | null = null;
/** the renderer origins, as a CSP source: a wildcard template is one */
export const rendererPattern = (): Promise<string> => rendererTemplate ??= fetch("/webview-origin").then(async (r) => {
  if (!r.ok) throw new Error("WebView requires a separate renderer site");
  const origin: unknown = await r.json();
  if (typeof origin !== "string" || new URL(origin.replace("*", "x")).origin === location.origin) throw new Error("Invalid WebView renderer origin");
  return origin;
});
/** the origin a WebView page of `partition` (its app, install and web origin) renders in. A distinct
 *  site keeps the page from this one's window and storage; a wildcard template gives each partition
 *  its own origin, as each app's WebView data directory keeps each web origin's storage apart. */
export async function rendererOrigin(partition: string): Promise<string> {
  const template = await rendererPattern();
  if (!template.includes("*")) return new URL(template).origin;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(partition)));
  return new URL(template.replace("*", digest.subarray(0, 16).toHex())).origin;
}

/** the renderer document on `origin` for bridge `id`, a subframe's with its token `sub` */
export const rendererUrl = (origin: string, id: string, sub?: string) => origin + "/webview?__wd_bridge=" + id + (sub ? "&__wd_sub=" + sub : "");
/** the renderer documents announcing themselves, by bridge id */
const announced = new Map<string, (event: MessageEvent<RendererReady>, win: Window) => void>();
const announce = (event: MessageEvent) => {
  const data = event.data as Partial<RendererReady> | null, win = event.source as Window | null;
  if (data?.kind === "ready" && typeof data.bridge === "string" && win) announced.get(data.bridge)?.(event as MessageEvent<RendererReady>, win);
};
/** `ready` for each renderer document of bridge `id` that announces itself, until the returned function runs */
export function onRendererReady(id: string, ready: (event: MessageEvent<RendererReady>, win: Window) => void): () => void {
  if (!announced.size) addEventListener("message", announce);
  announced.set(id, ready);
  return () => { if (announced.delete(id) && !announced.size) removeEventListener("message", announce); };
}
/** hand a renderer document on `origin` of bridge `id` its task and the port it answers on */
export const openRenderer = (win: Window, origin: string, id: string, task: RendererTask, port: MessagePort) =>
  win.postMessage({ ...task, bridge: id }, origin, [port]);

type StorageAnswer = { usage: number; quota: number };
/** `op` on `origin`'s storage, in a hidden frame on it (a browser lets only the origin itself
 *  enumerate or clear what it holds); null when the frame never answered */
export function rendererStorage(origin: string, op: StorageOp): Promise<StorageAnswer | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  const id = crypto.randomUUID(), frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = rendererUrl(origin, id);
  const ended = new AbortController();
  return new Promise<StorageAnswer | null>((resolve) => {
    const timer = setTimeout(() => done(null), 10_000);
    const done = (value: StorageAnswer | null) => { clearTimeout(timer); forget(); ended.abort(); frame.remove(); resolve(value); };
    const forget = onRendererReady(id, (event, win) => {
      if (win !== frame.contentWindow || event.origin !== origin) return;
      request({ kind: "storage", op }, (task, port) => openRenderer(win, origin, id, task, port), undefined, ended.signal)
        .then(({ usage = 0, quota = 0 }) => done({ usage, quota }), () => {});
    });
    document.body.append(frame);
  });
}
