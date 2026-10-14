import { onRendererReady, openRenderer } from "./webrenderer";
import type { RendererReady, RendererTask } from "./webpage/protocol";
import { WEB_FRAME_SANDBOX } from "./webinject";

export type FrameIdentity = Window | string;
export type SurfaceStyle = Partial<Pick<CSSStyleDeclaration, "visibility" | "background" | "left" | "top" | "width" | "height">>;
export type FrameAnnouncement = { data: RendererReady; origin: string; frame: FrameIdentity; main: boolean };
/** The DOM owner validates origin and ancestry; Java and renderer ports stay with the app. */
export interface WebSurface {
  style(value: SurfaceStyle): void;
  load(url: string): void;
  ready(bridge: string, callback: (announcement: FrameAnnouncement) => void): () => void;
  open(frame: FrameIdentity, origin: string, bridge: string, task: RendererTask, port: MessagePort): void;
  replace(frame: FrameIdentity, url: string): void;
  remove(): void;
}
/** whether `win` is the surface's main frame or one nested in it */
function owned(win: Window, main: Window | null): main is Window {
  if (!main) return false;
  if (win === main) return true;
  for (let w = win, depth = 0; w !== w.parent && depth < 32; w = w.parent, depth++) if (w.parent === main) return true;
  return false;
}
export function domWebSurface(layer: HTMLElement): WebSurface {
  const el = document.createElement("iframe");
  el.referrerPolicy = "no-referrer";
  el.setAttribute("sandbox", WEB_FRAME_SANDBOX);
  el.style.cssText = "position:absolute;border:0;pointer-events:auto;transform-origin:top left;transform:scale(var(--wd-web-scale,1));visibility:hidden";
  layer.appendChild(el);
  const watches = new Set<() => void>();
  return {
    style: value => Object.assign(el.style, value),
    load: url => { el.src = url; },
    ready(bridge, callback) {
      const end = onRendererReady(bridge, (event, win) => {
        const main = el.contentWindow;
        if (owned(win, main)) callback({data:event.data,origin:event.origin,frame:win,main:win === main});
      });
      const close = () => { end(); watches.delete(close); };
      watches.add(close); return close;
    },
    open(frame, origin, bridge, task, port) {
      if (typeof frame === "string") { port.close(); throw new Error("foreign renderer frame identity"); }
      const main = el.contentWindow;
      if (!owned(frame, main)) { port.close(); return; }
      openRenderer(frame, origin, bridge, task, port);
    },
    replace(frame, url) {
      const main = el.contentWindow;
      if (typeof frame !== "string" && owned(frame, main)) frame.location.replace(url);
    },
    remove() { for (const close of watches) close(); el.remove(); },
  };
}
