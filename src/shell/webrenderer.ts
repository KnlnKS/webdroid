// The renderer origins a WebView's pages render on, apart from this page's window and storage, and
// the documents the app drives there.

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

/** what a renderer origin's storage frame does: report its quota-managed usage, or delete its
 *  IndexedDB and file systems ("origin"), with its localStorage ("data"), or everything ("all") */
export type StorageOp = "usage" | "origin" | "data" | "all";
type StorageAnswer = { usage: number; quota: number };
/** `op` on `origin`'s storage, in a hidden frame on it (a browser lets only the origin itself
 *  enumerate or clear what it holds); null when the frame never answered */
export function rendererStorage(origin: string, op: StorageOp): Promise<StorageAnswer | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  const id = crypto.randomUUID(), frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = origin + "/webview?__wd_bridge=" + id;
  return new Promise<StorageAnswer | null>((resolve) => {
    const timer = setTimeout(() => done(null), 10_000);
    const done = (value: StorageAnswer | null) => {
      clearTimeout(timer); removeEventListener("message", ready); frame.remove(); resolve(value);
    };
    const ready = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.bridge !== id || event.data.kind !== "ready") return;
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => done({ usage: Number(data?.usage) || 0, quota: Number(data?.quota) || 0 });
      frame.contentWindow!.postMessage({ bridge: id, kind: "storage", op }, origin, [channel.port2]);
    };
    addEventListener("message", ready);
    document.body.append(frame);
  });
}
