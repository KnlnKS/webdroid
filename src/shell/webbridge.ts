import { loopbackFetch } from "./devicefetch";

/** each interface's methods; `returns`: the Java method returns a value */
export type WebInterfaces = Record<string, Record<string, ((...args: unknown[]) => Promise<unknown>) & { returns?: boolean }>>;
export type WebRequest = { url: string; method: string; main: boolean; headers: Record<string, string> };
export type WebResponse = { body: string; status: number; reason: string; headers: Record<string, string> };

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

export class WebBridge {
  readonly id = crypto.randomUUID();
  readonly ready: Promise<string>;
  private socket: WebSocket;
  private queue = Promise.resolve();

  constructor(private ifaces: WebInterfaces, intercept: ((request: WebRequest) => Promise<WebResponse | null>) | undefined, origin: Promise<string>) {
    const url = new URL("/webview-socket", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("id", this.id);
    const socket = this.socket = new WebSocket(url);
    const connected = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebView bridge connection failed"));
      socket.onclose = () => reject(new Error("WebView bridge closed"));
    });
    this.ready = Promise.all([connected, origin]).then(([, origin]) => origin);
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const at = event.data.indexOf("\n"), seq = event.data.slice(0, at), body = event.data.slice(at + 1);
      if (at < 1) return;
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const answer = async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        let reply: unknown;
        try {
          const call = parsed;
          if (!call || typeof call !== "object" || !("kind" in call)) throw new Error("Invalid bridge call");
          if (call.kind === "request") {
            if (!("url" in call) || typeof call.url !== "string" || !("method" in call) || typeof call.method !== "string"
              || !("main" in call) || typeof call.main !== "boolean" || !("headers" in call) || !call.headers || typeof call.headers !== "object") throw new Error("Invalid WebView request");
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(call.headers)) if (typeof value === "string") headers[key] = value;
            reply = { value: await intercept?.({ url: call.url, method: call.method, main: call.main, headers }) ?? null };
          } else if (call.kind === "loopback") {
            if (!("url" in call) || typeof call.url !== "string" || !("method" in call) || typeof call.method !== "string"
              || !("headers" in call) || !call.headers || typeof call.headers !== "object") throw new Error("Invalid WebView request");
            const response = await loopbackFetch(call.url, { method: call.method, headers: new Headers(call.headers as Record<string, string>),
              body: "body" in call && typeof call.body === "string" ? Uint8Array.fromBase64(call.body) : undefined });
            reply = { value: response && { status: response.status, reason: response.statusText, headers: Object.fromEntries(response.headers),
              body: new Uint8Array(await response.arrayBuffer()).toBase64() } };
          } else {
            const value = await this.call(call);
            reply = value === undefined ? { void: true } : { value };
          }
        } catch (error) { console.warn("[webview bridge]", error); reply = { error: "JavaScript interface invocation failed" }; }
        if (socket.readyState === WebSocket.OPEN) socket.send(seq + "\n" + JSON.stringify(reply));
      };
      // the page's thread is blocked, so the probe answers apart from the calls under way; the app's
      // own server answers in its own time, so the page's other calls do not wait behind it
      const kind = (parsed as { kind?: unknown } | null)?.kind;
      if (kind === "probe") socket.send(seq + "\n" + JSON.stringify({ void: true }));
      else if (kind === "loopback") void answer();
      else this.queue = this.queue.then(answer);
    };
  }
  /** a page's call of a JavaScript interface method, in order with its other calls */
  private call(call: object): Promise<unknown> {
    if (!("kind" in call) || call.kind !== "invoke" || !("object" in call) || typeof call.object !== "string" || !("method" in call) || typeof call.method !== "string" || !("args" in call) || !Array.isArray(call.args)) throw new Error("Invalid bridge invocation");
    const methods = Object.hasOwn(this.ifaces, call.object) ? this.ifaces[call.object] : undefined;
    if (!methods || !Object.hasOwn(methods, call.method)) throw new Error("Unknown JavaScript interface method");
    return methods[call.method](...call.args);
  }
  /** a call the page could not wait for (its renderer shares this thread): its result is not wanted */
  post(call: object) {
    this.queue = this.queue.then(() => this.call(call)).then(() => {}, (error) => console.warn("[webview bridge]", error));
  }
  close() { this.socket.close(); }
}
