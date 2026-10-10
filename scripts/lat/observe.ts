/** Injected before navigation in every realm; does not enable debugger domains or run guest code. */
export function installLatencyObserver(counters: string[]) {
  const local = globalThis as any;
  if (location.origin === "null" || !["/", "/process"].includes(location.pathname)) return;
  let root: Window = window;
  try { while (root.parent !== root && root.parent.location.origin === location.origin) root = root.parent; } catch { return; }
  const host = root as any;
  const snapshot = () => {
    const rows = [root, ...Array.from(root.document.querySelectorAll("iframe")).flatMap(f => {
      try { return f.contentWindow?.location.pathname === "/process" ? [f.contentWindow] : []; } catch { return []; }
    })].map(win => {
      const wd = (win as any).wd;
      return { url: win.location.href, pid: new URLSearchParams(win.location.search).get("pid"), pkg: wd?.app()?.pkg ?? null,
        tier: wd?.tier ?? null, available: !!wd?.perf, ticks: wd?.ticks ?? null,
        perf: wd?.perf ? Object.fromEntries(counters.map(k => [k, wd.perf[k] ?? null])) : null,
        compilerWorker: win.__wdCold?.worker ? { ...win.__wdCold.worker } : null,
        appBuilds: win.__wdCold?.appBuilds?.map(build => ({ ...build })) ?? [] };
    });
    if (new URLSearchParams(root.location.search).get("perfProbe") !== "1") return rows;
    const registry = host.wd?.counterReceipts?.();
    const found = new Map(rows.map(row => [row.url, row]));
    return [...(registry?.rows ?? []).map((record: any) => {
      const row = found.get(record.owner.url); found.delete(record.owner.url);
      const receipt = record.receipt;
      return { ...row, url: record.owner.url, pid: String(record.owner.pid), pkg: record.owner.pkg, runtimePkg: row?.pkg ?? null,
        tier: row?.tier ?? new URL(record.owner.url).searchParams.get("tier") ?? "js", available: !!receipt,
        perf: receipt ? { ...row?.perf, ...receipt.counters } : row?.perf ?? null, receiptProbe: true,
        proof: { schema: registry.schema, source: registry.source, sequence: registry.sequence, dropped: registry.dropped, events: registry.events,
          owner: record.owner, dead: record.dead, processDead: record.processDead, error: record.error, receipt } };
    }), ...[...found.values()].map(row => ({ ...row, receiptProbe: true, proof: null }))];
  };
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
  if (window === root) host.__wdLatObserver = { firstApp: null, lastApp: null, onFrame: null, times: null, snapshot };
  const original = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bitmap: ImageBitmap | null) {
    const canvas = this.canvas as HTMLCanvasElement, observer = host.__wdLatObserver;
    const copy = bitmap && observer?.onFrame && canvas.id === "screen" && local.wd?.app() ? createImageBitmap(bitmap) : null;
    let result;
    try { result = original.call(this, bitmap); }
    catch (error) { if (copy) void copy.then(image => image.close(), () => {}); throw error; }
    const at = performance.timeOrigin + performance.now() - root.performance.timeOrigin;
    // receipts only while a capture listens: visibility checks walk computed styles of every frame
    if (bitmap && canvas.id === "screen" && observer && (observer.onFrame || observer.times || !observer.firstApp) && local.wd?.app()) {
      const receipt = { at, url: location.href, pid: new URLSearchParams(location.search).get("pid"),
        pkg: local.wd.app().pkg, tier: local.wd.tier, visible: shown(canvas) };
      if (receipt.visible) { observer.lastApp = receipt; observer.firstApp ??= receipt; observer.times?.push(at); }
      observer.onFrame?.(receipt, copy);
    }
    return result;
  };
}
