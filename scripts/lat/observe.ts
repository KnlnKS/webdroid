/** Injected before navigation in every realm; does not enable debugger domains or run guest code. */
export function installLatencyObserver(counters: string[]) {
  const local = globalThis as any;
  if (location.origin === "null" || !["/", "/process"].includes(location.pathname)) return;
  let root: Window = window;
  try { while (root.parent !== root && root.parent.location.origin === location.origin) root = root.parent; } catch { return; }
  const host = root as any;
  const snapshot = () => [root, ...Array.from(root.document.querySelectorAll("iframe")).flatMap(f => {
    try { return f.contentWindow?.location.pathname === "/process" ? [f.contentWindow] : []; } catch { return []; }
  })].map(win => {
    const wd = (win as any).wd;
    return { url: win.location.href, pid: new URLSearchParams(win.location.search).get("pid"), pkg: wd?.app()?.pkg ?? null,
      tier: wd?.tier ?? null, available: !!wd?.perf, ticks: wd?.ticks ?? null,
      perf: wd?.perf ? Object.fromEntries(counters.map(k => [k, wd.perf[k] ?? null])) : null,
      compilerWorker: win.__wdCold?.worker ? { ...win.__wdCold.worker } : null,
      appBuilds: win.__wdCold?.appBuilds?.map(build => ({ ...build })) ?? [] };
  });
  const shown = (canvas: HTMLCanvasElement) => {
    if (root.document.visibilityState !== "visible" || host.wd?.displayCanvas?.() !== canvas) return false;
    for (let win: Window = window;; win = win.parent) {
      const element = win === window ? canvas : win.document.documentElement;
      const style = win.getComputedStyle(element), rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility !== "visible" || +style.opacity === 0 || !rect.width || !rect.height) return false;
      if (win === root) return true;
      const frame = win.frameElement;
      if (!frame || (frame as HTMLElement).hidden) return false;
      const parentStyle = win.parent.getComputedStyle(frame), frameRect = frame.getBoundingClientRect();
      if (parentStyle.display === "none" || parentStyle.visibility !== "visible" || +parentStyle.opacity === 0 || !frameRect.width || !frameRect.height) return false;
    }
  };
  if (window === root) host.__wdLatObserver = { firstApp: null, onFrame: null, snapshot };
  const original = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bitmap: ImageBitmap | null) {
    const canvas = this.canvas as HTMLCanvasElement, observer = host.__wdLatObserver;
    const copy = bitmap && observer?.onFrame && canvas.id === "screen" && local.wd?.app() ? createImageBitmap(bitmap) : null;
    const result = original.call(this, bitmap);
    const at = performance.timeOrigin + performance.now() - root.performance.timeOrigin;
    if (bitmap && canvas.id === "screen" && observer && local.wd?.app()) {
      const receipt = { at, url: location.href, pid: new URLSearchParams(location.search).get("pid"),
        pkg: local.wd.app().pkg, tier: local.wd.tier, visible: shown(canvas), processes: snapshot() };
      if (receipt.visible && !observer.firstApp) observer.firstApp = receipt;
      observer.onFrame?.(receipt, copy);
    }
    return result;
  };
}
