// webdroid shell: phone chrome, launcher, boot + input wiring.
import "./natives.ts";
import { PROCESS_PID } from "./android/os.ts";
import { hostFrames, recordVsync, vsyncScheduled } from "./android/vsync.ts";
import { pendingTransitions } from "./android/server/atm.ts";
import { mountSystemCertificates } from "./shell/cacerts.ts";
import { mountPlatformData } from "./shell/apex.ts";

import { newObj, vcall, scall } from "./jvm/natives/jentry.ts";
import { fetchPlatformJars, loadFramework } from "./android/framework.ts";
import { loadSkia } from "./android/skia.ts";
import type { Mirror } from "./shell/frame-port.ts";
import { startZygote, redraw, pressBack, rotateDevice, setDisplayChangeHandler, setScreenCanvas } from "./shell/device.ts";
import { attachIme } from "./shell/input.ts";
import { drainPointers } from "./shell/pointer-input.ts";
import { clearRoots } from "./shell/hostfs.ts";
import { clearPickedDocuments } from "./android/documents.ts";
import { mark, perf, perfReset } from "./perf.ts";
import { loadTier, wasmThreads } from "./jvm/tier.ts";
import { onMain } from "./android/mainloop.ts";
import { imeInput, imeAction } from "./android/ime.ts";
import { setWebLayer, webViewInfo } from "./android/webframes.ts";
import { packagesWithData, removePackageData } from "./shell/packagedata.ts";
import { clearUserData, deletePackage } from "./android/appdata.ts";
import { jitStats } from "./native/core.ts";
import { mountDiagnostics } from "./shell/diagnostics.ts";
import { realmWd, type RealmWd } from "./shell/realmwd.ts";
import { createShell } from "./shell/ui.ts";
import { openInstallLocal, openInstallRemote } from "./shell/install.ts";
import { activateLocalAssets, localAsset } from "./shell/localassets.ts";
import { vfs } from "./shell/vfs.ts";
import { yieldStats, timedParks } from "./jvm/yield.ts";
import { provisionPackages, provisionServices } from "./shell/provision.ts";
import { processBroker } from "./shell/processes.ts";
import { displayRate } from "./shell/display-rate.ts";
import { processPresentation } from "./shell/process-endpoint.ts";
import { timelineSince } from "./timeline.ts";
import { swipe } from "./shell/gesture.ts";
import { device } from "./shell/config.ts";
import { bootSystemOwner, prepareWorkerInstall } from "./shell/system-boot.ts";
import { hasFocusedWindow, hasTouchWindow, dispatchKey } from "./android/server/wm.ts";
import { imeActive } from "./android/ime.ts";
import { systemInputLayer } from "./shell/system-input.ts";
import { onProcessExit } from "./process-exit.ts";

const params = new URLSearchParams(location.search);

const back = async () => {
  if (hasFocusedWindow()) { await pressBack(); return; }
  const routed = processBroker().activities.back(PROCESS_PID);
  if (routed) await routed; else await pressBack();
};
const rotate = async (landscape: boolean) => {
  const routed = processBroker().activities.rotate(PROCESS_PID, landscape);
  if (routed) await routed; else await rotateDevice(landscape);
};
const shell = createShell({ launch: (file, local) => { void boot(file, local); }, back: () => { void back(); } });
const { canvas, kbd } = shell;
setScreenCanvas(canvas);
const systemInput = systemInputLayer(canvas, () => device);
setWebLayer(shell.webLayer);
setDisplayChangeHandler(shell.resizeDisplay);

void loadFramework();
void fetchPlatformJars();
void loadTier().then(() => mark("tierLoaded"), () => {});
// the next app's process loads its runtime while the page waits for a package to open, as a device's zygote waits forked
processBroker().prestartWorker();

if (process.env.NODE_ENV !== "production") {
  mountDiagnostics(document.querySelector<HTMLElement>("#side")!);
  void fetch("/apks").then((r) => r.json() as Promise<string[]>).catch(() => [] as string[]).then((files) => {
    for (const file of files) shell.addPackage(file);
    const auto = params.get("apk");
    if (auto && files.includes(auto)) void boot(auto);
  });
}

navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.kind !== "webasset" || !event.ports[0]) return;
  const port = event.ports[0], path = event.data.path;
  void localAsset(path).then((reply) => { port.postMessage(reply); port.close(); }, () => { port.postMessage({ status: 500 }); port.close(); });
});

// console capture: wd.logs is what the e2e driver and scripts/dbg.ts read back out of the page
const logBuf: string[] = [];
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    try {
      logBuf.push(level + ": " + args.map((a) => typeof a === "string" ? a : ((a as any)?.msg ?? (a as any)?.message ?? JSON.stringify(a)?.slice(0, 200) ?? String(a))).join(" "));
      if (logBuf.length > 4000) logBuf.splice(0, 1000);
    } catch { /* */ }
  };
}
window.addEventListener("error", (e) => logBuf.push("window.error: " + e.message + " @" + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => logBuf.push("unhandledrejection: " + ((e.reason as any)?.message ?? (e.reason as any)?.msg ?? String(e.reason)) + "\n" + ((e.reason as any)?.stack ?? "").slice(0, 600)));

let booting = false;
// the page opens one app; reopening it starts a new process
let runtimeStarted = false;
async function boot(file: string, local?: File) {
  if (booting || runtimeStarted) return;
  booting = true;
  shell.setState({ kind: "loading", file, stage: local ? "Opening package…" : "Downloading package…" });
  let rollbackAssets: (() => void) | undefined;
  try {
    mark("boot");
    void startZygote(displayRate());
    // the app's process needs only the package: the system realm waits for the page's tier itself
    const [install] = await Promise.all([local ? openInstallLocal(local) : openInstallRemote("/apks/" + encodeURIComponent(file)), provisionPackages(), loadSkia()]);
    const assets = local ? { key: crypto.randomUUID(), install } : null;
    if (local) {
      shell.setState({ kind: "loading", file, stage: "Preparing local app assets…" });
      await navigator.serviceWorker.register("/webview-worker.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
    mark("installOpened");
    rollbackAssets = activateLocalAssets(assets);
    const t0 = performance.now();
    shell.setState({ kind: "loading", file, stage: "Starting system services…" });
    canvas.style.position = "relative";
    canvas.style.zIndex = "2147483647";
    canvas.style.background = "transparent";
    canvas.style.pointerEvents = "none";
    await displayRate();
    runtimeStarted = true;
    const { pkg, label } = await prepareWorkerInstall(install);
    const broker = processBroker();
    let started!: ReturnType<typeof broker.launch>;
    // the task goes with its process (ActivityRecord.handleAppDied removes an activity with no saved
    // state) and the launcher returns, under AppErrors' crash dialog when it showed one; opening the
    // app again starts a new process for it while the other processes and the broker live on
    const launch = () => {
      shell.setState({ kind: "loading", file, stage: "Starting app…" });
      started = broker.launch(pkg, assets?.key ?? file);
      broker.watch(started.pid, death => shell.setState({ kind: "exited", file, label, crashed: death.crashed,
        crashDialog: death.crashed && death.repeated, retry: launch }));
      return started.shown.then(() => { shell.setState({ kind: "running", file, label }); },
        error => { shell.setState({ kind: "failed", file, error, retry: launch }); });
    };
    // the app's process is sent its package before the system realm's Java takes the page
    await Promise.all([launch(), bootSystemOwner()]);
    perf.bootMs = performance.now() - t0;
    // other packages' processes start once the app has shown its first frame
    void broker.presented(started.pid).then(() => provisionServices({ attestationEnabled: params.get("attestation") === "1" }))
      .then(() => broker.boot()).catch(error => console.error("[provision]", error));
  } catch (e) {
    rollbackAssets?.();
    console.error(e);
    shell.setState({ kind: "failed", file, error: e, retry: runtimeStarted ? null : () => { void boot(file, local); } });
  } finally {
    booting = false;
  }
}

const local = realmWd();
// a system window, then the process on top, takes the tap, as they take the browser's own pointer events
const tap = (x: number, y: number): Promise<void> => {
  const worker = processBroker().activities.shownEntries().at(-1)?.worker;
  return worker && !hasTouchWindow(x, y) ? worker.control.tap(x, y) : local.tap(x, y);
};

// `?jit=0` runs the interpreter alone, to tell the tiers apart
jitStats.on = params.get("jit") !== "0";

/** Dev-console and e2e-driver surface; tests/e2e/drivers/webdroid.ts fires these by name. */
const wd = {
  ...local,
  vfs, perfReset, yields: yieldStats, timedParks, vsyncScheduled, pendingTransitions, logs: logBuf, ticks: 0,
  // the JVM's entry points, so a page script can drive real bytecode where Canvas2D is needed
  newObj: (cls: string, desc?: string, ...args: unknown[]) => onMain(() => newObj(cls, desc, ...args)),
  vcall: (obj: unknown, name: string, desc: string, ...args: unknown[]) => onMain(() => vcall(obj, name, desc, ...args)),
  scall: (cls: string, name: string, desc: string, ...args: unknown[]) => onMain(() => scall(cls, name, desc, ...args)),
  boot, back,
  workerProcesses: () => processBroker().workerSnapshots(),
  counterReceipts: () => processBroker().counterReceipts(),
  workerAotProfiles: () => processBroker().workerAotProfiles(),
  displayCanvas: () => processBroker().displayCanvases(canvas).at(-1)!,
  displayCanvases: () => processBroker().displayCanvases(canvas),
  mirrorFrames: (on: Mirror) => processBroker().mirrorFrames(on),
  foregroundWorkerSnapshot: () => processBroker().foregroundWorkerSnapshot(),
  processStarting: () => processBroker().starting(),
  /** the foreground process's frame-path events since `from` (ms since the epoch), each [ms since the epoch, event, arg] */
  foregroundTimeline: async (from: number) => (await processBroker().foregroundWorker()?.control.timeline(from)) ?? [],
  /** the page's own events since `from` (ms since the epoch), as foregroundTimeline */
  pageTimeline: (from: number) => timelineSince(from - performance.timeOrigin),
  /** where the foreground process's on-demand compiling stands, and what it compiled since such a mark, each method with whether its class was linked by then */
  foregroundDemandMark: async () => (await processBroker().foregroundWorker()?.control.demandMark()) ?? null,
  foregroundDemandSince: async (mark: number[]) => (await processBroker().foregroundWorker()?.control.demandSince(mark)) ?? null,
  foregroundCodeReadiness: async (save: boolean) => (await processBroker().foregroundWorker()?.control.codeReadiness(save)) ?? null,
  visibleWorkerProcesses: (ms = 1500) => processBroker().visibleWorkerProcesses(ms),
  background: (ms = 1000) => processBroker().activities.background(ms),
  configuration: (orientation: "portrait" | "landscape") => rotate(orientation === "landscape"),
  // the canvas capture cannot see iframe pixels: this is how a harness proves a page loaded
  web: () => webViewInfo(),
  // the shown processes' windows bottom to top, then the system windows above them
  uiTree: async (): Promise<Awaited<ReturnType<RealmWd["uiTree"]>>> => {
    const nodes = [];
    for (const entry of processBroker().activities.shownEntries()) if (entry.worker) nodes.push(...await entry.worker.control.uiTree());
    return [...nodes, ...await local.uiTree()];
  },
  // Center of the first visible view whose text matches, in SCREEN coords (status bar included,
  // the space wd.tap takes), topmost window first.
  locateText: (s: string): Promise<{ x: number; y: number; bounds: [number, number, number, number] } | null> => {
    const normalized = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = normalized(s);
    const matches = (candidate: string) => candidate === want || candidate.startsWith(want);
    return wd.uiTree().then((nodes) => {
      // topmost window first, as a tap reaches it; an exact match before a prefix, as the device driver ranks them
      const shown = nodes.reverse().filter((n) => n.bounds[2] > n.bounds[0]), texts = (n: typeof shown[number]) => [normalized(n.text), normalized(n.desc)];
      const hit = shown.find((n) => texts(n).includes(want)) ?? shown.find((n) => texts(n).some(matches));
      return hit ? { x: (hit.bounds[0] + hit.bounds[2]) / 2, y: (hit.bounds[1] + hit.bounds[3]) / 2, bounds: hit.bounds } : null;
    });
  },
  tap,
  tapText: async (s: string) => {
    const hit = await wd.locateText(s);
    if (!hit) return "not found: " + s;
    await tap(hit.x, hit.y);
    return `tapped ${s} @ ${hit.x},${hit.y}`;
  },
  swipe: async (x1: number, y1: number, x2: number, y2: number, ms = 400) => {
    const worker = processBroker().foregroundWorker();
    if (worker && !hasTouchWindow(x1, y1)) await worker.control.swipe(x1, y1, x2, y2, ms);
    else await swipe(x1, y1, x2, y2, ms);
    return `swiped ${x1},${y1} -> ${x2},${y2}`;
  },
  // Is the main-looper queue still draining? A wedged job stops input and repaint alike, which
  // looks exactly like a settled screen from outside.
  alive: async (ms = 1500) => {
    const workersAlive = processBroker().visibleWorkersAlive(ms);
    let id: ReturnType<typeof setTimeout>;
    const rootAlive = Promise.race([
      onMain(() => true).finally(() => clearTimeout(id)),
      new Promise((r) => { id = setTimeout(() => r(false), ms); }),
    ]);
    const [root, workers] = await Promise.all([rootAlive, workersAlive]);
    return Boolean(root) && workers !== false;
  },
  // a fresh install of every app: each package's data and install state as its removal takes them,
  // with the shared storage and the picked directories
  reset: async () => {
    const broker = processBroker(), names = await packagesWithData(broker);
    await Promise.all(names.map((pkg) => removePackageData(broker, pkg)));
    await Promise.all([clearRoots(), clearPickedDocuments(), broker.files.clearAll()]);
    return names;
  },
  // an app's data cleared as Settings' "Clear storage" does, and its uninstall as the launcher's
  clearData: async (pkg: string) => (await onMain(() => clearUserData(pkg, false, false, null))).done,
  uninstall: (pkg: string) => onMain(() => deletePackage(pkg)),
  type: async (s: string) => {
    const worker = processBroker().foregroundWorker();
    if (worker && !hasFocusedWindow()) await worker.control.type(s);
    else { kbd.value = s; await imeInput(s); }
    return "typed " + s;
  },
  // the keyboard's action key on the focused field (Search, Go, Done…)
  enter: async () => "action " + ((await ((hasFocusedWindow() ? imeAction() : processBroker().foregroundWorker()?.control.enter()) ?? imeAction())) ? "handled" : "ignored"),
  looperDump: () => import("./android/mainloop.ts").then((m) => m.looperDump()),
  threads: wasmThreads,
  redraw,
  testFrame: async () => {
    await local.testFrame();
    for (const entry of processBroker().activities.shownEntries()) if (entry.worker) await entry.worker.control.testFrame();
  },
};
(globalThis as any).wd = wd;

hostFrames(time => {
  if (!processPresentation.visible) return;
  drainPointers(); // several fingers' moves and a wheel's synthetic drag, once per display frame
  if (recordVsync(time)) wd.ticks++;
});

attachIme(canvas, kbd, systemInput.element);
{
  const keys = new Map([["Escape", 4], ["BrowserBack", 4], ["Enter", 66], ["Tab", 61],
    ["ArrowUp", 19], ["ArrowDown", 20], ["ArrowLeft", 21], ["ArrowRight", 22]]);
  const listeners = new AbortController();
  document.addEventListener("keydown", event => {
    if (!hasFocusedWindow() || event.isComposing) return;
    const key = keys.get(event.key);
    if (key === undefined || key !== 4 && event.target === kbd && imeActive()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void dispatchKey(key).catch(error => console.error("[input]", error));
  }, { capture: true, signal: listeners.signal });
  const close = () => listeners.abort();
  window.addEventListener("pagehide", close, { once: true });
  onProcessExit(close);
}

mountSystemCertificates();
mountPlatformData();

// system_server boots while the page waits for a package to open, as a device's does before any app launches. A page opened for
// an app boots it once the app's process has its package: the page serves that process's code meanwhile.
if (!params.has("apk")) {
  void startZygote(displayRate());
  void provisionPackages().then(bootSystemOwner).catch(() => {});
}
