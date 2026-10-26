// A Surface parceled to another process (view::Surface, which carries its IGraphicBufferProducer): the owner and a
// token, which a reader elsewhere connects to through the broker. Frames the reader draws reach the owner's surface
// over that port, and its size comes back over it. A token resolves until what the surface draws to ends, which
// closes its ports; a port closes when either side drops it or dies.

import { onCallerDeath } from "./binder.ts";
import { presentSurface, type GlSurface } from "./glsurface.ts";
import type { Surface } from "./surfaceflinger.ts";
import { broker } from "../shell/broker-access.ts";

type Message = { kind: "size"; width: number; height: number } | { kind: "frame"; frame: ImageBitmap | VideoFrame };
/** a parceled surface, what it draws to, and its readers' ports with the functions closing them */
interface Export { surface: Surface; owner: object; target: GlSurface | null; readers: Map<MessagePort, () => void> }
const exported = new Map<number, Export>(), tokens = new WeakMap<Surface, number>();
const imported = new Map<string, GlSurface>();

/** the token `surface` parcels under, whose frames go to `target` */
export function exportSurface(surface: Surface, target: GlSurface | null): number {
  let token = tokens.get(surface);
  if (token === undefined) {
    const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
    token = (hi & 0x1fffff) * 2 ** 32 + lo;
    tokens.set(surface, token);
    exported.set(token, { surface, owner: surface.queue ?? surface.producer ?? surface, target, readers: new Map() });
  }
  return token;
}
export const exportedSurface = (token: number): Surface | null => exported.get(token)?.surface ?? null;
/** what `owner` (a queue or a producer) drew to has ended: its tokens stop resolving and their ports close */
export function endExports(owner: object): void {
  for (const [token, e] of exported) {
    if (e.owner !== owner) continue;
    exported.delete(token);
    for (const end of e.readers.values()) end();
  }
}
export function exportsResized(owner: object, width: number, height: number): void {
  for (const e of exported.values()) if (e.owner === owner) for (const port of e.readers.keys()) port.postMessage({ kind: "size", width, height } satisfies Message);
}

/** `close` once the port closes from the other side or process `pid` dies; the function that closes it from this side */
function closedWith(port: MessagePort, pid: number, close: () => void): () => void {
  const unwatch = onCallerDeath(pid, () => end());
  const end = () => { unwatch(); port.close(); close(); };
  port.addEventListener("close", end, { once: true });
  return end;
}
/** the owner's side of the port `reader` connected onto the surface it parceled under `token` */
export function connectSurface(token: number, port: MessagePort, reader: number): boolean {
  const e = exported.get(token), target = e?.target;
  if (!e || !target) { port.close(); return false; }
  port.onmessage = ({ data }: MessageEvent<Message>) => { if (data.kind === "frame") presentSurface(target, data.frame); };
  e.readers.set(port, closedWith(port, reader, () => e.readers.delete(port)));
  port.postMessage({ kind: "size", width: target.width, height: target.height } satisfies Message);
  return true;
}
/** the producer drawing to process `owner`'s surface parceled under `token`, one per surface while its port is open */
export function importedProducer(owner: number, token: number): GlSurface | null | Promise<GlSurface | null> {
  const key = `${owner}:${token}`;
  return imported.get(key) ?? (async () => {
    const port = await broker().surfaceConnect(owner, token);
    if (!port) return null;
    const producer = await new Promise<GlSurface>((resolve) => {
      port.onmessage = ({ data }: MessageEvent<Message>) => {
        if (data.kind !== "size") return;
        const { width, height } = data;
        resolve({ width, height, present: null, frames: 0, post: (frame) => port.postMessage({ kind: "frame", frame } satisfies Message, [frame]) });
      };
    });
    port.onmessage = ({ data }: MessageEvent<Message>) => { if (data.kind === "size") { producer.width = data.width; producer.height = data.height; } };
    imported.set(key, producer);
    closedWith(port, owner, () => { imported.delete(key); endExports(producer); });
    return producer;
  })();
}
