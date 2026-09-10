import type { WebCookies } from "./webcookies";

export type WebInterfaces = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

let frameOrigin: Promise<string> | null = null;
export class WebBridge {
  readonly id = crypto.randomUUID();
  readonly ready: Promise<string>;
  private socket: WebSocket;
  private queue = Promise.resolve();

  constructor(ifaces: WebInterfaces, cookies: Promise<WebCookies>, documentURL: () => string | null) {
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
      this.queue = this.queue.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        let reply: unknown;
        try {
          const call: unknown = JSON.parse(body);
          if (!call || typeof call !== "object" || !("kind" in call)) throw new Error("Invalid bridge call");
          if (call.kind === "describe") reply = { value: Object.fromEntries(Object.entries(ifaces).map(([name, methods]) => [name, Object.keys(methods)])) };
          else if (call.kind === "cookie") {
            const jar = await cookies, url = documentURL() ?? "";
            reply = { value: "value" in call && typeof call.value === "string" ? jar.set(url, call.value, false) : jar.get(url, false) };
          } else {
            if (call.kind !== "invoke" || !("object" in call) || typeof call.object !== "string" || !("method" in call) || typeof call.method !== "string" || !("args" in call) || !Array.isArray(call.args)) throw new Error("Invalid bridge invocation");
            const methods = Object.hasOwn(ifaces, call.object) ? ifaces[call.object] : undefined;
            if (!methods || !Object.hasOwn(methods, call.method)) throw new Error("Unknown JavaScript interface method");
            const value = await methods[call.method](...call.args);
            reply = value === undefined ? { void: true } : { value };
          }
        } catch { reply = { error: "JavaScript interface invocation failed" }; }
        if (socket.readyState === WebSocket.OPEN) socket.send(seq + "\n" + JSON.stringify(reply));
      });
    };
  }
  close() { this.socket.close(); }
}
