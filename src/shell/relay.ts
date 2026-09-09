const EMPTY_CHUNK = new Uint8Array(0);

const relayUrl = (host: string, port: number, tls: boolean) => {
  const page = typeof location === "undefined" ? { protocol: "http:", host: "localhost" } : location;
  return `${page.protocol === "https:" ? "wss" : "ws"}://${page.host}` +
    `/tcp?host=${encodeURIComponent(host)}&port=${port}${tls ? "&tls=1" : ""}`;
};

export interface RelayTransport {
  binaryType: BinaryType;
  readonly readyState: number;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export type RelayTransportFactory = (url: string) => RelayTransport;
const openWebSocket: RelayTransportFactory = (url) => new WebSocket(url);

interface RelayEndpoint {
  family: "IPv4" | "IPv6";
  address: string;
  port: number;
}

/** One WebSocket carries one TCP byte stream through server.ts's /tcp relay. */
export class Relay {
  private readonly transport: RelayTransport;
  private q: Uint8Array[] = [];
  private qHead = 0;
  private qLen = 0;
  private readonly waiters = new Set<() => void>();
  connected = false;
  eof = false;
  localEndpoint: RelayEndpoint | null = null;
  readonly ready: Promise<void>;

  constructor(host: string, port: number, tls: boolean, open: RelayTransportFactory = openWebSocket) {
    const transport = (this.transport = open(relayUrl(host, port, tls)));
    transport.binaryType = "arraybuffer";
    let settled = false;
    const wake = () => { for (const waiter of this.waiters) waiter(); this.waiters.clear(); };
    const done = () => { this.eof = true; wake(); };
    this.ready = new Promise<void>((resolve, reject) => {
      transport.onmessage = (event) => {
        if (typeof event.data === "string") {
          if (!settled) {
            try {
              const message = JSON.parse(event.data) as { type?: unknown; localFamily?: unknown; localAddress?: unknown; localPort?: unknown };
              if (message.type === "ready" && (message.localFamily === "IPv4" || message.localFamily === "IPv6") &&
                  typeof message.localAddress === "string" && Number.isInteger(message.localPort) &&
                  Number(message.localPort) >= 1 && Number(message.localPort) <= 65535) {
                this.localEndpoint = { family: message.localFamily, address: message.localAddress, port: Number(message.localPort) };
              }
            } catch { /* old relays send plain "ok" */ }
            settled = true; this.connected = true; resolve(); wake();
          }
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        this.q.push(bytes);
        this.qLen += bytes.length;
        wake();
      };
      const failed = () => {
        done();
        if (!settled) { settled = true; reject(new Error("connect failed")); }
      };
      transport.onclose = failed;
      transport.onerror = failed;
    });
    this.ready.then(() => { transport.onclose = done; transport.onerror = done; }, () => { /* caller reports connect failure */ });
  }

  available(): number { return this.qLen; }

  waitForChange(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  subscribe(waiter: () => void): () => void {
    this.waiters.add(waiter);
    return () => this.waiters.delete(waiter);
  }

  async read(out: Uint8Array, off: number, len: number): Promise<number> {
    if (len === 0) return 0;
    while (this.qLen === 0 && !this.eof) await this.waitForChange();
    if (this.qLen === 0) return -1;
    let n = 0;
    while (n < len && this.qLen) {
      const chunk = this.q[this.qHead];
      const take = Math.min(len - n, chunk.length);
      out.set(chunk.subarray(0, take), off + n);
      n += take;
      this.qLen -= take;
      if (take === chunk.length) this.q[this.qHead++] = EMPTY_CHUNK;
      else this.q[this.qHead] = chunk.subarray(take);
    }
    if (this.qHead === this.q.length) {
      this.q.length = 0;
      this.qHead = 0;
    } else if (this.qHead >= 1024 && this.qHead * 2 >= this.q.length) {
      this.q = this.q.slice(this.qHead);
      this.qHead = 0;
    }
    return n;
  }

  write(bytes: Uint8Array): boolean {
    if (this.transport.readyState !== 1) return false;
    this.transport.send(bytes);
    return true;
  }

  close(): void {
    try { this.transport.close(); } catch { /* already gone */ }
    this.eof = true;
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
}
