/** Injected before navigation; does not enable debugger domains or run guest code. */
export function installLatencyObserver(counters: string[]) {
  if (window !== window.top || location.pathname !== "/") return;
  const host = window as any;
  const probe = new URLSearchParams(location.search).get("perfProbe") === "1";
  const snapshot = () => {
    const wd = host.wd, wasm = window.__wdWasm;
    return [{ url: location.href, pid: null, pkg: wd?.app()?.pkg ?? null, available: !!wd?.perf, ticks: wd?.ticks ?? null,
      perf: wd?.perf ? Object.fromEntries(counters.map(k => [k, wd.perf[k] ?? null])) : null,
      compilerWorker: wasm?.worker ? { ...wasm.worker } : null, appBuilds: wasm?.appBuilds?.map(build => ({ ...build })) ?? [],
      ...probe ? { receipt: window.__wdCounterReceipt?.() ?? null } : {} }];
  };
  const shown = (canvas: HTMLCanvasElement) => {
    if (document.visibilityState !== "visible" || !host.wd?.displayCanvases?.().includes(canvas)) return false;
    const style = getComputedStyle(canvas), rect = canvas.getBoundingClientRect();
    return style.display !== "none" && style.visibility === "visible" && +style.opacity !== 0 && !!rect.width && !!rect.height;
  };
  host.__wdLatObserver = { firstApp: null, lastApp: null, onFrame: null, onCrops: null, times: null, snapshot };
  // a process Worker's canvas names its process
  const appOf = (canvas: HTMLCanvasElement) => canvas.dataset.pkg ? { pkg: canvas.dataset.pkg, pid: canvas.dataset.pid ?? null } : null;
  globalThis.__wdPresented = (canvas: HTMLCanvasElement, copy: ImageBitmap | null, at: number, crops?: ImageBitmap[], still?: boolean, frame?: number) => {
    const observer = host.__wdLatObserver, app = appOf(canvas);
    const drop = () => { copy?.close(); crops?.forEach(c => c.close()); };
    // receipts only while a capture listens: visibility checks read computed styles
    if (!app || !(observer.onFrame || observer.onCrops || observer.times || !observer.firstApp)) { drop(); return; }
    const receipt = { at, url: location.href, pid: app.pid, pkg: app.pkg, visible: shown(canvas), still: !!still };
    if (receipt.visible && !still) { observer.lastApp = receipt; observer.firstApp ??= receipt; observer.times?.push(frame ?? at); }
    if (crops && observer.onCrops) { observer.onCrops(receipt, crops); copy?.close(); }
    else if (observer.onFrame && copy) { observer.onFrame(receipt, copy); crops?.forEach(c => c.close()); }
    else drop();
  };
}
