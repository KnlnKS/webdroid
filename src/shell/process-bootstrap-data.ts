import type { PackedArchiveIndex } from "./packedarchive";
import type { RemoteFileData } from "./remote-file";

/** Installed config/feature splits are loaded only by their owning package. */
type PackageSnapshot = { certificates: Uint8Array[]; pkg: string;
  source: RemoteFileData | { index: PackedArchiveIndex; base: string }; splits: RemoteFileData[];
  uid: number; system: boolean; grants: string[]; signatures: Uint8Array[] | null };
export type ProcessBootstrap = { pid: number; pkg: string; process: string; uid: number; registry: PackageSnapshot[];
  launcher: { assetKey: string } | null; refreshRate: number; broker?: MessagePort; display?: MessagePort; ime?: MessagePort; web?: MessagePort };

/** Use at every bootstrap hop: structuredClone and the subsequent Worker postMessage. */
export function bootstrapTransfers(data: ProcessBootstrap): MessagePort[] {
  return [...data.registry.flatMap(record => [...("port" in record.source ? [record.source.port] : []),
    ...record.splits.map(split => split.port)]), ...(data.broker ? [data.broker] : []), ...(data.display ? [data.display] : []), ...(data.ime ? [data.ime] : []), ...(data.web ? [data.web] : [])];
}

/** Close only this received bootstrap's capabilities after an unpublished startup fails. */
export function closeProcessBootstrap(data: ProcessBootstrap): void {
  for (const port of bootstrapTransfers(data)) {
    try { port.postMessage({kind:"close"}); } catch { /* a failed transfer may leave a detached port */ }
    port.close();
  }
}
