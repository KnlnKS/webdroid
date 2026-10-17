import { loopbackFetch } from "./devicefetch.ts";
import { parseBridgeCall, type BridgeCall, type Invoke } from "./webpage/protocol.ts";

/** a JavaScript interface method; `returns`: the Java method returns a value */
export type WebMethod = ((...args: unknown[]) => Promise<unknown>) & { returns: boolean };
/** each interface's methods */
export type WebInterfaces = Record<string, Record<string, WebMethod>>;
export type WebRequest = { url: string; method: string; main: boolean; headers: Record<string, string> };
export type WebResponse = { body: string; status: number; reason: string; headers: Record<string, string> };

export class WebBridge {
  private ifaces: WebInterfaces;
  readonly id = crypto.randomUUID();
  readonly ready: Promise<string>;
  private socket: WebSocket;
  private queue = Promise.resolve();

  constructor(ifaces: WebInterfaces, intercept: ((request: WebRequest) => Promise<WebResponse | null>) | undefined, origin: Promise<string>) {
    this.ifaces = ifaces;
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
      const at = event.data.indexOf("\n"), seq = event.data.slice(0, at);
      if (at < 1) return;
      let call: BridgeCall | null = null;
      try { call = parseBridgeCall(JSON.parse(event.data.slice(at + 1))); } catch { /* answered as invalid */ }
      const reply = (value: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(seq + "\n" + JSON.stringify(value)); };
      const answer = async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        try { reply(await this.answer(call, intercept)); }
        catch (error) { console.warn("[webview bridge]", error); reply({ error: "JavaScript interface invocation failed" }); }
      };
      // the page's thread is blocked, so the probe answers apart from the calls under way; the app's
      // own server answers in its own time, so the page's other calls do not wait behind it
      if (call?.kind === "probe") reply({ void: true });
      else if (call?.kind === "loopback") void answer();
      else this.queue = this.queue.then(answer);
    };
  }
  private async answer(call: BridgeCall | null, intercept: ((request: WebRequest) => Promise<WebResponse | null>) | undefined): Promise<object> {
    if (call?.kind === "request") return { value: await intercept?.(call) ?? null };
    if (call?.kind === "loopback") {
      const response = await loopbackFetch(call.url, { method: call.method, headers: new Headers(call.headers), body: call.body === undefined ? undefined : Uint8Array.fromBase64(call.body) });
      return { value: response && { status: response.status, reason: response.statusText, headers: Object.fromEntries(response.headers),
        body: new Uint8Array(await response.arrayBuffer()).toBase64() } };
    }
    if (call?.kind !== "invoke") throw new Error("Invalid bridge call");
    const value = await this.call(call);
    return value === undefined ? { void: true } : { value };
  }
  /** a page's call of a JavaScript interface method, in order with its other calls */
  private call(call: Invoke): Promise<unknown> {
    const methods = Object.hasOwn(this.ifaces, call.object) ? this.ifaces[call.object] : undefined;
    if (!methods || !Object.hasOwn(methods, call.method)) throw new Error("Unknown JavaScript interface method");
    return methods[call.method](...call.args);
  }
  /** a call the page could not wait for (its renderer shares this thread): its result is not wanted */
  post(call: Invoke) {
    this.queue = this.queue.then(() => this.call(call)).then(() => {}, (error) => console.warn("[webview bridge]", error));
  }
  close() { this.socket.close(); }
}
