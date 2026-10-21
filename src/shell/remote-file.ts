import type { FileSource } from "./lazyfile.ts";
import { callProxy, callError, serveCalls, type CallFailure } from "./rpc.ts";

/** An immutable archive source crossing a process boundary without a live JS function. */
export type RemoteFileData = { size: number; port: MessagePort };
type FileCalls = { read(offset: number, length: number): Promise<Uint8Array> };

export function serveFile(source: FileSource): { data: RemoteFileData; close(): void } {
  const { port1: port, port2: remote } = new MessageChannel();
  // A view may alias a cached archive, or have a shared buffer: neither is transferable, so a read answers a copy.
  const close = serveCalls<FileCalls>(port, { read: async (offset, length) => new Uint8Array(await source.read(offset, length)) },
    undefined, {}, { read: bytes => [bytes.buffer] });
  return { data: { size: source.size, port: remote }, close };
}

/** a closed endpoint fails its reads as the archive's end */
const readError = (error: CallFailure) =>
  error.javaClass === "android/os/DeadObjectException" ? new Error("Archive source closed") : callError(error);
export class RemoteFile implements FileSource {
  readonly size: number;
  readonly read: (offset: number, length: number) => Promise<Uint8Array>;
  readonly close: () => void;
  constructor(data: RemoteFileData) {
    const { endpoint, close } = callProxy<FileCalls>(data.port, ["read"], { makeError: readError });
    this.size = data.size; this.read = endpoint.read; this.close = close;
  }
}
