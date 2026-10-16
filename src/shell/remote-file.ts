import type { FileSource } from "./lazyfile.ts";

/** An immutable archive source crossing a process boundary without a live JS function. */
export type RemoteFileData = { size: number; port: MessagePort };
type Request = { kind: "read"; id: number; offset: number; length: number } | { kind: "close" };
type Reply = { kind: "read"; id: number; bytes: Uint8Array }
  | { kind: "error"; id: number; name: string; message: string }
  | { kind: "close" };

export function serveFile(source: FileSource): { data: RemoteFileData; close(): void } {
  const { port1: port, port2: remote } = new MessageChannel();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    port.postMessage({ kind: "close" } satisfies Reply);
    port.close();
  };
  port.onmessage = async ({ data }: MessageEvent<Request>) => {
    if (closed) return;
    if (data.kind === "close") { close(); return; }
    try {
      // A view may alias a cached archive, or have a shared buffer: neither is transferable.
      const bytes = new Uint8Array(await source.read(data.offset, data.length));
      if (!closed) port.postMessage({ kind: "read", id: data.id, bytes } satisfies Reply, [bytes.buffer]);
    } catch (error) {
      if (!closed) port.postMessage({ kind: "error", id: data.id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error) } satisfies Reply);
    }
  };
  return { data: { size: source.size, port: remote }, close };
}

export class RemoteFile implements FileSource {
  private readonly data: RemoteFileData;
  readonly size: number;
  private nextId = 1;
  private closed = false;
  private pending = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: unknown): void }>();
  constructor(data: RemoteFileData) {
    this.data = data;
    this.size = data.size;
    data.port.onmessage = ({ data: reply }: MessageEvent<Reply>) => {
      if (reply.kind === "close") { this.finish(); return; }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.kind === "read") pending.resolve(reply.bytes);
      else { const error = new Error(reply.message); error.name = reply.name; pending.reject(error); }
    };
    data.port.onmessageerror = () => this.close();
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("Archive source closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.data.port.postMessage({ kind: "read", id, offset, length } satisfies Request); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  close(): void {
    if (this.closed) return;
    this.data.port.postMessage({ kind: "close" } satisfies Request);
    this.finish();
  }
  private finish(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Archive source closed"));
    this.pending.clear();
    this.data.port.close();
  }
}
