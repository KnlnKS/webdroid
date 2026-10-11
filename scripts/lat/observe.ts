/** Injected before navigation; does not enable debugger domains or run guest code. */
export function installLatencyObserver(counters: string[]) {
  if (window !== window.top || location.pathname !== "/") return;
  const host = window as any;
  const snapshot = () => {
    const wd = host.wd, cold = window.__wdCold;
    const rows = [{ url: location.href, pid: null, pkg: wd?.app()?.pkg ?? null, tier: wd?.tier ?? null, available: !!wd?.perf, ticks: wd?.ticks ?? null,
      perf: wd?.perf ? Object.fromEntries(counters.map(k => [k, wd.perf[k] ?? null])) : null,
      compilerWorker: cold?.worker ? { ...cold.worker } : null, appBuilds: cold?.appBuilds?.map(build => ({ ...build })) ?? [] }];
    if (new URLSearchParams(location.search).get("perfProbe") !== "1") return rows;
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
    if (document.visibilityState !== "visible" || !host.wd?.displayCanvases?.().includes(canvas)) return false;
    const style = getComputedStyle(canvas), rect = canvas.getBoundingClientRect();
    return style.display !== "none" && style.visibility === "visible" && +style.opacity !== 0 && !!rect.width && !!rect.height;
  };
  host.__wdLatObserver = { firstApp: null, lastApp: null, onFrame: null, times: null, snapshot };
  // a process Worker's canvas names its process
  const appOf = (canvas: HTMLCanvasElement) => canvas.dataset.pkg ? { pkg: canvas.dataset.pkg, pid: canvas.dataset.pid ?? null } : null;
  const original = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bitmap: ImageBitmap | null) {
    const canvas = this.canvas as HTMLCanvasElement, observer = host.__wdLatObserver, app = bitmap && observer ? appOf(canvas) : null;
    const copy = app && observer.onFrame ? createImageBitmap(bitmap!) : null;
    let result;
    try { result = original.call(this, bitmap); }
    catch (error) { if (copy) void copy.then(image => image.close(), () => {}); throw error; }
    const at = performance.now();
    // receipts only while a capture listens: visibility checks read computed styles
    if (app && (observer.onFrame || observer.times || !observer.firstApp)) {
      const receipt = { at, url: location.href, pid: app.pid, pkg: app.pkg, tier: host.wd?.tier, visible: shown(canvas) };
      if (receipt.visible) { observer.lastApp = receipt; observer.firstApp ??= receipt; observer.times?.push(at); }
      observer.onFrame?.(receipt, copy);
    }
    return result;
  };
}
