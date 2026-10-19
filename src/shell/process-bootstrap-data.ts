import type { PackedArchiveIndex } from "./packedarchive.ts";
import type { RemoteFileData } from "./remote-file.ts";
import type { Rotation } from "./config.ts";

/** Installed config/feature splits are loaded only by their owning package. */
type PackageSnapshot = { certificates: Uint8Array[]; pkg: string;
  source: RemoteFileData | { index: PackedArchiveIndex; base: string }; splits: RemoteFileData[];
  uid: number; system: boolean; grants: string[]; signatures: Uint8Array[] | null };
export type ProcessBootstrap = { pid: number; pkg: string; process: string; uid: number; registry: PackageSnapshot[];
  launcher: { assetKey: string } | null; broker: MessagePort; display: MessagePort; screen: OffscreenCanvas; ime: MessagePort; web: MessagePort; media: MessagePort;
  /** a replica of the device storage its package reads (device-storage.ts) */
  storage: [string, string][];
  /** the display's rotation state its activities' requests resolve against */
  rotation: Rotation };

/** Use at every bootstrap hop: structuredClone and the subsequent Worker postMessage. */
export const bootstrapTransfers = (data: ProcessBootstrap): Transferable[] => [...bootstrapPorts(data), data.screen];
function bootstrapPorts(data: ProcessBootstrap): MessagePort[] {
  return [...data.registry.flatMap(record => [...("port" in record.source ? [record.source.port] : []),
    ...record.splits.map(split => split.port)]), data.broker, data.display, data.ime, data.web, data.media];
}

/** Close only this received bootstrap's capabilities after an unpublished startup fails. */
export function closeProcessBootstrap(data: ProcessBootstrap): void {
  for (const port of bootstrapPorts(data)) {
    try { port.postMessage({kind:"close"}); } catch { /* a failed transfer may leave a detached port */ }
    port.close();
  }
}
