import type { WebCookies } from "./webcookies";
import { loopbackFetch } from "../native/loopback-http";

export type WebInterfaces = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
export type WebRequest = { url: string; method: string; main: boolean; headers: Record<string, string> };
export type WebResponse = { body: string; status: number; reason: string; headers: Record<string, string> };

let frameOrigin: Promise<string> | null = null;
export class WebBridge {
  readonly id = crypto.randomUUID();
  readonly ready: Promise<string>;
  private socket: WebSocket;
  private queue = Promise.resolve();

  constructor(ifaces: WebInterfaces, cookies: Promise<WebCookies>, documentURL: () => string | null, intercept?: (request: WebRequest) => Promise<WebResponse | null>) {
    const url = new URL("/webview-socket", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("id", this.id);
    const socket = this.socket = new WebSocket(url);
    const connected = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebView bridge connection failed"));
      socket.onclose = () => reject(new Error("WebView bridge closed"));
    });
    frameOrigin ??= fetch("/webview-origin").then(async (r) => {
      if (!r.ok) throw new Error("WebView requires a separate renderer site");
      const origin: unknown = await r.json();
      if (typeof origin !== "string" || new URL(origin).origin === location.origin) throw new Error("Invalid WebView renderer origin");
      return new URL(origin).origin;
    });
    this.ready = Promise.all([connected, frameOrigin]).then(([, origin]) => origin);
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
          } else if (call.kind === "cookie") {
            const jar = await cookies, url = documentURL() ?? "";
            reply = { value: "value" in call && typeof call.value === "string" ? jar.set(url, call.value, false) : jar.get(url, false) };
          } else {
            if (call.kind !== "invoke" || !("object" in call) || typeof call.object !== "string" || !("method" in call) || typeof call.method !== "string" || !("args" in call) || !Array.isArray(call.args)) throw new Error("Invalid bridge invocation");
            const methods = Object.hasOwn(ifaces, call.object) ? ifaces[call.object] : undefined;
            if (!methods || !Object.hasOwn(methods, call.method)) throw new Error("Unknown JavaScript interface method");
            const value = await methods[call.method](...call.args);
            reply = value === undefined ? { void: true } : { value };
          }
        } catch (error) { console.warn("[webview bridge]", error); reply = { error: "JavaScript interface invocation failed" }; }
        if (socket.readyState === WebSocket.OPEN) socket.send(seq + "\n" + JSON.stringify(reply));
      };
      // the app's own server answers in its own time: the page's other calls do not wait behind it
      if ((parsed as { kind?: unknown } | null)?.kind === "loopback") void answer();
      else this.queue = this.queue.then(answer);
    };
  }
  close() { this.socket.close(); }
}
