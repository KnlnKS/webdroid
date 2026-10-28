import type { PackedArchiveIndex } from "./packedarchive.ts";
import type { RemoteFileData } from "./remote-file.ts";
import type { Rotation } from "./config.ts";
import { closePort } from "./rpc.ts";

/** Installed config/feature splits are loaded only by their owning package. */
type PackageSnapshot = { certificates: Uint8Array[]; pkg: string;
  source: RemoteFileData | { index: PackedArchiveIndex; base: string }; splits: RemoteFileData[];
  uid: number; system: boolean; grants: string[]; signatures: Uint8Array[] | null };
/** the ports a snapshot's archive and splits are read through, which cross realms with it */
export const snapshotPorts = ({ source, splits }: PackageSnapshot): MessagePort[] => [source, ...splits].flatMap((file) => "port" in file ? [file.port] : []);
/** A process's surfaces, each a port between its page end (process-host.ts) and its Worker end (worker-bootstrap.ts): its
 *  frames; the pointer events and IME edits the page sends, with the IME state the page's text control hears; its WebView
 *  surfaces; and its audio and media elements. */
export type SurfaceName = "display" | "input" | "web" | "media";
export type ProcessBootstrap = { pid: number; pkg: string; process: string; uid: number; registry: PackageSnapshot[];
  launcher: { assetKey: string } | null; broker: MessagePort; screen: OffscreenCanvas; surfaces: Record<SurfaceName, MessagePort>;
  /** a replica of the device storage its package reads (device-storage.ts) */
  storage: [string, string][];
  /** the display's rotation state its activities' requests resolve against */
  rotation: Rotation;
  /** the page's counts of its files' changes (vfs.ts), when cross-origin isolation lets realms share them */
  fileChanges?: Int32Array };

/** Use at every bootstrap hop: structuredClone and the subsequent Worker postMessage. */
export const bootstrapTransfers = (data: ProcessBootstrap): Transferable[] => [...bootstrapPorts(data), data.screen];
function bootstrapPorts(data: ProcessBootstrap): MessagePort[] {
  return [...data.registry.flatMap(snapshotPorts), data.broker, ...Object.values(data.surfaces)];
}

/** Close only this received bootstrap's capabilities after an unpublished startup fails. */
export function closeProcessBootstrap(data: ProcessBootstrap): void {
  for (const port of bootstrapPorts(data)) closePort(port);
}
