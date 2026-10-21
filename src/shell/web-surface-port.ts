import { domWebSurface, type WebSurface, type SurfaceStyle, type FrameAnnouncement } from "./web-surface.ts";
import type { RendererReady, RendererTask } from "./webpage/protocol.ts";
import { callProxy, duplex, methodsOf, serveCalls } from "./rpc.ts";

/** a surface's DOM as the process it belongs to drives it, naming frames by the ids their announcements gave */
type SurfaceCalls = { style(value: SurfaceStyle): void; load(url: string): void; watch(bridge: string): void; unwatch(bridge: string): void;
  open(frame: string, origin: string, bridge: string, task: RendererTask, answer: MessagePort): void; replace(frame: string, url: string): void };
const surfaceMethods = methodsOf<SurfaceCalls>()(["style", "load", "watch", "unwatch", "open", "replace"]);
type Announcement = { data: RendererReady; origin: string; frame: string; main: boolean };
/** what the process hears of its surface's frames */
type SurfaceView = { ready(announcement: Announcement): void };
type SurfacesCalls = { create(surface: MessagePort): void };

function remoteSurface(port: MessagePort, retired: () => void): WebSurface {
  const watches = new Map<string,(event:FrameAnnouncement)=>void>();
  let closed = false;
  const owner = duplex<SurfaceView, SurfaceCalls>(port, { ready: event => { if (event.data.bridge) watches.get(event.data.bridge)?.(event); } },
    surfaceMethods, { notifications: surfaceMethods, onClose: () => { closed = true; watches.clear(); retired(); }, transfer: { open: (...args) => [args[4]] } });
  const send = <K extends keyof SurfaceCalls>(method: K, ...args: Parameters<SurfaceCalls[K]>) => {
    if (!closed) (owner.endpoint[method] as (...args: Parameters<SurfaceCalls[K]>) => void)(...args);
  };
  return {
    style: value => send("style", value), load: url => send("load", url),
    ready(bridge, callback) {
      watches.set(bridge, callback); send("watch", bridge);
      return () => { if (watches.get(bridge) === callback) { watches.delete(bridge); send("unwatch", bridge); } };
    },
    open(frame, origin, bridge, task, answer) {
      if (typeof frame !== "string") { answer.close(); throw new Error("foreign renderer frame identity"); }
      if (closed) answer.close(); else send("open", frame, origin, bridge, task, answer);
    },
    replace(frame, url) { if (typeof frame === "string") send("replace", frame, url); },
    remove: owner.close,
  };
}

/** This received process capability creates surfaces, never Java objects or foreign Window refs. */
export function sendWebSurfaces(port: MessagePort) {
  let closed = false;
  const surfaces = new Set<WebSurface>();
  const page = callProxy<SurfacesCalls>(port, ["create"], { notifications: ["create"],
    onClose: () => { closed = true; for (const surface of surfaces) surface.remove(); }, transfer: { create: surface => [surface] } });
  function create(): WebSurface {
    if (closed) throw new Error("WebView process owner closed");
    const channel = new MessageChannel();
    const surface = remoteSurface(channel.port1, () => surfaces.delete(surface));
    try { page.endpoint.create(channel.port2); }
    catch (error) { surface.remove(); channel.port2.close(); throw error; }
    surfaces.add(surface); return surface;
  }
  return { create, close: page.close };
}

function receiveSurface(port: MessagePort, layer: HTMLElement, retired: () => void) {
  const surface = domWebSurface(layer);
  const watches = new Map<string,()=>void>();
  const frames = new Map<string,FrameAnnouncement & {bridge:string}>();
  let closed = false;
  const forget = (bridge: string) => {
    watches.get(bridge)?.(); watches.delete(bridge);
    for (const [id,frame] of frames) if (frame.bridge === bridge) frames.delete(id);
  };
  const app = duplex<SurfaceCalls, SurfaceView>(port, {
    style: value => surface.style(value), load: url => surface.load(url),
    watch(bridge) {
      forget(bridge);
      watches.set(bridge, surface.ready(bridge, event => {
        if (closed) return;
        // Keep the Window identity here; repeated announcements replace its app-side port.
        const id = [...frames].find(([,old]) => old.frame === event.frame)?.[0] ?? crypto.randomUUID();
        frames.set(id, {...event, bridge});
        app.endpoint.ready({...event, frame: id});
      }));
    },
    unwatch: forget,
    open(id, origin, bridge, task, answer) {
      const frame = frames.get(id);
      if (!frame || frame.bridge !== bridge || frame.origin !== origin || !watches.has(bridge)) answer.close();
      else surface.open(frame.frame, origin, bridge, task, answer);
    },
    replace(id, url) { const frame = frames.get(id); if (frame) surface.replace(frame.frame, url); },
  }, ["ready"], { notifications: ["ready"], onClose: () => {
    closed = true;
    for (const end of watches.values()) end();
    watches.clear(); frames.clear(); surface.remove(); retired();
  } });
  return app.close;
}

/** Every DOM frame and observer is owned by this process bootstrap, including unannounced frames; `layer`
 *  holds them, starting where `canvas` is. */
export function receiveWebSurfaces(port:MessagePort, canvas:HTMLCanvasElement, geometry:()=>{density:number;width:number}) {
  const layer = document.createElement("div");
  layer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:16px";
  layer.hidden = canvas.hidden; layer.style.zIndex = canvas.style.zIndex;
  (canvas.parentElement ?? document.body).append(layer);
  const size = new ResizeObserver(([entry])=>layer.style.setProperty("--wd-web-scale",String(entry.contentRect.width * geometry().density / geometry().width)));
  size.observe(canvas);
  const surfaces = new Set<()=>void>();
  const close = serveCalls<SurfacesCalls>(port, { create(child) { const end = receiveSurface(child, layer, () => surfaces.delete(end)); surfaces.add(end); } },
    () => { for (const end of surfaces) end(); surfaces.clear(); size.disconnect(); layer.remove(); });
  return {close,layer};
}
