import { unshared } from "../jvm/abi.ts";

const EMPTY_CHUNK = new Uint8Array(0);

type Ipv4 = [number, number, number, number];
export function parseIpv4(text: string): Ipv4 | null {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) return null;
  const bytes: Ipv4 = [+match[1], +match[2], +match[3], +match[4]];
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}
export const ipv4Key = (bytes: ArrayLike<number>): number => ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
export const ipv4Text = (bytes: ArrayLike<number>): string => `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
// A name resolves to a stable address in 198.18.0.0/15 (RFC 2544's benchmarking block, unrouted)
// shared by Java's InetAddress and the native resolver: whichever side later dials the address,
// the relay is given the name it stands for. A numeric literal is itself.
const syntheticByHost = new Map<string, Ipv4>();
const hostBySynthetic = new Map<number, string>();
let nextSynthetic = 1;
export function syntheticAddress(host: string): Ipv4 {
  const numeric = parseIpv4(host);
  if (numeric) return numeric;
  const found = syntheticByHost.get(host);
  if (found) return found;
  const id = nextSynthetic++ & 0xffff;
  const bytes: Ipv4 = [198, 18, id >>> 8, id & 255];
  syntheticByHost.set(host, bytes);
  hostBySynthetic.set(ipv4Key(bytes), host);
  return bytes;
}
export const syntheticHost = (bytes: ArrayLike<number>): string | null => hostBySynthetic.get(ipv4Key(bytes)) ?? null;
const pageOrigin = () => typeof location === "undefined" ? "http://localhost" : `${location.protocol}//${location.host}`;
const socketOrigin = () => pageOrigin().replace(/^http/, "ws");
/** Whether `host` exists in DNS, asked of the dev server once per name: true, false for NXDOMAIN, or
 *  null when nothing could be asked (no server, a transport error), which callers treat as unknown
 *  rather than absent. A numeric literal exists. */
const knownNames = new Map<string, Promise<boolean | null>>();
export function nameExists(host: string): Promise<boolean | null> | boolean {
  if (parseIpv4(host) || host === "localhost") return true;
  let pending = knownNames.get(host);
  if (!pending) {
    pending = typeof location === "undefined" ? Promise.resolve(null) : fetch(`${pageOrigin()}/dns?host=${encodeURIComponent(host)}`).then(
      (r) => r.status === 200 ? true : r.status === 404 ? false : null, () => null);
    knownNames.set(host, pending);
  }
  return pending;
}
/** the name to dial for `host`: a synthetic literal stands for the name it was allotted to */
export function dialName(host: string): string {
  const numeric = parseIpv4(host);
  return (numeric && syntheticHost(numeric)) || host;
}

const relayUrl = (host: string, port: number, tls: boolean, alpn: string[]) =>
  `${socketOrigin()}/tcp?host=${encodeURIComponent(dialName(host))}&port=${port}${tls ? "&tls=1" + alpn.map(p => "&alpn=" + encodeURIComponent(p)).join("") : ""}`;

export class DatagramRelay {
  private readonly onPacket: (data: Uint8Array, source: Ipv4, port: number) => void;
  private transport: Promise<WebSocket> | null = null;
  private closed = false;
  constructor(onPacket: (data: Uint8Array, source: Ipv4, port: number) => void) { this.onPacket = onPacket; }
  private open(): Promise<WebSocket> {
    const transport = new WebSocket(`${socketOrigin()}/udp`);
    transport.binaryType = "arraybuffer";
    return new Promise<WebSocket>((resolve, reject) => {
      let opened = false;
      transport.onmessage = (event) => {
        if (typeof event.data === "string") {
          if (!opened) { opened = true; resolve(transport); }
          return;
        }
        // the source as this relay dialed it: a name stands for its synthetic address, as the
        // guest's connected peer does
        const frame = new Uint8Array(event.data as ArrayBuffer);
        if (frame.length < 3 + frame[0]) return;
        const source = new TextDecoder().decode(frame.subarray(3, 3 + frame[0]));
        this.onPacket(frame.subarray(3 + frame[0]), syntheticAddress(source), frame[1] << 8 | frame[2]);
      };
      const failed = () => { if (!opened) { opened = true; reject(new Error("UDP relay unavailable")); } };
      transport.onclose = failed;
      transport.onerror = failed;
    });
  }
  async send(host: string, port: number, bytes: Uint8Array): Promise<void> {
    if (port === 53) return void this.resolve(host, bytes);
    const transport = await (this.transport ??= this.open());
    const name = new TextEncoder().encode(dialName(host));
    if (name.length > 253 || bytes.length > 65507) throw new Error("UDP datagram is too large");
    const frame = new Uint8Array(3 + name.length + bytes.length);
    frame[0] = name.length; frame[1] = port >> 8; frame[2] = port & 255;
    frame.set(name, 3); frame.set(bytes, 3 + name.length);
    transport.send(frame);
  }
  /** A guest's own resolver is answered over DNS-over-HTTPS, which needs no UDP relay (the deployed
   *  Worker has none). A failed query is a lost datagram: the resolver's retry and timeout apply. */
  private async resolve(host: string, query: Uint8Array): Promise<void> {
    try {
      const r = await fetch(`${pageOrigin()}/dns-query`, { method: "POST", body: query.slice(), headers: { "content-type": "application/dns-message" } });
      if (r.ok && !this.closed) this.onPacket(new Uint8Array(await r.arrayBuffer()), parseIpv4(host) ?? syntheticAddress(host), 53);
    } catch { /* lost */ }
  }
  close(): void {
    this.closed = true;
    void this.transport?.then((transport) => transport.close(), () => {});
  }
}

interface RelayEndpoint {
  family: "IPv4" | "IPv6";
  address: string;
  port: number;
}

/** received bytes in arrival order, drained from the front without copying the rest */
export class ByteQueue {
  private q: Uint8Array[] = [];
  private head = 0;
  length = 0;
  push(bytes: Uint8Array): void { this.q.push(bytes); this.length += bytes.length; }
  /** moves up to `len` bytes into `out` at `off`; `peek` leaves them queued */
  take(out: Uint8Array, off: number, len: number, peek = false): number {
    let n = 0, i = this.head;
    while (n < len && i < this.q.length) {
      const chunk = this.q[i], take = Math.min(len - n, chunk.length);
      out.set(take === chunk.length ? chunk : chunk.subarray(0, take), off + n);
      n += take;
      if (peek) i++;
      else if (take === chunk.length) this.q[i++] = EMPTY_CHUNK;
      else this.q[i] = chunk.subarray(take);
    }
    if (peek) return n;
    this.length -= n; this.head = i;
    if (this.head === this.q.length) { this.q.length = 0; this.head = 0; }
    else if (this.head >= 1024 && this.head * 2 >= this.q.length) { this.q = this.q.slice(this.head); this.head = 0; }
    return n;
  }
}

/** One WebSocket carries one TCP byte stream through server.ts's /tcp relay. */
export class Relay {
  private readonly transport: WebSocket;
  private readonly q = new ByteQueue();
  private readonly waiters = new Set<() => void>();
  connected = false;
  applicationProtocol: string | null = null;
  eof = false;
  /** why the relay could not connect: its close frame's reason */
  failure = "";
  localEndpoint: RelayEndpoint | null = null;
  readonly ready: Promise<void>;

  constructor(host: string, port: number, tls: boolean, alpn: string[] = []) {
    const transport = (this.transport = new WebSocket(relayUrl(host, port, tls, alpn)));
    transport.binaryType = "arraybuffer";
    let settled = false;
    const wake = () => this.wakeWaiters();
    const done = () => { this.eof = true; wake(); };
    this.ready = new Promise<void>((resolve, reject) => {
      transport.onmessage = (event) => {
        if (typeof event.data === "string") {
          if (!settled) {
            try {
              const message = JSON.parse(event.data) as { type?: unknown; localFamily?: unknown; localAddress?: unknown; localPort?: unknown; alpn?: unknown };
              if (message.type === "ready" && (message.localFamily === "IPv4" || message.localFamily === "IPv6") &&
                  typeof message.localAddress === "string" && Number.isInteger(message.localPort) &&
                  Number(message.localPort) >= 1 && Number(message.localPort) <= 65535) {
                this.applicationProtocol = typeof message.alpn === "string" ? message.alpn : "";
                this.localEndpoint = { family: message.localFamily, address: message.localAddress, port: Number(message.localPort) };
              }
            } catch { /* plain "ok": the worker relay could not parse its local address */ }
            this.applicationProtocol ??= "";
            settled = true; this.connected = true; resolve(); wake();
          }
          return;
        }
        this.q.push(new Uint8Array(event.data as ArrayBuffer));
        wake();
      };
      const failed = (event: Event) => {
        if (!settled) this.failure = (event as CloseEvent).reason ?? "";
        done();
        if (!settled) { settled = true; reject(new Error("connect failed")); }
      };
      transport.onclose = failed;
      transport.onerror = failed;
    });
    this.ready.then(() => { transport.onclose = done; transport.onerror = done; }, () => { /* caller reports connect failure */ });
  }

  available(): number { return this.q.length; }

  /** the bytes that have arrived, without waiting (0 when none have) */
  take(out: Uint8Array, off: number, len: number, peek = false): number { return this.q.take(out, off, len, peek); }

  /** wait until a read can complete without blocking, or `ms` elapses — SO_TIMEOUT's contract,
   *  which a caller probing an idle connection depends on to not wait forever */
  async waitReadable(ms: number): Promise<boolean> {
    if (this.q.length || this.eof) return true;
    await new Promise<void>((resolve) => {
      const fire = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.waiters.delete(fire); resolve(); }, ms);
      this.waiters.add(fire);
    });
    return this.q.length > 0 || this.eof;
  }

  subscribe(waiter: () => void): () => void {
    this.waiters.add(waiter);
    return () => this.waiters.delete(waiter);
  }

  async read(out: Uint8Array, off: number, len: number): Promise<number> {
    if (len === 0) return 0;
    while (this.q.length === 0 && !this.eof) await new Promise<void>((resolve) => this.waiters.add(resolve));
    return this.q.length ? this.q.take(out, off, len) : -1;
  }

  write(bytes: Uint8Array): boolean {
    if (this.transport.readyState !== 1) return false;
    this.transport.send(unshared(bytes));
    return true;
  }

  /** shutdown(SHUT_WR): the relay ends its side of the TCP stream once what was written has gone */
  shutdownWrite(): void {
    if (this.transport.readyState === 1) this.transport.send("shutdown");
  }

  close(): void {
    try { this.transport.close(); } catch { /* already gone */ }
    this.eof = true;
    this.wakeWaiters();
  }
  /** each waiter once: one that subscribes again while woken waits for the next change */
  private wakeWaiters(): void { const waiters = [...this.waiters]; this.waiters.clear(); for (const waiter of waiters) waiter(); }
}
