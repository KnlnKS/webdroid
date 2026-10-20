import { domWebSurface, type WebSurface, type SurfaceStyle, type FrameAnnouncement } from "./web-surface.ts";
import type { RendererReady, RendererTask } from "./webpage/protocol.ts";

type SurfaceCommand = {kind:"style"; value:SurfaceStyle} | {kind:"load";url:string}
  | {kind:"watch";bridge:string} | {kind:"unwatch";bridge:string}
  | {kind:"open";frame:string;origin:string;bridge:string;task:RendererTask}
  | {kind:"replace";frame:string;url:string} | {kind:"close"};
type Announcement = {kind:"ready";data:RendererReady;origin:string;frame:string;main:boolean};

function remoteSurface(port: MessagePort, retired: () => void): WebSurface {
  let closed = false;
  const watches = new Map<string,(event:FrameAnnouncement)=>void>();
  const post = (data:SurfaceCommand, transfer:Transferable[] = []) => {
    if (closed) { for (const item of transfer) if (item instanceof MessagePort) item.close(); return; }
    port.postMessage(data,transfer);
  };
  port.onmessage = ({data}:MessageEvent<Announcement | {kind:"close"}>) => {
    if (data.kind === "close") { close(false); return; }
    if (data.kind === "ready" && data.data.bridge) watches.get(data.data.bridge)?.(data);
  };
  function close(notify = true) {
    if (closed) return;
    if (notify) post({kind:"close"});
    closed = true; watches.clear(); port.close(); retired();
  }
  return {
    style:value => post({kind:"style",value}), load:url=>post({kind:"load",url}),
    ready(bridge,callback) {
      watches.set(bridge,callback); post({kind:"watch",bridge});
      return () => { if (watches.get(bridge) === callback) { watches.delete(bridge); post({kind:"unwatch",bridge}); } };
    },
    open(frame,origin,bridge,task,answer) {
      if (typeof frame !== "string") { answer.close(); throw new Error("foreign renderer frame identity"); }
      post({kind:"open",frame,origin,bridge,task},[answer]);
    },
    replace(frame,url) { if (typeof frame === "string") post({kind:"replace",frame,url}); },
    remove:()=>close(),
  };
}

/** This received process capability creates surfaces, never Java objects or foreign Window refs. */
export function sendWebSurfaces(port: MessagePort) {
  let closed = false;
  const surfaces = new Set<WebSurface>();
  function create():WebSurface {
    if (closed) throw new Error("WebView process owner closed");
    const channel = new MessageChannel();
    const surface = remoteSurface(channel.port1,()=>surfaces.delete(surface));
    try { port.postMessage({kind:"create"},[channel.port2]); }
    catch (error) { surface.remove(); channel.port2.close(); throw error; }
    surfaces.add(surface); return surface;
  }
  function close(notify = true) {
    if (closed) return;
    closed = true;
    for (const surface of surfaces) surface.remove();
    if (notify) port.postMessage({kind:"close"});
    port.close();
  }
  port.onmessage = ({data}) => { if (data?.kind === "close") close(false); };
  return {create,close};
}

function receiveSurface(port:MessagePort, layer:HTMLElement, retired:()=>void) {
  const surface = domWebSurface(layer);
  const watches = new Map<string,()=>void>();
  const frames = new Map<string,FrameAnnouncement & {bridge:string}>();
  let closed = false;
  const forget = (bridge:string) => {
    watches.get(bridge)?.(); watches.delete(bridge);
    for (const [id,frame] of frames) if (frame.bridge === bridge) frames.delete(id);
  };
  function close(notify = true) {
    if (closed) return;
    closed = true;
    for (const end of watches.values()) end();
    watches.clear(); frames.clear(); surface.remove();
    if (notify) port.postMessage({kind:"close"});
    port.close(); retired();
  }
  port.onmessage = ({data,ports}:MessageEvent<SurfaceCommand>) => {
    if (closed) { for (const answer of ports) answer.close(); return; }
    switch (data.kind) {
      case "style": surface.style(data.value); break;
      case "load": surface.load(data.url); break;
      case "watch": {
        forget(data.bridge);
        const bridge = data.bridge;
        watches.set(bridge,surface.ready(bridge,event => {
          if (closed) return;
          // Keep the Window identity here; repeated announcements replace its app-side port.
          const previous = [...frames].find(([,old])=>old.frame===event.frame);
          const id = previous?.[0] ?? crypto.randomUUID();
          frames.set(id,{...event,bridge});
          port.postMessage({kind:"ready",...event,frame:id} satisfies Announcement);
        })); break;
      }
      case "unwatch": forget(data.bridge); break;
      case "open": {
        const frame = frames.get(data.frame), answer = ports[0];
        if (!answer) break;
        if (!frame || frame.bridge !== data.bridge || frame.origin !== data.origin || !watches.has(data.bridge)) { answer.close(); break; }
        surface.open(frame.frame,data.origin,data.bridge,data.task,answer); break;
      }
      case "replace": {
        const frame = frames.get(data.frame);
        if (frame) surface.replace(frame.frame,data.url); break;
      }
      case "close": close(false); break;
    }
  };
  return close;
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
  let closed = false;
  function close(notify = true) {
    if (closed) return;
    closed = true;
    for (const end of surfaces) end();
    surfaces.clear(); size.disconnect(); layer.remove();
    if (notify) port.postMessage({kind:"close"});
    port.close();
  }
  port.onmessage = ({data,ports}) => {
    if (data?.kind === "close") { close(false); return; }
    const child = ports[0];
    if (!child) return;
    if (closed || data?.kind !== "create") { child.close(); return; }
    const end = receiveSurface(child,layer,()=>surfaces.delete(end)); surfaces.add(end);
  };
  return {close,layer};
}
